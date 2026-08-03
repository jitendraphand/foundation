import { prisma } from '../db.js';
import { env } from '../env.js';

/**
 * Signed-in sessions.
 *
 * A bare JWT cannot be taken back: once issued it is valid until it expires,
 * so "sign out", "log this device out", "an idle session should end" and "one
 * account, one device" are all impossible to honour. The token now carries
 * only a session id, and this module owns whether that session is still good.
 *
 * The cost is one indexed lookup per request, on a table with a row per active
 * sign-in - a few hundred rows for a school. It is joined into the query the
 * request already makes for the user.
 */

export type RevokeReason = 'signed_out' | 'idle' | 'superseded' | 'password_changed' | 'revoked';

/**
 * How stale a lastSeenAt may get before it is worth another write.
 *
 * Must stay comfortably under the idle timeout: if the activity clock is
 * written less often than the timeout allows, a session dies while its owner
 * is actively using it. A minute is plenty for the default half-hour, and the
 * divisor keeps it honest if someone sets a much shorter timeout.
 */
function touchAfterMs(): number {
  const idleMs = env.IDLE_TIMEOUT_MINUTES * 60_000;
  if (idleMs <= 0) return 60_000;
  return Math.max(1_000, Math.min(60_000, Math.floor(idleMs / 3)));
}

export interface SessionCheck {
  ok: boolean;
  reason?: RevokeReason | 'expired' | 'unknown';
  message?: string;
}

export async function createSession(
  userId: string,
  opts: { ip?: string; userAgent?: string; singleDevice: boolean },
): Promise<{ id: string; expiresAt: Date; supersededCount: number }> {
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_MINUTES * 60_000);

  // One account, one device: signing in here ends every other live session for
  // this user. Deliberately newest-wins rather than refusing the new sign-in -
  // refusing would lock a student out of their own account until the old
  // session timed out, which is exactly what happens when a browser crashes
  // mid-exam.
  let supersededCount = 0;
  if (opts.singleDevice) {
    const { count } = await prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'superseded' },
    });
    supersededCount = count;
  }

  const session = await prisma.session.create({
    data: {
      userId,
      expiresAt,
      ip: opts.ip ?? null,
      // Trimmed: the full string is long, and this is only ever shown back to
      // the person who was signed out so they recognise the other device.
      userAgent: opts.userAgent?.slice(0, 250) ?? null,
    },
  });

  return { id: session.id, expiresAt, supersededCount };
}

/**
 * Is this session still usable, and roll its activity clock forward.
 *
 * Returns the reason when it is not, so the sign-in screen can say "you were
 * signed out because you signed in on another device" rather than the
 * uniformly unhelpful "your session has expired".
 */
export async function touchSession(sessionId: string): Promise<SessionCheck> {
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { id: true, revokedAt: true, revokedReason: true, expiresAt: true, lastSeenAt: true },
  });

  if (!session) return { ok: false, reason: 'unknown', message: 'Please sign in again.' };

  if (session.revokedAt) {
    return { ok: false, reason: (session.revokedReason as RevokeReason) ?? 'revoked', message: revokeMessage(session.revokedReason) };
  }

  const now = Date.now();

  if (session.expiresAt.getTime() <= now) {
    await revokeSession(session.id, 'revoked');
    return { ok: false, reason: 'expired', message: 'Your session has expired. Please sign in again.' };
  }

  // Idle timeout. Measured from the last request, not from sign-in, so someone
  // working steadily is never interrupted. A student writing a paper sends a
  // heartbeat every 20 seconds, so an exam cannot go idle underneath them.
  const idleMs = env.IDLE_TIMEOUT_MINUTES * 60_000;
  if (idleMs > 0 && now - session.lastSeenAt.getTime() > idleMs) {
    await revokeSession(session.id, 'idle');
    return { ok: false, reason: 'idle', message: revokeMessage('idle') };
  }

  // Throttled: rolling this forward on every single request would double the
  // writes of a heartbeat for no benefit.
  if (now - session.lastSeenAt.getTime() > touchAfterMs()) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => undefined);
  }

  return { ok: true };
}

export async function revokeSession(sessionId: string, reason: RevokeReason): Promise<void> {
  await prisma.session
    .updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } })
    .catch(() => undefined);
}

/** Ends every live session for a user. Used when a password changes. */
export async function revokeAllSessions(userId: string, reason: RevokeReason, except?: string): Promise<number> {
  const { count } = await prisma.session.updateMany({
    where: { userId, revokedAt: null, ...(except ? { id: { not: except } } : {}) },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return count;
}

export function revokeMessage(reason: string | null): string {
  switch (reason) {
    case 'superseded':
      return 'You have been signed out because this account was signed in on another device. Only one device at a time is allowed.';
    case 'idle':
      return 'You were signed out after a period of inactivity. Please sign in again.';
    case 'password_changed':
      return 'Your password was changed, so you have been signed out everywhere. Please sign in again.';
    case 'signed_out':
      return 'You have been signed out.';
    default:
      return 'Your session has ended. Please sign in again.';
  }
}

/**
 * Housekeeping. Revoked and expired rows are useful for a little while - they
 * are what lets the sign-in screen explain what happened - then they are just
 * rows.
 */
export async function pruneSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60_000);
  const { count } = await prisma.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });
  return count;
}
