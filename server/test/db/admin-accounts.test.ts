import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { testDatabase, closeDatabase, resetDatabase, skipWithoutDatabase } from '../helpers/database.js';
import { testApi, type TestApi } from '../helpers/api.js';
import { makeAdmin, makeStudent } from '../helpers/factories.js';

/**
 * Who may write to an administrator's account.
 *
 * `users.manage` is the privilege for enrolling and looking after students; the
 * Office / records preset grants it to a school secretary along with reporting
 * and nothing else. Every account endpoint takes a bare user id, and an
 * administrator's id looks exactly like a child's, so before this was enforced
 * the secretary could reset the founding administrator's password to one they
 * chose and sign in holding every privilege in the system.
 *
 * These are written against that path specifically: not "does it return 404"
 * but "is the account still theirs afterwards".
 */

/** What the Office / records preset actually grants. */
const OFFICE = ['users.manage', 'analytics.view'] as const;

describe('reaching an administrator account', { skip: skipWithoutDatabase }, () => {
  let prisma: PrismaClient;
  let api: TestApi;

  before(async () => {
    prisma = await testDatabase();
    api = await testApi(prisma);
  });
  after(async () => {
    await api.close();
    await closeDatabase();
  });
  beforeEach(async () => { await resetDatabase(prisma); });

  test('the office cannot reset an administrator password and become them', async () => {
    const head = await makeAdmin(prisma);
    const office = await makeAdmin(prisma, [...OFFICE]);

    const secretary = await api.as(office);
    const res = await secretary.post(`/api/admin/users/${head.id}/reset-password`, {
      newPassword: 'takeover12345',
    });

    assert.equal(res.status, 404);

    // The refusal is worth nothing if the write happened anyway, so check the
    // account rather than the reply: same password, still signed in, and not
    // holding a forced change at the door.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: head.id } });
    assert.equal(after.passwordHash, head.passwordHash, 'the password was changed');
    assert.equal(after.mustChangePassword, false);
  });

  test('nor edit, deactivate or delete one', async () => {
    const head = await makeAdmin(prisma);
    const office = await makeAdmin(prisma, [...OFFICE]);
    const secretary = await api.as(office);

    const edited = await secretary.patch(`/api/admin/users/${head.id}`, { firstName: 'Renamed' });
    const closed = await secretary.post(`/api/admin/users/${head.id}/activate`, { isActive: false });
    const removed = await secretary.del(`/api/admin/users/${head.id}`);

    assert.deepEqual(
      [edited.status, closed.status, removed.status],
      [404, 404, 404],
    );

    const after = await prisma.user.findUniqueOrThrow({ where: { id: head.id } });
    assert.equal(after.firstName, head.firstName);
    assert.equal(after.isActive, true);
    assert.equal(after.deletedAt, null);
  });

  test('and cannot read one, which is where they would find the id', async () => {
    const head = await makeAdmin(prisma);
    const office = await makeAdmin(prisma, [...OFFICE]);

    const res = await (await api.as(office)).get(`/api/admin/users/${head.id}`);
    assert.equal(res.status, 404);
    // Not 403: whether an id belongs to an administrator is not a fact to
    // confirm to somebody who may not manage them.
    assert.doesNotMatch(res.raw, /permission|privilege|administrator/i);
  });

  test('but the office still runs the student records it exists for', async () => {
    // The guard would be easy to write in a way that also stops the secretary
    // doing their job, and that failure would be found by a school rather than
    // by us.
    const child = await makeStudent(prisma);
    const office = await makeAdmin(prisma, [...OFFICE]);
    const secretary = await api.as(office);

    const read = await secretary.get(`/api/admin/users/${child.id}`);
    assert.equal(read.status, 200);

    const edited = await secretary.patch(`/api/admin/users/${child.id}`, { firstName: 'Renamed' });
    assert.equal(edited.status, 200);

    const reset = await secretary.post(`/api/admin/users/${child.id}/reset-password`, {
      newPassword: 'freshstart42',
    });
    assert.equal(reset.status, 200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: child.id } });
    assert.equal(after.firstName, 'Renamed');
    assert.notEqual(after.passwordHash, child.passwordHash);
    assert.equal(after.mustChangePassword, true, 'the child must choose their own at the door');
  });

  test('someone who manages administrators can reset one', async () => {
    const head = await makeAdmin(prisma);
    const colleague = await makeAdmin(prisma);

    const res = await (await api.as(head)).post(`/api/admin/users/${colleague.id}/reset-password`, {
      newPassword: 'ridgeline77',
    });

    assert.equal(res.status, 200);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: colleague.id } });
    assert.notEqual(after.passwordHash, colleague.passwordHash);
    assert.equal(after.mustChangePassword, true);
  });

  test('resetting your own is refused, and points at changing it instead', async () => {
    // It would sign you out of the session you did it from and then demand the
    // password again at the door. Change password asks for the current one and
    // keeps you where you are.
    const head = await makeAdmin(prisma);

    const res = await (await api.as(head)).post(`/api/admin/users/${head.id}/reset-password`, {
      newPassword: 'somethingelse9',
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /Change password/);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: head.id } });
    assert.equal(after.passwordHash, head.passwordHash);
  });

  test('a reset ends every session the old password opened', async () => {
    // Otherwise resetting for someone who has lost control of their account
    // achieves nothing until the intruder's session happens to expire.
    const head = await makeAdmin(prisma);
    const colleague = await makeAdmin(prisma);

    const theirBrowser = await api.as(colleague);
    assert.equal((await theirBrowser.get('/api/auth/me')).status, 200);

    await (await api.as(head)).post(`/api/admin/users/${colleague.id}/reset-password`, {
      newPassword: 'ridgeline77',
    });

    assert.equal((await theirBrowser.get('/api/auth/me')).status, 401, 'the old session still works');
  });
});
