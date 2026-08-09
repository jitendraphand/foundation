import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../env.js';
import { prisma } from '../../db.js';
import { audit, requirePermission } from '../../middleware/auth.js';
import { normalizeContent, normalizeBlocks, blocksToText, type Block } from '../../lib/content.js';
import { figureIndex, isFigure } from '../../lib/diagram.js';
import { validateAnswerKey } from '../../lib/grading.js';
import { importQuestions, runGeneration, buildUserPrompt, sweepAbandonedRuns } from '../../llm/generate.js';
import { IMPORT_TEMPLATE } from '../../llm/import-template.js';
import { LlmError, PROVIDERS } from '../../llm/providers.js';
import { capabilitiesOf } from '../../llm/capabilities.js';
import { ownedBy, seesEverything, type Actor } from '../../lib/ownership.js';
import { generateImage, pictureRequestFor } from '../../llm/images.js';
import { redrawFigure } from '../../llm/redraw.js';
import { imagePromptSchema } from '../../llm/schema.js';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_TEMPLATE } from '../../llm/prompts.js';
import { findWeakAreas, weakAreasToPromptHint, type Breakdown } from '../../lib/analytics.js';

const generateSchema = z.object({
  credentialId: z.string().uuid(),
  model: z.string().min(1).max(200),
  promptTemplateId: z.string().uuid().optional(),
  systemPrompt: z.string().max(40_000).optional(),
  /** Fully custom user prompt; overrides the templated one when present. */
  userPrompt: z.string().max(40_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  kind: z.enum(['REGULAR', 'PRACTICE']).default('REGULAR'),
  targetUserId: z.string().uuid().optional(),
  spec: z.object({
    subject: z.string().min(1).max(120),
    topic: z.string().max(200).optional(),
    subtopic: z.string().max(200).optional(),
    grade: z.string().max(20).optional(),
    // Split into batches of ten behind the scenes; see planBatches, so what
    // one reply can hold is no longer the limit. The remaining bound is
    // patience - a large run is many sequential calls - not the format.
    count: z.number().int().min(1).max(500),
    marksPerQuestion: z.number().min(0.25).max(100).default(1),
    difficultyMix: z.record(z.number().int().min(0)).optional(),
    cognitiveMix: z.record(z.number().int().min(0)).optional(),
    skillFocus: z.array(z.string()).max(8).optional(),
    formats: z.array(z.enum(['MCQ_SINGLE', 'MCQ_MULTI'])).max(2).optional(),
    extraInstructions: z.string().max(4000).optional(),
    avoidImages: z.boolean().optional(),
  }),
});

/**
 * The three lists in the question bank.
 *
 * "Approved" means approved AND still free. A question placed on a paper leaves
 * the list, because the list is what an admin builds the next paper from and
 * anything already spoken for is noise there - fifty approved questions of
 * which forty are on papers is a list nobody can use.
 *
 * Where it goes instead is the paper's own page, which shows the questions in
 * order with their marks. There was briefly a fourth "On a test" tab holding
 * them all together, which was the wrong shape: a paper's contents belong to
 * that paper, not to a pile spanning every paper in the school.
 *
 * Being on a paper is derived from the links rather than stored as a fourth
 * status, so it needs nothing kept in step: take a question off a test, or
 * delete the test, and it returns to Approved by itself. Links to deleted tests
 * do not count - the paper is gone, the question is free.
 */
type QuestionBucket = 'DRAFT' | 'APPROVED' | 'REJECTED';

const ON_NO_LIVE_TEST = { none: { test: { deletedAt: null } } };

function bucketWhere(bucket?: QuestionBucket) {
  switch (bucket) {
    case 'DRAFT':
      return { status: 'DRAFT' as const };
    case 'APPROVED':
      return { status: 'APPROVED' as const, testQuestions: ON_NO_LIVE_TEST };
    case 'REJECTED':
      return { status: 'REJECTED' as const };
    default:
      return {};
  }
}

/**
 * Which of these questions sit on a paper that may no longer change, and why.
 *
 * A published test is out: students can see it and may be part-way through it.
 * A test with attempts has been sat, and its marks were computed from exactly
 * these questions. Editing, deleting or retiring a question underneath either
 * one silently changes an exam while it is happening, or rewrites the paper a
 * released result refers to.
 *
 * The same rule as compositionLock in routes/admin/tests.ts, approached from
 * the other side: that one stops a paper's list of questions changing, this one
 * stops the questions themselves changing. Both are needed - otherwise the
 * paper keeps its ten questions and question four quietly becomes a different
 * question.
 *
 * Returns a map from question id to a sentence naming the paper, so the refusal
 * can say which test is in the way rather than leaving the admin to find it.
 */
async function liveTestLocks(ids: string[]): Promise<Map<string, string>> {
  const locks = new Map<string, string>();
  if (ids.length === 0) return locks;

  const links = await prisma.testQuestion.findMany({
    where: { questionId: { in: ids }, test: { deletedAt: null } },
    select: {
      questionId: true,
      test: { select: { title: true, status: true, _count: { select: { attempts: true } } } },
    },
  });

  for (const link of links) {
    if (locks.has(link.questionId)) continue;
    const { title, status, _count } = link.test;

    if (_count.attempts > 0) {
      locks.set(
        link.questionId,
        `it is on “${title}”, which students have already sat. Their marks were worked out from this exact ` +
          'question, so it can no longer be changed.',
      );
    } else if (status === 'PUBLISHED') {
      locks.set(
        link.questionId,
        `it is on “${title}”, which is live to students right now. Move that test back to draft first, ` +
          'change the question, then publish it again.',
      );
    }
  }

  return locks;
}

/** The lock on one question, or null when it is free to change. */
async function liveTestLock(id: string): Promise<string | null> {
  return (await liveTestLocks([id])).get(id) ?? null;
}

/**
 * Which questions this administrator may see; see lib/ownership.ts. The third
 * argument says questions with no author are everybody's - only this table has
 * any, from before authorship was recorded.
 */
function visibleToUser(request: Actor) {
  return ownedBy(request, 'createdById', true);
}

/** Whether this administrator may act on one particular question. */
async function mayTouch(request: Actor, questionId: string): Promise<boolean> {
  if (seesEverything(request)) return true;
  const q = await prisma.question.findUnique({ where: { id: questionId }, select: { createdById: true } });
  return !q || q.createdById === null || q.createdById === request.user!.sub;
}

export default async function adminQuestionRoutes(app: FastifyInstance) {
  /** Everything the "Set test" screen needs to render its form. */
  app.get('/api/admin/generation/context', async () => {
    const [tags, allCredentials, templates, curriculum] = await Promise.all([
      prisma.tag.findMany({ where: { isActive: true }, orderBy: [{ axis: 'asc' }, { sortOrder: 'asc' }] }),
      prisma.apiCredential.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true, provider: true, label: true, baseUrl: true, keyHint: true, defaultModel: true, meta: true },
      }),
      prisma.promptTemplate.findMany({
        // The Step-up template is excluded: it renders placeholders that only
        // exist when a student asks about one specific question, so choosing it
        // on the Set-test screen would send the model an empty brief.
        where: { isActive: true, kind: { in: ['REGULAR', 'PRACTICE'] } },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        select: { id: true, name: true, description: true, kind: true, isDefault: true, systemPrompt: true, userTemplate: true },
      }),
      prisma.curriculumNode.findMany({
        where: { isActive: true },
        orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }],
        select: { id: true, parentId: true, level: true, code: true, label: true, path: true, grade: true },
      }),
    ]);

    // A credential kept only for drawing pictures has no business in the
    // "which model writes the questions" dropdown; see llm/capabilities.ts.
    const credentials = allCredentials
      .filter((c) => capabilitiesOf(c).text)
      .map(({ meta, ...rest }) => { void meta; return rest; });

    return {
      tags: {
        difficulty: tags.filter((t) => t.axis === 'DIFFICULTY'),
        cognitive: tags.filter((t) => t.axis === 'COGNITIVE'),
        skill: tags.filter((t) => t.axis === 'SKILL'),
      },
      credentials,
      templates,
      curriculum,
      providers: Object.values(PROVIDERS),
      defaults: { systemPrompt: DEFAULT_SYSTEM_PROMPT, userTemplate: DEFAULT_USER_TEMPLATE },
      formats: [
        { code: 'MCQ_SINGLE', label: 'Multiple choice - one correct answer' },
        { code: 'MCQ_MULTI', label: 'Multiple choice - more than one correct answer' },
      ],
    };
  });

  /** Preview the exact prompt that would be sent, before spending a call. */
  app.post('/api/admin/generation/preview-prompt', async (request) => {
    const body = generateSchema.pick({ spec: true, systemPrompt: true, userPrompt: true, promptTemplateId: true }).parse(request.body);

    let template = DEFAULT_USER_TEMPLATE;
    let systemPrompt = body.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

    if (body.promptTemplateId) {
      const t = await prisma.promptTemplate.findUnique({ where: { id: body.promptTemplateId } });
      if (t) {
        template = t.userTemplate;
        systemPrompt = body.systemPrompt ?? t.systemPrompt;
      }
    }

    return {
      systemPrompt,
      userPrompt: body.userPrompt ?? buildUserPrompt(body.spec, template),
    };
  });

  /** Generate draft questions from the LLM. */
  app.post('/api/admin/generation/run', {
    preHandler: requirePermission('questions.generate'),
    config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const body = generateSchema.parse(request.body);

    let systemPrompt = body.systemPrompt;
    let userPrompt = body.userPrompt;

    if (body.promptTemplateId && !systemPrompt) {
      const t = await prisma.promptTemplate.findUnique({ where: { id: body.promptTemplateId } });
      if (t) {
        systemPrompt = t.systemPrompt;
        if (!userPrompt) userPrompt = buildUserPrompt(body.spec, t.userTemplate);
      }
    }

    // Practice runs are seeded from the student's actual weak areas.
    let spec = body.spec;
    if (body.kind === 'PRACTICE') {
      if (!body.targetUserId) return reply.code(400).send({ error: 'A practice test needs a target student.' });

      const attempts = await prisma.attempt.findMany({
        where: { userId: body.targetUserId, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
        select: { breakdown: true },
        orderBy: { submittedAt: 'desc' },
        take: 25,
      });
      const weak = findWeakAreas(attempts.map((a) => a.breakdown as unknown as Breakdown).filter(Boolean), { limit: 8 });
      spec = {
        ...spec,
        extraInstructions: `${spec.extraInstructions ?? ''}\n\n${weakAreasToPromptHint(weak)}`.trim(),
        // Practice should be attemptable straight away, never blocked waiting
        // for someone to generate and attach a picture.
        avoidImages: true,
      };
    }

    try {
      const outcome = await runGeneration({
        requestedById: request.user!.sub,
        credentialId: body.credentialId,
        model: body.model,
        systemPrompt,
        userPrompt,
        promptTemplateId: body.promptTemplateId,
        spec,
        kind: body.kind,
        targetUserId: body.targetUserId,
        temperature: body.temperature,
      });

      await audit(request.user!.sub, 'generation.run', {
        entity: 'GenerationRun', entityId: outcome.runId, ip: request.ip,
        detail: { accepted: outcome.accepted, parsed: outcome.parsed, kind: body.kind, needingImages: outcome.needingImages },
      });

      return outcome;
    } catch (err) {
      if (err instanceof LlmError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  /**
   * Loads questions from a JSON document rather than from a model.
   *
   * The offline route in: no key, no credit, no internet, or simply a batch
   * produced somewhere else. Same schema, same validation, same review queue.
   */
  app.post('/api/admin/questions/import', {
    preHandler: requirePermission('questions.generate'),
    config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const body = z
      .object({
        // Either pasted text or a parsed object; both end up in the same
        // extractJson path, so a copied reply with fences around it works.
        payload: z.union([z.string().min(2).max(4_000_000), z.record(z.any())]),
        sourceLabel: z.string().max(200).optional(),
      })
      .parse(request.body);

    try {
      const outcome = await importQuestions({
        requestedById: request.user!.sub,
        payload: body.payload,
        sourceLabel: body.sourceLabel,
      });

      await audit(request.user!.sub, 'questions.import', {
        entity: 'GenerationRun', entityId: outcome.runId, ip: request.ip,
        detail: { accepted: outcome.accepted, parsed: outcome.parsed, source: body.sourceLabel ?? 'json-upload' },
      });

      return outcome;
    } catch (err) {
      if (err instanceof LlmError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  /**
   * A worked example of the import format, so nobody has to reverse-engineer
   * it from the schema. Doubles as the prompt to hand to any chat assistant
   * when the API is unavailable: paste this, ask for more of the same.
   */
  app.get('/api/admin/questions/import-template', async () => {
    return {
      filename: 'foundation-questions-template.json',
      template: IMPORT_TEMPLATE,
      notes: [
        'One object with a "questions" array. Every field shown is required unless marked optional.',
        'difficultyTag, cognitiveTag and skillTags must use codes from Admin > Settings > Tags.',
        'Blocks may be text, math (LaTeX), svg, mermaid, chart, table, code — the same as a generated question.',
        'answerKey is { "correctOptionId": "b" } for MCQ_SINGLE, { "correctOptionIds": ["a","c"] } for MCQ_MULTI.',
        'Imported questions arrive as drafts and still have to be approved.',
      ],
    };
  });

  /**
   * Generation history, so a bad batch can be diagnosed after the fact - and so
   * an admin who closed the tab mid-run can find out what happened.
   */
  app.get('/api/admin/generation/runs', async (request) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);

    // Anything left "running" by a restart is closed off first, so the list
    // never shows a spinner that will never stop.
    await sweepAbandonedRuns().catch(() => undefined);

    const mine = ownedBy(request, 'requestedById');

    const [total, runs] = await Promise.all([
      prisma.generationRun.count({ where: mine }),
      prisma.generationRun.findMany({
        where: mine,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true, status: true, provider: true, model: true, kind: true, createdAt: true,
          completedAt: true, questionsRequested: true, questionsParsed: true, questionsAccepted: true,
          latencyMs: true, promptTokens: true, completionTokens: true, errorMessage: true,
          requestSpec: true, targetUserId: true,
          requestedBy: { select: { username: true } },
        },
      }),
    ]);

    return { total, page: q.page, pageSize: q.pageSize, runs };
  });

  app.get('/api/admin/generation/runs/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const run = await prisma.generationRun.findFirst({
      // Scoped, not just listed-scoped: an id copied from elsewhere must not
      // open somebody else's run, prompt and raw model reply included.
      where: { id, ...ownedBy(request, 'requestedById') },
      include: { questions: { orderBy: { createdAt: 'asc' } }, requestedBy: { select: { username: true } } },
    });
    if (!run) return reply.code(404).send({ error: 'Generation run not found.' });
    return { run };
  });

  // --- The question bank ---------------------------------------------------

  app.get('/api/admin/questions', async (request) => {
    const q = z
      .object({
        status: z.enum(['DRAFT', 'APPROVED', 'REJECTED']).optional(),
        /** Which list the admin is looking at; see bucketWhere. */
        bucket: z.enum(['DRAFT', 'APPROVED', 'REJECTED']).optional(),
        subject: z.string().optional(),
        topic: z.string().optional(),
        difficultyTag: z.string().optional(),
        cognitiveTag: z.string().optional(),
        skillTag: z.string().optional(),
        generationRunId: z.string().uuid().optional(),
        search: z.string().optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(request.query);

    const bucket = bucketWhere(q.bucket);
    const mine = visibleToUser(request);

    const where = {
      ...mine,
      // The Rejected view is the bin - it deliberately shows retired rows, so
      // a rejection can be undone. Every other view hides them.
      ...(q.status === 'REJECTED' || q.bucket === 'REJECTED' ? {} : { deletedAt: null }),
      ...(q.status ? { status: q.status } : {}),
      ...bucket,
      // Case-insensitive: a test called "Maths" must still find questions
      // filed under "maths". An exact match here silently returned nothing
      // and looked like the question bank was empty.
      ...(q.subject ? { subject: { equals: q.subject, mode: 'insensitive' as const } } : {}),
      ...(q.topic ? { topic: { equals: q.topic, mode: 'insensitive' as const } } : {}),
      ...(q.difficultyTag ? { difficultyTag: q.difficultyTag } : {}),
      ...(q.cognitiveTag ? { cognitiveTag: q.cognitiveTag } : {}),
      ...(q.skillTag ? { skillTags: { has: q.skillTag } } : {}),
      ...(q.generationRunId ? { generationRunId: q.generationRunId } : {}),
    };

    const [total, questions] = await Promise.all([
      prisma.question.count({ where }),
      prisma.question.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        // Which papers it is on. The attempt count comes with it so the UI can
        // apply exactly the rule liveTestLocks applies, and disable the edit
        // button with a reason rather than offering it and being refused.
        include: {
          testQuestions: {
            where: { test: { deletedAt: null } },
            select: {
              test: {
                select: { id: true, title: true, status: true, _count: { select: { attempts: true } } },
              },
            },
          },
        },
      }),
    ]);

    // Text search happens after the fetch: question text lives inside JSONB
    // blocks, and a proper full-text index is not worth it at this scale.
    const filtered = q.search
      ? questions.filter((x) =>
          blocksToText((x.content as { blocks: never[] }).blocks).toLowerCase().includes(q.search!.toLowerCase()),
        )
      : questions;

    // Which subjects exist at this status, so the UI can offer a real choice
    // rather than leaving the admin to guess why a filter found nothing.
    const subjectRows = await prisma.question.groupBy({
      by: ['subject'],
      where: {
        ...mine,
        ...(q.status === 'REJECTED' || q.bucket === 'REJECTED' ? {} : { deletedAt: null }),
        ...(q.status ? { status: q.status } : {}),
        ...bucket,
      },
      _count: { _all: true },
      orderBy: { subject: 'asc' },
    });

    // Counts for the tabs, so each one can show how much is waiting without
    // the UI fetching three pages to find out.
    const [draft, approved, rejected] = await Promise.all([
      prisma.question.count({ where: { ...mine, deletedAt: null, ...bucketWhere('DRAFT') } }),
      prisma.question.count({ where: { ...mine, deletedAt: null, ...bucketWhere('APPROVED') } }),
      prisma.question.count({ where: { ...mine, ...bucketWhere('REJECTED') } }),
    ]);

    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      questions: filtered,
      subjects: subjectRows.map((r) => ({ subject: r.subject, count: r._count._all })),
      counts: { DRAFT: draft, APPROVED: approved, REJECTED: rejected },
    };
  });

  app.get('/api/admin/questions/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const question = await prisma.question.findFirst({ where: { id, deletedAt: null, ...visibleToUser(request) } });
    if (!question) return reply.code(404).send({ error: 'Question not found.' });
    return { question };
  });

  /** Approve or reject drafts in bulk - the main review action. */
  app.post('/api/admin/questions/bulk-status', { preHandler: requirePermission('questions.review') }, async (request) => {
    const body = z
      .object({
        ids: z.array(z.string().uuid()).min(1),
        status: z.enum(['DRAFT', 'APPROVED', 'REJECTED']),
        reviewNote: z.string().max(1000).optional(),
      })
      .parse(request.body);

    // Only the caller's own questions, so a stale tab or a copied id cannot
    // reach into a colleague's bank.
    const owned = await prisma.question.findMany({
      where: { id: { in: body.ids }, ...visibleToUser(request) },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((q) => q.id));

    // A question that needs a picture cannot be approved until one is
    // attached, otherwise a student would sit a question they cannot answer.
    let blocked: string[] = [];
    let ids = body.ids.filter((id) => ownedIds.has(id));

    // A question on a live or sat paper is frozen. Rejecting one would retire
    // it mid-exam; sending it back to draft would take an approved question
    // off a paper students can see. Both are refused, and the rest of the
    // selection still goes through - a bulk action should not fail entirely
    // because one of thirty is spoken for.
    const locks = await liveTestLocks(ids);
    const lockedIds = ids.filter((id) => locks.has(id));
    ids = ids.filter((id) => !locks.has(id));

    if (body.status === 'APPROVED') {
      const unfulfilled = await prisma.question.findMany({
        where: { id: { in: ids }, deletedAt: null, imageRequired: true, imageFulfilled: false },
        select: { id: true },
      });
      blocked = unfulfilled.map((q) => q.id);
      ids = ids.filter((id) => !blocked.includes(id));
    }

    /**
     * Rejecting takes the question out of circulation, not just out of the
     * approved list.
     *
     * It is retired (deletedAt set), which is what keeps it off any paper a
     * student starts from now on, and it is unlinked from every test that can
     * still be changed. Tests students have already sat keep their link,
     * because grading and past results are computed from it - unlinking there
     * would silently rescore papers that may already have been released.
     *
     * Rejected questions stay visible under the Rejected filter, so a
     * mis-click can be undone by putting one back to draft.
     */
    let unlinkedFrom = 0;
    let keptOnSatTests = 0;

    if (body.status === 'REJECTED' && ids.length) {
      const links = await prisma.testQuestion.findMany({
        where: { questionId: { in: ids } },
        select: { id: true, testId: true, test: { select: { _count: { select: { attempts: true } } } } },
      });

      const removable = links.filter((l) => l.test._count.attempts === 0).map((l) => l.id);
      keptOnSatTests = links.length - removable.length;

      if (removable.length) {
        const removed = await prisma.testQuestion.deleteMany({ where: { id: { in: removable } } });
        unlinkedFrom = removed.count;
      }
    }

    const result = ids.length
      ? await prisma.question.updateMany({
          where: { id: { in: ids } },
          data: {
            status: body.status,
            ...(body.reviewNote ? { reviewNote: body.reviewNote } : {}),
            // Rejecting retires it; putting one back to draft brings it back.
            ...(body.status === 'REJECTED' ? { deletedAt: new Date() } : { deletedAt: null }),
          },
        })
      : { count: 0 };

    await audit(request.user!.sub, 'question.bulk_status', {
      entity: 'Question', ip: request.ip,
      detail: {
        count: result.count, status: body.status, blocked: blocked.length,
        onLiveTest: lockedIds.length, unlinkedFrom, keptOnSatTests,
      },
    });

    const notes = [
      // The lock is named first: it is the one an admin will otherwise stare
      // at the screen about, since nothing appears to have happened.
      lockedIds.length === 1
        ? `1 question was left alone because ${locks.get(lockedIds[0])}`
        : lockedIds.length > 1
          ? `${lockedIds.length} questions were left alone because they are on a paper that is live or has been sat. ` +
            'Move that test back to draft first.'
          : null,
      unlinkedFrom > 0 ? `Removed from ${unlinkedFrom} test${unlinkedFrom === 1 ? '' : 's'}.` : null,
      keptOnSatTests > 0
        ? `Left on ${keptOnSatTests} test${keptOnSatTests === 1 ? '' : 's'} that students have already sat, so their results are unaffected — no new attempt will include it.`
        : null,
    ].filter(Boolean);

    return {
      ok: true,
      updated: result.count,
      blocked: blocked.length,
      blockedIds: blocked,
      onLiveTest: lockedIds.length,
      onLiveTestIds: lockedIds,
      unlinkedFrom,
      keptOnSatTests,
      ...(blocked.length
        ? {
            message:
              (blocked.length === 1
                ? '1 question still needs an image before it can be approved. Attach the image first.'
                : `${blocked.length} questions still need an image before they can be approved. Attach the images first.`) +
              (notes.length ? ` ${notes.join(' ')}` : ''),
          }
        : notes.length
          ? { message: notes.join(' ') }
          : {}),
    };
  });

  /**
   * Attaches a generated image to a question that was flagged as needing one.
   * The asset must already be uploaded via POST /api/admin/assets.
   */
  app.post('/api/admin/questions/:id/image', { preHandler: requirePermission('questions.review') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!(await mayTouch(request, id))) return reply.code(404).send({ error: 'Question not found.' });
    const body = z
      .object({
        assetId: z.string().uuid(),
        altText: z.string().max(500).optional(),
        caption: z.string().max(500).optional(),
      })
      .parse(request.body);

    const question = await prisma.question.findFirst({ where: { id, deletedAt: null } });
    if (!question) return reply.code(404).send({ error: 'Question not found.' });

    // Attaching a picture rewrites the question's content, so the same freeze
    // applies as to any other edit.
    const lock = await liveTestLock(id);
    if (lock) return reply.code(409).send({ error: `No picture can be attached because ${lock}` });

    const asset = await prisma.asset.findUnique({ where: { id: body.assetId } });
    if (!asset) return reply.code(400).send({ error: 'That image has not been uploaded yet.' });

    const spec = (question.imagePrompt ?? {}) as { placement?: string; optionId?: string; altText?: string };
    const alt = body.altText ?? spec.altText ?? '';
    const imageBlock = {
      type: 'image' as const,
      assetId: body.assetId,
      alt,
      ...(body.caption ? { caption: body.caption } : {}),
      // Recorded now so the renderer never has to guess; see the image block
      // schema for why the space must be reserved before the file arrives.
      ...(asset.width && asset.height ? { width: asset.width, height: asset.height } : {}),
    };

    let content = question.content as { version: number; blocks: unknown[] };
    let options = question.options as Array<{ id: string; blocks: unknown[] }>;

    if (spec.placement === 'OPTION' && spec.optionId) {
      const target = options.find((o) => o.id === spec.optionId);
      if (!target) return reply.code(400).send({ error: `Option "${spec.optionId}" no longer exists on this question.` });
      options = options.map((o) => (o.id === spec.optionId ? { ...o, blocks: [imageBlock, ...o.blocks] } : o));
    } else {
      // Pictures belong above the question text they illustrate.
      content = { ...content, blocks: [imageBlock, ...content.blocks] };
    }

    const updated = await prisma.$transaction(async (tx) => {
      await tx.asset.update({ where: { id: body.assetId }, data: { questionId: id, altText: alt } });
      return tx.question.update({
        where: { id },
        data: {
          content: content as object,
          options: options as object,
          imageFulfilled: true,
          isAdminEdited: true,
        },
      });
    });

    await audit(request.user!.sub, 'question.image_attached', {
      entity: 'Question', entityId: id, ip: request.ip, detail: { assetId: body.assetId },
    });

    return { ok: true, question: updated, message: 'Image attached. This question can now be approved.' };
  });

  /** The queue of questions still waiting for a picture. */
  /**
   * Draws the picture this question asks for, and hands back the asset ready
   * to attach. Deliberately does not attach it: the administrator should look
   * at what came back before it goes on a paper a child will sit.
   */
  app.post('/api/admin/questions/:id/generate-image', {
    preHandler: requirePermission('questions.review'),
    // Image calls are the most expensive thing here per request.
    config: { rateLimit: { max: 40, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!(await mayTouch(request, id))) return reply.code(404).send({ error: 'Question not found.' });

    const question = await prisma.question.findFirst({ where: { id, deletedAt: null } });
    if (!question) return reply.code(404).send({ error: 'Question not found.' });

    const parsed = imagePromptSchema.safeParse(question.imagePrompt);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'This question has no usable image prompt. Edit it to add one, or clear the image-required flag.',
      });
    }

    try {
      const image = await generateImage(parsed.data);
      await audit(request.user!.sub, 'question.image_generated', {
        entity: 'Question', entityId: id, ip: request.ip, detail: { assetId: image.assetId },
      });
      return { ok: true, ...image };
    } catch (err) {
      if (err instanceof LlmError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/admin/questions/awaiting-images', async (request) => {
    const q = z.object({ generationRunId: z.string().uuid().optional() }).parse(request.query);

    const questions = await prisma.question.findMany({
      where: {
        ...visibleToUser(request),
        deletedAt: null,
        imageRequired: true,
        imageFulfilled: false,
        status: { not: 'REJECTED' },
        ...(q.generationRunId ? { generationRunId: q.generationRunId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return { total: questions.length, questions };
  });

  /**
   * Rewrites the picture request in place.
   *
   * The prompt the model wrote is a first draft, and the reviewer looking at
   * the question is the person who knows what the picture actually has to show.
   * Until now the only way to change it was the full JSON edit form, so in
   * practice nobody did: they generated from wording they disagreed with, or
   * gave up and drew it themselves.
   *
   * Placement is not editable here. Which option a picture belongs to is a
   * structural fact about the question, not a matter of wording, and changing
   * it in a prompt box would silently move the picture somewhere else.
   */
  app.patch('/api/admin/questions/:id/image-prompt', { preHandler: requirePermission('questions.review') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!(await mayTouch(request, id))) return reply.code(404).send({ error: 'Question not found.' });

    const body = z
      .object({
        prompt: z.string().min(20).max(2000),
        description: z.string().min(10).max(1000),
        details: z.array(z.string().max(300)).max(20).default([]),
        style: z.string().max(300).optional(),
        widthPx: z.number().int().min(128).max(4096).optional(),
        heightPx: z.number().int().min(128).max(4096).optional(),
        altText: z.string().max(500).optional(),
      })
      .parse(request.body);

    const question = await prisma.question.findFirst({ where: { id, deletedAt: null } });
    if (!question) return reply.code(404).send({ error: 'Question not found.' });

    // Everything not being edited is kept, so a question whose prompt came
    // from an older shape does not lose the fields this form does not show.
    const existing = (question.imagePrompt ?? {}) as Record<string, unknown>;
    const merged = imagePromptSchema.parse({
      ...existing,
      ...body,
      details: body.details.filter((d) => d.trim().length > 0),
    });

    await prisma.question.update({
      where: { id },
      data: { imagePrompt: merged as object, imageRequired: true },
    });

    await audit(request.user!.sub, 'question.image_prompt_edited', {
      entity: 'Question', entityId: id, ip: request.ip,
    });

    return { ok: true, imagePrompt: merged, message: 'Prompt saved. Generating now uses your wording.' };
  });

  /**
   * Draws a figure again, and hands back the candidate without saving it.
   *
   * See llm/redraw.ts for why this asks for the figure alone rather than
   * regenerating the question, and why nothing is written until the reviewer
   * has looked at what came back.
   */
  app.post('/api/admin/questions/:id/figure/redraw', {
    preHandler: requirePermission('questions.review'),
    config: { rateLimit: { max: 40, timeWindow: '10 minutes' } },
  }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!(await mayTouch(request, id))) return reply.code(404).send({ error: 'Question not found.' });

    const body = z
      .object({
        index: z.number().int().min(0).optional(),
        instructions: z.string().max(2000).optional(),
        credentialId: z.string().uuid().optional(),
        model: z.string().max(200).optional(),
      })
      .parse(request.body ?? {});

    const question = await prisma.question.findFirst({ where: { id, deletedAt: null } });
    if (!question) return reply.code(404).send({ error: 'Question not found.' });

    const lock = await liveTestLock(id);
    if (lock) return reply.code(409).send({ error: `This figure cannot be changed because ${lock}` });

    const blocks = (question.content as { blocks: Block[] }).blocks;
    const found = figureIndex(blocks);
    const current = typeof body.index === 'number' ? (blocks[body.index] ?? null) : (found >= 0 ? blocks[found] : null);

    try {
      const result = await redrawFigure({ question, current, instructions: body.instructions, credentialId: body.credentialId, model: body.model });
      return { ok: true, ...result };
    } catch (err) {
      if (err instanceof LlmError) return reply.code(502).send({ error: err.message });
      throw err;
    }
  });

  /** Puts a redrawn figure into the question, replacing the one at `index`. */
  app.put('/api/admin/questions/:id/figure', { preHandler: requirePermission('questions.review') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!(await mayTouch(request, id))) return reply.code(404).send({ error: 'Question not found.' });
    const body = z.object({ index: z.number().int().min(0), block: z.any() }).parse(request.body);

    const question = await prisma.question.findFirst({ where: { id, deletedAt: null } });
    if (!question) return reply.code(404).send({ error: 'Question not found.' });

    const lock = await liveTestLock(id);
    if (lock) return reply.code(409).send({ error: `This figure cannot be changed because ${lock}` });

    const blocks = (question.content as { blocks: unknown[] }).blocks;
    if (body.index >= blocks.length) return reply.code(400).send({ error: 'That figure is no longer there.' });

    // Sanitised on the way in, exactly as a generated one is.
    const [block] = normalizeBlocks([body.block]);
    const next = blocks.map((b, i) => (i === body.index ? block : b));
    const content = normalizeContent({ version: 1, blocks: next });

    const updated = await prisma.question.update({
      where: { id },
      data: { content: content as object, isAdminEdited: true },
    });

    await audit(request.user!.sub, 'question.figure_replaced', {
      entity: 'Question', entityId: id, ip: request.ip, detail: { index: body.index },
    });

    return { ok: true, question: updated, message: 'Figure replaced.' };
  });

  /**
   * Throws the figure away and asks for a real picture in its place.
   *
   * Deliberately destructive and in that order: the drawing is removed from the
   * question and, if it was a generated picture, the file behind it is deleted
   * too, before anything new exists. A "replace" that leaves the old image on
   * disk and half-attached is how a question ends up showing the wrong figure
   * to a child when the new one fails to arrive.
   *
   * What is left is a question flagged as needing a picture, with the brief the
   * drawing was made from already written into the prompt - so the panel that
   * already knows how to generate, review and attach a picture takes over.
   */
  app.post('/api/admin/questions/:id/figure/to-picture', { preHandler: requirePermission('questions.review') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!(await mayTouch(request, id))) return reply.code(404).send({ error: 'Question not found.' });
    const body = z.object({ index: z.number().int().min(0).optional() }).parse(request.body ?? {});

    const question = await prisma.question.findFirst({ where: { id, deletedAt: null } });
    if (!question) return reply.code(404).send({ error: 'Question not found.' });

    const lock = await liveTestLock(id);
    if (lock) return reply.code(409).send({ error: `This figure cannot be removed because ${lock}` });

    const blocks = (question.content as { blocks: Block[] }).blocks;
    const index = typeof body.index === 'number' ? body.index : figureIndex(blocks);
    const figure = index >= 0 ? blocks[index] : undefined;
    if (!figure || !isFigure(figure)) {
      return reply.code(400).send({ error: 'There is no figure on this question to replace.' });
    }

    const stem = blocksToText(blocks.filter((_, i) => i !== index));
    // A photograph being replaced already has the prompt that produced it, and
    // that is a better starting point than anything derived from its alt text.
    const previous = figure.type === 'image' ? imagePromptSchema.safeParse(question.imagePrompt) : null;
    const wanted = previous?.success ? previous.data : pictureRequestFor(figure, stem);
    const remaining = blocks.filter((_, i) => i !== index);
    if (remaining.length === 0) {
      return reply.code(400).send({ error: 'This question is nothing but that figure - edit the question instead.' });
    }

    // The file goes before the row, and the row before the question is saved:
    // a leftover file is tidy-up, a row pointing at a missing file is a broken
    // picture on a paper.
    if (figure.type === 'image') {
      const asset = await prisma.asset.findUnique({ where: { id: figure.assetId } });
      if (asset) {
        await fs.rm(path.join(env.UPLOAD_DIR, asset.storageKey), { force: true }).catch(() => undefined);
        await prisma.asset.delete({ where: { id: asset.id } }).catch(() => undefined);
      }
    }

    const updated = await prisma.question.update({
      where: { id },
      data: {
        content: { version: 1, blocks: remaining } as object,
        imageRequired: true,
        imageFulfilled: false,
        imagePrompt: wanted as object,
        isAdminEdited: true,
      },
    });

    await audit(request.user!.sub, 'question.figure_discarded', {
      entity: 'Question', entityId: id, ip: request.ip, detail: { index, was: figure.type },
    });

    return {
      ok: true,
      question: updated,
      imagePrompt: wanted,
      message: 'The figure has been deleted. Edit the prompt if you want to, then generate the picture.',
    };
  });

  /** Full edit of a draft question, including its diagram blocks. */
  app.patch('/api/admin/questions/:id', { preHandler: requirePermission('questions.review') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!(await mayTouch(request, id))) return reply.code(404).send({ error: 'Question not found.' });
    const body = z
      .object({
        format: z.enum(['MCQ_SINGLE', 'MCQ_MULTI']).optional(),
        content: z.any().optional(),
        options: z.array(z.object({ id: z.string().min(1).max(8), blocks: z.array(z.any()) })).optional(),
        answerKey: z.any().optional(),
        explanation: z.any().optional(),
        difficultyTag: z.string().optional(),
        cognitiveTag: z.string().optional(),
        skillTags: z.array(z.string()).max(4).optional(),
        subject: z.string().max(120).optional(),
        topic: z.string().max(200).nullable().optional(),
        subtopic: z.string().max(200).nullable().optional(),
        grade: z.string().max(20).nullable().optional(),
        estimatedSeconds: z.number().int().min(5).max(1800).optional(),
        status: z.enum(['DRAFT', 'APPROVED', 'REJECTED']).optional(),
        reviewNote: z.string().max(1000).nullable().optional(),
        /** Let an admin clear the flag when they have drawn the figure by hand. */
        imageRequired: z.boolean().optional(),
      })
      .parse(request.body);

    const existing = await prisma.question.findFirst({ where: { id, deletedAt: null } });
    if (!existing) return reply.code(404).send({ error: 'Question not found.' });

    // A question on a live or already-sat paper is frozen; see liveTestLocks.
    const lock = await liveTestLock(id);
    if (lock) return reply.code(409).send({ error: `This question cannot be edited because ${lock}` });

    const format = body.format ?? existing.format;
    const data: Record<string, unknown> = { isAdminEdited: true };

    try {
      if (body.content !== undefined) data.content = normalizeContent(body.content);
      if (body.explanation !== undefined) {
        data.explanation = { version: 1, blocks: normalizeBlocks(body.explanation.blocks ?? []) };
      }
      if (body.options !== undefined) {
        data.options = body.options.map((o) => ({ id: o.id, blocks: normalizeBlocks(o.blocks) }));
      }
      if (body.answerKey !== undefined) data.answerKey = validateAnswerKey(format, body.answerKey);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Invalid question content.' });
    }

    // A changed key must still point at an option that exists.
    const options = (data.options ?? existing.options) as Array<{ id: string }>;
    const key = (data.answerKey ?? existing.answerKey) as Record<string, unknown>;
    if (format === 'MCQ_SINGLE' && !options.some((o) => o.id === key.correctOptionId)) {
      return reply.code(400).send({ error: `The answer key points at option "${key.correctOptionId}", which does not exist.` });
    }
    if (format === 'MCQ_MULTI') {
      const ids = (key.correctOptionIds as string[]) ?? [];
      const missing = ids.filter((i) => !options.some((o) => o.id === i));
      if (missing.length) return reply.code(400).send({ error: `The answer key points at option(s) ${missing.join(', ')}, which do not exist.` });
    }

    for (const field of ['format', 'difficultyTag', 'cognitiveTag', 'skillTags', 'subject', 'topic', 'subtopic', 'grade', 'estimatedSeconds', 'reviewNote', 'imageRequired'] as const) {
      if (body[field] !== undefined) data[field] = body[field];
    }

    // Same guard as the bulk route: never approve a question that is still
    // waiting for its picture.
    if (body.status !== undefined) {
      const needsImage = (body.imageRequired ?? existing.imageRequired) && !existing.imageFulfilled;
      if (body.status === 'APPROVED' && needsImage) {
        return reply.code(409).send({
          error: 'This question needs an image before it can be approved. Attach one, or clear the "image required" flag if you have drawn the figure yourself.',
        });
      }
      data.status = body.status;
    }

    const updated = await prisma.question.update({ where: { id }, data });
    await audit(request.user!.sub, 'question.update', { entity: 'Question', entityId: id, ip: request.ip });

    return { ok: true, question: updated };
  });

  /**
   * Deletes a question for good.
   *
   * The Rejected list is a bin, and a bin nobody can empty just becomes a
   * place where rubbish accumulates - so this really does remove the row.
   *
   * It is refused in exactly one case: the question has been answered by
   * somebody. Those answers are what a released result was computed from, and
   * deleting the question would leave marks that can no longer be explained.
   * A question merely sitting on an unsat paper is unlinked and then deleted,
   * because nothing has been computed from it yet.
   */
  app.delete('/api/admin/questions/:id', { preHandler: requirePermission('questions.review') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!(await mayTouch(request, id))) return reply.code(404).send({ error: 'Question not found.' });

    const question = await prisma.question.findUnique({
      where: { id },
      select: { id: true, status: true, _count: { select: { answers: true, testQuestions: true } } },
    });
    if (!question) return reply.code(404).send({ error: 'Question not found.' });

    // Refused outright while the paper it is on is live: unlinking it would
    // shorten an exam that students can see, mid-sitting.
    const lock = await liveTestLock(id);
    if (lock) return reply.code(409).send({ error: `This question cannot be deleted because ${lock}` });

    if (question._count.answers > 0) {
      await prisma.question.update({ where: { id }, data: { deletedAt: new Date(), status: 'REJECTED' } });
      await audit(request.user!.sub, 'question.retire', { entity: 'Question', entityId: id, ip: request.ip });
      return {
        ok: true,
        mode: 'soft',
        message:
          'Students have answered this question, so it has been retired rather than deleted - deleting it would ' +
          'leave marks in released results that could no longer be explained. It will never be served again.',
      };
    }

    // Unlink from any unsat paper first; the foreign key would otherwise
    // refuse the delete and the admin would see a database error.
    await prisma.$transaction([
      prisma.testQuestion.deleteMany({ where: { questionId: id } }),
      prisma.asset.deleteMany({ where: { questionId: id } }),
      prisma.question.delete({ where: { id } }),
    ]);

    await audit(request.user!.sub, 'question.delete', {
      entity: 'Question', entityId: id, ip: request.ip,
      detail: { unlinkedFrom: question._count.testQuestions },
    });
    return { ok: true, mode: 'hard' };
  });

  /**
   * Empties the Rejected list in one go.
   *
   * Rejected questions accumulate fast - a bad prompt produces twenty in one
   * run - and removing them one at a time is not a real option.
   */
  app.post('/api/admin/questions/purge-rejected', { preHandler: requirePermission('questions.review') }, async (request) => {
    const rejected = await prisma.question.findMany({
      where: { status: 'REJECTED', ...visibleToUser(request) },
      select: { id: true, _count: { select: { answers: true } } },
    });

    // Answered questions stay, so released marks remain explainable. So do any
    // still sitting on a live paper - possible only for a question rejected
    // before that freeze existed, but emptying the bin must not be the one way
    // round it.
    const locks = await liveTestLocks(rejected.map((q) => q.id));
    const deletable = rejected.filter((q) => q._count.answers === 0 && !locks.has(q.id)).map((q) => q.id);
    const kept = rejected.length - deletable.length;

    if (deletable.length) {
      await prisma.$transaction([
        prisma.testQuestion.deleteMany({ where: { questionId: { in: deletable } } }),
        prisma.asset.deleteMany({ where: { questionId: { in: deletable } } }),
        prisma.question.deleteMany({ where: { id: { in: deletable } } }),
      ]);
    }

    await audit(request.user!.sub, 'question.purge_rejected', {
      entity: 'Question', ip: request.ip, detail: { deleted: deletable.length, kept },
    });

    return {
      ok: true,
      deleted: deletable.length,
      kept,
      message: kept
        ? `Deleted ${deletable.length}. Kept ${kept} that students have already answered, so released results stay explainable.`
        : `Deleted ${deletable.length} rejected question${deletable.length === 1 ? '' : 's'}.`,
    };
  });
}
