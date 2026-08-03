import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { cookieSecure, env } from '../env.js';
import { touchSession } from '../services/sessions.js';
import { prisma } from '../db.js';
import type { Role } from '@prisma/client';
import { hasAnyPermission, sanitizePermissions, type Permission } from '../lib/permissions.js';

export const COOKIE_NAME = 'foundation_session';

export interface SessionClaims {
  sub: string;
  username: string;
  role: Role;
  /**
   * The Session row backing this token. Without it a JWT can only be waited
   * out; with it, signing out, an idle timeout and "one account, one device"
   * all become possible.
   */
  sid?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionClaims & { mustChangePassword: boolean; permissions: Permission[] };
  }
}

export function signSession(claims: SessionClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: `${env.SESSION_TTL_MINUTES}m` });
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    // Caddy terminates TLS, so cookies are marked Secure in production. A
    // plain-HTTP trial can turn that off with COOKIE_SECURE=false, because a
    // browser will not store a Secure cookie from http://192.168.x.x.
    secure: cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: env.SESSION_TTL_MINUTES * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(COOKIE_NAME, { path: '/' });
}

/**
 * Resolves the session. The user row is re-read on every request rather than
 * trusted from the token, so deactivating or deleting a user takes effect
 * immediately instead of when their token happens to expire.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies?.[COOKIE_NAME];
  if (!token) return reply.code(401).send({ error: 'Not signed in.' });

  let claims: SessionClaims;
  try {
    claims = jwt.verify(token, env.JWT_SECRET) as SessionClaims;
  } catch {
    clearSessionCookie(reply);
    return reply.code(401).send({ error: 'Your session has expired. Please sign in again.' });
  }

  // The session row decides whether this token is still good, and rolls its
  // idle clock forward. A token issued before sessions existed has no sid and
  // is simply retired, which costs one re-login.
  if (!claims.sid) {
    clearSessionCookie(reply);
    return reply.code(401).send({ error: 'Please sign in again.', code: 'SESSION_ENDED' });
  }

  const check = await touchSession(claims.sid);
  if (!check.ok) {
    clearSessionCookie(reply);
    return reply.code(401).send({ error: check.message ?? 'Your session has ended.', code: 'SESSION_ENDED', reason: check.reason });
  }

  // Privileges are read from the row on every request, never from the token,
  // so revoking one takes effect immediately rather than when it expires.
  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: {
      id: true, username: true, role: true, isActive: true,
      deletedAt: true, mustChangePassword: true, permissions: true,
    },
  });

  if (!user || user.deletedAt) {
    clearSessionCookie(reply);
    return reply.code(401).send({ error: 'This account no longer exists.' });
  }
  if (!user.isActive) {
    clearSessionCookie(reply);
    return reply.code(403).send({ error: 'This account has been deactivated. Please contact your administrator.' });
  }

  request.user = {
    sub: user.id,
    username: user.username,
    role: user.role,
    sid: claims.sid,
    mustChangePassword: user.mustChangePassword,
    permissions: sanitizePermissions(user.permissions),
  };
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  await authenticate(request, reply);
  if (reply.sent) return;
  if (request.user?.role !== 'ADMIN') {
    return reply.code(403).send({ error: 'Administrator access is required.' });
  }
}

/**
 * Gates a route on one or more privileges. Pass several to mean "any of
 * these"; use it twice to mean "all of these".
 *
 * Runs after requireAdmin, so by this point the caller is known to be an
 * administrator - this only decides which parts of the admin area they reach.
 */
export function requirePermission(required: Permission | Permission[]) {
  const needed = Array.isArray(required) ? required : [required];

  return async function check(request: FastifyRequest, reply: FastifyReply) {
    const granted = request.user?.permissions ?? [];
    if (hasAnyPermission(granted, needed)) return;

    return reply.code(403).send({
      error: 'You do not have permission to do that. Ask an administrator to grant it to you.',
      code: 'PERMISSION_DENIED',
      required: needed,
    });
  };
}

/**
 * Blocks normal work until a forced password change is done. Applied to
 * everything except /auth/me and /auth/change-password.
 */
export async function requireFreshPassword(request: FastifyRequest, reply: FastifyReply) {
  if (request.user?.mustChangePassword) {
    return reply.code(428).send({
      error: 'You must set a new password before continuing.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }
}

/**
 * Stops a student at the door until every mandatory activity is done.
 *
 * Applied to the student routes only. The activity routes themselves, sign-in
 * and the password change are deliberately outside it - blocking the very
 * screens needed to clear the block would leave nowhere to go.
 *
 * Administrators are never held; the check in pendingActivitiesFor short
 * circuits for them.
 *
 * A student already writing a paper is not held either. An activity published
 * during a test would otherwise throw the whole class out of it, and - because
 * the exam clock is server-side and keeps running - they could not even submit
 * what they had written. Same reasoning as an availability window closing
 * mid-attempt: the gate applies to what they do next, not to the paper in
 * front of them. It resumes the moment they submit.
 */
export async function requireActivitiesComplete(request: FastifyRequest, reply: FastifyReply) {
  if (!request.user || request.user.role !== 'STUDENT') return;

  const writing = await prisma.attempt.count({
    where: { userId: request.user.sub, status: 'IN_PROGRESS' },
  });
  if (writing > 0) return;

  const { hasPendingActivity } = await import('../services/activities.js');
  const pending = await hasPendingActivity(request.user.sub);
  if (!pending) return;

  return reply.code(428).send({
    error: `Please complete "${pending.title}" before continuing.`,
    code: 'ACTIVITY_REQUIRED',
    activity: pending,
  });
}

export async function audit(
  actorId: string | null,
  action: string,
  opts: { entity?: string; entityId?: string; ip?: string; detail?: unknown } = {},
) {
  await prisma.auditLog
    .create({
      data: {
        actorId,
        action,
        entity: opts.entity ?? null,
        entityId: opts.entityId ?? null,
        ip: opts.ip ?? null,
        detail: (opts.detail ?? {}) as object,
      },
    })
    .catch(() => undefined); // auditing must never break the request
}
