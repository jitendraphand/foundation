import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { checkPassword, hashPassword } from '../../lib/password.js';
import { allocateUsername } from '../../lib/username.js';
import { audit, requirePermission } from '../../middleware/auth.js';
import { ALL_PERMISSIONS, PERMISSIONS, PRESETS, sanitizePermissions, type Permission } from '../../lib/permissions.js';
import { revokeAllSessions } from '../../services/sessions.js';

/**
 * Turns whatever the admin sent into the pair of columns the database keeps.
 *
 * A student has a home division - the one their roll number is unique inside -
 * and a list of every division they belong to. Those must never disagree, so
 * there is exactly one function that decides both, and it is the only thing any
 * write path calls.
 *
 * The home division wins its place at the front, whether it arrived on its own,
 * inside the list, or both. Duplicates are dropped rather than rejected: an
 * admin ticking "Science Foundation" on a child already filed under it has
 * expressed no error worth a message.
 */
function setDivisions(home: string, extra?: string[]): { division: string; divisions: string[] } {
  const all = [home, ...(extra ?? [])].map((d) => d.trim()).filter(Boolean);
  return { division: home, divisions: [...new Set(all)] };
}

/** Every division code named in a create or edit, for one existence check. */
function divisionCodes(home: string | undefined, extra: string[] | undefined): string[] {
  return [...new Set([home, ...(extra ?? [])].filter((d): d is string => !!d && d.trim() !== ''))];
}

/**
 * Which of these division codes are not real. Named so the message can list
 * them, rather than saying "that division does not exist" about a set of four.
 */
async function unknownDivisions(codes: string[]): Promise<string[]> {
  if (codes.length === 0) return [];
  const found = await prisma.schoolClass.findMany({
    where: { kind: 'DIVISION', code: { in: codes } },
    select: { code: true },
  });
  return codes.filter((c) => !found.some((f) => f.code === c));
}

/**
 * The account a write is aimed at, or the reason this administrator may not
 * have it.
 *
 * `users.manage` means "enrol and look after students" - it is what the Office
 * preset grants a school secretary, alongside nothing else but reporting. Every
 * endpoint below takes a bare user id, and an administrator's id is the same
 * shape as a child's, so without this the secretary could point the reset at
 * the founding administrator, choose its new password, and sign in holding
 * every privilege in the system. Editing, deactivating and deleting one are the
 * same story more slowly.
 *
 * Administrators are managed under `admins.manage`. Somebody without it is told
 * the account does not exist rather than that they may not touch it: whether a
 * particular id belongs to an administrator is not a fact worth confirming to
 * someone who has just tried to reach one.
 */
async function accountToWrite(request: FastifyRequest, id: string) {
  const user = await prisma.user.findFirst({ where: { id, deletedAt: null } });
  if (!user) return null;
  if (user.role === 'ADMIN' && !(request.user?.permissions ?? []).includes('admins.manage')) return null;
  return user;
}

