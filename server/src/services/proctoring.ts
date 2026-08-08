import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';

/**
 * Optional proctoring.
 *
 * What a browser can honestly do, and what it cannot, matters more here than
 * the feature list - a school that believes this prevents cheating will
 * supervise less, which makes things worse rather than better.
 *
 * What it can see: the tab losing focus, the page being hidden behind another
 * window or app, fullscreen being left, and the paper being reloaded. On a
 * phone, switching apps hides the page, so that is caught too.
 *
 * What it cannot see: a second device, a person in the room, notes on paper,
 * or a screenshot. It cannot stop any of those, and it cannot stop a
 * determined student disabling JavaScript - though that also stops the paper
 * working at all.
 *
 * So this is a deterrent and a record, not a lock. It makes casual
 * tab-switching visibly costly, and gives the invigilator a list afterwards.
 * The documentation says exactly this, because an honest limitation is worth
 * more than an implied guarantee.
 *
 * Events are recorded on the attempt rather than trusted from the client for
 * enforcement: the client reports them, the server counts them and decides
 * when the allowance is spent, so editing the page cannot raise the limit.
 */

export type ProctorEventKind = 'blur' | 'hidden' | 'fullscreen_exit' | 'reload';

export interface ProctorSettings {
  enabled: boolean;
  /** How many times a student may leave before the paper is taken away. */
  allowance: number;
  /** Whether leaving fullscreen counts, or only hiding the page entirely. */
  requireFullscreen: boolean;
}

export const DEFAULT_PROCTORING: ProctorSettings = {
  enabled: false,
  allowance: 3,
  requireFullscreen: true,
};

export function proctoringFor(test: { meta: unknown }): ProctorSettings {
  const meta = (test.meta ?? {}) as { proctoring?: Partial<ProctorSettings> };
  const stored = meta.proctoring;
  if (!stored?.enabled) return DEFAULT_PROCTORING;

  return {
    enabled: true,
    // Zero would mean the first slip ends the paper, which is too harsh for a
    // notification popping up on a school laptop. One is the floor.
    allowance: Math.max(1, Math.min(20, Math.floor(stored.allowance ?? DEFAULT_PROCTORING.allowance))),
    requireFullscreen: stored.requireFullscreen ?? true,
  };
}

export interface ProctorLogEntry {
  kind: ProctorEventKind;
  at: string;
  /** How long the student was away, when the client could measure it. */
  awayMs?: number;
}

export interface ProctorState {
  events: ProctorLogEntry[];
  count: number;
}

export function proctorStateOf(attempt: { meta: unknown }): ProctorState {
  const meta = (attempt.meta ?? {}) as { proctor?: { events?: ProctorLogEntry[] } };
  const events = Array.isArray(meta.proctor?.events) ? meta.proctor!.events! : [];
  return { events, count: events.length };
}

/**
 * Records one event and says what should happen next.
 *
 * The decision is made here, from the stored count, rather than by the client
 * reporting "that was my third". A page that has been edited can lie about
 * anything it computes; it cannot lie about how many events the server has
 * already written down.
 */
export async function recordProctorEvent(
  attemptId: string,
  kind: ProctorEventKind,
  awayMs: number | undefined,
  settings: ProctorSettings,
): Promise<{ count: number; remaining: number; shouldSubmit: boolean }> {
  const attempt = await prisma.attempt.findUnique({ where: { id: attemptId }, select: { meta: true } });
  const state = proctorStateOf(attempt ?? { meta: {} });

  // Capped so a page stuck in a blur/focus loop cannot grow the row without
  // bound; the count past the allowance is all that matters anyway.
  const events = [...state.events, { kind, at: new Date().toISOString(), ...(awayMs ? { awayMs } : {}) }].slice(-50);

  await prisma.attempt.update({
    where: { id: attemptId },
    data: {
      meta: { ...((attempt?.meta ?? {}) as object), proctor: { events } } as unknown as Prisma.InputJsonValue,
    },
  });

  const count = events.length;
  return {
    count,
    remaining: Math.max(0, settings.allowance - count),
    shouldSubmit: count > settings.allowance,
  };
}
