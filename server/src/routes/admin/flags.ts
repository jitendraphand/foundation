import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { audit } from '../../middleware/auth.js';
import { ownedBy, type Actor } from '../../lib/ownership.js';

function flagsVisibleTo(request: Actor) {
  // Same ownership rule as tests: a flag is visible if its test is visible.
  // We filter by test's createdById.
  return ownedBy(request, 'createdById');
}

export default async function adminFlagRoutes(app: FastifyInstance) {
  // List all flags visible to this admin (i.e. flags on tests they created,
  // or all if they have content.viewAll / admins.manage).
  app.get('/api/admin/flags', async (request) => {
    const q = z
      .object({
        testId: z.string().uuid().optional(),
        questionId: z.string().uuid().optional(),
        status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(request.query);

    const testFilter = {
      ...flagsVisibleTo(request),
      ...(q.testId ? { id: q.testId } : {}),
    };

    // Find testIds visible to this admin first, then filter flags by those.
    // This avoids a join that Prisma can't express cleanly with JSON ownership.
    const visibleTests = await prisma.test.findMany({
      where: testFilter,
      select: { id: true },
    });
    const visibleTestIds = visibleTests.map((t) => t.id);

    if (visibleTestIds.length === 0) {
      return { total: 0, page: q.page, pageSize: q.pageSize, flags: [] };
    }

    const where: Record<string, unknown> = {
      testId: { in: visibleTestIds },
    };
    if (q.testId) where.testId = q.testId;
    if (q.questionId) where.questionId = q.questionId;
    if (q.status) where.status = q.status;

    const [total, flags] = await Promise.all([
      prisma.questionFlag.count({ where: where as never }),
      prisma.questionFlag.findMany({
        where: where as never,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          question: { select: { id: true, content: true, subject: true, topic: true, difficultyTag: true } },
          test: { select: { id: true, publicId: true, title: true, subject: true, createdById: true } },
          flaggedBy: { select: { id: true, username: true, firstName: true, lastName: true, grade: true, division: true } },
          resolvedBy: { select: { id: true, username: true, firstName: true, lastName: true } },
        },
      }),
    ]);

    return { total, page: q.page, pageSize: q.pageSize, flags };
  });

  // Flags for a single test (creator view)
  app.get('/api/admin/tests/:id/flags', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const q = z
      .object({
        status: z.enum(['OPEN', 'RESOLVED', 'DISMISSED']).optional(),
      })
      .parse(request.query);

    const test = await prisma.test.findFirst({
      where: { id, ...flagsVisibleTo(request) },
      select: { id: true },
    });
    if (!test) return reply.code(404).send({ error: 'Test not found.' });

    const flags = await prisma.questionFlag.findMany({
      where: {
        testId: id,
        ...(q.status ? { status: q.status } : {}),
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        question: { select: { id: true, content: true, subject: true, topic: true, difficultyTag: true } },
        flaggedBy: { select: { id: true, username: true, firstName: true, lastName: true, grade: true, division: true } },
        resolvedBy: { select: { id: true, username: true, firstName: true, lastName: true } },
      },
    });

    // Also return per-question aggregate for the test's question list
    const byQuestion: Record<string, number> = {};
    for (const f of flags) {
      if (f.status === 'OPEN') byQuestion[f.questionId] = (byQuestion[f.questionId] ?? 0) + 1;
    }

    return { flags, byQuestion, openCount: flags.filter((f) => f.status === 'OPEN').length };
  });

  // Resolve / dismiss a flag
  app.patch('/api/admin/flags/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        status: z.enum(['RESOLVED', 'DISMISSED']),
        resolutionNote: z.string().trim().max(2000).optional(),
      })
      .parse(request.body);

    const flag = await prisma.questionFlag.findUnique({
      where: { id },
      include: { test: { select: { id: true, createdById: true } } },
    });
    if (!flag) return reply.code(404).send({ error: 'Flag not found.' });

    // Must be able to see the test this flag belongs to
    const testVisible = await prisma.test.findFirst({
      where: { id: flag.testId, ...flagsVisibleTo(request) },
      select: { id: true },
    });
    if (!testVisible) return reply.code(404).send({ error: 'Flag not found.' });

    const updated = await prisma.questionFlag.update({
      where: { id },
      data: {
        status: body.status,
        resolutionNote: body.resolutionNote?.trim() ? body.resolutionNote.trim() : null,
        resolvedById: request.user!.sub,
        resolvedAt: new Date(),
      },
    });

    await audit(request.user!.sub, `flag.${body.status.toLowerCase()}`, {
      entity: 'QuestionFlag',
      entityId: id,
      ip: request.ip,
      detail: { questionId: flag.questionId, testId: flag.testId, status: body.status },
    });

    return { ok: true, flag: updated };
  });

  // Delete a flag (admin cleanup)
  app.delete('/api/admin/flags/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const flag = await prisma.questionFlag.findUnique({
      where: { id },
      include: { test: { select: { id: true } } },
    });
    if (!flag) return reply.code(404).send({ error: 'Flag not found.' });

    const testVisible = await prisma.test.findFirst({
      where: { id: flag.testId, ...flagsVisibleTo(request) },
      select: { id: true },
    });
    if (!testVisible) return reply.code(404).send({ error: 'Flag not found.' });

    await prisma.questionFlag.delete({ where: { id } });
    await audit(request.user!.sub, 'flag.delete', { entity: 'QuestionFlag', entityId: id, ip: request.ip });
    return { ok: true };
  });
}
