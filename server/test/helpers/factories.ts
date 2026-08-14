import type { PrismaClient, Prisma } from '@prisma/client';
import { ALL_PERMISSIONS, type Permission } from '../../src/lib/permissions.js';

/**
 * The smallest school that can be examined.
 *
 * Every database test needs an administrator, some children, some questions and
 * a paper. Building that inline three times over is how the setup ends up
 * differing between tests in ways nobody notices, so it lives here and the
 * tests say only what makes their case different.
 */

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Placeholder hash. No test signs in with a password; those go through the API. */
const HASH = '$argon2id$v=19$m=65536,t=3,p=1$dGVzdHNhbHR0ZXN0c2E$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/**
 * An administrator.
 *
 * Permissions default to all of them, because the ADMIN role on its own grants
 * nothing - every area is gated on a specific privilege. Pass a narrower list
 * to test that gate.
 */
export async function makeAdmin(prisma: PrismaClient, permissions: Permission[] = ALL_PERMISSIONS) {
  return prisma.user.create({
    data: {
      username: `admin_${unique()}`,
      passwordHash: HASH,
      role: 'ADMIN',
      permissions,
      firstName: 'Test',
      lastName: 'Admin',
      grade: '',
      division: '',
      divisions: [],
      rollNo: '',
      dateOfBirth: new Date(1990, 0, 1),
      mustChangePassword: false,
    },
  });
}

export async function makeStudent(
  prisma: PrismaClient,
  over: { firstName?: string; grade?: string; division?: string; isActive?: boolean } = {},
) {
  const division = over.division ?? 'SCIENCE';
  return prisma.user.create({
    data: {
      username: `pupil_${unique()}`,
      passwordHash: HASH,
      role: 'STUDENT',
      firstName: over.firstName ?? 'Test',
      lastName: 'Pupil',
      grade: over.grade ?? 'Grade 8',
      division,
      divisions: [division],
      rollNo: unique(),
      dateOfBirth: new Date(2012, 5, 1),
      isActive: over.isActive ?? true,
      mustChangePassword: false,
    },
  });
}

export interface QuestionSpec {
  skills?: string[];
  difficulty?: string;
  cognitive?: string;
  subject?: string;
  text?: string;
}

export async function makeQuestion(prisma: PrismaClient, authorId: string, spec: QuestionSpec = {}) {
  return prisma.question.create({
    data: {
      format: 'MCQ_SINGLE',
      status: 'APPROVED',
      content: { version: 1, blocks: [{ type: 'text', value: spec.text ?? `Question ${unique()}` }] },
      options: ['a', 'b', 'c', 'd'].map((id) => ({ id, blocks: [{ type: 'text', value: id }] })),
      answerKey: { correctOptionId: 'b' },
      explanation: { version: 1, blocks: [{ type: 'text', value: 'Because.' }] },
      difficultyTag: spec.difficulty ?? 'medium',
      cognitiveTag: spec.cognitive ?? 'application',
      skillTags: spec.skills ?? ['fraction_operations'],
      subject: spec.subject ?? 'Mathematics',
      estimatedSeconds: 60,
      createdById: authorId,
    },
  });
}

export interface PaperSpec {
  title?: string;
  subject?: string;
  questions?: number;
  resultsReleased?: boolean;
  negativeMarks?: number;
  durationMinutes?: number;
  skills?: string[];
  targetGrades?: string[];
  targetDivisions?: string[];
}

export async function makePaper(prisma: PrismaClient, authorId: string, spec: PaperSpec = {}) {
  const count = spec.questions ?? 3;
  const questions = [];
  for (let i = 0; i < count; i++) {
    questions.push(await makeQuestion(prisma, authorId, { skills: spec.skills, subject: spec.subject }));
  }

  const test = await prisma.test.create({
    data: {
      title: spec.title ?? `Paper ${unique()}`,
      subject: spec.subject ?? 'Mathematics',
      kind: 'REGULAR',
      status: 'PUBLISHED',
      resultsReleased: spec.resultsReleased ?? true,
      durationMinutes: spec.durationMinutes ?? 30,
      marksPerQuestion: 1,
      negativeMarks: spec.negativeMarks ?? 0,
      maxAttempts: 1,
      passPercentage: 40,
      targetGrades: spec.targetGrades ?? [],
      targetDivisions: spec.targetDivisions ?? [],
      createdById: authorId,
      questions: { create: questions.map((q, i) => ({ questionId: q.id, position: i, marks: 1 })) },
    },
  });

  return { test, questions };
}

/**
 * A sitting in progress, with an answer row per question, exactly as
 * POST /start leaves it.
 */
export async function startAttempt(
  prisma: PrismaClient,
  args: { testId: string; userId: string; questionIds: string[]; expiresAt?: Date; attemptNumber?: number },
) {
  const attempt = await prisma.attempt.create({
    data: {
      testId: args.testId,
      userId: args.userId,
      attemptNumber: args.attemptNumber ?? 1,
      status: 'IN_PROGRESS',
      expiresAt: args.expiresAt ?? new Date(Date.now() + 30 * 60_000),
      maxScore: args.questionIds.length,
      layout: { questionIds: args.questionIds, optionOrder: {} },
    },
  });
  await prisma.answer.createMany({
    data: args.questionIds.map((questionId) => ({ attemptId: attempt.id, questionId })),
  });
  return attempt;
}

/** Answers every question on an attempt, right or wrong as asked. */
export async function answerAll(
  prisma: PrismaClient,
  attemptId: string,
  questionIds: string[],
  correctFor: (index: number) => boolean,
) {
  for (const [i, questionId] of questionIds.entries()) {
    await prisma.answer.update({
      where: { attemptId_questionId: { attemptId, questionId } },
      data: { response: { optionId: correctFor(i) ? 'b' : 'a' } as Prisma.InputJsonValue, answeredAt: new Date() },
    });
  }
}

/**
 * A finished sitting written straight to the database, with the breakdown a
 * real submission would have produced. For tests about *reading* results, where
 * going through grading each time would be slow and beside the point.
 */
export async function recordResult(
  prisma: PrismaClient,
  args: {
    testId: string;
    userId: string;
    percentage: number;
    skills?: Record<string, { correct: number; total: number }>;
    submittedAt?: Date;
    attemptNumber?: number;
  },
) {
  const bySkill: Record<string, unknown> = {};
  for (const [key, { correct, total }] of Object.entries(args.skills ?? {})) {
    bySkill[key] = {
      correct, total, answered: total, marks: correct, maxMarks: total,
      accuracy: total ? Math.round((correct / total) * 100) / 100 : 0, avgTimeMs: 30_000,
    };
  }

  return prisma.attempt.create({
    data: {
      testId: args.testId,
      userId: args.userId,
      attemptNumber: args.attemptNumber ?? 1,
      status: 'SUBMITTED',
      expiresAt: new Date(),
      submittedAt: args.submittedAt ?? new Date(),
      score: args.percentage,
      maxScore: 100,
      percentage: args.percentage,
      correctCount: 0,
      incorrectCount: 0,
      unansweredCount: 0,
      breakdown: { byDifficulty: {}, byCognitive: {}, bySkill, byTopic: {}, bySubtopic: {} },
    },
  });
}
