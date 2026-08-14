import { test, expect } from '@playwright/test';
import { ADMIN_STATE, watchForBreakage } from '../fixtures/people.js';

/**
 * The credentials screen, and the two things on it that exist so nobody has to
 * wait for a code change when a vendor ships a new model.
 *
 * The key used here is a made-up string pointed at an endpoint that does not
 * exist. Nothing in this file calls a real provider: what is being checked is
 * that the settings are stored and that the request built from them is the one
 * that would be sent - not whether some company's server is up.
 */

const LABEL = 'E2E NVIDIA';
const FAKE_KEY = 'nvapi-e2e-not-a-real-key-0000000000';

test.use({ storageState: ADMIN_STATE });
test.describe.configure({ mode: 'serial' });

test('a credential can be added and given a vendor\'s per-model settings', async ({ page }) => {
  const problems = watchForBreakage(page);

  // Creating it through the API: the form has its own coverage, and what this
  // file is about starts once a credential exists.
  await page.goto('/admin/settings');
  const created = await page.evaluate(async ({ label, key }) => {
    const res = await fetch('/api/admin/credentials', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label, provider: 'nvidia', apiKey: key,
        defaultModel: 'nvidia/nemotron-3.5-lightning-30b-a3b',
      }),
    });
    return { status: res.status, body: await res.text() };
  }, { label: LABEL, key: FAKE_KEY });
  expect(created.status, created.body.slice(0, 200)).toBeLessThan(400);

  await page.goto('/admin/settings');
  await page.getByRole('tab', { name: 'LLM providers' }).click();
  await expect(page.getByText(LABEL).first()).toBeVisible({ timeout: 20_000 });

  // --- the settings a vendor's sample varies by -----------------------------
  const row = page.locator('tr', { hasText: LABEL }).first();
  await row.getByRole('button', { name: 'Model settings' }).click();
  await expect(page.getByText(`Model settings for ${LABEL}`)).toBeVisible({ timeout: 15_000 });

  await page.getByLabel('Thinking model').selectOption('yes');
  await page.getByLabel('Temperature').fill('1');
  await page.getByLabel('Top P').fill('0.95');
  await page.getByLabel('Seed').fill('42');
  // Copied from build.nvidia.com's extra_body for this model.
  await page.locator('textarea').first()
    .fill('{"chat_template_kwargs":{"enable_thinking":true},"reasoning_budget":16384}');
  await page.getByRole('button', { name: 'Save settings' }).click();

  await expect(page.getByText(`Model settings for ${LABEL}`)).toBeHidden({ timeout: 15_000 });
  expect(problems).toEqual([]);
});

test('invalid JSON is refused with a reason, and so is anything the server owns', async ({ page }) => {
  await page.goto('/admin/settings');
  await page.getByRole('tab', { name: 'LLM providers' }).click();
  await expect(page.getByText(LABEL).first()).toBeVisible({ timeout: 20_000 });

  const row = page.locator('tr', { hasText: LABEL }).first();
  await row.getByRole('button', { name: 'Model settings' }).click();
  await expect(page.getByText(`Model settings for ${LABEL}`)).toBeVisible({ timeout: 15_000 });

  await page.locator('textarea').first().fill('{not json');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText(/that is not valid JSON/i)).toBeVisible({ timeout: 10_000 });

  // A setting must never be able to send the request somewhere else, and the
  // refusal has to say so rather than dropping the field in silence.
  await page.locator('textarea').first().fill('{"messages":"hijack","model":"other"}');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText(/cannot include/i)).toBeVisible({ timeout: 15_000 });
});

test('the request preview shows what would be sent, and never the key', async ({ page }) => {
  const problems = watchForBreakage(page);
  await page.goto('/admin/settings');
  await page.getByRole('tab', { name: 'LLM providers' }).click();
  await expect(page.getByText(LABEL).first()).toBeVisible({ timeout: 20_000 });

  const row = page.locator('tr', { hasText: LABEL }).first();
  await row.getByRole('button', { name: 'Show the request' }).click();
  await expect(page.getByText('What this credential sends')).toBeVisible({ timeout: 20_000 });

  const panel = page.locator('td', { hasText: 'What this credential sends' }).first();

  // The settings saved above appear in the body, which is what makes the panel
  // comparable with the vendor's own sample.
  await expect(panel).toContainText('chat_template_kwargs');
  await expect(panel).toContainText('16384');
  await expect(panel).toContainText('"model"');

  // The whole page, not just this panel: this is the screen most likely to be
  // screenshotted into a support thread.
  expect(await page.content(), 'the API key was on screen').not.toContain(FAKE_KEY);

  await page.getByText(/As a curl command/).click();
  await expect(panel).toContainText('curl http');
  await expect(panel).toContainText('your API key');
  expect(await page.content(), 'the API key was in the curl command').not.toContain(FAKE_KEY);

  expect(problems).toEqual([]);
});

test('trying two questions against a dead endpoint says what went wrong', async ({ page }) => {
  await page.goto('/admin/settings');
  await page.getByRole('tab', { name: 'LLM providers' }).click();
  await expect(page.getByText(LABEL).first()).toBeVisible({ timeout: 20_000 });

  const row = page.locator('tr', { hasText: LABEL }).first();
  await row.getByRole('button', { name: 'Try 2 questions' }).click();

  // The endpoint is NVIDIA's real hostname with a fake key, so this fails - and
  // failing usefully is the point. What must not happen is a bare "failed" with
  // nothing an administrator can act on.
  await expect(page.getByText('failed').first()).toBeVisible({ timeout: 60_000 });
  const report = page.locator('td', { hasText: /Took:/ }).first();
  await expect(report).toContainText(/Took:/);
  await expect(report).toContainText(/Streamed:/);
});
