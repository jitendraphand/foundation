import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../../db.js';
import { audit } from '../../middleware/auth.js';
import { normalizeActivityContent, EMPTY_ACTIVITY_CONTENT } from '../../lib/content.js';
import { parseVideoUrl } from '../../lib/video.js';
import { audienceWhere } from '../../lib/audience.js';

/**
 * Activities: a flashcard stack and/or a video that a student must go through
 * before they can do anything else.
 *
 * The whole area sits behind the `activities.manage` privilege (see index.ts).
 * Everything a student is forced through is authored here, so the rules about
 * what makes an activity *complete* are enforced at publish time rather than
 * discovered by a class of thirty when it will not let them past.
 */

const activityFields = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  kind: z.enum(['FLASHCARD', 'VIDEO', 'MIXED']).default('FLASHCARD'),

  /// { version, cards: [{ id, title?, blocks: [...] }] } — same blocks as questions.
  content: z.unknown().optional(),

  /// Raw as typed by the admin; normalised through lib/video.ts before storage.
  videoUrl: z.string().max(2000).optional().nullable(),

  minSeconds: z.number().int().min(0).max(3600).default(0),
  isMandatory: z.boolean().default(true),

  targetGrades: z.array(z.string().max(20)).max(20).default([]),
  targetDivisions: z.array(z.string().max(20)).max(20).default([]),
  targetUserId: z.string().uuid().optional().nullable(),

  startsAt: z.string().datetime().optional().nullable(),
  endsAt: z.string().datetime().optional().nullable(),
});

/** Shared by create and update: turns the admin's input into columns. */
function videoColumns(videoUrl: string | null | undefined) {
  if (videoUrl === undefined) return {};
  if (videoUrl === null || videoUrl.trim() === '') {
    return { videoUrl: null, videoEmbedUrl: null, videoProvider: null };
  }
  const parsed = parseVideoUrl(videoUrl); // throws a readable message
  return { videoUrl: parsed.url, videoEmbedUrl: parsed.embedUrl, videoProvider: parsed.provider };
}

function cardsOf(content: unknown): unknown[] {
  const cards = (content as { cards?: unknown } | null)?.cards;
  return Array.isArray(cards) ? cards : [];
}

/**
 * Is this activity actually doable?
 *
 * A student can only finish an activity by seeing every card, so a FLASHCARD
 * activity with no cards would be an unclearable gate on the whole site.
 */
function completenessError(a: { kind: string; content: unknown; videoUrl: string | null }): string | null {
  const cards = cardsOf(a.content).length;
  const needsCards = a.kind === 'FLASHCARD' || a.kind === 'MIXED';
  const needsVideo = a.kind === 'VIDEO' || a.kind === 'MIXED';

  if (needsCards && cards === 0) {
    return a.kind === 'FLASHCARD'
      ? 'Add at least one card before publishing this activity.'
      : 'This activity is set to cards and video, so it needs at least one card.';
  }
  if (needsVideo && !a.videoUrl) {
    return a.kind === 'VIDEO'
      ? 'Add a video link before publishing this activity.'
      : 'This activity is set to cards and video, so it needs a video link.';
  }
  return null;
}

