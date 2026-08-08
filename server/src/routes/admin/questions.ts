import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { audit, requirePermission } from '../../middleware/auth.js';
import { normalizeContent, normalizeBlocks, blocksToText } from '../../lib/content.js';
import { validateAnswerKey } from '../../lib/grading.js';
import { importQuestions, runGeneration, buildUserPrompt } from '../../llm/generate.js';
import { IMPORT_TEMPLATE } from '../../llm/import-template.js';
import { LlmError, PROVIDERS } from '../../llm/providers.js';
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
 * The four places a question can be, as one exclusive set.
 *
 * "Approved" and "on a test" were the same status, so an approved question
 * that had been placed on a paper still sat in the approved list, and an
 * admin building a second paper could not tell what was already spoken for.
 *
 * Rather than store a fourth status - which would then have to be kept in step
 * with every add, remove, and test deletion, and would be wrong the moment it
 * was not - "on a test" is derived from the links themselves. A question is on
 * a test if some live test still references it; remove it from that test and
 * it returns to the approved list by itself, with nothing to reconcile.
 *
 * Links to deleted tests do not count: the paper is gone, the question is free.
 */
type QuestionBucket = 'DRAFT' | 'APPROVED' | 'ON_TEST' | 'REJECTED';

const ON_A_LIVE_TEST = { some: { test: { deletedAt: null } } };
const ON_NO_LIVE_TEST = { none: { test: { deletedAt: null } } };

function bucketWhere(bucket?: QuestionBucket) {
  switch (bucket) {
    case 'DRAFT':
      return { status: 'DRAFT' as const };
    case 'APPROVED':
      return { status: 'APPROVED' as const, testQuestions: ON_NO_LIVE_TEST };
    case 'ON_TEST':
      return { status: 'APPROVED' as const, testQuestions: ON_A_LIVE_TEST };
    case 'REJECTED':
      return { status: 'REJECTED' as const };
    default:
      return {};
  }
}

export default async function adminQuestionRoutes(app: FastifyInstance) {
  /** Everything the "Set test" screen needs to render its form. */
  app.get('/api/admin/generation/context', async () => {
    const [tags, credentials, templates, curriculum] = await Promise.all([
      prisma.tag.findMany({ where: { isActive: true }, orderBy: [{ axis: 'asc' }, { sortOrder: 'asc' }] }),
      prisma.apiCredential.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true, provider: true, label: true, baseUrl: true, keyHint: true, defaultModel: true },
      }),
      prisma.promptTemplate.findMany({
        where: { isActive: true },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        select: { id: true, name: true, description: true, kind: true, isDefault: true, systemPrompt: true, userTemplate: true },
      }),
      prisma.curriculumNode.findMany({
        where: { isActive: true },
        orderBy: [{ level: 'asc' }, { sortOrder: 'asc' }],
        select: { id: true, parentId: true, level: true, code: true, label: true, path: true, grade: true },
      }),
    ]);

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

  /** Generation history, so a bad batch can be diagnosed after the fact. */
  app.get('/api/admin/generation/runs', async (request) => {
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }).parse(request.query);

    const [total, runs] = await Promise.all([
      prisma.generationRun.count(),
      prisma.generationRun.findMany({
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
    const run = await prisma.generationRun.findUnique({
      where: { id },
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
        /**
         * Where the question sits, as one of four mutually exclusive places.
         * Preferred over `status`, which cannot express "approved but already
         * on a paper" - see bucketWhere.
         */
        bucket: z.enum(['DRAFT', 'APPROVED', 'ON_TEST', 'REJECTED']).optional(),
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

    const where = {
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
        // Which papers it is on, so the bank can say "on Maths Unit 1" rather
        // than leaving an approved question mysteriously absent from the
        // approved list.
        include: {
          testQuestions: {
            where: { test: { deletedAt: null } },
            select: { test: { select: { id: true, title: true, status: true } } },
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
        ...(q.status === 'REJECTED' || q.bucket === 'REJECTED' ? {} : { deletedAt: null }),
        ...(q.status ? { status: q.status } : {}),
        ...bucket,
      },
      _count: { _all: true },
      orderBy: { subject: 'asc' },
    });

    // Counts for the four tabs, so each one can show how much is waiting
    // without the UI fetching four pages to find out.
    const [draft, approved, onTest, rejected] = await Promise.all([
      prisma.question.count({ where: { deletedAt: null, ...bucketWhere('DRAFT') } }),
      prisma.question.count({ where: { deletedAt: null, ...bucketWhere('APPROVED') } }),
      prisma.question.count({ where: { deletedAt: null, ...bucketWhere('ON_TEST') } }),
      prisma.question.count({ where: bucketWhere('REJECTED') }),
    ]);

    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      questions: filtered,
      subjects: subjectRows.map((r) => ({ subject: r.subject, count: r._count._all })),
      counts: { DRAFT: draft, APPROVED: approved, ON_TEST: onTest, REJECTED: rejected },
    };
  });

  app.get('/api/admin/questions/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const question = await prisma.question.findFirst({ where: { id, deletedAt: null } });
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

    // A question that needs a picture cannot be approved until one is
    // attached, otherwise a student would sit a question they cannot answer.
    let blocked: string[] = [];
    let ids = body.ids;

    if (body.status === 'APPROVED') {
      const unfulfilled = await prisma.question.findMany({
        where: { id: { in: body.ids }, deletedAt: null, imageRequired: true, imageFulfilled: false },
        select: { id: true },
      });
      blocked = unfulfilled.map((q) => q.id);
      ids = body.ids.filter((id) => !blocked.includes(id));
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
      detail: { count: result.count, status: body.status, blocked: blocked.length, unlinkedFrom, keptOnSatTests },
    });

    const notes = [
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
      unlinkedFrom,
      keptOnSatTests,
      ...(blocked.length
        ? {
            message:
              blocked.length === 1
                ? '1 question still needs an image before it can be approved. Attach the image first.'
                : `${blocked.length} questions still need an image before they can be approved. Attach the images first.`,
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
    const body = z
      .object({
        assetId: z.string().uuid(),
        altText: z.string().max(500).optional(),
        caption: z.string().max(500).optional(),
      })
      .parse(request.body);

    const question = await prisma.question.findFirst({ where: { id, deletedAt: null } });
    if (!question) return reply.code(404).send({ error: 'Question not found.' });

    const asset = await prisma.asset.findUnique({ where: { id: body.assetId } });
    if (!asset) return reply.code(400).send({ error: 'That image has not been uploaded yet.' });

    const spec = (question.imagePrompt ?? {}) as { placement?: string; optionId?: string; altText?: string };
    const alt = body.altText ?? spec.altText ?? '';
    const imageBlock = { type: 'image' as const, assetId: body.assetId, alt, ...(body.caption ? { caption: body.caption } : {}) };

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
  app.get('/api/admin/questions/awaiting-images', async (request) => {
    const q = z.object({ generationRunId: z.string().uuid().optional() }).parse(request.query);

    const questions = await prisma.question.findMany({
      where: {
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

  /** Full edit of a draft question, including its diagram blocks. */
  app.patch('/api/admin/questions/:id', { preHandler: requirePermission('questions.review') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
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

    const question = await prisma.question.findUnique({
      where: { id },
      select: { id: true, status: true, _count: { select: { answers: true, testQuestions: true } } },
    });
    if (!question) return reply.code(404).send({ error: 'Question not found.' });

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
      where: { status: 'REJECTED' },
      select: { id: true, _count: { select: { answers: true } } },
    });

    const deletable = rejected.filter((q) => q._count.answers === 0).map((q) => q.id);
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