export default async function adminUserRoutes(app: FastifyInstance) {
  /** Paginated, searchable user list. */
  app.get('/api/admin/users', { preHandler: requirePermission('users.manage') }, async (request) => {
    const q = z
      .object({
        search: z.string().optional(),
        grade: z.string().optional(),
        division: z.string().optional(),
        status: z.enum(['all', 'active', 'inactive']).default('all'),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(25),
        sort: z.enum(['name', 'username', 'roll', 'created', 'lastLogin']).default('name'),
      })
      .parse(request.query);

    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      role: 'STUDENT',
      ...(q.grade ? { grade: q.grade } : {}),
      // Membership, not the home division: filtering by Sports Foundation has
      // to find the child whose home division is Science Foundation and who is
      // in Sports Foundation as well.
      ...(q.division ? { divisions: { has: q.division } } : {}),
      ...(q.status === 'active' ? { isActive: true } : q.status === 'inactive' ? { isActive: false } : {}),
      ...(q.search
        ? {
            OR: [
              { firstName: { contains: q.search, mode: 'insensitive' } },
              { lastName: { contains: q.search, mode: 'insensitive' } },
              { username: { contains: q.search, mode: 'insensitive' } },
              { rollNo: { contains: q.search, mode: 'insensitive' } },
              { publicId: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const orderBy: Prisma.UserOrderByWithRelationInput[] =
      q.sort === 'username' ? [{ username: 'asc' }] :
      q.sort === 'roll' ? [{ grade: 'asc' }, { division: 'asc' }, { rollNo: 'asc' }] :
      q.sort === 'created' ? [{ createdAt: 'desc' }] :
      q.sort === 'lastLogin' ? [{ lastLoginAt: 'desc' }] :
      [{ firstName: 'asc' }, { lastName: 'asc' }];

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true, publicId: true, username: true, firstName: true, lastName: true, grade: true, division: true,
          divisions: true, rollNo: true, dateOfBirth: true, isActive: true, lastLoginAt: true, createdAt: true,
          _count: { select: { attempts: true } },
        },
      }),
    ]);

    return { total, page: q.page, pageSize: q.pageSize, users };
  });

  /** One student, with their full performance profile. */
  app.get('/api/admin/users/:id', { preHandler: requirePermission('users.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const user = await prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, publicId: true, username: true, firstName: true, lastName: true, grade: true, division: true,
        divisions: true, rollNo: true, dateOfBirth: true, isActive: true, role: true, lastLoginAt: true,
        createdAt: true, mustChangePassword: true,
      },
    });
    if (!user || (user.role === 'ADMIN' && !(request.user?.permissions ?? []).includes('admins.manage'))) {
      return reply.code(404).send({ error: 'Account not found.' });
    }

    const attempts = await prisma.attempt.findMany({
      where: { userId: id, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } },
      orderBy: { submittedAt: 'desc' },
      select: {
        id: true, score: true, maxScore: true, percentage: true, submittedAt: true,
        correctCount: true, incorrectCount: true, unansweredCount: true, breakdown: true,
        test: { select: { id: true, title: true, subject: true, kind: true } },
      },
    });

    return { user, attempts };
  });

  const editSchema = z.object({
    firstName: z.string().trim().min(1).max(60).optional(),
    lastName: z.string().trim().min(1).max(60).optional(),
    grade: z.string().trim().min(1).max(20).optional(),
    division: z.string().trim().min(1).max(20).optional(),
    /**
     * Additional divisions beyond the home one. Sending this replaces the whole
     * set, so the UI always posts the full list rather than a delta - a delta
     * would need a removal verb and two tabs open would then fight.
     */
    divisions: z.array(z.string().trim().min(1).max(20)).max(20).optional(),
    rollNo: z.string().trim().min(1).max(20).optional(),
    dateOfBirth: z.string().optional(),
    isActive: z.boolean().optional(),
    /**
     * Set the username directly. Lowercase letters and digits only, so it
     * stays easy for a child to type and safe to put in a URL.
     */
    username: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(40)
      .regex(/^[a-z][a-z0-9]*$/, 'A username must start with a letter and contain only lowercase letters and numbers.')
      .optional(),
    /** Re-derive the username from the (possibly new) name instead. */
    regenerateUsername: z.boolean().optional(),
  });

  app.patch('/api/admin/users/:id', { preHandler: requirePermission('users.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = editSchema.parse(request.body);

    const before = await accountToWrite(request, id);
    if (!before) return reply.code(404).send({ error: 'Account not found.' });

    if (body.grade) {
      const g = await prisma.schoolClass.findUnique({ where: { kind_code: { kind: 'GRADE', code: body.grade } } });
      if (!g) return reply.code(400).send({ error: 'That grade does not exist.' });
    }
    const unknown = await unknownDivisions(divisionCodes(body.division, body.divisions));
    if (unknown.length) {
      return reply.code(400).send({
        error: `${unknown.length === 1 ? 'This division does' : 'These divisions do'} not exist: ${unknown.join(', ')}.`,
      });
    }

    const data: Prisma.UserUpdateInput = {
      ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
      ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
      ...(body.grade !== undefined ? { grade: body.grade } : {}),
      ...(body.rollNo !== undefined ? { rollNo: body.rollNo } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    };

    // Both columns move together or neither does; see setDivisions. The home
    // division falls back to the stored one, so an edit that only adds a second
    // division does not have to restate the first.
    if (body.division !== undefined || body.divisions !== undefined) {
      Object.assign(data, setDivisions(body.division ?? before.division, body.divisions));
    }

    if (body.dateOfBirth) {
      const dob = new Date(body.dateOfBirth);
      if (Number.isNaN(dob.getTime())) return reply.code(400).send({ error: 'Invalid date of birth.' });
      data.dateOfBirth = dob;
    }

    // An explicit username wins over "re-derive it from the name".
    if (body.username && body.regenerateUsername) {
      return reply.code(400).send({
        error: 'Choose either a specific username or re-generate it from the name, not both.',
      });
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        if (body.username) {
          data.username = body.username;
        } else if (body.regenerateUsername) {
          data.username = await allocateUsername(
            tx,
            body.firstName ?? before.firstName,
            body.lastName ?? before.lastName,
          );
        }
        // publicId is deliberately never touched: it is the stable identity
        // that survives every spelling correction made here.
        return tx.user.update({
          where: { id },
          data,
          select: { id: true, publicId: true, username: true },
        });
      });

      await audit(request.user!.sub, 'user.update', {
        entity: 'User',
        entityId: id,
        ip: request.ip,
        detail: {
          publicId: before.publicId,
          before: {
            username: before.username,
            firstName: before.firstName,
            lastName: before.lastName,
            grade: before.grade,
            division: before.division,
            divisions: before.divisions,
            rollNo: before.rollNo,
            isActive: before.isActive,
          },
          after: body,
        },
      });

      return {
        ok: true,
        user: updated,
        ...(updated.username !== before.username
          ? { message: `Username changed from ${before.username} to ${updated.username}. Tell the student their new username.` }
          : {}),
      };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | string | undefined) ?? '';
        const fields = Array.isArray(target) ? target.join(',') : String(target);
        if (fields.includes('username')) {
          return reply.code(409).send({ error: `The username "${body.username}" is already taken.` });
        }
        return reply.code(409).send({
          error: 'Another student already has that roll number in that grade and division.',
        });
      }
      throw err;
    }
  });

  /** Checks a username before the admin commits to it. */
  app.get('/api/admin/users/username-available', { preHandler: requirePermission('users.manage') }, async (request) => {
    const q = z
      .object({ username: z.string().trim().toLowerCase().min(1).max(40), excludeUserId: z.string().uuid().optional() })
      .parse(request.query);

    if (!/^[a-z][a-z0-9]*$/.test(q.username) || q.username.length < 3) {
      return { available: false, reason: 'Use at least 3 characters: lowercase letters and numbers, starting with a letter.' };
    }

    const existing = await prisma.user.findUnique({ where: { username: q.username }, select: { id: true } });
    if (existing && existing.id !== q.excludeUserId) {
      return { available: false, reason: 'That username is already taken.' };
    }
    return { available: true };
  });

  app.post('/api/admin/users/:id/activate', { preHandler: requirePermission('users.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { isActive } = z.object({ isActive: z.boolean() }).parse(request.body);

    if (id === request.user!.sub && !isActive) {
      return reply.code(400).send({ error: 'You cannot deactivate your own account.' });
    }

    const user = await accountToWrite(request, id);
    if (!user) return reply.code(404).send({ error: 'Account not found.' });

    if (!isActive && user.permissions.includes('admins.manage')) {
      const holders = await prisma.user.count({
        where: { role: 'ADMIN', deletedAt: null, isActive: true, permissions: { has: 'admins.manage' } },
      });
      if (holders <= 1) {
        return reply.code(400).send({
          error: 'This is the only active account that can manage administrators, so it cannot be deactivated.',
        });
      }
    }

    await prisma.user.update({ where: { id }, data: { isActive } });
    // authenticate already refuses a deactivated account on the next request;
    // ending the session as well means the browser is told to sign in again
    // rather than sitting on a dead page.
    if (!isActive) await revokeAllSessions(id, 'revoked');

    await audit(request.user!.sub, isActive ? 'user.activate' : 'user.deactivate', {
      entity: 'User', entityId: id, ip: request.ip,
    });

    return { ok: true, isActive };
  });

  app.post('/api/admin/users/:id/reset-password', { preHandler: requirePermission('users.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ newPassword: z.string().min(1).max(200) }).parse(request.body);

    // Resetting your own would sign you out of the session you are doing it
    // from and then demand you choose the password again at the door. Changing
    // it is the path for that, and it asks for the current one first.
    if (id === request.user!.sub) {
      return reply.code(400).send({ error: 'To change your own password, use Change password.' });
    }

    const user = await accountToWrite(request, id);
    if (!user) return reply.code(404).send({ error: 'Account not found.' });

    const policy = checkPassword(body.newPassword, {
      username: user.username, firstName: user.firstName, lastName: user.lastName,
    });
    if (!policy.ok) return reply.code(400).send({ error: policy.errors.join(' ') });

    await prisma.user.update({
      where: { id },
      data: {
        passwordHash: await hashPassword(body.newPassword),
        // They must pick their own on next sign-in.
        mustChangePassword: true,
        failedLogins: 0,
        lockedUntil: null,
        passwordSetAt: new Date(),
      },
    });
    // The old password must stop working everywhere it is signed in, or
    // resetting it for a student who has lost control of their account would
    // achieve nothing until their session happened to expire.
    const endedSessions = await revokeAllSessions(id, 'password_changed');

    await audit(request.user!.sub, 'user.password_reset', {
      entity: 'User', entityId: id, ip: request.ip, detail: { endedSessions },
    });

    return {
      ok: true,
      message:
        `Temporary password set for ${user.username}. They will be asked to choose a new one when they sign in.` +
        (endedSessions > 0 ? ' They have been signed out of every device.' : ''),
    };
  });

  /**
   * Delete. Soft by default so historical results survive; hard delete is
   * available but removes every attempt and answer with it.
   */
  app.delete('/api/admin/users/:id', { preHandler: requirePermission('users.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { hard } = z.object({ hard: z.coerce.boolean().default(false) }).parse(request.query);

    if (id === request.user!.sub) return reply.code(400).send({ error: 'You cannot delete your own account.' });

    const user = await accountToWrite(request, id);
    if (!user) return reply.code(404).send({ error: 'Account not found.' });

    // Never leave the system with nobody able to grant privileges again.
    if (user.permissions.includes('admins.manage')) {
      const holders = await prisma.user.count({
        where: { role: 'ADMIN', deletedAt: null, isActive: true, permissions: { has: 'admins.manage' } },
      });
      if (holders <= 1) {
        return reply.code(400).send({
          error: 'This is the only account that can manage administrators. Grant that privilege to someone else first.',
        });
      }
    }

    if (hard) {
      await prisma.user.delete({ where: { id } });
      await audit(request.user!.sub, 'user.delete_hard', {
        entity: 'User', entityId: id, ip: request.ip, detail: { username: user.username },
      });
      return { ok: true, mode: 'hard', message: `${user.username} and all of their results have been permanently deleted.` };
    }

    // Soft delete: free the username and roll number for reuse, keep the row.
    await prisma.user.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        isActive: false,
        username: `${user.username}.deleted.${Date.now().toString(36)}`,
        rollNo: `${user.rollNo}.deleted.${Date.now().toString(36)}`.slice(0, 20),
      },
    });
    await revokeAllSessions(id, 'revoked');
    await audit(request.user!.sub, 'user.delete_soft', {
      entity: 'User', entityId: id, ip: request.ip, detail: { username: user.username },
    });

    return { ok: true, mode: 'soft', message: `${user.username} has been removed. Their past results are retained for reporting.` };
  });

  // --- Administrators ------------------------------------------------------

  /** The privilege catalogue and presets, for the checkbox UI. */
  app.get('/api/admin/permissions', async () => ({
    permissions: PERMISSIONS,
    presets: PRESETS,
  }));

  /** Everyone who can reach the admin area, and what each of them may do. */
  app.get('/api/admin/administrators', { preHandler: requirePermission('admins.manage') }, async () => {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN', deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, publicId: true, username: true, firstName: true, lastName: true,
        isActive: true, permissions: true, lastLoginAt: true, createdAt: true,
        mustChangePassword: true,
      },
    });
    return { administrators: admins };
  });

  /**
   * Creates a student, or an administrator with exactly the privileges ticked.
   *
   * Creating an administrator additionally requires `admins.manage`, so
   * somebody with only `users.manage` can enrol students but cannot promote
   * themselves or anyone else.
   */
  app.post('/api/admin/users', async (request, reply) => {
    const body = z
      .object({
        firstName: z.string().trim().min(1).max(60),
        lastName: z.string().trim().min(1).max(60),
        grade: z.string().trim().min(1).max(20).optional(),
        division: z.string().trim().min(1).max(20).optional(),
        /** Any further divisions this student is also in; see setDivisions. */
        divisions: z.array(z.string().trim().min(1).max(20)).max(20).optional(),
        rollNo: z.string().trim().min(1).max(20).optional(),
        dateOfBirth: z.string(),
        password: z.string().min(1).max(200),
        role: z.enum(['STUDENT', 'ADMIN']).default('STUDENT'),
        permissions: z.array(z.string()).max(50).default([]),
        /** Force a password change at first sign-in. */
        mustChangePassword: z.boolean().default(true),
        /** Set the username explicitly instead of deriving it from the name. */
        username: z
          .string().trim().toLowerCase().min(3).max(40)
          .regex(/^[a-z][a-z0-9]*$/, 'A username must start with a letter and contain only lowercase letters and numbers.')
          .optional(),
      })
      .parse(request.body);

    const isAdmin = body.role === 'ADMIN';
    const permissions: Permission[] = isAdmin ? sanitizePermissions(body.permissions) : [];

    if (!isAdmin && !request.user!.permissions.includes('users.manage')) {
      return reply.code(403).send({
        error: 'Adding a student requires the "Manage students" privilege.',
        code: 'PERMISSION_DENIED',
      });
    }

    if (isAdmin) {
      if (!request.user!.permissions.includes('admins.manage')) {
        return reply.code(403).send({
          error: 'Creating an administrator requires the "Manage administrators" privilege.',
          code: 'PERMISSION_DENIED',
        });
      }
      if (permissions.length === 0) {
        return reply.code(400).send({
          error: 'Choose at least one privilege, otherwise this administrator would be able to sign in but do nothing.',
        });
      }
    }

    const policy = checkPassword(body.password, { firstName: body.firstName, lastName: body.lastName });
    if (!policy.ok) return reply.code(400).send({ error: policy.errors.join(' ') });

    const dob = new Date(body.dateOfBirth);
    if (Number.isNaN(dob.getTime())) return reply.code(400).send({ error: 'Invalid date of birth.' });

    // An administrator has no class; students must have one, and it must exist.
    const grade = isAdmin ? 'STAFF' : body.grade;
    const division = isAdmin ? 'STAFF' : body.division;
    const rollNo = isAdmin ? `ADM-${Date.now().toString(36)}` : body.rollNo;

    if (!isAdmin) {
      if (!grade || !division || !rollNo) {
        return reply.code(400).send({ error: 'A student needs a grade, a division and a roll number.' });
      }
      const [g, unknown] = await Promise.all([
        prisma.schoolClass.findUnique({ where: { kind_code: { kind: 'GRADE', code: grade } } }),
        unknownDivisions(divisionCodes(division, body.divisions)),
      ]);
      if (!g) return reply.code(400).send({ error: 'That grade does not exist.' });
      if (unknown.length) {
        return reply.code(400).send({
          error: `${unknown.length === 1 ? 'This division does' : 'These divisions do'} not exist: ${unknown.join(', ')}.`,
        });
      }
    }

    const passwordHash = await hashPassword(body.password);

    try {
      const user = await prisma.$transaction(async (tx) => {
        const username = body.username ?? (await allocateUsername(tx, body.firstName, body.lastName));
        return tx.user.create({
          data: {
            username,
            firstName: body.firstName,
            lastName: body.lastName,
            grade: grade!,
            // An administrator gets the STAFF division and nothing else: they
            // are not in a class, and a second one would put them in a class
            // list. Only a student can carry extras.
            ...setDivisions(division!, isAdmin ? [] : body.divisions),
            rollNo: rollNo!,
            dateOfBirth: dob,
            passwordHash,
            role: body.role,
            permissions,
            mustChangePassword: body.mustChangePassword,
          },
          select: { id: true, publicId: true, username: true, role: true, permissions: true },
        });
      });

      await audit(request.user!.sub, isAdmin ? 'admin.create' : 'user.create', {
        entity: 'User', entityId: user.id, ip: request.ip,
        detail: { role: body.role, permissions },
      });

      return reply.code(201).send({
        ok: true,
        user,
        message: isAdmin
          ? `Administrator ${user.username} created (${user.publicId}). Give them the password in person - they will be asked to change it at first sign-in.`
          : `Student ${user.username} created (${user.publicId}).`,
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = (err.meta?.target as string[] | string | undefined) ?? '';
        const fields = Array.isArray(target) ? target.join(',') : String(target);
        if (fields.includes('username')) {
          return reply.code(409).send({ error: `The username "${body.username}" is already taken.` });
        }
        return reply.code(409).send({ error: 'That roll number already exists in that grade and division.' });
      }
      throw err;
    }
  });

  /** Changes what an administrator may do, or promotes/demotes them. */
  app.patch('/api/admin/users/:id/permissions', { preHandler: requirePermission('admins.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        role: z.enum(['STUDENT', 'ADMIN']).optional(),
        permissions: z.array(z.string()).max(50),
      })
      .parse(request.body);

    const target = await prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!target) return reply.code(404).send({ error: 'User not found.' });

    const role = body.role ?? target.role;
    const permissions: Permission[] = role === 'ADMIN' ? sanitizePermissions(body.permissions) : [];

    if (role === 'ADMIN' && permissions.length === 0) {
      return reply.code(400).send({ error: 'An administrator needs at least one privilege.' });
    }

    // Nobody may remove their own ability to manage administrators - that is
    // how a system ends up with no one able to grant privileges again.
    if (id === request.user!.sub && !permissions.includes('admins.manage')) {
      return reply.code(400).send({
        error: 'You cannot remove your own "Manage administrators" privilege. Ask another administrator to do it.',
      });
    }

    // Nor may the last holder be demoted away.
    if (target.permissions.includes('admins.manage') && !permissions.includes('admins.manage')) {
      const holders = await prisma.user.count({
        where: { role: 'ADMIN', deletedAt: null, isActive: true, permissions: { has: 'admins.manage' } },
      });
      if (holders <= 1) {
        return reply.code(400).send({
          error: 'This is the only account that can manage administrators. Grant that privilege to someone else first.',
        });
      }
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { role, permissions },
      select: { id: true, publicId: true, username: true, role: true, permissions: true },
    });

    await audit(request.user!.sub, 'admin.permissions_changed', {
      entity: 'User', entityId: id, ip: request.ip,
      detail: { before: { role: target.role, permissions: target.permissions }, after: { role, permissions } },
    });

    return { ok: true, user: updated, message: `Privileges updated for ${updated.username}.` };
  });
}
