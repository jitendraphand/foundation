import { prisma } from '../db.js';
import { zonedNow } from '../lib/availability.js';
import { getSchoolTimezone } from '../services/settings.js';
import { callParamsFor } from './credentials.js';
import { LlmError, PROVIDERS } from './providers.js';
import { chatWithFallback } from './resilience.js';
import { ceilingFromError, rememberCeiling, resolveCeiling } from './limits.js';
import { extractJson, llmResponseSchema } from './schema.js';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_STEP_UP_TEMPLATE, renderTemplate } from './prompts.js';
import { normalizeContent, normalizeBlocks, blocksToText, CONTENT_VERSION } from '../lib/content.js';
import { validateAnswerKey } from '../lib/grading.js';
import type { Question } from '@prisma/client';

/**
 * The Step-up Test.
 *
 * A student looking at a question they got wrong has exactly one useful next
 * thought - "give me more of these" - and no way to act on it. This turns that
 * into five questions, generated on the spot, sat immediately, marked at once.
 *
 * Two modes, because "more of these" means two different things depending on
 * whether the question was nearly right or completely out of reach:
 *
 *   SAME    five more at the same difficulty, testing the same idea from
 *           different angles. For a student who half knows it.
 *   LADDER  five building up to it, the first well within reach and the last
 *           at the original's level. For a student who did not know where to
 *           start, and needs the step before the step.
 *
 * It is built on the practice-test machinery rather than beside it: a Step-up
 * paper is a PRACTICE test targeted at the one student. That means the exam
 * runner, the grader, the result view, the release rules and the "practice is
 * segregated from class data" guarantee all apply already, with nothing new to
 * keep in step.
 *
 * The questions belong to the student who asked for them, so they never appear
 * in an administrator's review queue.
 */

export type StepUpMode = 'SAME' | 'LADDER';

export const STEP_UP_COUNT = 5;

const MODE_INSTRUCTIONS: Record<StepUpMode, string> = {
  SAME: `Write ${STEP_UP_COUNT} NEW questions at the SAME difficulty as the one below, testing the SAME underlying idea.

Vary the surface completely - different numbers, different context, different wording, and where it makes sense a different angle on the same concept. A student who has just got the original wrong must not be able to pattern-match their way through these; they should have to understand the idea.

Do NOT restate the original question. Do NOT simply change the numbers in it.`,

  LADDER: `Write ${STEP_UP_COUNT} questions that build up to the one below, in order, as a ladder.

Question 1 must be clearly easier than the original - the simplest single step that the concept rests on, answerable by a student who has understood nothing of the original yet.
Questions 2, 3 and 4 add one idea each, in order.
Question ${STEP_UP_COUNT} must be at the same difficulty as the original, and of the same kind.

Each question must be answerable on its own, without having seen the previous one. The point is that a student working through them in order arrives at the original able to do it. Set difficultyTag honestly across the ladder: it should start easy and end at the original's level.`,
};

