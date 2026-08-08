import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { activityVisibleTo, cardCount, pendingActivitiesFor } from '../services/activities.js';

/**
 * The student's side of activities.
 *
 * Registered outside the blocked scope, since these are the very routes a
 * student uses to clear the block.
 */
export default async function activityRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  /** Everything still owed. Drives the "you must do this first" redirect. */
  app.get('/api/activities/pending', async (request) => {
    const pending = await pendingActivitiesFor(request.user!.sub);
    return { pending, count: pending.length };
  });

  /** Everything visible to this student, done or not, for the dashboard. */
  app.get('/api/activities', async (request) => {
    const userId = request.user!.sub;
    const me = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { grade: true, division: true },
    });

    const now = new Date();
    const activities = await prisma.activity.findMany({
      where: {
        status: 'PUBLISHED',
        deletedAt: null,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
          {
            OR: [
              {
                targetUserId: null,
                AND: [
                  { OR: [{ targetGrades: { isEmpty: true } }, { targetGrades: { has: me.grade } }] },
                  { OR: [{ targetDivisions: { isEmpty: true } }, { targetDivisions: { has: me.division } }] },
                ],
              },
              { targetUserId: userId },
            ],
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true, publicId: true, title: true, description: true, kind: true,
        isMandatory: true, minSeconds: true, content: true, videoProvider: true, videoUrl: true,
        completions: { where: { userId }, select: { completedAt: true, secondsSpent: true, cardsSeen: true } },
      },
    });

    return {
      activities: activities.map((a) => ({
        id: a.id,
        publicId: a.publicId,
        title: a.title,
        description: a.description,
        kind: a.kind,
        isMandatory: a.isMandatory,
        cardCount: cardCount(a),
        hasVideo: !!a.videoProvider,
        completedAt: a.completions[0]?.completedAt ?? null,
      })),
    };
  });

  /** Opens an activity and starts (or resumes) the student's progress. */
  app.get('/api/activities/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const userId = request.user!.sub;

    const activity = await activityVisibleTo(id, userId);
    if (!activity) return reply.code(404).send({ error: 'That activity is not available to you.' });

    // Opening it starts the clock; re-opening does not restart it.
    const progress = await prisma.activityCompletion.upsert({
      where: { activityId_userId: { activityId: id, userId } },
      update: {},
      create: { activityId: id, userId },
    });

    return {
      activity: {
        id: activity.id,
        publicId: activity.publicId,
        title: activity.title,
        description: activity.description,
        kind: activity.kind,
        content: activity.content,
        videoUrl: activity.videoUrl,
        videoEmbedUrl: activity.videoEmbedUrl,
        videoProvider: activity.videoProvider,
        minSeconds: activity.minSeconds,
        isMandatory: activity.isMandatory,
        cardCount: cardCount(activity),
      },
      progress: {
        startedAt: progress.startedAt,
        completedAt: progress.completedAt,
        secondsSpent: progress.secondsSpent,
        cardsSeen: progress.cardsSeen,
        videoOpened: progress.videoOpened,
      },
    };
  });

  /**
   * Heartbeat while the activity is open.
   *
   * Time is accumulated on the server from the gap between beats, never taken
   * from the client - otherwise "I have watched it for 300 seconds" would be
   * a single crafted request away.
   */
  app.post('/api/activities/:id/progress', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        cardsSeen: z.number().int().min(0).max(500).optional(),
        videoOpened: z.boolean().optional(),
      })
      .parse(request.body ?? {});

    const userId = request.user!.sub;

    const activity = await activityVisibleTo(id, userId);
    if (!activity) return reply.code(404).send({ error: 'That activity is not available to you.' });

    const progress = await prisma.activityCompletion.findUnique({
      where: { activityId_userId: { activityId: id, userId } },
    });
    if (!progress) return reply.code(409).send({ error: 'Open the activity before recording progress.' });

    // Credit the gap since the last beat, capped so a tab left open overnight
    // does not count as engagement, and floored at 0 against clock skew.
    const elapsedSeconds = Math.round((Date.now() - progress.lastBeatAt.getTime()) / 1000);
    const credited = Math.min(Math.max(elapsedSeconds, 0), 120);

    const updated = await prisma.activityCompletion.update({
      where: { id: progress.id },
      data: {
        lastBeatAt: new Date(),
        secondsSpent: { increment: credited },
        ...(body.cardsSeen !== undefined ? { cardsSeen: Math.max(progress.cardsSeen, body.cardsSeen) } : {}),
        ...(body.videoOpened ? { videoOpened: true } : {}),
      },
    });

    const required = activity.minSeconds;
    return {
      secondsSpent: updated.secondsSpent,
      cardsSeen: updated.cardsSeen,
      secondsRemaining: Math.max(0, required - updated.secondsSpent),
      canComplete: canComplete(activity, updated),
    };
  });

  /** Marks it done, if the student has genuinely been through it. */
  app.post('/api/activities/:id/complete', async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const userId = request.user!.sub;

    const activity = await activityVisibleTo(id, userId);
    if (!activity) return reply.code(404).send({ error: 'That activity is not available to you.' });

    const progress = await prisma.activityCompletion.findUnique({
      where: { activityId_userId: { activityId: id, userId } },
    });
    if (!progress) return reply.code(409).send({ error: 'Open the activity before completing it.' });
    if (progress.completedAt) return { ok: true, alreadyComplete: true, completedAt: progress.completedAt };

    const total = cardCount(activity);
    if (progress.cardsSeen < total) {
      return reply.code(409).send({
        error: `Please read all ${total} card${total === 1 ? '' : 's'} first - you are on ${progress.cardsSeen}.`,
      });
    }
    if (progress.secondsSpent < activity.minSeconds) {
      const left = activity.minSeconds - progress.secondsSpent;
      return reply.code(409).send({
        error: `Please spend a little longer on this - about ${left} more second${left === 1 ? '' : 's'}.`,
        secondsRemaining: left,
      });
    }
    if (activity.videoUrl && !progress.videoOpened) {
      return reply.code(409).send({ error: 'Please start the video before marking this as done.' });
    }

    const done = await prisma.activityCompletion.update({
      where: { id: progress.id },
      data: { completedAt: new Date() },
    });

    const stillPending = await pendingActivitiesFor(userId);

    return {
      ok: true,
      completedAt: done.completedAt,
      remainingActivities: stillPending.length,
      message: stillPending.length > 0
        ? `Done. You have ${stillPending.length} more to go through.`
        : 'Done. You can carry on now.',
    };
  });
}

/**
 * Whether the student has genuinely been through this.
 *
 * Three conditions, and the third was missing. Time is wall-clock time on the
 * page - the system cannot see how much of a video was played, because a
 * YouTube iframe does not report that to the page embedding it - so without
 * requiring the video to have been opened at all, a video activity could be
 * satisfied by leaving the tab open and doing something else. It was being
 * recorded and then ignored.
 *
 * The honest limit remains: this knows the video was opened and that the
 * student stayed on the page for the required time. It does not know they
 * watched. Setting minSeconds to roughly the video's length is what makes the
 * time requirement mean anything.
 */
function canComplete(
  activity: { minSeconds: number; content: unknown; videoUrl?: string | null },
  progress: { secondsSpent: number; cardsSeen: number; videoOpened?: boolean },
): boolean {
  const total = cardCount(activity as never);
  if (progress.cardsSeen < total) return false;
  if (progress.secondsSpent < activity.minSeconds) return false;
  if (activity.videoUrl && !progress.videoOpened) return false;
  return true;
}
