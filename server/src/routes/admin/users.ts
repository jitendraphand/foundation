import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { checkPassword, hashPassword } from '../../lib/password.js';
import { allocateUsername } from '../../lib/username.js';
import { audit, requirePermission } from '../../middleware/auth.js';
import { ALL_PERMISSIONS, PERMISSIONS, PRESETS, sanitizePermissions, type Permission } from '../../lib/permissions.js';

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
      ...(q.division ? { division: q.division } : {}),
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
          rollNo: true, dateOfBirth: true, isActive: true, lastLoginAt: true, createdAt: true,
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
        rollNo: true, dateOfBirth: true, isActive: true, role: true, lastLoginAt: true,
        createdAt: true, mustChangePassword: true,
      },
    });
    if (!user) return reply.code(404).send({ error: 'Student not found.' });

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

    const before = await prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!before) return reply.code(404).send({ error: 'Student not found.' });

    if (body.grade) {
      const g = await prisma.schoolClass.findUnique({ where: { kind_code: { kind: 'GRADE', code: body.grade } } });
      if (!g) return reply.code(400).send({ error: 'That grade does not exist.' });
    }
    if (body.division) {
      const d = await prisma.schoolClass.findUnique({ where: { kind_code: { kind: 'DIVISION', code: body.division } } });
      if (!d) return reply.code(400).send({ error: 'That division does not exist.' });
    }

    const data: Prisma.UserUpdateInput = {
      ...(body.firstName !== undefined ? { firstName: body.firstName } : {}),
      ...(body.lastName !== undefined ? { lastName: body.lastName } : {}),
      ...(body.grade !== undefined ? { grade: body.grade } : {}),
      ...(body.division !== undefined ? { division: body.division } : {}),
      ...(body.rollNo !== undefined ? { rollNo: body.rollNo } : {}),
      ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
    };

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

    const user = await prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) return reply.code(404).send({ error: 'Student not found.' });

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
    await audit(request.user!.sub, isActive ? 'user.activate' : 'user.deactivate', {
      entity: 'User', entityId: id, ip: request.ip,
    });

    return { ok: true, isActive };
  });

  app.post('/api/admin/users/:id/reset-password', { preHandler: requirePermission('users.manage') }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ newPassword: z.string().min(1).max(200) }).parse(request.body);

    const user = await prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) return reply.code(404).send({ error: 'Student not found.' });

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
    await audit(request.user!.sub, 'user.password_reset', { entity: 'User', entityId: id, ip: request.ip });

    return {
      ok: true,
      message: `Temporary password set for ${user.username}. They will be asked to choose a new one when they sign in.`,
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

    const user = await prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!user) return reply.code(404).send({ error: 'Student not found.' });

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
      const [g, d] = await Promise.all([
        prisma.schoolClass.findUnique({ where: { kind_code: { kind: 'GRADE', code: grade } } }),
        prisma.schoolClass.findUnique({ where: { kind_code: { kind: 'DIVISION', code: division } } }),
      ]);
      if (!g) return reply.code(400).send({ error: 'That grade does not exist.' });
      if (!d) return reply.code(400).send({ error: 'That division does not exist.' });
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
            division: division!,
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
