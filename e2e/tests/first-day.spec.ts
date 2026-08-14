import { test, expect } from '@playwright/test';
import {
  signInAsAdmin, signUp, myUsername, sampleQuestions,
  importQuestions, createPaper, addApprovedQuestions, publish, releaseResults,
  watchForBreakage,
} from '../fixtures/people.js';

/**
 * A school's first morning, end to end, in a browser.
 *
 * Everything below happens on a database that was empty when the run started.
 * The server suite proves each piece; this proves they add up to a school being
 * able to examine a child and give them a mark - which is the only thing this
 * software is for.
 */

test.describe.configure({ mode: 'serial' });

let testId: string;
let studentPassword = 'bluetiger4291';

test('a teacher loads questions, reviews them, and publishes a paper', async ({ page }) => {
  const problems = watchForBreakage(page);
  await signInAsAdmin(page);

  // The documented route when no model is configured, or when the provider is
  // down and the exam is tomorrow. Same validation, same review queue.
  const accepted = await importQuestions(page, sampleQuestions(5));
  expect(accepted).toBe(5);

  // --- review ---------------------------------------------------------------
  await page.goto('/admin/questions?bucket=DRAFT');
  await expect(page.getByText('Question 1.').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('li.card')).toHaveCount(5);

  // Maths is rendered for the reviewer, not shown as raw TeX. A reviewer who
  // cannot read the question cannot review it.
  await expect(page.locator('.katex').first()).toBeVisible();

  for (const box of await page.locator('li.card input[type=checkbox]').all()) await box.check();
  await page.getByRole('button', { name: /^Approve/ }).first().click();
  await page.waitForURL(/bucket=APPROVED/, { timeout: 20_000 });
  await expect(page.getByText('Question 1.').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('li.card')).toHaveCount(5);

  // --- build and publish ----------------------------------------------------
  testId = await createPaper(page, 'First-day arithmetic');
  expect(testId, 'the paper should have been created').toBeTruthy();

  const added = await addApprovedQuestions(page, testId);
  expect(added.status).toBeLessThan(400);
  expect(added.count).toBe(5);

  await page.goto(`/admin/tests/${testId}`);
  await expect(page.getByText('First-day arithmetic').first()).toBeVisible({ timeout: 20_000 });

  await publish(page, testId);
  expect(problems, 'the teacher hit no errors').toEqual([]);
});

test('a child signs up, sits the paper, and is told nothing about the answers', async ({ page }) => {
  const problems = watchForBreakage(page);

  await signUp(page, { firstName: 'Meera', lastName: 'Iyer', rollNo: '17', password: studentPassword });
  const username = await myUsername(page);
  expect(username, 'the server allocates a username').toBeTruthy();

  await page.goto('/dashboard');
  await expect(page.getByText('First-day arithmetic').first()).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: /Attempt test|Start|Resume/i }).first().click();
  await page.waitForURL(/attempt/, { timeout: 25_000 });
  await expect(page.getByText(/A train travels/).first()).toBeVisible({ timeout: 20_000 });

  // The single most damaging thing this system could do. Checked on what the
  // browser was actually given, not on what the page chose to render.
  const given = await page.evaluate(async () => {
    const id = location.pathname.split('/').pop();
    const res = await fetch(`/api/student/attempts/${id}`, { credentials: 'include' });
    return JSON.stringify(await res.json());
  });
  expect(given, 'the answer key reached the browser').not.toMatch(/answerKey|correctOptionId/i);
  expect(given, 'the explanation reached the browser').not.toMatch(/"explanation"/);

  // And nothing in the rendered page either - a key in the DOM is a key a
  // curious child can read with the developer tools every browser ships.
  const html = await page.content();
  expect(html).not.toMatch(/correctOptionId/i);

  // --- answer every question and hand it in ---------------------------------
  for (let i = 0; i < 5; i++) {
    const options = page.locator('main label, main [role=radio], main button').filter({ hasText: /km\/h/ });
    if (await options.count()) await options.nth(i % (await options.count())).click();
    const next = page.getByRole('button', { name: /^Next/ });
    if (await next.count()) await next.first().click();
  }

  page.on('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: /Submit/i }).first().click();
  const confirm = page.getByRole('button', { name: /Submit|Yes/i }).last();
  if (await confirm.count()) await confirm.click().catch(() => undefined);
  await page.waitForURL(/dashboard|result/, { timeout: 30_000 });

  // Submitting does not reveal the mark: the teacher releases it, so nobody
  // learns the answers from a classmate who sat it first.
  const dashboard = await page.evaluate(async () =>
    JSON.stringify(await (await fetch('/api/student/dashboard', { credentials: 'include' })).json()));
  expect(dashboard).toMatch(/awaitingResults/);
  expect(problems, 'the child hit no errors').toEqual([]);
});

test('the teacher releases the results and the child can see their mark', async ({ page }) => {
  const problems = watchForBreakage(page);
  await signInAsAdmin(page);

  await page.goto(`/admin/tests/${testId}`);
  await page.getByRole('tab', { name: /Results/ }).click();
  await expect(page.getByText(/Meera/).first()).toBeVisible({ timeout: 20_000 });

  await releaseResults(page, testId);
  expect(problems).toEqual([]);
});

test('and the child now sees it', async ({ page }) => {
  const problems = watchForBreakage(page);
  await signUpOrSignIn(page);

  await page.goto('/dashboard');
  const released = await page.evaluate(async () => {
    const d = await (await fetch('/api/student/dashboard', { credentials: 'include' })).json();
    return d.results?.regular?.length ?? 0;
  });
  expect(released, 'the released paper is in their results').toBeGreaterThan(0);
  expect(problems).toEqual([]);

  async function signUpOrSignIn(p: typeof page) {
    // The child from the earlier test; each test gets a fresh browser context,
    // so they sign in again rather than carrying a session.
    await p.goto('/');
    await p.getByRole('button', { name: 'Sign in', exact: true }).click();
    await p.fill('input[autocomplete="username"]', 'meeraiyer');
    await p.fill('input[type="password"]', studentPassword);
    await p.click('button[type="submit"]');
    await p.waitForURL(/dashboard/, { timeout: 30_000 });
  }
});

test('the reports account for the child who sat it', async ({ page }) => {
  const problems = watchForBreakage(page);
  await signInAsAdmin(page);

  // --- who has not sat it ---------------------------------------------------
  await page.goto('/admin/reports');
  await expect(page.getByText('First-day arithmetic').first()).toBeVisible({ timeout: 25_000 });

  // One child, in the audience, and finished. The screen defaults to showing
  // only children still owing work, so the right outcome here is that it says
  // there are none - not that it lists her.
  const audience = page.locator('div').filter({ hasText: /^In the audience/ }).first();
  await expect(audience).toContainText('1');
  await expect(page.getByText(/Everybody has sat everything/i)).toBeVisible();

  // Unticking the filter puts her back on screen, which is how a teacher checks
  // a class rather than chases one.
  await page.getByRole('checkbox', { name: /Only those still owing work/i }).uncheck();
  await expect(page.getByText(/Meera/).first()).toBeVisible({ timeout: 25_000 });

  // --- and the ranked table -------------------------------------------------
  await page.goto('/admin/students');
  await expect(page.getByText(/Meera/).first()).toBeVisible({ timeout: 25_000 });

  expect(problems).toEqual([]);
});