function describeSource(question: Question): string {
  const content = blocksToText((question.content as { blocks: never[] }).blocks);
  const options = (question.options as Array<{ id: string; blocks: never[] }>)
    .map((o) => `  ${o.id}) ${blocksToText(o.blocks)}`)
    .join('\n');

  return [
    `Subject: ${question.subject}`,
    question.topic ? `Topic: ${question.topic}` : '',
    question.grade ? `Grade: ${question.grade}` : '',
    `Difficulty: ${question.difficultyTag}`,
    `Cognitive level: ${question.cognitiveTag}`,
    `Skills: ${question.skillTags.join(', ')}`,
    '',
    'THE ORIGINAL QUESTION',
    content,
    options,
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildStepUpPrompt(
  question: Question,
  mode: StepUpMode,
  template = DEFAULT_STEP_UP_TEMPLATE,
): string {
  return renderTemplate(template, {
    modeInstructions: MODE_INSTRUCTIONS[mode],
    source: describeSource(question),
    count: STEP_UP_COUNT,
  });
}

/** The prompt kind the Step-up generator reads from Settings > Prompts. */
export const STEP_UP_PROMPT_KIND = 'STEP_UP';

/**
 * The system prompt and user template Step-up should use.
 *
 * An administrator's edited template wins; the built-in defaults are the
 * fallback, not the other way round. Falling back rather than failing matters
 * here because a student presses this button themselves, mid-review, and
 * "Step-up is not configured" would be a dead end they cannot act on.
 */
async function stepUpPrompts(): Promise<{ systemPrompt: string; userTemplate: string }> {
  const template = await prisma.promptTemplate
    .findFirst({
      where: { kind: STEP_UP_PROMPT_KIND, isActive: true },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
    })
    .catch(() => null);

  return {
    systemPrompt: template?.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT,
    userTemplate: template?.userTemplate?.trim() || DEFAULT_STEP_UP_TEMPLATE,
  };
}

/** Which provider Step-up uses, chosen by an administrator. */
export const STEP_UP_SETTING = 'stepup.provider';

/**
 * How many Step-up papers one student may generate in a school day, unless an
 * administrator says otherwise.
 *
 * Step-up is the one feature a student can spend the school's API budget on
 * themselves, several times an afternoon, without anybody approving it. The
 * rate limit already stops a runaway loop, but 6 an hour is 144 a day, which is
 * not a budget - it is an absence of one. Five is enough for the purpose (a
 * student works through the questions they got wrong on one paper) and small
 * enough that a class of thirty cannot surprise anybody with a bill.
 */
export const DEFAULT_STEP_UP_QUOTA = 5;

export interface StepUpConfig {
  credentialId: string;
  model?: string;
  /** Papers per student per school day. 0 means no limit at all. */
  dailyQuota?: number;
}

export async function getStepUpConfig(): Promise<StepUpConfig | null> {
  const row = await prisma.setting.findUnique({ where: { key: STEP_UP_SETTING } }).catch(() => null);
  const value = row?.value as Partial<StepUpConfig> | null;
  if (!value?.credentialId) return null;
  return {
    credentialId: value.credentialId,
    model: value.model,
    // Absent means this was configured before quotas existed. The default
    // applies rather than "unlimited", which would leave exactly the installs
    // that never chose a number with no limit at all.
    dailyQuota: typeof value.dailyQuota === 'number' ? value.dailyQuota : DEFAULT_STEP_UP_QUOTA,
  };
}

export async function setStepUpConfig(config: StepUpConfig | null): Promise<void> {
  if (!config) {
    await prisma.setting.deleteMany({ where: { key: STEP_UP_SETTING } });
    return;
  }
  const value = {
    credentialId: config.credentialId,
    ...(config.model ? { model: config.model } : {}),
    dailyQuota: config.dailyQuota ?? DEFAULT_STEP_UP_QUOTA,
  };
  await prisma.setting.upsert({
    where: { key: STEP_UP_SETTING },
    update: { value },
    create: { key: STEP_UP_SETTING, value },
  });
}

/** Marks a test as one Step-up built, so the quota has something to count. */
const STEP_UP_MARK = { stepUp: true };

/**
 * The start of today, in the school's own timezone.
 *
 * Not UTC midnight: in India that falls at half past five in the morning, so a
 * student's allowance would appear to reset in the middle of the night and then
 * again mid-afternoon relative to what they expect. Seconds are dropped, which
 * can only widen the day by under a minute.
 *
 * A day on which the clocks change is an hour out. For a quota that is not
 * worth the arithmetic.
 */
async function startOfSchoolDay(now = new Date()): Promise<Date> {
  const timezone = await getSchoolTimezone();
  const { minuteOfDay } = zonedNow(timezone, now);
  const start = new Date(now.getTime() - minuteOfDay * 60_000);
  start.setSeconds(0, 0);
  return start;
}

export interface StepUpAllowance {
  /** Papers a day. 0 means no limit. */
  quota: number;
  used: number;
  /** null when there is no limit. */
  remaining: number | null;
}

/**
 * How much of today's allowance this student has left.
 *
 * Counts papers built, including any since deleted: a student who deletes a
 * Step-up paper has still spent the call that made it, and refunding it would
 * be a way round the limit.
 */
export async function stepUpAllowanceFor(studentId: string): Promise<StepUpAllowance> {
  const config = await getStepUpConfig();
  const quota = config?.dailyQuota ?? DEFAULT_STEP_UP_QUOTA;
  if (quota <= 0) return { quota: 0, used: 0, remaining: null };

  const used = await prisma.test.count({
    where: {
      createdById: studentId,
      kind: 'PRACTICE',
      meta: { path: ['stepUp'], equals: true },
      createdAt: { gte: await startOfSchoolDay() },
    },
  });

  return { quota, used, remaining: Math.max(0, quota - used) };
}

export interface StepUpResult {
  testId: string;
  publicId: string;
  title: string;
  questionCount: number;
}

/**
 * Generates a Step-up paper and returns the test to sit.
 *
 * Everything is one transaction at the end: a half-created paper with three of
 * its five questions would be worse than none, because the student would sit
 * it and get a mark out of three that means nothing.
 */
export async function generateStepUp(args: {
  question: Question;
  mode: StepUpMode;
  studentId: string;
}): Promise<StepUpResult> {
  const config = await getStepUpConfig();
  if (!config) {
    throw new LlmError(
      'Step-up tests are not set up yet. Ask your teacher to choose a provider for them in Settings.',
    );
  }

  // Checked before anything is spent. The message names the number, because
  // "you have reached your limit" without one leaves a fourteen-year-old with
  // nothing to do but press the button again.
  const allowance = await stepUpAllowanceFor(args.studentId);
  if (allowance.remaining === 0) {
    throw new LlmError(
      `You have used all ${allowance.quota} of today's Step-up tests. You can build more tomorrow, or ask your ` +
        'teacher for extra practice.',
    );
  }

  const credential = await prisma.apiCredential.findUnique({ where: { id: config.credentialId } });
  if (!credential || !credential.isActive) {
    throw new LlmError('The provider set for Step-up tests is unavailable. Ask your teacher to check it.');
  }

  const model = config.model || credential.defaultModel;
  if (!model) throw new LlmError('The provider set for Step-up tests has no model chosen.');

  const providerDef = PROVIDERS[credential.provider] ?? PROVIDERS.custom;
  const call = await callParamsFor(credential);
  const prompts = await stepUpPrompts();

  // Five questions with worked explanations, plus room for a reasoning model to
  // think first - but never more than this provider and model will accept. See
  // limits.ts: the ceiling may have been set by an admin, learned from an
  // earlier refusal, or come from the provider's own default.
  const ceiling = resolveCeiling(credential, model);
  const maxTokens = Math.min(12_000, ceiling ?? 12_000);

  const messages = [
    { role: 'system' as const, content: prompts.systemPrompt },
    { role: 'user' as const, content: buildStepUpPrompt(args.question, args.mode, prompts.userTemplate) },
  ];

  const ask = (budget: number) =>
    chatWithFallback(messages, {
      candidates: [
        {
          label: credential.label,
          model,
          call: { ...call, temperature: 0.5, jsonMode: providerDef.supportsJsonMode, maxTokens: budget },
        },
      ],
    });

  let response;
  try {
    ({ response } = await ask(maxTokens));
  } catch (err) {
    // The provider refused the size of the reply and named what it does allow.
    // Nobody is going to relay that to a fourteen-year-old, so take it, store
    // it, and ask again inside the limit. One retry only: a second refusal is
    // a real failure, not a number we can work around.
    const learned = ceilingFromError(err, maxTokens);
    if (!learned) throw err;
    await rememberCeiling(config.credentialId, model, learned).catch(() => undefined);
    ({ response } = await ask(learned));
  }

  let parsed;
  try {
    parsed = llmResponseSchema.parse(extractJson(response.text));
  } catch {
    throw new LlmError('The model did not return usable questions. Try again in a moment.');
  }

  const validTags = await loadTagVocabulary();

  const rows = parsed.questions.slice(0, STEP_UP_COUNT).map((q) => {
    const options = q.options.map((o) => ({ id: o.id, blocks: normalizeBlocks(o.blocks) }));
    if (options.length < 2) throw new LlmError('The model returned a question with no options. Try again.');

    const answerKey = validateAnswerKey(q.format, q.answerKey);
    if (q.format === 'MCQ_SINGLE') {
      const id = (answerKey as { correctOptionId: string }).correctOptionId;
      if (!options.some((o) => o.id === id)) throw new LlmError('The model returned an answer that is not an option.');
    }

    return {
      status: 'APPROVED' as const,
      format: q.format,
      content: normalizeContent({ version: CONTENT_VERSION, blocks: q.content.blocks }),
      options,
      answerKey,
      explanation: normalizeContent({ version: CONTENT_VERSION, blocks: q.explanation.blocks }),
      // Anything the model invented falls back to the original's tag, so a
      // Step-up question is never filed somewhere the vocabulary does not go.
      difficultyTag: validTags.difficulty.has(q.difficultyTag) ? q.difficultyTag : args.question.difficultyTag,
      cognitiveTag: validTags.cognitive.has(q.cognitiveTag) ? q.cognitiveTag : args.question.cognitiveTag,
      skillTags: q.skillTags.filter((s) => validTags.skill.has(s)).length
        ? q.skillTags.filter((s) => validTags.skill.has(s))
        : args.question.skillTags,
      subject: args.question.subject,
      topic: args.question.topic,
      subtopic: args.question.subtopic,
      grade: args.question.grade,
      estimatedSeconds: q.estimatedSeconds,
      sourceModel: model,
      // The student owns these, so they never reach an admin's review queue.
      createdById: args.studentId,
      imageRequired: false,
    };
  });

  if (rows.length === 0) throw new LlmError('The model returned no questions. Try again in a moment.');

  const title =
    args.mode === 'SAME'
      ? `Step-up: more like this (${args.question.subject})`
      : `Step-up: building up to it (${args.question.subject})`;

  return prisma.$transaction(async (tx) => {
    const created = await Promise.all(rows.map((data) => tx.question.create({ data: data as never })));

    const test = await tx.test.create({
      data: {
        title,
        description:
          args.mode === 'SAME'
            ? 'Five more questions on the same idea, generated for you.'
            : 'Five questions building up to the one you asked about, easiest first.',
        kind: 'PRACTICE',
        // Published immediately: the student asked for it and is about to sit
        // it. Practice results are always visible, so nothing to release.
        status: 'PUBLISHED',
        subject: args.question.subject,
        grade: args.question.grade,
        targetUserId: args.studentId,
        createdById: args.studentId,
        marksPerQuestion: 1,
        negativeMarks: 0,
        durationMinutes: Math.max(5, Math.ceil((rows.reduce((n, r) => n + r.estimatedSeconds, 0) * 1.5) / 60)),
        maxAttempts: 1,
        shuffleQuestions: false, // a ladder is meaningless out of order
        // Nor are the options shuffled. A Step-up paper is generated fresh for
        // one student, so there is nobody to copy from and nothing to defend
        // against - and shuffling actively harms it: "which labelled part
        // receives signals?" with options A, B, C, D matching labels on the
        // diagram becomes B, C, D, A, so option A reads "D". The model also
        // writes a ladder's options in a deliberate order, easiest wrong answer
        // first, and reordering throws that away.
        shuffleOptions: false,
        showAnswersAfter: true,
        publishedAt: new Date(),
        // What the daily allowance counts; see stepUpAllowanceFor.
        meta: STEP_UP_MARK,
      },
    });

    await tx.testQuestion.createMany({
      data: created.map((q, index) => ({ testId: test.id, questionId: q.id, position: index, marks: 1 })),
    });

    return { testId: test.id, publicId: test.publicId, title: test.title, questionCount: created.length };
  });
}

async function loadTagVocabulary() {
  const tags = await prisma.tag.findMany({ where: { isActive: true }, select: { axis: true, code: true } });
  return {
    difficulty: new Set(tags.filter((t) => t.axis === 'DIFFICULTY').map((t) => t.code)),
    cognitive: new Set(tags.filter((t) => t.axis === 'COGNITIVE').map((t) => t.code)),
    skill: new Set(tags.filter((t) => t.axis === 'SKILL').map((t) => t.code)),
  };
}
