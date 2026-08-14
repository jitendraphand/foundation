import { test, expect, type Browser, type Page } from '@playwright/test';
import { ADMIN_STATE, ADMIN_USERNAME, onTheApp, signIn, watchForBreakage } from '../fixtures/people.js';

/**
 * How an administrator's password gets changed.
 *
 * Both routes here were missing, and the gap was the kind that only shows up
 * when somebody needs it: a school signs in with the password from .env - which
 * the seed applies once, on the first boot of an empty database, and never
 * reads again - and then finds nowhere in the admin area to replace it. A
 * colleague who forgot theirs was worse: administrators never appear in the
 * Students list, where the reset for everybody else lives, so their account was
 * unreachable from every screen in the app.
 */

test.describe.configure({ mode: 'serial' });
test.use({ storageState: ADMIN_STATE });

/** A fresh browser signed in as nobody, so the shared admin session survives. */
async function inTheirOwnBrowser(browser: Browser, body: (page: Page) => Promise<void>) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  try {
    await body(page);
  } finally {
    await context.close();
  }
}

interface Colleague {
  firstName: string;
  lastName: string;
  username: string;
  password: string;
  mustChangePassword?: boolean;
}

/**
 * Another administrator, made through the API.
 *
 * The creation form has its own coverage; what these tests are about starts
 * once a second administrator exists, and building one by hand in each of them
 * would only make them slow.
 */
async function createColleague(page: Page, who: Colleague): Promise<void> {
  // A test that adopts the saved session starts on about:blank, where a
  // relative URL has no origin to be relative to.
  await onTheApp(page);
  const res = await page.evaluate(async (c) => {
    const r = await fetch('/api/admin/users', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        firstName: c.firstName,
        lastName: c.lastName,
        username: c.username,
        dateOfBirth: '1988-04-02',
        password: c.password,
        role: 'ADMIN',
        // Enough to reach a screen and no more: none of these tests need a
        // colleague who could undo what the others check.
        permissions: ['analytics.view'],
        mustChangePassword: c.mustChangePassword ?? false,
      }),
    });
    return { status: r.status, body: await r.text() };
  }, who);
  expect(res.status, `could not create ${who.username}: ${res.body.slice(0, 200)}`).toBeLessThan(400);
}

const SELF = { firstName: 'Nadia', lastName: 'Roy', username: 'nadiaroy', password: 'ridgeline77' };
const FORGOTFUL = { firstName: 'Omar', lastName: 'Sethi', username: 'omarsethi', password: 'harbourlight8' };

test('the admin area offers a way to change your own password', async ({ page }) => {
  // The whole bug: this link did not exist, and typing the URL was the only
  // way to reach the form.
  const problems = watchForBreakage(page);

  await page.goto('/admin');
  await page.getByRole('link', { name: /Change password|^Password$/ }).click();

  await expect(page.getByRole('heading', { name: 'Change your password' })).toBeVisible({ timeout: 20_000 });
  expect(problems).toEqual([]);
});

test('an administrator changes their own password and the new one is the one that works', async ({ page, browser }) => {
  await createColleague(page, SELF);
  const chosen = 'northgate5512';

  await inTheirOwnBrowser(browser, async (theirs) => {
    await signIn(theirs, SELF.username, SELF.password);
    await theirs.waitForURL(/\/admin/, { timeout: 30_000 });

    await theirs.getByRole('link', { name: /Change password|^Password$/ }).click();
    await expect(theirs.getByRole('heading', { name: 'Change your password' })).toBeVisible();

    // The labels carry a required marker, so match loosely and take them in
    // order - "New password" is also a substring of "Confirm new password".
    await theirs.getByLabel('Current password').fill(SELF.password);
    await theirs.getByLabel('New password').first().fill(chosen);
    await theirs.getByLabel('Confirm new password').fill(chosen);
    await theirs.getByRole('button', { name: 'Update password' }).click();

    // Back where they were, still signed in - not bounced to the door.
    await theirs.waitForURL(/\/admin/, { timeout: 30_000 });
  });

  // The claim is not "the form submitted" but "the password changed", so it is
  // checked at the only place that settles it.
  await inTheirOwnBrowser(browser, async (theirs) => {
    await signIn(theirs, SELF.username, SELF.password);
    await expect(theirs.getByText('Incorrect username or password.')).toBeVisible({ timeout: 20_000 });
  });

  await inTheirOwnBrowser(browser, async (theirs) => {
    await signIn(theirs, SELF.username, chosen);
    await theirs.waitForURL(/\/admin/, { timeout: 30_000 });
  });
});

test('a colleague who has forgotten theirs can be reset from the People screen', async ({ page, browser }) => {
  await createColleague(page, FORGOTFUL);
  const temporary = 'lanterncove3';

  const problems = watchForBreakage(page);
  await page.goto('/admin/people');

  const row = page.locator('tr').filter({ hasText: FORGOTFUL.username });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.getByRole('button', { name: 'Reset password' }).click();

  await expect(page.getByRole('heading', { name: `Reset password for ${FORGOTFUL.username}` })).toBeVisible();

  // Found by its label, which is the point: this box sits inside a wrapper
  // beside a Suggest button, and Field used to stop at the wrapper and leave
  // the label naming nothing at all.
  await page.getByLabel('Temporary password').fill(temporary);
  await page.getByRole('button', { name: 'Reset password', exact: true }).last().click();

  // The administrator doing the reset has to be able to read out what they set.
  await expect(page.getByText(temporary)).toBeVisible({ timeout: 20_000 });
  expect(problems).toEqual([]);

  await inTheirOwnBrowser(browser, async (theirs) => {
    await signIn(theirs, FORGOTFUL.username, temporary);
    // Straight to choosing their own: a password somebody else picked is not
    // one they should keep.
    await theirs.waitForURL(/change-password/, { timeout: 30_000 });
    await expect(theirs.getByText(/reset by an administrator/i)).toBeVisible();
  });
});

test('your own row offers no reset, because changing it is the path for that', async ({ page }) => {
  // Resetting your own would end the session you are doing it from and then ask
  // for the password again at the door. The server refuses it too.
  await page.goto('/admin/people');

  const mine = page.locator('tr').filter({ hasText: ADMIN_USERNAME }).first();
  await expect(mine).toBeVisible({ timeout: 20_000 });
  expect(await mine.getByRole('button', { name: 'Reset password' }).count()).toBe(0);
  await expect(mine.getByRole('button', { name: 'Edit privileges' })).toBeVisible();
});
