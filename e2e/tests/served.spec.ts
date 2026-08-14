import { test, expect } from '@playwright/test';

/**
 * The things the *server* in front of the app has to get right.
 *
 * Everything else in this suite would pass identically against `vite preview`,
 * because it is about the application. This file is about the thirteen lines of
 * web/nginx.conf and the routing in the Caddyfile, which preview stands in for
 * rather than exercises - and which, being configuration, fail silently and
 * completely rather than partially.
 *
 * It runs in every mode, because a check that only runs against the real stack
 * is a check nobody runs. Against preview it confirms the app's own behaviour;
 * against a deployment (E2E_BASE_URL) it confirms nginx's. The assertions that
 * only a real server can satisfy are marked.
 */

const servedByRealStack = !!process.env.E2E_BASE_URL;

test('a deep link survives a hard refresh', async ({ page }) => {
  // The single-page app owns /dashboard, but the browser asks the server for it
  // on a refresh or a pasted link. Without `try_files ... /index.html` that is a
  // 404, and a child who reloads mid-exam loses the paper. It is the most
  // damaging thing a static-hosting misconfiguration can do here.
  const res = await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });

  expect(res?.status(), 'a deep link 404ed instead of serving the app').toBeLessThan(400);
  // Not signed in, so the app sends them to the landing page - which is proof
  // the app loaded and routed, rather than the server having served nothing.
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({ timeout: 20_000 });
});

test('an unknown path still serves the app rather than a server error page', async ({ page }) => {
  const res = await page.goto('/attempt/00000000-0000-0000-0000-000000000000', { waitUntil: 'domcontentloaded' });
  expect(res?.status()).toBeLessThan(400);
  expect(await page.content(), 'nginx served its own error page').not.toMatch(/nginx\/|<center>/i);
});

test('the API is reachable through the same origin as the app', async ({ page }) => {
  // In production this is Caddy routing /api to the API container; in a normal
  // run it is vite's proxy. Either way the app only ever talks to one origin,
  // and if that routing is wrong every screen is empty.
  await page.goto('/');
  const health = await page.evaluate(async () => {
    const res = await fetch('/api/health', { credentials: 'include' });
    return { status: res.status, body: await res.json() };
  });
  expect(health.status).toBe(200);
  expect(health.body.ok).toBe(true);
});

test('the built assets are cached hard, and the page is not', async ({ page }) => {
  test.skip(!servedByRealStack, 'cache headers are nginx\'s job; run with E2E_BASE_URL against a deployment');

  const assets = page.waitForResponse((r) => /\/assets\/.*\.js$/.test(r.url()));
  await page.goto('/');
  const asset = await assets;

  // Asset filenames carry a content hash, so they can be cached forever - and
  // must be, or every page load re-downloads the bundle over a school's
  // connection.
  expect(asset.headers()['cache-control'], 'hashed assets are not cached')
    .toMatch(/immutable|max-age=\d{6,}/);

  const html = await page.request.get('/');
  // index.html must NOT be, or a deployed fix never reaches anybody.
  expect(html.headers()['cache-control'], 'index.html is being cached')
    .toMatch(/no-cache|no-store|max-age=0/);
});

test('the assets are compressed on the way out', async ({ page }) => {
  test.skip(!servedByRealStack, 'compression is nginx\'s job; run with E2E_BASE_URL against a deployment');

  // The bundle is around 700 KB uncompressed and about a fifth of that gzipped.
  // On a school's connection, with a class loading at once, that is the
  // difference between a lesson starting on time and not.
  const res = await page.request.get('/', { headers: { 'accept-encoding': 'gzip, deflate, br' } });
  const assetUrl = (await res.text()).match(/\/assets\/[^"']+\.js/)?.[0];
  expect(assetUrl, 'no asset link found in index.html').toBeTruthy();

  const asset = await page.request.get(assetUrl!, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
  expect(asset.headers()['content-encoding'], 'assets are served uncompressed').toMatch(/gzip|br|zstd/);
});

test('the security headers a school expects are present', async ({ page }) => {
  test.skip(!servedByRealStack, 'these are set by Caddy; run with E2E_BASE_URL against a deployment');

  const res = await page.request.get('/');
  const headers = res.headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toMatch(/SAMEORIGIN|DENY/i);
});
