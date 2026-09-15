import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PrismaClient } from '@prisma/client';
import { testDatabase, closeDatabase, resetDatabase, skipWithoutDatabase } from '../helpers/database.js';
import { testApi, anonymous, type TestApi } from '../helpers/api.js';
import { makeAdmin, makeStudent } from '../helpers/factories.js';
import { hashPassword } from '../../src/lib/password.js';

/**
 * Self-service password reset over email, mirroring the WhatsApp leg.
 *
 * The student proves who they are the same way; only the delivery channel
 * differs. A stub webhook stands in for n8n so the test sees the real
 * `via: 'n8n'` path instead of the log fallback.
 */

describe('password reset over email', { skip: skipWithoutDatabase }, () => {
  let prisma: PrismaClient;
  let api: TestApi;
  let received: Array<{ to: string; subject: string; message: string }>;
  let server: http.Server;

  before(async () => {
    prisma = await testDatabase();
    api = await testApi(prisma);

    received = [];
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        try { received.push(JSON.parse(raw)); } catch { /* ignore */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as AddressInfo).port;
    process.env.N8N_EMAIL_WEBHOOK_URL = `http://127.0.0.1:${port}/webhook/email-reset`;
  });
  after(async () => {
    delete process.env.N8N_EMAIL_WEBHOOK_URL;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await api.close();
    await closeDatabase();
  });
  beforeEach(async () => {
    await resetDatabase(prisma);
    received.length = 0;
  });

  async function studentWithEmail(email: string | null) {
    const student = await makeStudent(prisma);
    await prisma.user.update({ where: { id: student.id }, data: { email } });
    return prisma.user.findUniqueOrThrow({ where: { id: student.id } });
  }

  function identityOf(user: { username: string; rollNo: string; dateOfBirth: Date }) {
    return {
      username: user.username,
      role: 'STUDENT' as const,
      dateOfBirth: user.dateOfBirth.toISOString().slice(0, 10),
      rollNo: user.rollNo,
    };
  }

  test('availability reports both channels', async () => {
    const res = await anonymous(api.app).get('/api/reset/availability');
    assert.equal(res.status, 200);
    assert.equal((res.body as { channels: { email: boolean } }).channels.email, true);
  });

  test('email channel delivers the new password to the registered address', async () => {
    const student = await studentWithEmail('pupil.reset@example.com');
    const before = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });

    const res = await anonymous(api.app).post('/api/reset/request', {
      ...identityOf(student),
      channel: 'email',
    });
    assert.equal(res.status, 200);
    assert.match((res.body as { message: string }).message, /p\*\*\*@example\.com/);

    assert.equal(received.length, 1);
    assert.equal(received[0].to, 'pupil.reset@example.com');
    assert.match(received[0].subject, /password has been reset/i);

    // The password really changed, and the student must choose their own next.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
    assert.notEqual(after.passwordHash, before.passwordHash);
    assert.equal(after.mustChangePassword, true);
  });

  test('email channel is refused when no address is on file', async () => {
    const student = await studentWithEmail(null);
    const res = await anonymous(api.app).post('/api/reset/request', {
      ...identityOf(student),
      channel: 'email',
    });
    assert.equal(res.status, 400);
    assert.match((res.body as { error: string }).error, /email/i);
    assert.equal(received.length, 0);
  });

  test('email addresses are a System Administrator field, like mobiles', async () => {
    const head = await makeAdmin(prisma);
    const office = await makeAdmin(prisma, ['users.manage']);
    const child = await makeStudent(prisma);

    const headCall = await api.as(head);
    const saved = await headCall.patch(`/api/admin/users/${child.id}`, { email: 'Pupil.One@Example.com' });
    assert.equal(saved.status, 200);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: child.id } });
    assert.equal(stored.email, 'pupil.one@example.com');

    // A System Administrator sees it; the office does not.
    const seen = await headCall.get(`/api/admin/users/${child.id}`);
    assert.equal((seen.body as { user: { email: string } }).user.email, 'pupil.one@example.com');
    const hidden = await (await api.as(office)).get(`/api/admin/users/${child.id}`);
    assert.equal((hidden.body as { user: { email?: string } }).user.email, undefined);

    // The office cannot set it either.
    const refused = await (await api.as(office)).patch(`/api/admin/users/${child.id}`, { email: 'x@example.com' });
    assert.equal(refused.status, 403);

    // ...nor an invalid one through the front door.
    const invalid = await headCall.patch(`/api/admin/users/${child.id}`, { email: 'not-an-email' });
    assert.equal(invalid.status, 400);
  });
});

/**
 * A student updates their own email address.
 *
 * The admin-set path stays as it was; this is the self-service counterpart.
 * Anything typed here costs the current password first, so an unlocked device
 * alone cannot redirect somebody's resets.
 */
describe('a student updates their own email', { skip: skipWithoutDatabase }, () => {
  let prisma: PrismaClient;
  let api: TestApi;

  const PASSWORD = 'StudentPass99';

  before(async () => {
    prisma = await testDatabase();
    api = await testApi(prisma);
  });
  after(async () => {
    await api.close();
    await closeDatabase();
  });
  beforeEach(async () => { await resetDatabase(prisma); });

  async function studentWithPassword() {
    const student = await makeStudent(prisma);
    await prisma.user.update({
      where: { id: student.id },
      data: { passwordHash: await hashPassword(PASSWORD) },
    });
    return prisma.user.findUniqueOrThrow({ where: { id: student.id } });
  }

  test('sets and lowercases the address with the right password', async () => {
    const student = await studentWithPassword();
    const res = await (await api.as(student)).patch('/api/auth/profile', {
      email: 'Pupil.Self@Example.COM',
      currentPassword: PASSWORD,
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as { email: string }).email, 'pupil.self@example.com');

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
    assert.equal(stored.email, 'pupil.self@example.com');

    const audit = await prisma.auditLog.findFirst({ where: { action: 'auth.email_changed', entityId: student.id } });
    assert.ok(audit, 'the change is audited');
    assert.equal((audit!.detail as { email: string }).email, 'p***@example.com');
  });

  test('wrong password changes nothing', async () => {
    const student = await studentWithPassword();
    const res = await (await api.as(student)).patch('/api/auth/profile', {
      email: 'hijack@example.com',
      currentPassword: 'WrongPass99',
    });
    assert.equal(res.status, 401);

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: student.id } });
    assert.equal(stored.email, null);
  });

  test('an invalid address is refused', async () => {
    const student = await studentWithPassword();
    const res = await (await api.as(student)).patch('/api/auth/profile', {
      email: 'not-an-email',
      currentPassword: PASSWORD,
    });
    assert.equal(res.status, 400);
  });

  test('clearing removes the address, and nobody else is touched', async () => {
    const mine = await studentWithPassword();
    const theirs = await studentWithPassword();
    await prisma.user.update({ where: { id: theirs.id }, data: { email: 'theirs@example.com' } });

    await prisma.user.update({ where: { id: mine.id }, data: { email: 'mine@example.com' } });
    const cleared = await (await api.as(mine)).patch('/api/auth/profile', {
      email: '',
      currentPassword: PASSWORD,
    });
    assert.equal(cleared.status, 200);
    assert.equal((cleared.body as { email: null }).email, null);

    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: mine.id } })).email, null);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: theirs.id } })).email, 'theirs@example.com');
  });
});
