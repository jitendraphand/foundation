import { test as setup, expect } from '@playwright/test';
import { ADMIN_STATE, signInAsAdmin } from '../fixtures/people.js';

/**
 * Sign in as the administrator once, and keep the session.
 *
 * Signing in at the top of every test is not how anybody uses this - a teacher
 * signs in in the morning - and it costs a login each time. That matters,
 * because login is rate limited to twenty attempts per five minutes per address
 * and the whole suite comes from one address. Against a deployment behind a
 * proxy, where several runs share one long-lived API, a suite that signs in
 * fifteen times starts being told "too many requests" - which is the limiter
 * working correctly, on a test that was behaving unlike a person.
 *
 * The specs that only need an administrator adopt this state with
 * `test.use({ storageState: ADMIN_STATE })`. Anything that signs up or signs in
 * as a child does its own, because that is the thing it is testing.
 */

setup('sign in as the administrator', async ({ page }) => {
  await signInAsAdmin(page);
  await expect(page.getByRole('link', { name: /Overview/ }).first()).toBeVisible({ timeout: 20_000 });
  await page.context().storageState({ path: ADMIN_STATE });
});
