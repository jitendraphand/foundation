import { test, expect } from '@playwright/test';
import { signUp, watchForBreakage } from '../fixtures/people.js';

/**
 * Sitting a paper on a phone.
 *
 * Most of the children in this school will use one, so a layout that only works
 * at 1340px is a layout that does not work. This runs in the `phone` project -
 * a Pixel 7 viewport with touch - against the paper the desktop run published.
 *
 * What is checked is not how it looks, which a test cannot judge, but the two
 * things that make a small screen unusable: content wider than the window, and
 * controls too small or too covered to press.
 */

test('a child can sit and hand in a paper on a phone', async ({ page }) => {
  const problems = watchForBreakage(page);

  await signUp(page, { firstName: 'Arun', lastName: 'Nair', rollNo: '204', password: 'greenriver8823' });

  await page.goto('/dashboard');
  await expect(page.getByText('First-day arithmetic').first()).toBeVisible({ timeout: 25_000 });

  // Nothing may spill sideways: a page that scrolls horizontally on a phone is
  // one where the child cannot see the end of a question.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'the dashboard scrolls sideways on a phone').toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: /Attempt test|Start|Resume/i }).first().click();
  await page.waitForURL(/attempt/, { timeout: 25_000 });
  await expect(page.getByText(/A train travels/).first()).toBeVisible({ timeout: 20_000 });

  const examOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(examOverflow, 'the paper scrolls sideways on a phone').toBeLessThanOrEqual(1);

  // The options have to be reachable by thumb. 40px is below the usual 44px
  // guidance but above the size at which a child taps the wrong answer.
  const option = page.locator('main label, main [role=radio], main button').filter({ hasText: /km\/h/ }).first();
  await expect(option).toBeVisible();
  const box = await option.boundingBox();
  expect(box!.height, 'an answer option is too small to tap').toBeGreaterThanOrEqual(40);

  // And the timer must stay in view while scrolling, or a child cannot tell
  // how long is left without losing their place.
  await page.mouse.wheel(0, 400);
  const timer = page.getByText(/\d+:\d\d/).first();
  await expect(timer).toBeInViewport();

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

  const handedIn = await page.evaluate(async () => {
    const d = await (await fetch('/api/student/dashboard', { credentials: 'include' })).json();
    return (d.results?.regular?.length ?? 0) + (d.awaitingResults?.length ?? 0);
  });
  expect(handedIn, 'the paper was not recorded').toBeGreaterThan(0);

  expect(problems).toEqual([]);
});
