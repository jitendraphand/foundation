import jwt from 'jsonwebtoken';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env, isProd } from '../env.js';
import { prisma } from '../db.js';
import type { Role } from '@prisma/client';

export const COOKIE_NAME = 'foundation_session';

export interface SessionClaims {
  sub: string;
  username: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: SessionClaims & { mustChangePassword: boolean };
  }
}

export function signSession(claims: SessionClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: `${env.SESSION_TTL_MINUTES}m` });
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    // Caddy terminates TLS, so cookies are only marked Secure in production.
    secure: isProd,
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

  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: { id: true, username: true, role: true, isActive: true, deletedAt: true, mustChangePassword: true },
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
    mustChangePassword: user.mustChangePassword,
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
