import { prisma } from '../db.js';
import { callParamsFor } from './credentials.js';
import { LlmError, PROVIDERS } from './providers.js';
import { chatWithFallback } from './resilience.js';
import { extractJson, llmResponseSchema } from './schema.js';
import { DEFAULT_SYSTEM_PROMPT } from './prompts.js';
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

export function buildStepUpPrompt(question: Question, mode: StepUpMode): string {
  return [
    MODE_INSTRUCTIONS[mode],
    '',
    describeSource(question),
    '',
    `Return {"questions": [...]} with exactly ${STEP_UP_COUNT} questions in the schema above, in order.`,
    'Every question must be multiple choice with exactly one correct answer, and must carry a worked explanation - ' +
      'the explanation is the point of the exercise, so make it teach rather than assert.',
    'Do NOT produce any question needing a photograph. Draw any visual as SVG, and set "imageRequired": false.',
  ].join('\n');
}

/** Which provider Step-up uses, chosen by an administrator. */
export const STEP_UP_SETTING = 'stepup.provider';

export interface StepUpConfig {
  credentialId: string;
  model?: string;
}

export async function getStepUpConfig(): Promise<StepUpConfig | null> {
  const row = await prisma.setting.findUnique({ where: { key: STEP_UP_SETTING } }).catch(() => null);
  const value = row?.value as Partial<StepUpConfig> | null;
  return value?.credentialId ? { credentialId: value.credentialId, model: value.model } : null;
}

export async function setStepUpConfig(config: StepUpConfig | null): Promise<void> {
  if (!config) {
    await prisma.setting.deleteMany({ where: { key: STEP_UP_SETTING } });
    return;
  }
  const value = { credentialId: config.credentialId, ...(config.model ? { model: config.model } : {}) };
  await prisma.setting.upsert({
    where: { key: STEP_UP_SETTING },
    update: { value },
    create: { key: STEP_UP_SETTING, value },
  });
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

  const credential = await prisma.apiCredential.findUnique({ where: { id: config.credentialId } });
  if (!credential || !credential.isActive) {
    throw new LlmError('The provider set for Step-up tests is unavailable. Ask your teacher to check it.');
  }

  const model = config.model || credential.defaultModel;
  if (!model) throw new LlmError('The provider set for Step-up tests has no model chosen.');

  const providerDef = PROVIDERS[credential.provider] ?? PROVIDERS.custom;
  const call = await callParamsFor(credential);

  const { response } = await chatWithFallback(
    [
      { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
      { role: 'user', content: buildStepUpPrompt(args.question, args.mode) },
    ],
    {
      candidates: [
        {
          label: credential.label,
          model,
          call: {
            ...call,
            temperature: 0.5,
            jsonMode: providerDef.supportsJsonMode,
            // Five questions with worked explanations, plus room for a
            // reasoning model to think first.
            maxTokens: 12_000,
          },
        },
      ],
    },
  );

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
        shuffleOptions: true,
        showAnswersAfter: true,
        publishedAt: new Date(),
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
