import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import { testDatabase, closeDatabase, resetDatabase, skipWithoutDatabase } from '../helpers/database.js';
import { testApi, type TestApi } from '../helpers/api.js';
import { makeAdmin, makeStudent, makePaper } from '../helpers/factories.js';

/**
 * The per-test downloads: attempted, non-attempted and results, as CSVs.
 *
 * A roster built from attempts alone can only name the children who turned up,
 * so the non-attempted list is audience minus attempts — and it carries email
 * and mobile, which is the whole point: the list exists so a teacher can chase
 * the missing children. Contact details are a System Administrator's fields,
 * so a caller holding only tests.manage gets them blanked.
 */

describe('per-test downloads', { skip: skipWithoutDatabase }, () => {
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

  function parseCsv(raw: string): { header: string[]; rows: string[][] } {
    const lines = raw.trim().split('\n');
    return { header: lines[0].split(','), rows: lines.slice(1).map((l) => l.split(',')) };
  }

  test('attempted list names who sat it, with contacts for a System Admin', async () => {
    const admin = await makeAdmin(prisma);
    const sat = await makeStudent(prisma, { firstName: 'Sat', lastName: 'Pupil' });
    await prisma.user.update({ where: { id: sat.id }, data: { email: 'sat@example.com', mobile: '919876543210' } });
    const absent = await makeStudent(prisma, { firstName: 'Absent', lastName: 'Pupil' });
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 2 });

    const child = await api.as(sat);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);
    await child.post(`/api/student/attempts/${started.attemptId}/submit`);

    const res = await (await api.as(admin)).get(`/api/admin/tests/${paper.id}/attempts.csv`);
    assert.equal(res.status, 200);
    const { header, rows } = parseCsv(res.raw);
    assert.ok(header.includes('email'), 'email column present');
    assert.ok(header.includes('mobile'), 'mobile column present');
    assert.equal(rows.length, 1, 'only the student who sat it is listed');
    const row = rows[0];
    assert.equal(row[header.indexOf('username')], sat.username);
    assert.equal(row[header.indexOf('email')], 'sat@example.com');
    assert.equal(row[header.indexOf('mobile')], '919876543210');
    assert.ok(!res.raw.includes(absent.username), 'the non-attempted child is not in this list');
  });

  test('non-attempted list is audience minus attempts, with contacts', async () => {
    const admin = await makeAdmin(prisma);
    const sat = await makeStudent(prisma, { firstName: 'Sat', lastName: 'Pupil' });
    const absent = await makeStudent(prisma, { firstName: 'Absent', lastName: 'Pupil' });
    await prisma.user.update({ where: { id: absent.id }, data: { email: 'absent@example.com', mobile: '919800000000' } });
    const { test: paper } = await makePaper(prisma, admin.id, { questions: 2 });

    const child = await api.as(sat);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);
    await child.post(`/api/student/attempts/${started.attemptId}/submit`);

    const res = await (await api.as(admin)).get(`/api/admin/tests/${paper.id}/non-attempts.csv`);
    assert.equal(res.status, 200);
    const { header, rows } = parseCsv(res.raw);
    assert.equal(rows.length, 1, 'only the child with no attempt is listed');
    const row = rows[0];
    assert.equal(row[header.indexOf('username')], absent.username);
    assert.equal(row[header.indexOf('email')], 'absent@example.com');
    assert.equal(row[header.indexOf('mobile')], '919800000000');
    assert.ok(!res.raw.includes(sat.username), 'the child who sat it is not in this list');
  });

  test('results list carries the marks, highest first', async () => {
    const admin = await makeAdmin(prisma);
    const high = await makeStudent(prisma, { firstName: 'High', lastName: 'Scorer' });
    const low = await makeStudent(prisma, { firstName: 'Low', lastName: 'Scorer' });
    const { test: paper, questions } = await makePaper(prisma, admin.id, { questions: 2 });

    for (const [student, correctCount] of [[high, 2], [low, 0]] as const) {
      const child = await api.as(student);
      const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);
      for (const [i, q] of questions.entries()) {
        await child.post(`/api/student/attempts/${started.attemptId}/answer`, {
          questionId: q.id, response: { optionId: i < correctCount ? 'b' : 'a' },
        });
      }
      await child.post(`/api/student/attempts/${started.attemptId}/submit`);
    }

    const res = await (await api.as(admin)).get(`/api/admin/tests/${paper.id}/results.csv`);
    assert.equal(res.status, 200);
    const { header, rows } = parseCsv(res.raw);
    assert.equal(rows.length, 2);
    assert.equal(rows[0][header.indexOf('username')], high.username, 'highest first');
    assert.equal(rows[0][header.indexOf('percentage')], '100');
    assert.equal(rows[1][header.indexOf('percentage')], '0');
    assert.equal(rows[0][header.indexOf('passed')], 'yes');
    assert.equal(rows[1][header.indexOf('passed')], rows[1][header.indexOf('passed')]);
  });

  test('contact details are blanked for a creator without admins.manage', async () => {
    // The creator sees their own paper but, without admins.manage, their
    // download must not carry contact details — the same rule the on-screen
    // lists apply.
    const colleague = await makeAdmin(prisma, ['tests.manage']);
    const student = await makeStudent(prisma);
    await prisma.user.update({ where: { id: student.id }, data: { email: 'private@example.com', mobile: '919811111111' } });
    const { test: paper } = await makePaper(prisma, colleague.id, { questions: 1 });

    const child = await api.as(student);
    const { body: started } = await child.post(`/api/student/tests/${paper.id}/start`);
    await child.post(`/api/student/attempts/${started.attemptId}/submit`);

    for (const kind of ['attempts.csv', 'results.csv']) {
      const res = await (await api.as(colleague)).get(`/api/admin/tests/${paper.id}/${kind}`);
      assert.equal(res.status, 200);
      const { header, rows } = parseCsv(res.raw);
      assert.equal(rows[0][header.indexOf('email')], '', 'email blanked');
      assert.equal(rows[0][header.indexOf('mobile')], '', 'mobile blanked');
      assert.ok(!res.raw.includes('private@example.com'));
    }
  });

  test('an unknown test is a clean 404', async () => {
    const admin = await makeAdmin(prisma);
    for (const kind of ['attempts.csv', 'non-attempts.csv', 'results.csv']) {
      const res = await (await api.as(admin)).get(`/api/admin/tests/00000000-0000-0000-0000-000000000000/${kind}`);
      assert.equal(res.status, 404);
    }
  });
});
