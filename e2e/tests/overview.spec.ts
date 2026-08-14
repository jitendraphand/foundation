import { test, expect } from '@playwright/test';
import { ADMIN_STATE, importQuestions, sampleQuestions, watchForBreakage } from '../fixtures/people.js';

/**
 * The screen a teacher opens first.
 *
 * It was rebuilt to lead with findings in sentences rather than with charts the
 * reader has to interpret, so what is checked here is the ordering and the
 * wording - the things that make it worth opening.
 *
 * Runs after first-day.spec, which is what puts a result in the database.
 */

test.use({ storageState: ADMIN_STATE });

test('the overview leads with what needs attention, not with charts', async ({ page }) => {
  const problems = watchForBreakage(page);
  await page.goto('/admin');

  // Either there is something to report or there is not; both are answers, and
  // both must appear before any chart.
  const briefing = page.getByText(/What needs your attention|Nothing needs your attention/).first();
  await expect(briefing).toBeVisible({ timeout: 30_000 });

  const briefingBox = await briefing.boundingBox();
  const firstChart = await page.locator('.card svg').first().boundingBox().catch(() => null);
  expect(firstChart === null || briefingBox!.y < firstChart.y,
    'a chart appeared above the briefing').toBeTruthy();

  // The figures start folded away: somebody who only wanted to know whether
  // anything was wrong has already been told.
  await expect(page.getByRole('button', { name: /Show the figures/ })).toBeVisible();
  expect(await page.locator('.card svg').count(), 'a chart was on screen before it was asked for').toBe(0);

  expect(problems).toEqual([]);
});

test('opening the figures shows the evidence behind them', async ({ page }) => {
  const problems = watchForBreakage(page);
  await page.goto('/admin');

  await page.getByRole('button', { name: /Show the figures/ }).click();
  await expect(page.getByText('Score distribution')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.card svg').first()).toBeVisible();

  // Folding them away again leaves the findings, which is the point.
  await page.getByRole('button', { name: /Hide the figures/ }).click();
  expect(await page.locator('.card svg').count()).toBe(0);

  expect(problems).toEqual([]);
});

test('the headline numbers say what they are counting', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByText(/What needs your attention|Nothing needs your attention/).first())
    .toBeVisible({ timeout: 30_000 });

  // The median beside the mean, because one child on 4% drags an average down
  // in a way that misrepresents a class.
  const average = page.locator('.card').filter({ hasText: 'Average score' }).first();
  await expect(average).toContainText(/median/);
  await expect(average).toContainText(/passed/);

  // And how many children are behind the figure: an average over 8,000 papers
  // means something different if it is 40 students or 240.
  const sat = page.locator('.card').filter({ hasText: 'Papers sat' }).first();
  await expect(sat).toContainText(/by \d+ students?/);
});

test('a finding names a number and leads somewhere a teacher can act', async ({ page }) => {

  // Give it something to find, rather than hoping the earlier tests left
  // something behind: one question imported and not reviewed. A test that
  // skips itself whenever the school is in good order is a test that never
  // runs.
  await importQuestions(page, sampleQuestions(1));

  await page.goto('/admin');
  await expect(page.getByText(/What needs your attention/).first()).toBeVisible({ timeout: 30_000 });

  const finding = page.locator('li').filter({ hasText: /waiting for review/ }).first();
  await expect(finding).toBeVisible();
  await expect(finding, 'a finding must carry a number').toContainText(/\d/);

  await finding.getByRole('link').click();
  await page.waitForURL(/\/admin\/questions/, { timeout: 20_000 });
  await expect(page.getByText(/A train travels/).first()).toBeVisible({ timeout: 20_000 });
});
