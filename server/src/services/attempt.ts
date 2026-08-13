import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { gradeAnswer, marksFor, round2 } from '../lib/grading.js';
import { buildBreakdown, type GradedRow } from '../lib/analytics.js';
import type { Attempt, Question, Test, TestQuestion } from '@prisma/client';
import { evaluateAvailability } from '../lib/availability.js';
import { getSchoolTimezone } from './settings.js';

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
 * The single rule for whether a student may see their score.
 *
 * Submitting never reveals it. An administrator releases a whole test at once,
 * normally after every student has finished, so nobody can learn the answers
 * from a classmate who sat it earlier.
 *
 * Practice tests are the deliberate exception: they exist for the student to
 * learn from, so their results are always immediate.
 *
 * Every route that returns a score consults this, so there is no second place
 * for the rule to drift out of step.
 */
export function resultsAreVisible(test: Pick<Test, 'kind' | 'resultsReleased'>): boolean {
  return test.kind === 'PRACTICE' || test.resultsReleased;
}

/**
 * Grades and finalises an attempt.
 *
 * Idempotent under concurrency, which is the whole difficulty here. This is
 * called from five places - submit, the timer, the tick, loading a paper, and
 * the expiry sweep - and the sweep runs on every student's dashboard load, so
 * during a class the same expired attempt is picked up by several requests
 * within milliseconds of each other.
 *
 * Checking the status before starting is not enough: every caller reads
 * IN_PROGRESS, every caller proceeds, and every caller adds one to
 * `timesServed` on all 25 questions. Six dashboards open meant a paper sat once
 * counted six times, and `observedP` - the number a teacher uses to spot a
 * badly worded question - was wrong by that factor.
 *
 * So the attempt is *claimed* instead: one conditional UPDATE moves it out of
 * IN_PROGRESS, and only the caller whose update actually matched a row goes on
 * to write the statistics. The losers return the stored result, which is what
 * they wanted anyway.
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
    // Claim the attempt. `status: 'IN_PROGRESS'` in the filter is the lock:
    // exactly one concurrent caller can match, and the rest see count 0.
    const claim = await tx.attempt.updateMany({
      where: { id: attemptId, status: 'IN_PROGRESS' },
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
    });
    if (claim.count === 0) return null;

    // One statement rather than one per answer. A fifty-question paper used to
    // be fifty sequential round trips inside this transaction, and a class
    // submitting together queued behind every one of them.
    if (updates.length > 0) {
      await tx.$executeRaw`
        UPDATE "Answer" AS a
        SET "isCorrect" = v.is_correct, "marksAwarded" = v.marks
        FROM (VALUES ${Prisma.join(
          updates.map((u) => Prisma.sql`(${u.id}, ${u.isCorrect}::boolean, ${u.marksAwarded}::double precision)`),
        )}) AS v(id, is_correct, marks)
        WHERE a.id = v.id`;
    }

    // Live difficulty statistics, used to spot questions that are badly worded.
    //
    // No ::uuid cast on the id: Prisma maps `String @id @default(uuid())` to a
    // TEXT column unless @db.Uuid is declared, and Postgres has no
    // text = uuid operator, so casting here fails every submission.
    const answered = rows.filter((r) => r.answered);
    if (answered.length > 0) {
      await tx.$executeRaw`
        UPDATE "Question" AS q
        SET "timesServed"  = q."timesServed" + 1,
            "timesCorrect" = q."timesCorrect" + v.hit,
            "observedP"    = (q."timesCorrect" + v.hit)::float / (q."timesServed" + 1)
        FROM (VALUES ${Prisma.join(
          answered.map((r) => Prisma.sql`(${r.questionId}, ${r.isCorrect ? 1 : 0}::int)`),
        )}) AS v(id, hit)
        WHERE q.id = v.id`;
    }

    return tx.attempt.findUniqueOrThrow({ where: { id: attemptId }, include: { test: true } });
  });

  // Somebody else finalised it while we were grading. Their result is the one
  // that counts, and it is already written.
  if (!updated) {
    return prisma.attempt.findUniqueOrThrow({ where: { id: attemptId }, include: { test: true } });
  }

  return updated;
}

/**
 * The opportunistic sweep, throttled.
 *
 * A background timer sweeps every minute regardless; the dashboard also asks,
 * so a paper is never left un-graded for a full minute after the student comes
 * back. But a whole class refreshing at once meant two hundred sweeps in a few
 * seconds - two hundred scans for the same handful of rows, each blocking the
 * one process everybody else is waiting on.
 *
 * One sweep at a time, and at most one every fifteen seconds. Everybody who
 * asks in between gets the in-flight one, or nothing to do.
 */
let sweepInFlight: Promise<number> | null = null;
let lastSweepAt = 0;
const SWEEP_EVERY_MS = 15_000;

export function sweepExpiredAttemptsThrottled(): Promise<number> {
  if (sweepInFlight) return sweepInFlight;
  if (Date.now() - lastSweepAt < SWEEP_EVERY_MS) return Promise.resolve(0);

  sweepInFlight = sweepExpiredAttempts()
    .finally(() => {
      lastSweepAt = Date.now();
      sweepInFlight = null;
    });
  return sweepInFlight;
}

/**
 * Closes attempts whose timer ran out while the student was away. Called on a
 * timer and also opportunistically whenever a student loads their dashboard,
 * so a result never sits un-graded because the browser was closed.
 */
export async function sweepExpiredAttempts(): Promise<number> {
  const now = new Date();

  const expired = await prisma.attempt.findMany({
    where: { status: 'IN_PROGRESS', expiresAt: { lt: now } },
    select: { id: true },
    take: 200,
  });

  const toClose = new Set(expired.map((a) => a.id));

  // Tests that opt in to cutting papers off when their daily window shuts.
  // Off by default: a student who started in time normally finishes.
  const windowed = await prisma.attempt.findMany({
    where: {
      status: 'IN_PROGRESS',
      expiresAt: { gte: now },
      test: { autoSubmitOnClose: true, availabilityMode: { not: 'ALWAYS' } },
    },
    select: {
      id: true,
      test: {
        select: {
          availabilityMode: true, windowStartMinute: true, windowEndMinute: true, windowDays: true,
        },
      },
    },
    take: 200,
  });

  if (windowed.length > 0) {
    const timezone = await getSchoolTimezone();
    for (const attempt of windowed) {
      if (!evaluateAvailability(attempt.test, timezone, now).open) toClose.add(attempt.id);
    }
  }

  let done = 0;
  for (const id of toClose) {
    try {
      await finalizeAttempt(id, true);
      done++;
    } catch (err) {
      console.error('[sweep] could not finalise attempt', id, err);
    }
  }
  return done;
}