export default async function adminActivityRoutes(app: FastifyInstance) {
  app.get('/api/admin/activities', async (request) => {
    const q = z
      .object({
        status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
        kind: z.enum(['FLASHCARD', 'VIDEO', 'MIXED']).optional(),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(request.query);

    const where = {
      deletedAt: null,
      ...(q.status ? { status: q.status } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.activity.count({ where }),
      prisma.activity.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: {
          targetUser: { select: { id: true, username: true, firstName: true, lastName: true } },
          createdBy: { select: { id: true, username: true } },
          _count: { select: { completions: true } },
        },
      }),
    ]);

    // How many have actually finished, as opposed to merely opened it.
    const finished = await prisma.activityCompletion.groupBy({
      by: ['activityId'],
      where: { activityId: { in: rows.map((r) => r.id) }, completedAt: { not: null } },
      _count: { _all: true },
    });
    const finishedBy = new Map(finished.map((f) => [f.activityId, f._count._all]));

    return {
      total,
      page: q.page,
      pageSize: q.pageSize,
      activities: rows.map((a) => ({
        ...a,
        cardCount: cardsOf(a.content).length,
        startedCount: a._count.completions,
        completedCount: finishedBy.get(a.id) ?? 0,
      })),
    };
  });

  app.get('/api/admin/activities/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const activity = await prisma.activity.findFirst({
      where: { id, deletedAt: null },
      include: {
        targetUser: { select: { id: true, username: true, firstName: true, lastName: true } },
        createdBy: { select: { id: true, username: true } },
      },
    });
    if (!activity) return reply.code(404).send({ error: 'Activity not found.' });

    return { activity: { ...activity, cardCount: cardsOf(activity.content).length } };
  });

  app.post('/api/admin/activities', async (request, reply) => {
    const body = activityFields.parse(request.body);

    const content = body.content === undefined
      ? EMPTY_ACTIVITY_CONTENT
      : normalizeActivityContent(body.content);

    let video: ReturnType<typeof videoColumns>;
    try {
      video = videoColumns(body.videoUrl);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    const activity = await prisma.activity.create({
      data: {
        title: body.title,
        description: body.description ?? null,
        kind: body.kind,
        content,
        minSeconds: body.minSeconds,
        isMandatory: body.isMandatory,
        targetGrades: body.targetGrades,
        targetDivisions: body.targetDivisions,
        targetUserId: body.targetUserId ?? null,
        startsAt: body.startsAt ? new Date(body.startsAt) : null,
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        createdById: request.user!.sub,
        ...video,
      },
    });

    await audit(request.user!.sub, 'activity.create', { entity: 'Activity', entityId: activity.id, ip: request.ip });
    return reply.code(201).send({ ok: true, activity });
  });

  app.patch('/api/admin/activities/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = activityFields.partial().parse(request.body);

    const existing = await prisma.activity.findFirst({ where: { id, deletedAt: null } });
    if (!existing) return reply.code(404).send({ error: 'Activity not found.' });

    let video: ReturnType<typeof videoColumns>;
    try {
      video = videoColumns(body.videoUrl);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    const content = body.content === undefined ? undefined : normalizeActivityContent(body.content);

    // A published activity is a live gate. Do not let an edit turn it into one
    // nobody can clear; the admin must unpublish first if they want to gut it.
    if (existing.status === 'PUBLISHED') {
      const problem = completenessError({
        kind: body.kind ?? existing.kind,
        content: content ?? existing.content,
        videoUrl: 'videoUrl' in video ? (video.videoUrl ?? null) : existing.videoUrl,
      });
      if (problem) {
        return reply.code(400).send({ error: `${problem} It is live at the moment, so it cannot be left unfinishable.` });
      }
    }

    const activity = await prisma.activity.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description ?? null } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(body.minSeconds !== undefined ? { minSeconds: body.minSeconds } : {}),
        ...(body.isMandatory !== undefined ? { isMandatory: body.isMandatory } : {}),
        ...(body.targetGrades !== undefined ? { targetGrades: body.targetGrades } : {}),
        ...(body.targetDivisions !== undefined ? { targetDivisions: body.targetDivisions } : {}),
        ...(body.targetUserId !== undefined ? { targetUserId: body.targetUserId ?? null } : {}),
        ...(body.startsAt !== undefined ? { startsAt: body.startsAt ? new Date(body.startsAt) : null } : {}),
        ...(body.endsAt !== undefined ? { endsAt: body.endsAt ? new Date(body.endsAt) : null } : {}),
        ...video,
      },
    });

    await audit(request.user!.sub, 'activity.update', { entity: 'Activity', entityId: id, ip: request.ip });
    return { ok: true, activity };
  });

  /** Publish, unpublish or archive. Publishing is what makes it block. */
  app.post('/api/admin/activities/:id/publish', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { status } = z.object({ status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']) }).parse(request.body);

    const existing = await prisma.activity.findFirst({ where: { id, deletedAt: null } });
    if (!existing) return reply.code(404).send({ error: 'Activity not found.' });

    if (status === 'PUBLISHED') {
      const problem = completenessError(existing);
      if (problem) return reply.code(400).send({ error: problem });
    }

    const activity = await prisma.activity.update({
      where: { id },
      data: { status, publishedAt: status === 'PUBLISHED' ? new Date() : existing.publishedAt },
    });

    await audit(request.user!.sub, `activity.${status.toLowerCase()}`, { entity: 'Activity', entityId: id, ip: request.ip });

    const blocking = status === 'PUBLISHED' && existing.isMandatory;
    return {
      ok: true,
      activity,
      message:
        status === 'PUBLISHED'
          ? blocking
            ? 'The activity is live. Students it is aimed at will have to go through it before they can do anything else.'
            : 'The activity is live and will appear on the students’ dashboards. It is optional, so nothing is blocked.'
          : status === 'ARCHIVED'
            ? 'The activity has been archived. It no longer blocks anyone, and the record of who completed it is kept.'
            : 'The activity has been moved back to draft and is hidden from students.',
    };
  });

  /**
   * Who has done it and who has not.
   *
   * The roster is worked out from the audience rules rather than from the
   * completion rows, so a student who has never opened it still appears - that
   * is precisely the list a teacher wants.
   */
  app.get('/api/admin/activities/:id/completions', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const activity = await prisma.activity.findFirst({ where: { id, deletedAt: null } });
    if (!activity) return reply.code(404).send({ error: 'Activity not found.' });

    // The same three rules the test rosters use; see lib/audience.ts.
    const audience = audienceWhere(activity);

    const [students, completions] = await Promise.all([
      prisma.user.findMany({
        where: audience,
        orderBy: [{ grade: 'asc' }, { division: 'asc' }, { rollNo: 'asc' }],
        select: {
          id: true, publicId: true, username: true, firstName: true, lastName: true,
          grade: true, division: true, rollNo: true,
        },
      }),
      prisma.activityCompletion.findMany({ where: { activityId: id } }),
    ]);

    const byUser = new Map(completions.map((c) => [c.userId, c]));

    const rows = students.map((s) => {
      const c = byUser.get(s.id);
      return {
        user: s,
        startedAt: c?.startedAt ?? null,
        completedAt: c?.completedAt ?? null,
        secondsSpent: c?.secondsSpent ?? 0,
        cardsSeen: c?.cardsSeen ?? 0,
        videoOpened: c?.videoOpened ?? false,
        state: !c ? 'not_started' : c.completedAt ? 'completed' : 'in_progress',
      };
    });

    return {
      activity: { id: activity.id, publicId: activity.publicId, title: activity.title, status: activity.status, isMandatory: activity.isMandatory },
      total: rows.length,
      completed: rows.filter((r) => r.state === 'completed').length,
      inProgress: rows.filter((r) => r.state === 'in_progress').length,
      notStarted: rows.filter((r) => r.state === 'not_started').length,
      rows,
    };
  });

  /**
   * Makes a student do it again - one student, or the whole audience.
   *
   * Useful when the cards were corrected after half the class had read the
   * wrong version.
   */
  app.post('/api/admin/activities/:id/reset', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { userId } = z.object({ userId: z.string().uuid().optional() }).parse(request.body ?? {});

    const activity = await prisma.activity.findFirst({ where: { id, deletedAt: null } });
    if (!activity) return reply.code(404).send({ error: 'Activity not found.' });

    const { count } = await prisma.activityCompletion.deleteMany({
      where: { activityId: id, ...(userId ? { userId } : {}) },
    });

    await audit(request.user!.sub, 'activity.reset', {
      entity: 'Activity', entityId: id, ip: request.ip, detail: { userId: userId ?? 'all', cleared: count },
    });

    return {
      ok: true,
      cleared: count,
      message: userId
        ? 'That student will be asked to go through the activity again.'
        : `Cleared for ${count} student${count === 1 ? '' : 's'}. They will all be asked to go through it again.`,
    };
  });

  app.delete('/api/admin/activities/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const activity = await prisma.activity.findFirst({
      where: { id, deletedAt: null },
      include: { _count: { select: { completions: true } } },
    });
    if (!activity) return reply.code(404).send({ error: 'Activity not found.' });

    // Anything students have engaged with is archived, not erased, so the
    // record of who did what survives.
    if (activity._count.completions > 0) {
      await prisma.activity.update({ where: { id }, data: { deletedAt: new Date(), status: 'ARCHIVED' } });
      await audit(request.user!.sub, 'activity.archive', { entity: 'Activity', entityId: id, ip: request.ip });
      return {
        ok: true,
        mode: 'soft',
        message: 'Students have already opened this activity, so it has been archived rather than deleted. It no longer blocks anyone.',
      };
    }

    await prisma.activity.delete({ where: { id } });
    await audit(request.user!.sub, 'activity.delete', { entity: 'Activity', entityId: id, ip: request.ip });
    return { ok: true, mode: 'hard' };
  });
}
