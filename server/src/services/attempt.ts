import { prisma } from '../db.js';
import { gradeAnswer, marksFor, round2 } from '../lib/grading.js';
import { buildBreakdown, type GradedRow } from '../lib/analytics.js';
import type { Attempt, Question, Test, TestQuestion } from '@prisma/client';

/**
 * Deterministic shuffle from a seed, so the same attempt always produces the
 * same order even if it is recomputed. mulberry32 is tiny and good enough for
 * shuffling exam questions.
 */
function seededShuffle<T>(items: T[], seed: string): T[] {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface AttemptLayout {
  questionIds: string[];
  optionOrder: Record<string, string[]>;
}

export function buildLayout(
  test: Pick<Test, 'shuffleQuestions' | 'shuffleOptions'>,
  testQuestions: Array<TestQuestion & { question: Pick<Question, 'id' | 'options'> }>,
  seed: string,
): AttemptLayout {
  const ordered = [...testQuestions].sort((a, b) => a.position - b.position);
  const questions = test.shuffleQuestions ? seededShuffle(ordered, `${seed}:q`) : ordered;

  const optionOrder: Record<string, string[]> = {};
  for (const tq of questions) {
    const opts = (tq.question.options as Array<{ id: string }>) ?? [];
    if (opts.length === 0) continue;
    const ids = opts.map((o) => o.id);
    optionOrder[tq.question.id] = test.shuffleOptions ? seededShuffle(ids, `${seed}:${tq.question.id}`) : ids;
  }

  return { questionIds: questions.map((tq) => tq.question.id), optionOrder };
}

/** Strips the answer key and explanation before anything goes to a student. */
export function publicQuestion(
  question: Question,
  marks: number,
  optionOrder: string[] | undefined,
  includeAnswers: boolean,
) {
  const rawOptions = (question.options as Array<{ id: string; blocks: unknown }>) ?? [];
  const options = optionOrder
    ? optionOrder.map((id) => rawOptions.find((o) => o.id === id)).filter(Boolean)
    : rawOptions;

  return {
    id: question.id,
    format: question.format,
    content: question.content,
    options,
    marks,
    estimatedSeconds: question.estimatedSeconds,
    difficultyTag: question.difficultyTag,
    cognitiveTag: question.cognitiveTag,
    skillTags: question.skillTags,
    subject: question.subject,
    topic: question.topic,
    subtopic: question.subtopic,
    ...(includeAnswers ? { answerKey: question.answerKey, explanation: question.explanation } : {}),
  };
}

export function remainingMs(attempt: Pick<Attempt, 'expiresAt'>): number {
  return Math.max(0, attempt.expiresAt.getTime() - Date.now());
}

/**
 * Grades and finalises an attempt. Idempotent: re-running on an already
 * submitted attempt returns the stored result rather than double-counting the
 * per-question statistics.
 */
export async function finalizeAttempt(attemptId: string, auto: boolean) {
  const attempt = await prisma.attempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: {
      test: true,
      answers: true,
    },
  });

  if (attempt.status !== 'IN_PROGRESS') {
    return attempt;
  }

  const testQuestions = await prisma.testQuestion.findMany({
    where: { testId: attempt.testId },
    include: { question: true },
  });

  const byQuestion = new Map(testQuestions.map((tq) => [tq.questionId, tq]));
  const answerByQuestion = new Map(attempt.answers.map((a) => [a.questionId, a]));

  const rows: GradedRow[] = [];
  const updates: Array<{ id: string; isCorrect: boolean; marksAwarded: number }> = [];

  let score = 0;
  let maxScore = 0;
  let correctCount = 0;
  let incorrectCount = 0;
  let unansweredCount = 0;

  for (const tq of testQuestions) {
    const q = tq.question;
    const answer = answerByQuestion.get(q.id);
    const answered = !!answer && answer.response !== null && answer.response !== undefined;

    const grade = answered
      ? gradeAnswer(q.format, q.answerKey, answer!.response)
      : { isCorrect: false, fraction: 0 };

    const awarded = marksFor(grade, tq.marks, attempt.test.negativeMarks, answered);

    maxScore = round2(maxScore + tq.marks);
    score = round2(score + awarded);

    if (!answered) unansweredCount++;
    else if (grade.isCorrect) correctCount++;
    else incorrectCount++;

    if (answer) updates.push({ id: answer.id, isCorrect: grade.isCorrect, marksAwarded: awarded });

    rows.push({
      questionId: q.id,
      isCorrect: grade.isCorrect,
      marksAwarded: awarded,
      maxMarks: tq.marks,
      answered,
      timeSpentMs: answer?.timeSpentMs ?? 0,
      difficultyTag: q.difficultyTag,
      cognitiveTag: q.cognitiveTag,
      skillTags: q.skillTags,
      subject: q.subject,
      topic: q.topic,
      subtopic: q.subtopic,
    });
  }

  // Never report a negative total: negative marking can only reach zero.
  score = Math.max(0, score);
  const percentage = maxScore > 0 ? round2((score / maxScore) * 100) : 0;
  const breakdown = buildBreakdown(rows);

  const updated = await prisma.$transaction(async (tx) => {
    for (const u of updates) {
      await tx.answer.update({
        where: { id: u.id },
        data: { isCorrect: u.isCorrect, marksAwarded: u.marksAwarded },
      });
    }

    // Live difficulty statistics, used to spot questions that are badly worded.
    for (const row of rows) {
      if (!row.answered) continue;
      await tx.$executeRaw`
        UPDATE "Question"
        SET "timesServed" = "timesServed" + 1,
            "timesCorrect" = "timesCorrect" + ${row.isCorrect ? 1 : 0},
            "observedP" = CASE WHEN ("timesServed" + 1) > 0
              THEN ("timesCorrect" + ${row.isCorrect ? 1 : 0})::float / ("timesServed" + 1)
              ELSE 0 END
        WHERE "id" = ${row.questionId}::uuid`;
    }

    return tx.attempt.update({
      where: { id: attemptId },
      data: {
        status: auto ? 'AUTO_SUBMITTED' : 'SUBMITTED',
        submittedAt: new Date(),
        score,
        maxScore,
        percentage,
        correctCount,
        incorrectCount,
        unansweredCount,
        breakdown: breakdown as object,
      },
      include: { test: true },
    });
  });

  return updated;
}

/**
 * Closes attempts whose timer ran out while the student was away. Called on a
 * timer and also opportunistically whenever a student loads their dashboard,
 * so a result never sits un-graded because the browser was closed.
 */
export async function sweepExpiredAttempts(): Promise<number> {
  const expired = await prisma.attempt.findMany({
    where: { status: 'IN_PROGRESS', expiresAt: { lt: new Date() } },
    select: { id: true },
    take: 200,
  });

  let done = 0;
  for (const { id } of expired) {
    try {
      await finalizeAttempt(id, true);
      done++;
    } catch (err) {
      console.error('[sweep] could not finalise attempt', id, err);
    }
  }
  return done;
}
