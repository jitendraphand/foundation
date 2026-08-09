import { z } from 'zod';
import { prisma } from '../db.js';
import { callParamsFor, type CallParams } from './credentials.js';
import { normalizeContent, normalizeBlocks, blocksToText, CONTENT_VERSION, type Block } from '../lib/content.js';
import { checkDiagram, type DiagramProblem } from '../lib/diagram.js';
import { pictureRequestFor } from './images.js';
import { validateAnswerKey } from '../lib/grading.js';
import { chatComplete, emitsReasoning, LlmError, PROVIDERS, type ChatMessage, type ChatRequest } from './providers.js';
import { chatWithFallback, ProviderChainError } from './resilience.js';
import { ceilingFromError, rememberCeiling, resolveCeiling } from './limits.js';
import { capabilitiesOf } from './capabilities.js';
import { extractJson, llmResponseSchema, llmQuestionSchema, describeIssues, type LlmQuestion } from './schema.js';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_TEMPLATE, PRACTICE_SYSTEM_SUFFIX, renderTemplate } from './prompts.js';
import type { TestKind, QuestionStatus } from '@prisma/client';

export interface GenerateSpec {
  subject: string;
  topic?: string;
  subtopic?: string;
  grade?: string;
  count: number;
  marksPerQuestion: number;
  difficultyMix?: Record<string, number>;
  cognitiveMix?: Record<string, number>;
  skillFocus?: string[];
  formats?: string[];
  extraInstructions?: string;
  /** When true, tell the model not to produce questions needing a photograph. */
  avoidImages?: boolean;
}

export interface GenerateOptions {
  requestedById: string;
  /** The provider is read from the credential, never trusted from the client. */
  model: string;
  credentialId: string;
  systemPrompt?: string;
  userPrompt?: string;
  promptTemplateId?: string;
  spec: GenerateSpec;
  kind: TestKind;
  targetUserId?: string;
  temperature?: number;
}

export interface GenerateOutcome {
  runId: string;
  accepted: number;
  parsed: number;
  /** How many of the accepted questions still need a picture attaching. */
  needingImages: number;
  rejected: Array<{ index: number; reason: string }>;
  warnings: string[];
}

function describeMix(mix: Record<string, number> | undefined, fallback: string): string {
  if (!mix || Object.keys(mix).length === 0) return fallback;
  return Object.entries(mix)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(', ');
}

