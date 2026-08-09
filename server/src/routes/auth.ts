import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { checkPassword, hashPassword, verifyPassword } from '../lib/password.js';
import { allocateUsername } from '../lib/username.js';
import jwt from 'jsonwebtoken';
import { env } from '../env.js';
import { COOKIE_NAME, audit, authenticate, clearSessionCookie, setSessionCookie, signSession } from '../middleware/auth.js';
import { createSession, revokeAllSessions, revokeSession } from '../services/sessions.js';

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

const signupSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required.').max(60),
  lastName: z.string().trim().min(1, 'Last name is required.').max(60),
  grade: z.string().trim().min(1, 'Grade is required.').max(20),
  division: z.string().trim().min(1, 'Division is required.').max(20),
  rollNo: z.string().trim().min(1, 'Roll number is required.').max(20),
  dateOfBirth: z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Enter a valid date of birth.'),
  password: z.string().min(1, 'Password is required.'),
});

export default async function authRoutes(app: FastifyInstance) {
  /** Grades and divisions for the signup dropdowns. Public: needed before login. */
  app.get('/api/auth/classes', async () => {
    const rows = await prisma.schoolClass.findMany({
      where: { isActive: true },
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }],
      select: { kind: true, code: true, label: true },
    });
    return {
      grades: rows.filter((r) => r.kind === 'GRADE').map(({ code, label }) => ({ code, label })),
      divisions: rows.filter((r) => r.kind === 'DIVISION').map(({ code, label }) => ({ code, label })),
    };
  });

  /** Live password-policy feedback for the signup form. */
  app.post('/api/auth/check-password', async (request) => {
    const body = z.object({ password: z.string().max(200) }).parse(request.body);
    return checkPassword(body.password);
  });

  app.post('/api/auth/signup', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const parsed = signupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid details.', issues: parsed.error.issues });
    }
    const body = parsed.data;

    const policy = checkPassword(body.password, { firstName: body.firstName, lastName: body.lastName });
    if (!policy.ok) return reply.code(400).send({ error: policy.errors.join(' '), passwordErrors: policy.errors });

    const dob = new Date(body.dateOfBirth);
    const now = new Date();
    if (dob > now) return reply.code(400).send({ error: 'Date of birth cannot be in the future.' });
    if (now.getFullYear() - dob.getFullYear() > 100) return reply.code(400).send({ error: 'Please check the date of birth.' });

    // Grade and division must exist, so analytics never sees "8th" vs "VIII".
    const [grade, division] = await Promise.all([
      prisma.schoolClass.findUnique({ where: { kind_code: { kind: 'GRADE', code: body.grade } } }),
      prisma.schoolClass.findUnique({ where: { kind_code: { kind: 'DIVISION', code: body.division } } }),
    ]);
    if (!grade || !grade.isActive) return reply.code(400).send({ error: 'Please choose a valid grade.' });
    if (!division || !division.isActive) return reply.code(400).send({ error: 'Please choose a valid division.' });

    const passwordHash = await hashPassword(body.password);

    // Retry once on a username race: two people signing up with the same name
    // at the same instant can both pick the same suffix.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const user = await prisma.$transaction(async (tx) => {
          const username = await allocateUsername(tx, body.firstName, body.lastName);
          return tx.user.create({
            data: {
              username,
              firstName: body.firstName,
              lastName: body.lastName,
              grade: body.grade,
              division: body.division,
              // A child signing up puts themselves in one division; a second
              // is an administrator's decision, not theirs.
              divisions: [body.division],
              rollNo: body.rollNo,
              dateOfBirth: dob,
              passwordHash,
              role: 'STUDENT',
            },
            select: { id: true, publicId: true, username: true, firstName: true, lastName: true, role: true },
          });
        });

        await audit(user.id, 'user.signup', { entity: 'User', entityId: user.id, ip: request.ip });

        const session = await createSession(user.id, {
          ip: request.ip,
          userAgent: request.headers['user-agent'],
          singleDevice: env.SINGLE_DEVICE_LOGIN,
        });
        const token = signSession({ sub: user.id, username: user.username, role: user.role, sid: session.id });
        setSessionCookie(reply, token);

        return reply.code(201).send({
          user: { id: user.id, publicId: user.publicId, username: user.username, firstName: user.firstName, lastName: user.lastName, role: user.role },
          message: `Welcome. Your username is ${user.username} - please remember it, you will use it to sign in. Your user ID is ${user.publicId}.`,
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const target = (err.meta?.target as string[] | string | undefined) ?? '';
          const fields = Array.isArray(target) ? target.join(',') : String(target);

          if (fields.includes('rollNo') || fields.includes('roll_in_class')) {
            return reply.code(409).send({
              error: `Roll number ${body.rollNo} is already registered for Grade ${body.grade} Division ${body.division}. Please check your roll number.`,
            });
          }
          if (fields.includes('username')) continue; // race - retry
        }
        throw err;
      }
    }

    return reply.code(500).send({ error: 'Could not create your account. Please try again.' });
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const body = z
      .object({ username: z.string().trim().min(1).max(60), password: z.string().min(1).max(200) })
      .parse(request.body);

    const user = await prisma.user.findUnique({ where: { username: body.username.toLowerCase() } });

    // Uniform failure message: never reveal whether a username exists.
    const fail = () => reply.code(401).send({ error: 'Incorrect username or password.' });

    if (!user || user.deletedAt) {
      // Constant-ish time: still spend the cost of a verify on a dummy hash.
      await verifyPassword('$argon2id$v=19$m=65536,t=3,p=1$YWJjZGVmZ2hpamts$3g2Zx2Q0y0m1Xz0000000000000000000000000000', body.password);
      return fail();
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      return reply.code(429).send({ error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
    }

    const ok = await verifyPassword(user.passwordHash, body.password);

    if (!ok) {
      const failed = user.failedLogins + 1;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLogins: failed,
          lockedUntil: failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null,
        },
      });
      await audit(user.id, 'auth.login_failed', { entity: 'User', entityId: user.id, ip: request.ip });
      return fail();
    }

    if (!user.isActive) {
      return reply.code(403).send({ error: 'This account has been deactivated. Please contact your administrator.' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    await audit(user.id, 'auth.login', { entity: 'User', entityId: user.id, ip: request.ip });

    // One account, one device: this ends any session already running for it.
    const session = await createSession(user.id, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      singleDevice: env.SINGLE_DEVICE_LOGIN,
    });
    setSessionCookie(reply, signSession({ sub: user.id, username: user.username, role: user.role, sid: session.id }));

    return {
      // Worth saying out loud: if this account was open elsewhere, that
      // session has just been ended, and the person using it will be told why.
      displacedOtherDevice: session.supersededCount > 0,
      user: {
        id: user.id,
        publicId: user.publicId,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        permissions: user.permissions,
        mustChangePassword: user.mustChangePassword,
      },
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    // Clearing the cookie only stops this browser sending the token; the token
    // itself stays valid until it expires. Ending the session is what makes
    // signing out mean something.
    const token = request.cookies?.[COOKIE_NAME];
    if (token) {
      try {
        const claims = jwt.verify(token, env.JWT_SECRET) as { sid?: string };
        if (claims.sid) await revokeSession(claims.sid, 'signed_out');
      } catch {
        // An expired or forged token has nothing to revoke.
      }
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: authenticate }, async (request) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: request.user!.sub },
      select: {
        id: true, publicId: true, username: true, firstName: true, lastName: true, grade: true, division: true,
        rollNo: true, dateOfBirth: true, role: true, permissions: true, mustChangePassword: true, lastLoginAt: true, createdAt: true,
      },
    });
    return { user };
  });

  app.post('/api/auth/change-password', { preHandler: authenticate }, async (request, reply) => {
    const body = z
      .object({ currentPassword: z.string().min(1), newPassword: z.string().min(1).max(200) })
      .parse(request.body);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: request.user!.sub } });

    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
      return reply.code(401).send({ error: 'Your current password is not correct.' });
    }

    const policy = checkPassword(body.newPassword, {
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
    });
    if (!policy.ok) return reply.code(400).send({ error: policy.errors.join(' '), passwordErrors: policy.errors });

    if (await verifyPassword(user.passwordHash, body.newPassword)) {
      return reply.code(400).send({ error: 'Your new password must be different from the current one.' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await hashPassword(body.newPassword),
        mustChangePassword: false,
        passwordSetAt: new Date(),
      },
    });
    // A password change should log out anywhere the old one was used.
    const endedElsewhere = await revokeAllSessions(user.id, 'password_changed', request.user!.sid);

    await audit(user.id, 'auth.password_changed', {
      entity: 'User', entityId: user.id, ip: request.ip, detail: { endedElsewhere },
    });

    return {
      ok: true,
      message:
        'Your password has been updated.' +
        (endedElsewhere > 0 ? ' Any other device signed in with the old password has been signed out.' : ''),
    };
  });
}
