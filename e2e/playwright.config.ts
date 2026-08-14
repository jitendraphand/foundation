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
  // Several children sign in during the run, which is exactly what single
  // device login is designed to stop.
  SINGLE_DEVICE_LOGIN: 'false',
};

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
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    // Kept only for a failure: a passing run should leave nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
  },

  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /mobile\./,
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

  webServer: [
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