export function buildUserPrompt(spec: GenerateSpec, template = DEFAULT_USER_TEMPLATE): string {
  const extra = [
    spec.extraInstructions ?? '',
    spec.avoidImages
      ? 'Do NOT produce any question that needs a real photograph. Every visual must be drawn as SVG, Mermaid or a chart spec. Set "imageRequired": false on every question.'
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return renderTemplate(template, {
    count: spec.count,
    subject: spec.subject,
    topic: spec.topic || 'any appropriate topic within the subject',
    subtopic: spec.subtopic || 'any appropriate subtopic',
    grade: spec.grade || 'unspecified',
    marksPerQuestion: spec.marksPerQuestion,
    difficultyMix: describeMix(spec.difficultyMix, 'a balanced spread of easy, medium and hard'),
    cognitiveMix: describeMix(spec.cognitiveMix, 'a balanced spread across the cognitive levels'),
    formats: spec.formats?.length ? spec.formats.join(', ') : 'MCQ_SINGLE',
    skillFocus: spec.skillFocus?.length ? spec.skillFocus.join(', ') : 'any relevant skills',
    extraInstructions: extra,
  });
}

/**
 * The order to try providers in, when the chosen one will not answer.
 *
 * The administrator's choice always goes first and is never skipped - a
 * fallback is a way to finish a run that would otherwise be lost, not a
 * licence to quietly spend money somewhere else.
 *
 * After that, only credentials explicitly marked as fallbacks are used, in the
 * order they were added. Left unmarked, nothing happens: an admin using a paid
 * key and a free one would be very surprised to find a rate limit on the free
 * one silently billed to the paid account.
 *
 * Each candidate keeps its own model, because a model id is provider-specific
 * - "gpt-4.1" means nothing to Bedrock - and the credential's default is the
 * only sensible choice on a provider the admin did not pick.
 */
async function buildCandidates(
  chosen: { id: string; label: string },
  model: string,
  call: CallParams,
): Promise<Array<{ label: string; model: string; call: Omit<ChatRequest, 'model' | 'messages'> }>> {
  const candidates = [{ label: chosen.label, model, call }];

  const fallbacks = await prisma.apiCredential.findMany({
    where: { isActive: true, id: { not: chosen.id }, meta: { path: ['useAsFallback'], equals: true } },
    orderBy: { createdAt: 'asc' },
  });

  for (const credential of fallbacks) {
    // A fallback with no default model has nothing usable to call, and one kept
    // only for drawing pictures cannot write a question.
    if (!credential.defaultModel) continue;
    if (!capabilitiesOf(credential).text) continue;
    try {
      candidates.push({
        label: credential.label,
        model: credential.defaultModel,
        call: await callParamsFor(credential),
      });
    } catch {
      // A fallback that cannot even be unpacked - a Vertex token exchange that
      // fails, say - is skipped rather than breaking the run it was meant to
      // rescue.
    }
  }

  return candidates;
}

/**
 * Puts each supplied tag on the axis it actually belongs to.
 *
 * Models mix up the cognitive and skill axes constantly - they are two
 * adjacent taxonomies of "what this question is like", and no amount of
 * prompt wording stops it. A typical batch arrives with
 *
 *   cognitiveTag: "spatial_visual"      (a skill)
 *   skillTags:    ["conceptual"]        (a cognitive level)
 *
 * Both codes are real and both are correct - they are simply in each other's
 * field. Rejecting those questions threw away good work over a filing error,
 * which is what turned a batch of twelve into six.
 *
 * So every supplied code goes into one pool and is dealt back out to the axis
 * whose vocabulary contains it, keeping whatever was already in the right
 * place. A code that belongs to no axis at all is still an error: that is a
 * model inventing vocabulary, not misfiling it, and silently guessing a tag
 * would corrupt the weak-area reports these feed.
 */
function sortTagsIntoAxes(
  q: Pick<LlmQuestion, 'difficultyTag' | 'cognitiveTag' | 'skillTags'>,
  valid: ValidTags,
): { difficultyTag: string; cognitiveTag: string; skills: string[]; moved: boolean } {
  const pool = [q.difficultyTag, q.cognitiveTag, ...q.skillTags].map((t) => t.trim()).filter(Boolean);

  const pickOne = (supplied: string, vocabulary: Set<string>): string | undefined =>
    vocabulary.has(supplied) ? supplied : pool.find((t) => vocabulary.has(t));

  const difficultyTag = pickOne(q.difficultyTag, valid.difficulty);
  const cognitiveTag = pickOne(q.cognitiveTag, valid.cognitive);

  const ownSkills = q.skillTags.filter((s) => valid.skill.has(s));
  // Deduplicated: a code can only be dealt to one axis, but the model may have
  // repeated it across two.
  const skills = ownSkills.length ? [...new Set(ownSkills)] : [...new Set(pool.filter((t) => valid.skill.has(t)))];

  const unknown = (name: string, vocabulary: Set<string>) =>
    new Error(
      `no usable ${name} in [${pool.join(', ')}] - expected one of: ${[...vocabulary].sort().join(', ')}`,
    );

  if (!difficultyTag) throw unknown('difficultyTag', valid.difficulty);
  if (!cognitiveTag) throw unknown('cognitiveTag', valid.cognitive);
  if (skills.length === 0) throw unknown('skillTags', valid.skill);

  const moved =
    difficultyTag !== q.difficultyTag ||
    cognitiveTag !== q.cognitiveTag ||
    skills.length !== ownSkills.length;

  return { difficultyTag, cognitiveTag, skills, moved };
}

/**
 * A second attempt at the questions that parsed but were unusable.
 *
 * Deliberately one round and one call: the batch already cost several, and a
 * question the model cannot fix when told exactly what is wrong with it is not
 * going to come good on the third ask. Anything still failing is reported
 * unchanged, so this can only ever add questions, never lose them.
 */
async function repairRejected(args: {
  call: CallParams;
  opts: GenerateOptions;
  providerDef: { supportsJsonMode: boolean; maxOutputTokens?: number };
  systemPrompt: string;
  questions: LlmQuestion[];
  rejected: Array<{ index: number; reason: string }>;
  ctx: Parameters<typeof toQuestionRow>[1];
  tokensPerQuestion: number;
}): Promise<{
  rows: ReturnType<typeof toQuestionRow>[];
  stillRejected: Array<{ index: number; reason: string }>;
  attempts: number;
  latencyMs: number;
}> {
  const { rejected, questions } = args;
  const nothing = { rows: [], stillRejected: rejected, attempts: 0, latencyMs: 0 };

  // Beyond this the prompt is longer than the batch that produced it, and the
  // reply is more likely to be truncated than correct.
  if (rejected.length > 20) return nothing;

  const listing = rejected
    .map((r, i) => `--- Question ${i + 1}\nProblem: ${r.reason}\nYour JSON:\n${JSON.stringify(questions[r.index])}`)
    .join('\n\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: args.systemPrompt },
    {
      role: 'user',
      content:
        `${rejected.length} of the questions you produced were rejected. Each is listed below with the exact ` +
        `reason and the JSON you sent.\n\n${listing}\n\n` +
        'Fix ONLY the stated problem in each. Keep the question, the options and the answer entirely as they are - ' +
        'this is a metadata correction, not a rewrite. Use only codes from the TAG VOCABULARY above.\n' +
        `Return {"questions": [...]} containing all ${rejected.length} corrected questions in the same order. ` +
        'Output only the JSON object, no fences and no commentary.',
    },
  ];

  let response;
  try {
    response = await chatComplete({
      ...args.call,
      model: args.opts.model,
      messages,
      temperature: 0.1,
      jsonMode: args.providerDef.supportsJsonMode,
      maxTokens: tokenBudget(args.tokensPerQuestion, rejected.length, args.providerDef.maxOutputTokens),
    });
  } catch {
    // The repair is a bonus, never a reason to fail a run that produced work.
    return nothing;
  }

  let corrected: LlmQuestion[];
  try {
    corrected = llmResponseSchema.parse(extractJson(response.text)).questions;
  } catch {
    return { ...nothing, attempts: 1, latencyMs: response.latencyMs };
  }

  const rows: ReturnType<typeof toQuestionRow>[] = [];
  const stillRejected: Array<{ index: number; reason: string }> = [];

  rejected.forEach((original, i) => {
    const fixed = corrected[i];
    if (!fixed) return stillRejected.push(original);
    try {
      rows.push(toQuestionRow(fixed, args.ctx));
    } catch (err) {
      // Report the original complaint, not the repair's: the admin cares what
      // was wrong with the question, not that a retry also failed.
      stillRejected.push(original);
      void err;
    }
  });

  return { rows, stillRejected, attempts: 1, latencyMs: response.latencyMs };
}

/**
 * Throws away a drawing that is definitively not what the question describes,
 * and asks for a real picture in its place.
 *
 * A weaker model returns syntactically perfect nonsense: one diagonal stroke
 * captioned "Similar Triangles ABC and DEF", or a triangle with no vertex
 * labelled in a question that names A, B and C. The markup is valid, so
 * nothing rejected it, and it reached a child as a question that cannot be
 * answered from the picture in front of them.
 *
 * The question itself is kept. Only the drawing is dropped, and the question
 * is marked as needing a picture - which puts it in front of an administrator
 * on the review screen with the brief already written, where they can edit the
 * wording, generate a real image, or draw it again. Rejecting the whole
 * question instead would throw away a good stem over a bad sketch.
 */
function vetDiagrams(blocks: Block[], stemText: string): { blocks: Block[]; problems: DiagramProblem[]; brief: Block | null } {
  const problems: DiagramProblem[] = [];
  let brief: Block | null = null;
  const kept = blocks.filter((block) => {
    const problem = checkDiagram(block, stemText);
    if (!problem) return true;
    problems.push(problem);
    // The first casualty is the one whose brief becomes the picture request;
    // a question with two broken figures is beyond automatic rescue anyway.
    if (!brief) brief = block;
    return false;
  });
  return { blocks: kept, problems, brief };
}

/**
 * Converts one validated LLM question into the row shape, re-validating the
 * answer key against the declared format and sanitising every SVG on the way
 * in. Throws with a human-readable reason, which is surfaced per-question to
 * the admin rather than failing the whole batch.
 */
function toQuestionRow(
  q: LlmQuestion,
  ctx: {
    runId: string;
    model: string;
    createdById: string;
    validTags: ValidTags;
    retagged: { count: number };
    badDiagrams?: { count: number };
  },
) {
  // Tags must exist in the vocabulary, otherwise analytics silently splits into
  // buckets nobody ever looks at. Misfiled ones are moved to the axis they
  // belong to first; see sortTagsIntoAxes.
  const { difficultyTag, cognitiveTag, skills, moved } = sortTagsIntoAxes(q, ctx.validTags);
  if (moved) ctx.retagged.count++;

  const normalized = normalizeContent({ version: CONTENT_VERSION, blocks: q.content.blocks });

  // Drawings are vetted against the question's own words, so a figure that
  // does not contain what the stem refers to never reaches a student.
  const vetted = vetDiagrams(normalized.blocks, blocksToText(normalized.blocks));
  if (vetted.problems.length > 0 && ctx.badDiagrams) ctx.badDiagrams.count++;
  if (vetted.blocks.length === 0) {
    throw new Error(`${vetted.problems[0].reason}, and the question is nothing but that drawing`);
  }
  const content = { version: CONTENT_VERSION, blocks: vetted.blocks };

  const options = q.options.map((o) => ({ id: o.id, blocks: normalizeBlocks(o.blocks) }));

  if (options.length < 2) throw new Error('multiple-choice question has fewer than 2 options');
  const ids = new Set(options.map((o) => o.id));
  if (ids.size !== options.length) throw new Error('duplicate option ids');

  // Throws if the key does not match the declared format.
  const answerKey = validateAnswerKey(q.format, q.answerKey);

  // The key must point at options that actually exist.
  if (q.format === 'MCQ_SINGLE') {
    const id = (answerKey as { correctOptionId: string }).correctOptionId;
    if (!options.some((o) => o.id === id)) throw new Error(`answer key names option "${id}" which does not exist`);
  }
  if (q.format === 'MCQ_MULTI') {
    const correctIds = (answerKey as { correctOptionIds: string[] }).correctOptionIds;
    for (const id of correctIds) {
      if (!options.some((o) => o.id === id)) throw new Error(`answer key names option "${id}" which does not exist`);
    }
    if (correctIds.length < 2) {
      throw new Error('multi-select question has only one correct option - it should be MCQ_SINGLE');
    }
    if (correctIds.length >= options.length) {
      throw new Error('every option is marked correct, which makes the question meaningless');
    }
  }

  // A question flagged as needing a picture is useless without the prompt to
  // generate one, so reject it rather than let it into the review queue.
  let imageRequired = q.imageRequired;
  let imagePrompt: object | null = null;
  if (q.imageRequired) {
    if (!q.imagePrompt) {
      throw new Error('imageRequired is true but no imagePrompt was supplied');
    }
    if (q.imagePrompt.placement === 'OPTION') {
      const target = q.imagePrompt.optionId;
      if (!target || !options.some((o) => o.id === target)) {
        throw new Error(`imagePrompt targets option "${target ?? '(none)'}" which does not exist`);
      }
    }
    imagePrompt = q.imagePrompt as object;
  }

  // The figure this question needed has just been thrown away. Turn its brief
  // into a picture request so the gap is visible and fillable, rather than the
  // question quietly arriving without the thing it refers to.
  if (!imageRequired && vetted.brief) {
    imagePrompt = pictureRequestFor(vetted.brief, blocksToText(vetted.blocks)) as object;
    imageRequired = true;
  }

  const explanation = q.explanation?.blocks?.length
    ? { version: CONTENT_VERSION, blocks: normalizeBlocks(q.explanation.blocks) }
    : { version: CONTENT_VERSION, blocks: [] };

  return {
    status: 'DRAFT' as QuestionStatus,
    format: q.format,
    content: content as object,
    options: options as object,
    answerKey: answerKey as object,
    explanation: explanation as object,
    difficultyTag,
    cognitiveTag,
    skillTags: skills,
    subject: q.subject,
    topic: q.topic ?? null,
    subtopic: q.subtopic ?? null,
    estimatedSeconds: q.estimatedSeconds,
    imageRequired,
    imagePrompt,
    imageFulfilled: false,
    generationRunId: ctx.runId,
    createdById: ctx.createdById,
    sourceModel: ctx.model,
  };
}

interface ValidTags {
  difficulty: Set<string>;
  cognitive: Set<string>;
  skill: Set<string>;
}

async function loadValidTags(): Promise<ValidTags> {
  const tags = await prisma.tag.findMany({ where: { isActive: true }, select: { axis: true, code: true } });
  return {
    difficulty: new Set(tags.filter((t) => t.axis === 'DIFFICULTY').map((t) => t.code)),
    cognitive: new Set(tags.filter((t) => t.axis === 'COGNITIVE').map((t) => t.code)),
    skill: new Set(tags.filter((t) => t.axis === 'SKILL').map((t) => t.code)),
  };
}

/**
 * How many questions to ask for in a single call to the model.
 *
 * Not a matter of taste: a batch has to fit in the model's output budget, and
 * a question with worked explanations and diagram source runs to well over a
 * thousand tokens. Ask for forty in one go and the reply is truncated
 * mid-JSON, which surfaces as "the model did not return questions in the
 * required format" - which is true, but blames the wrong thing.
 *
 * Ten is comfortable for every provider here. Larger requests are split.
 */
const QUESTIONS_PER_CALL = 10;

/**
 * A one-line summary of a question, used to tell a later batch what has
 * already been written so it does not produce the same thing again.
 */
function firstLineOf(question: { content?: { blocks?: Array<Record<string, unknown>> } }): string {
  const blocks = question.content?.blocks ?? [];
  const text = blocks.find((b) => b.type === 'text')?.value;
  const line = typeof text === 'string' ? text : JSON.stringify(blocks[0] ?? {});
  return line.replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * How many questions one call may ask for, given what the provider will let us
 * request as a completion.
 *
 * Ten is comfortable where the ceiling is generous. Oracle Cloud caps a
 * completion at 4096 tokens and rejects anything larger outright, which at
 * ~1400 tokens a question is two - so on OCI a run is more, smaller calls
 * rather than one that fails.
 *
 * Clamping the token request alone would be worse than useless: the call would
 * succeed and the reply would be cut off mid-JSON, turning a clear 400 into
 * "the model did not return questions in the required format", which blames
 * the model for our arithmetic.
 */
export function questionsPerCall(tokensPerQuestion: number, maxOutputTokens?: number): number {
  if (!maxOutputTokens) return QUESTIONS_PER_CALL;
  // A little headroom for the JSON envelope around the questions themselves.
  const usable = Math.floor(maxOutputTokens * 0.9);
  return Math.max(1, Math.min(QUESTIONS_PER_CALL, Math.floor(usable / tokensPerQuestion)));
}

/** The completion size to ask for, never above what the provider accepts. */
export function tokenBudget(tokensPerQuestion: number, count: number, maxOutputTokens?: number): number {
  const wanted = tokensPerQuestion * Math.max(1, count);
  return Math.min(wanted, maxOutputTokens ?? 32_000, 32_000);
}

/** Splits a total into batches of at most QUESTIONS_PER_CALL. */
export function planBatches(total: number, per = QUESTIONS_PER_CALL): number[] {
  const batches: number[] = [];
  let left = Math.max(1, total);
  while (left > 0) {
    batches.push(Math.min(per, left));
    left -= per;
  }
  return batches;
}

/**
 * The ceiling a provider just told us about, if that is what went wrong.
 *
 * Only the administrator's own credential is read, never a fallback's: the
 * number is stored against that credential and against that model, and a
 * ceiling learned from whatever rescued the batch would be attached to the
 * wrong provider entirely.
 */
function learnedCeilingFrom(err: unknown, ownLabel: string, asked: number): number | undefined {
  if (err instanceof ProviderChainError) {
    const own = err.notes.filter((n) => n.credentialLabel === ownLabel);
    for (const note of own) {
      const ceiling = ceilingFromError(note.cause, asked);
      if (ceiling) return ceiling;
    }
    return undefined;
  }
  return ceilingFromError(err, asked);
}

/**
 * How many times one run may shrink its batches before giving up.
 *
 * Three is generous: each shrink follows a refusal that named an exact number,
 * so the first is nearly always the last. The bound exists so that a provider
 * returning a nonsensical ceiling - or the same one repeatedly - ends as a
 * clear failure rather than an endless loop of ever-smaller requests.
 */
const MAX_CEILING_SHRINKS = 3;

/**
 * How long a run may sit as RUNNING before it is assumed dead.
 *
 * A run is many sequential calls and a large one legitimately takes a while, so
 * this is generous. What it catches is the run whose process is gone: the API
 * container restarted mid-generation - a deploy, a crash, an out-of-memory -
 * and nothing is left to write the final status. Those otherwise show as
 * "running" for ever, and an admin waiting for one has no way to tell.
 */
const RUN_ASSUMED_DEAD_MS = 2 * 60 * 60 * 1000;

/**
 * Closes off runs that can no longer finish.
 *
 * Safe to call at any time, including while a slow run is genuinely still
 * going: that run writes its own status when it completes, and overwrites this.
 * Cheap enough to do on every history fetch, which is what makes it
 * self-healing rather than another thing to remember.
 */
export async function sweepAbandonedRuns(): Promise<number> {
  const result = await prisma.generationRun.updateMany({
    where: { status: 'RUNNING', createdAt: { lt: new Date(Date.now() - RUN_ASSUMED_DEAD_MS) } },
    data: {
      status: 'FAILED',
      completedAt: new Date(),
      errorMessage:
        'The server restarted while this run was in progress, so it could not be finished. Any questions it had ' +
        'already produced are in the question bank; run it again for the rest.',
    },
  });
  return result.count;
}

/**
 * Runs one generation. Questions land as DRAFT; nothing reaches a student
 * until an admin approves it and places it on a test.
 *
 * Deliberately not tied to the HTTP request that started it. Closing the tab,
 * navigating away or signing out does not cancel anything: the run continues,
 * the questions land in the bank, and the outcome is on the run itself. Losing
 * a batch because somebody switched tabs to check a timetable would be a
 * miserable way to waste a paid API call.
 *
 * A request for more questions than fit in one reply is split into several
 * calls behind a single run, so the admin asks for fifty and gets fifty
 * rather than an unexplained format error.
 */
export async function runGeneration(opts: GenerateOptions): Promise<GenerateOutcome> {
  const credential = await prisma.apiCredential.findUnique({ where: { id: opts.credentialId } });
  if (!credential || !credential.isActive) {
    throw new LlmError('That API credential no longer exists or has been disabled.');
  }

  const call = await callParamsFor(credential);
  const providerDef = PROVIDERS[credential.provider] ?? PROVIDERS.custom;

  // The chosen credential first, then whatever else is available, so a free
  // endpoint that rate-limits mid-run does not lose the whole batch. See
  // buildCandidates for why the order is what it is.
  const candidates = await buildCandidates(credential, opts.model, call);

  let systemPrompt = opts.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
  if (opts.kind === 'PRACTICE') systemPrompt += PRACTICE_SYSTEM_SUFFIX;

  // A model that thinks out loud spends output tokens before it writes a word
  // of the answer, so it needs a bigger budget for the same number of
  // questions.
  const tokensPerQuestion = emitsReasoning(opts.model) ? 2600 : 1400;

  // What this provider will actually accept decides the batch size, not the
  // other way round. Both can change mid-run: a refusal that names the real
  // ceiling is believed immediately and the remaining batches are re-planned
  // around it. See limits.ts.
  let ceiling = resolveCeiling(credential, opts.model);
  let perCall = questionsPerCall(tokensPerQuestion, ceiling);
  const batches = planBatches(opts.spec.count, perCall);

  const run = await prisma.generationRun.create({
    data: {
      status: 'RUNNING',
      requestedById: opts.requestedById,
      provider: credential.provider,
      model: opts.model,
      promptTemplateId: opts.promptTemplateId ?? null,
      systemPrompt,
      userPrompt: buildUserPrompt({ ...opts.spec, count: batches[0] }),
      requestSpec: opts.spec as object,
      kind: opts.kind,
      targetUserId: opts.targetUserId ?? null,
      questionsRequested: opts.spec.count,
    },
  });

  const warnings: string[] = [];
  if (batches.length > 1) {
    warnings.push(
      `Asked for ${opts.spec.count} questions in ${batches.length} calls of at most ${perCall}, ` +
        'because one reply cannot hold that many.',
    );
  }

  try {
    const collected: z.infer<typeof llmResponseSchema>['questions'] = [];
    let rawText = '';
    let attempts = 0;
    let latencyMs = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let lastError = '';

    // A queue rather than a fixed list, because the batch size is not fixed:
    // a provider that refuses the request and names its real ceiling causes
    // everything still to be written to be re-planned around that number. See
    // MAX_CEILING_SHRINKS.
    let remaining = opts.spec.count;
    let batchIndex = 0;
    let shrinks = 0;

    while (remaining > 0) {
      const batchCount = Math.min(perCall, remaining);
      const isLastBatch = remaining - batchCount === 0;
      const totalBatches = batchIndex + Math.ceil(remaining / perCall);

      // Each call asks only for its own share, and is told what has already
      // been written so the batches do not repeat each other.
      const batchPrompt =
        (opts.userPrompt?.trim() || buildUserPrompt({ ...opts.spec, count: batchCount })) +
        (batchIndex > 0
          ? `\n\nThis is part ${batchIndex + 1} of ${totalBatches} for the same paper. ` +
            `Write ${batchCount} FURTHER questions. Do not repeat any of these, which are already written:\n` +
            collected.map((q, i) => `${i + 1}. ${firstLineOf(q)}`).join('\n')
          : '');

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: batchPrompt },
      ];

      const asked = tokenBudget(tokensPerQuestion, batchCount, ceiling);
      const shared = {
        temperature: opts.temperature ?? 0.4,
        jsonMode: providerDef.supportsJsonMode,
        maxTokens: asked,
      };

      let first;
      try {
        first = await chatWithFallback(messages, {
          candidates: candidates.map((c) => ({ ...c, call: { ...c.call, ...shared } })),
          onRetry: (note) =>
            warnings.push(
              `${note.credentialLabel} was busy on batch ${batchIndex + 1} (${note.error.slice(0, 90)}). ` +
                `Waiting ${Math.round((note.waitedMs ?? 0) / 1000)}s and trying again.`,
            ),
        });
      } catch (err) {
        // "That completion is bigger than I allow" is the one failure worth
        // acting on rather than reporting: the provider has just told us the
        // number it does allow, so believe it, remember it and try the same
        // batch again in pieces that fit.
        const learned = learnedCeilingFrom(err, credential.label, asked);
        if (learned && shrinks < MAX_CEILING_SHRINKS && (ceiling === undefined || learned < ceiling)) {
          shrinks++;
          ceiling = learned;
          perCall = questionsPerCall(tokensPerQuestion, ceiling);
          // Stored so the next run starts correct instead of paying for this
          // discovery again. Never allowed to fail the run it was meant to
          // rescue.
          await rememberCeiling(credential.id, opts.model, learned).catch(() => undefined);
          warnings.push(
            `${credential.label} accepts at most ${learned} tokens in one reply, which is fewer than this batch ` +
              `needed. Continuing in calls of ${perCall} question${perCall === 1 ? '' : 's'}, and remembering the ` +
              'limit so the next run starts this way.',
          );
          continue;
        }
        throw err;
      }

      let response = first.response;
      if (first.usedLabel !== credential.label) {
        warnings.push(`Batch ${batchIndex + 1} fell back to ${first.usedLabel} (${first.usedModel}).`);
      }

      rawText = response.text;
      attempts++;
      latencyMs += response.latencyMs;
      promptTokens += response.promptTokens ?? 0;
      completionTokens += response.completionTokens ?? 0;

      let parsedBatch: z.infer<typeof llmResponseSchema> | null = null;

      // Up to two repair rounds. Sending the model its own validation errors is
      // dramatically more effective than simply retrying the same prompt.
      for (let round = 0; round < 3; round++) {
        try {
          const json = extractJson(rawText);
          parsedBatch = llmResponseSchema.parse(json);
          break;
        } catch (err) {
          lastError =
            err instanceof z.ZodError ? describeIssues(err) : err instanceof Error ? err.message : String(err);

          if (round === 2) break;

          warnings.push(
            `Batch ${batchIndex + 1}, repair round ${round + 1}: the model's reply did not match the contract.`,
          );
          messages.push({ role: 'assistant', content: rawText.slice(0, 12_000) });
          messages.push({
            role: 'user',
            content:
              `Your reply did not satisfy the required JSON contract. Problems found:\n${lastError}\n\n` +
              `Return the corrected, complete JSON object now. Output only the JSON object, no fences and no commentary.`,
          });

          response = (
            await chatWithFallback(messages, {
              candidates: candidates.map((c) => ({
                ...c,
                call: {
                  ...c.call,
                  temperature: 0.1,
                  jsonMode: providerDef.supportsJsonMode,
                  maxTokens: tokenBudget(tokensPerQuestion, batchCount, ceiling),
                },
              })),
            })
          ).response;
          rawText = response.text;
          attempts++;
          latencyMs += response.latencyMs;
        }
      }

      if (parsedBatch) {
        collected.push(...parsedBatch.questions);
      } else if (collected.length === 0 && isLastBatch) {
        // Nothing usable from any batch: fail, with the model's own reply kept
        // for diagnosis.
        await prisma.generationRun.update({
          where: { id: run.id },
          data: {
            status: 'FAILED',
            rawResponse: rawText.slice(0, 100_000),
            errorMessage: `Could not obtain a valid response after ${attempts} attempts.\n${lastError}`,
            parseAttempts: attempts,
            completedAt: new Date(),
            latencyMs,
          },
        });
        throw new LlmError(
          `The model did not return questions in the required format after ${attempts} attempts. ` +
            `Open the run in Admin > Generation history to see its raw reply. Last problem:\n${lastError}`,
        );
      } else {
        // One batch of several failed. Keep what the others produced and say
        // so, rather than throwing away good questions.
        warnings.push(`Batch ${batchIndex + 1} produced nothing usable: ${lastError}`);
      }

      batchIndex++;
      remaining -= batchCount;
    }

    const parsedResponse = { questions: collected };

    const validTags = await loadValidTags();
    const retagged = { count: 0 };
    const badDiagrams = { count: 0 };
    const rejected: Array<{ index: number; reason: string }> = [];
    const rows: ReturnType<typeof toQuestionRow>[] = [];

    parsedResponse.questions.forEach((q, index) => {
      try {
        rows.push(toQuestionRow(q, { runId: run.id, model: opts.model, createdById: opts.requestedById, validTags, retagged, badDiagrams }));
      } catch (err) {
        rejected.push({ index, reason: err instanceof Error ? err.message : String(err) });
      }
    });

    // One more round for the ones that failed. The schema-level repair above
    // only fires when the whole reply is malformed; a question that parses but
    // is unusable - a tag that is not in the vocabulary, an answer key naming
    // an option that does not exist - never got a second chance, and those are
    // the failures an admin actually sees. Sending the model its own question
    // back with the specific complaint fixes most of them, and the ones it
    // cannot fix are reported exactly as before.
    if (rejected.length > 0) {
      const recovered = await repairRejected({
        call,
        opts,
        // Whatever the run finished on, which may be lower than where it
        // started if a provider refused a batch along the way.
        providerDef: { supportsJsonMode: providerDef.supportsJsonMode, maxOutputTokens: ceiling },
        systemPrompt,
        questions: parsedResponse.questions,
        rejected,
        ctx: { runId: run.id, model: opts.model, createdById: opts.requestedById, validTags, retagged, badDiagrams },
        tokensPerQuestion,
      });
      if (recovered.rows.length > 0) {
        rows.push(...recovered.rows);
        attempts += recovered.attempts;
        latencyMs += recovered.latencyMs;
        warnings.push(
          `${recovered.rows.length} of ${rejected.length} rejected question${rejected.length === 1 ? '' : 's'} ` +
            'were recovered by sending the model its own validation errors.',
        );
        // Keep only the ones still broken.
        rejected.splice(0, rejected.length, ...recovered.stillRejected);
      }
    }

    if (rows.length > 0) {
      await prisma.question.createMany({ data: rows as never });
    }

    await prisma.generationRun.update({
      where: { id: run.id },
      data: {
        status: rows.length > 0 ? 'SUCCEEDED' : 'FAILED',
        rawResponse: rawText.slice(0, 100_000),
        parseAttempts: attempts,
        promptTokens: promptTokens || null,
        completionTokens: completionTokens || null,
        latencyMs,
        questionsParsed: parsedResponse.questions.length,
        questionsAccepted: rows.length,
        errorMessage: rejected.length ? rejected.map((r) => `Q${r.index + 1}: ${r.reason}`).join('\n') : null,
        completedAt: new Date(),
      },
    });

    if (rows.length === 0) {
      throw new LlmError(
        `All ${parsedResponse.questions.length} questions failed validation:\n` +
          rejected.map((r) => `Q${r.index + 1}: ${r.reason}`).join('\n'),
      );
    }

    if (retagged.count > 0) {
      warnings.push(
        `Tags corrected on ${retagged.count} question${retagged.count === 1 ? '' : 's'}: the model put a skill on the ` +
          'cognitive axis, or the reverse. They were filed correctly rather than rejected.',
      );
    }

    if (badDiagrams.count > 0) {
      warnings.push(
        `${badDiagrams.count} question${badDiagrams.count === 1 ? "'s drawing was" : "s' drawings were"} discarded - ` +
          `${badDiagrams.count === 1 ? 'it did' : 'they did'} not show what the question describes. ` +
          `Those questions are marked as needing a picture, with the brief already written.`,
      );
    }

    const needingImages = rows.filter((r) => r.imageRequired).length;

    return {
      runId: run.id,
      accepted: rows.length,
      parsed: parsedResponse.questions.length,
      needingImages,
      rejected,
      warnings,
    };
  } catch (err) {
    if (!(err instanceof LlmError)) {
      await prisma.generationRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          errorMessage: err instanceof Error ? err.message : String(err),
          completedAt: new Date(),
        },
      }).catch(() => undefined);
    }
    throw err;
  }
}

