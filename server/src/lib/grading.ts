import { z } from 'zod';
import type { QuestionFormat } from '@prisma/client';

/**
 * Answer keys and student responses.
 *
 * Two question formats, both multiple choice and both auto-graded:
 *   MCQ_SINGLE - exactly one correct option
 *   MCQ_MULTI  - several correct options, with optional partial credit
 *
 * Both are JSON, so a future format is a new branch here plus a new input
 * component - never a migration.
 */

export const answerKeySchemas = {
  MCQ_SINGLE: z.object({ correctOptionId: z.string().min(1) }),
  MCQ_MULTI: z.object({
    correctOptionIds: z.array(z.string().min(1)).min(1),
    partialCredit: z.boolean().default(false),
  }),
} as const;

export const responseSchemas = {
  MCQ_SINGLE: z.object({ optionId: z.string().min(1) }),
  MCQ_MULTI: z.object({ optionIds: z.array(z.string().min(1)) }),
} as const;

export function validateAnswerKey(format: QuestionFormat, key: unknown) {
  return answerKeySchemas[format].parse(key);
}

export function validateResponse(format: QuestionFormat, response: unknown) {
  return responseSchemas[format].parse(response);
}

export interface GradeResult {
  isCorrect: boolean;
  /** Fraction of the question's marks earned, 0..1. */
  fraction: number;
}

/**
 * Grades one answer. Pure function, no database access - which is what makes
 * it straightforward to re-grade an entire test after fixing a bad answer key.
 */
export function gradeAnswer(format: QuestionFormat, answerKey: unknown, response: unknown): GradeResult {
  if (response === null || response === undefined) return { isCorrect: false, fraction: 0 };

  switch (format) {
    case 'MCQ_SINGLE': {
      const key = answerKeySchemas.MCQ_SINGLE.parse(answerKey);
      const res = responseSchemas.MCQ_SINGLE.safeParse(response);
      if (!res.success) return { isCorrect: false, fraction: 0 };
      const ok = res.data.optionId === key.correctOptionId;
      return { isCorrect: ok, fraction: ok ? 1 : 0 };
    }

    case 'MCQ_MULTI': {
      const key = answerKeySchemas.MCQ_MULTI.parse(answerKey);
      const res = responseSchemas.MCQ_MULTI.safeParse(response);
      if (!res.success) return { isCorrect: false, fraction: 0 };

      const correct = new Set(key.correctOptionIds);
      // De-duplicate: a repeated id must not count twice.
      const chosen = new Set(res.data.optionIds);
      if (chosen.size === 0) return { isCorrect: false, fraction: 0 };

      const hits = [...chosen].filter((id) => correct.has(id)).length;
      const misses = [...chosen].filter((id) => !correct.has(id)).length;
      const exact = hits === correct.size && misses === 0;

      if (exact) return { isCorrect: true, fraction: 1 };
      if (!key.partialCredit) return { isCorrect: false, fraction: 0 };

      // Partial credit: credit for hits, penalty for wrong ticks, floored at 0.
      const fraction = Math.max(0, (hits - misses) / correct.size);
      return { isCorrect: false, fraction };
    }

    default: {
      const _exhaustive: never = format;
      return { isCorrect: false, fraction: 0 };
    }
  }
}

/**
 * Marks for one answer, including negative marking.
 * Negative marks apply only to a fully wrong attempt at an *answered*
 * question - never to a blank, and never to a partially correct multi-select.
 */
export function marksFor(
  grade: GradeResult,
  marks: number,
  negativeMarks: number,
  answered: boolean,
): number {
  if (!answered) return 0;
  if (grade.fraction > 0) return round2(marks * grade.fraction);
  return round2(-Math.abs(negativeMarks));
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
