import { defineConfig, devices } from '@playwright/test';

/**
 * The whole system in a browser.
 *
 * The server suite proves the parts; this proves they add up to a school being
 * able to run an exam. It is deliberately small - a handful of journeys that
 * would each be a bad morning if they broke - because a large browser suite is
 * slow, flaky, and stops being run.
 *
 * Playwright starts everything: Postgres must already exist (see README), and
 * the API and the built web app are launched below and torn down afterwards.
 */

const API_PORT = 4100;
const WEB_PORT = 4173;

/** A database of its own, dropped and recreated by the global setup. */
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:5432/foundation_e2e';

export const ADMIN_USERNAME = 'admin';
export const ADMIN_PASSWORD = 'E2E_Admin_4471';

const serverEnv = {
  DATABASE_URL,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  JWT_SECRET: 'e2e_jwt_secret_that_is_long_enough_1234567890',
  ENCRYPTION_KEY: 'e2e_encryption_key_thirty_two_bytes_x',
  PORT: String(API_PORT),
  NODE_ENV: 'production',
  UPLOAD_DIR: '/tmp/foundation-e2e-uploads',
  BACKUP_DIR: '/tmp/foundation-e2e-backups',
  // One worker: these tests do not measure throughput, and a single process
  // makes a failure's logs readable.
  WEB_CONCURRENCY: '1',
  // Single-device login is deliberately left at its default. The suite signs
  // the administrator in once and gives each child its own browser context, so
  // it works under the protection a school actually runs with - and a run that
  // starts failing here is telling you something true.
};

/**
 * Run against something already running, instead of starting our own.
 *
 * Set E2E_BASE_URL to point the whole suite at a deployment - the real Docker
 * Compose stack, most usefully, where nginx serves the assets and Caddy routes
 * /api. That is the one arrangement `vite preview` cannot stand in for: preview
 * serves the right bundle from the wrong server, so the SPA fallback, the cache
 * headers and the gzip config in web/nginx.conf go untested by a normal run.
 *
 * When it is set, nothing is started and nothing is torn down: the stack is
 * somebody else's to bring up, and it is expected to be freshly deployed.
 */
const externalOrigin = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './tests',
  // A browser journey has real waiting in it - a page load, a paper being
  // graded - so the per-test budget is generous while the whole run is not.
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // These share one database and one admin account, so they run in order.
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],

  use: {
    baseURL: externalOrigin ?? `http://127.0.0.1:${WEB_PORT}`,
    // Kept only for a failure: a passing run should leave nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
  },

  projects: [
    {
      // Signs in as the administrator once and saves the session; see
      // tests/auth.setup.ts for why that is worth a project of its own.
      name: 'setup',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /auth\.setup\.ts/,
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /mobile\.|auth\.setup\./,
      dependencies: ['setup'],
    },
    {
      // The system is used on phones by most of the children, so the paper is
      // sat on one here rather than only on a laptop.
      name: 'phone',
      use: { ...devices['Pixel 7'] },
      testMatch: /mobile\./,
      // The paper it sits is the one the desktop run publishes, so this is a
      // real dependency rather than an ordering that happens to hold.
      dependencies: ['desktop'],
    },
  ],

  // Nothing to start when we have been pointed at a running deployment.
  webServer: externalOrigin ? undefined : [
    {
      // Rebuilds the database and then starts the API, in one process. See the
      // note in serve.mjs: Playwright starts webServer before globalSetup, so
      // preparing the database in globalSetup rebuilds it underneath a running
      // API and the first sign-in comes back 500.
      command: 'node ../e2e/fixtures/serve.mjs',
      cwd: '../server',
      port: API_PORT,
      env: serverEnv,
      reuseExistingServer: !process.env.CI,
      // The API logs every request; thousands of lines per run buries the
      // actual test output. Failures go to stderr, which is kept.
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 60_000,
    },
    {
      // `preview`, not `dev`: the browser tests should see the bundle a school
      // gets, including the admin chunk that is only split out by a build.
      command: 'npx vite preview --host 127.0.0.1 --port 4173 --strictPort',
      cwd: '../web',
      port: WEB_PORT,
      // The preview server proxies /api the way Caddy does in production. It
      // has to be told where this run's API is, or it goes looking for a
      // development one on 4000.
      env: { VITE_API_TARGET: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 60_000,
    },
  ],
});