export { llmQuestionSchema };

// --- Importing questions from a file ---------------------------------------

export interface ImportOutcome {
  runId: string;
  accepted: number;
  parsed: number;
  needingImages: number;
  rejected: Array<{ index: number; reason: string }>;
  warnings: string[];
}

/**
 * Loads questions from a JSON document instead of a model.
 *
 * The fallback for the day the API key has run out, the provider is down, or
 * the school's connection is not working - which, in a building where the
 * exam is at nine tomorrow, is the day it matters. The document uses exactly
 * the format the model is asked to produce, so a reply captured from anywhere
 * can be pasted in, and every question goes through the same validation:
 * tag vocabulary, answer keys pointing at options that exist, SVG
 * sanitisation. Nothing skips review - imported questions land as drafts.
 */
export async function importQuestions(opts: {
  requestedById: string;
  payload: unknown;
  sourceLabel?: string;
}): Promise<ImportOutcome> {
  let parsedResponse: z.infer<typeof llmResponseSchema>;
  try {
    parsedResponse = llmResponseSchema.parse(extractJson(
      typeof opts.payload === 'string' ? opts.payload : JSON.stringify(opts.payload),
    ));
  } catch (err) {
    const detail = err instanceof z.ZodError ? describeIssues(err) : err instanceof Error ? err.message : String(err);
    throw new LlmError(`That file is not in the expected format.\n${detail}`);
  }

  const run = await prisma.generationRun.create({
    data: {
      status: 'RUNNING',
      requestedById: opts.requestedById,
      // Recorded as a run so imported questions are traceable and filterable
      // in exactly the same way as generated ones.
      provider: 'import',
      model: opts.sourceLabel?.slice(0, 200) || 'json-upload',
      systemPrompt: '',
      userPrompt: '',
      requestSpec: { source: 'json-import' } as object,
      kind: 'REGULAR',
      questionsRequested: parsedResponse.questions.length,
    },
  });

  const validTags = await loadValidTags();
  const retagged = { count: 0 };
  const badDiagrams = { count: 0 };
  const rejected: Array<{ index: number; reason: string }> = [];
  const rows: ReturnType<typeof toQuestionRow>[] = [];

  parsedResponse.questions.forEach((q, index) => {
    try {
      rows.push(toQuestionRow(q, { runId: run.id, model: run.model, createdById: opts.requestedById, validTags, retagged, badDiagrams }));
    } catch (err) {
      rejected.push({ index, reason: err instanceof Error ? err.message : String(err) });
    }
  });

  if (rows.length > 0) {
    await prisma.question.createMany({ data: rows as never });
  }

  await prisma.generationRun.update({
    where: { id: run.id },
    data: {
      status: rows.length > 0 ? 'SUCCEEDED' : 'FAILED',
      questionsParsed: parsedResponse.questions.length,
      questionsAccepted: rows.length,
      errorMessage: rejected.length ? rejected.map((r) => `Q${r.index + 1}: ${r.reason}`).join('\n') : null,
      completedAt: new Date(),
    },
  });

  if (rows.length === 0) {
    throw new LlmError(
      `None of the ${parsedResponse.questions.length} questions could be used:\n` +
        rejected.map((r) => `Q${r.index + 1}: ${r.reason}`).join('\n'),
    );
  }

  return {
    runId: run.id,
    accepted: rows.length,
    parsed: parsedResponse.questions.length,
    needingImages: rows.filter((r) => r.imageRequired).length,
    rejected,
    warnings: [
      ...(rejected.length
        ? [`${rejected.length} of ${parsedResponse.questions.length} questions were skipped - see the list below.`]
        : []),
      ...(retagged.count > 0
        ? [
            `Tags corrected on ${retagged.count} question${retagged.count === 1 ? '' : 's'}: a skill was on the ` +
              'cognitive axis, or the reverse.',
          ]
        : []),
      ...(badDiagrams.count > 0
        ? [
            `${badDiagrams.count} drawing${badDiagrams.count === 1 ? ' was' : 's were'} discarded for not showing ` +
              'what the question describes; those questions are marked as needing a picture.',
          ]
        : []),
    ],
  };
}

/** Exposed for the axis-sorting checks; not part of the module's API. */
export const __testing = { sortTagsIntoAxes, planBatches };
