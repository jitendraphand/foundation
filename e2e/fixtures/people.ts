import { expect, type Page } from '@playwright/test';

/**
 * The two people who use this system, and the things they do often enough that
 * every test would otherwise spell them out.
 */

/**
 * Where the administrator's signed-in session is kept between tests. Written by
 * the setup project, adopted by the specs that only need an administrator.
 */
export const ADMIN_STATE = 'playwright/.auth/admin.json';

export const ADMIN_USERNAME = process.env.E2E_ADMIN_USERNAME ?? 'admin';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'E2E_Admin_4471';

export async function signIn(page: Page, username: string, password: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.fill('input[autocomplete="username"]', username);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
}

export async function signInAsAdmin(page: Page) {
  await signIn(page, ADMIN_USERNAME, ADMIN_PASSWORD);
  await page.waitForURL(/\/admin/, { timeout: 30_000 });
}

export interface NewStudent {
  firstName: string;
  lastName: string;
  rollNo: string;
  password: string;
  dateOfBirth?: string;
}

/**
 * A child signing themselves up, which is how the school onboards them.
 *
 * Grade and division are chosen by index rather than by label: what a school
 * has called its divisions is its own business, and a test that hard-codes
 * "Science Foundation" breaks the first time somebody renames one.
 */
export async function signUp(page: Page, student: NewStudent): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /Create an account|Sign up/i }).first().click();

  await page.getByLabel('First name').fill(student.firstName);
  await page.getByLabel('Last name').fill(student.lastName);
  await page.getByLabel('Grade').selectOption({ index: 1 });
  await page.getByLabel('Division').selectOption({ index: 1 });
  await page.getByLabel('Roll no.').fill(student.rollNo);
  await page.getByLabel('Date of birth').fill(student.dateOfBirth ?? '2012-06-15');
  // The label carries a required marker, so match loosely and take them in order.
  await page.getByLabel('Password').first().fill(student.password);
  await page.getByLabel('Confirm password').fill(student.password);

  await page.getByRole('button', { name: /Create account|Sign up/i }).last().click();
  await page.waitForURL(/dashboard|change-password/, { timeout: 30_000 });
}

/** The username the server allocated, which is what they sign in with. */
export async function myUsername(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    return (await res.json()).user?.username as string;
  });
}

/**
 * Five ordinary multiple-choice questions, one block of maths in each.
 *
 * `b` is always the right answer, which keeps the marking arithmetic in the
 * tests obvious - the paper shuffles the *order*, not the option ids.
 */
export function sampleQuestions(count = 5) {
  return Array.from({ length: count }, (_, i) => ({
    format: 'MCQ_SINGLE',
    content: {
      version: 1,
      blocks: [
        { type: 'text', value: `Question ${i + 1}. A train travels ` },
        { type: 'math', tex: `${(i + 1) * 30}`, display: false },
        { type: 'text', value: ' km in 1.5 hours. What is its average speed?' },
      ],
    },
    options: ['a', 'b', 'c', 'd'].map((id, k) => ({
      id,
      blocks: [{ type: 'text', value: `${(k + 1) * 10 * (i + 1)} km/h` }],
    })),
    answerKey: { correctOptionId: 'b' },
    explanation: { version: 1, blocks: [{ type: 'text', value: 'Speed is distance divided by time.' }] },
    difficultyTag: i > 2 ? 'hard' : 'medium',
    cognitiveTag: 'application',
    skillTags: ['numerical_computation'],
    subject: 'Mathematics',
    estimatedSeconds: 60,
  }));
}

/**
 * Setting up a paper, through the API the screens call.
 *
 * Deliberately not through the builder UI. These tests exist to check the
 * journeys a person takes - reviewing, sitting, marking, reading a report - and
 * clicking through paper construction in every one of them would make each test
 * slow and make a change to the builder break all of them at once. The builder
 * has its own test.
 *
 * They call it from inside the page, so the page has to be *on* the app first:
 * a relative URL has no origin on about:blank, which is where a test starts
 * when it adopts a saved session instead of signing in.
 */
export async function onTheApp(page: Page) {
  if (!/^https?:/.test(page.url())) await page.goto('/');
}

export async function importQuestions(page: Page, questions: unknown[]) {
  await onTheApp(page);
  const result = await page.evaluate(async (payload) => {
    const res = await fetch('/api/admin/questions/import', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { questions: payload }, sourceLabel: 'e2e' }),
    });
    return { status: res.status, body: await res.json() };
  }, questions);

  expect(result.status, `import failed: ${JSON.stringify(result.body).slice(0, 200)}`).toBeLessThan(400);
  expect(result.body.rejected, 'nothing should have been rejected').toEqual([]);
  return result.body.accepted as number;
}

export async function createPaper(page: Page, title: string, opts: { durationMinutes?: number } = {}) {
  await onTheApp(page);
  return page.evaluate(async ({ title, durationMinutes }) => {
    const res = await fetch('/api/admin/tests', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title, subject: 'Mathematics', kind: 'REGULAR',
        durationMinutes: durationMinutes ?? 20,
        marksPerQuestion: 1, passPercentage: 40,
        targetGrades: [], targetDivisions: [],
      }),
    });
    return (await res.json()).test?.id as string;
  }, { title, durationMinutes: opts.durationMinutes });
}

export async function addApprovedQuestions(page: Page, testId: string) {
  await onTheApp(page);
  return page.evaluate(async (id) => {
    const list = await (await fetch('/api/admin/questions?bucket=APPROVED&pageSize=50', { credentials: 'include' })).json();
    const questionIds = list.questions.map((q: { id: string }) => q.id);
    const res = await fetch(`/api/admin/tests/${id}/questions/add`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ questionIds }),
    });
    return { status: res.status, count: questionIds.length };
  }, testId);
}

export async function publish(page: Page, testId: string) {
  await onTheApp(page);
  const res = await page.evaluate(async (id) => {
    const r = await fetch(`/api/admin/tests/${id}/publish`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'PUBLISHED' }),
    });
    return { status: r.status, body: await r.text() };
  }, testId);
  expect(res.status, `publish failed: ${res.body.slice(0, 200)}`).toBeLessThan(400);
}

export async function releaseResults(page: Page, testId: string) {
  await onTheApp(page);
  const res = await page.evaluate(async (id) => {
    const r = await fetch(`/api/admin/tests/${id}/release`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ released: true }),
    });
    return { status: r.status, body: await r.text() };
  }, testId);
  expect(res.status, `release failed: ${res.body.slice(0, 200)}`).toBeLessThan(400);
}

/**
 * Watches a page for the things a passing test must not produce: an uncaught
 * exception, or a failed request. A 401 from the "am I signed in?" probe is the
 * answer "no", not a fault.
 */
export function watchForBreakage(page: Page): string[] {
  const problems: string[] = [];
  page.on('pageerror', (err) => problems.push(`uncaught: ${err.message}`));
  page.on('response', (res) => {
    if (res.status() < 400) return;
    if (res.status() === 401 && /\/api\/auth\/me/.test(res.url())) return;
    problems.push(`${res.status()} ${res.request().method()} ${new URL(res.url()).pathname}`);
  });
  return problems;
}
