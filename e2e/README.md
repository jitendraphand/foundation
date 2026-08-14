# Browser tests

```bash
cd e2e
npm ci
npx playwright install --with-deps chromium   # once
npm test
```

Needs a Postgres you do not mind losing. The run **drops and recreates**
`foundation_e2e` every time, then migrates and seeds it, so what these tests
describe is a school's first morning rather than whatever state a previous run
left behind. Point it elsewhere with `E2E_DATABASE_URL`.

Everything else Playwright starts and stops itself: the API on 4100 and the
**built** web app on 4173.

## What is here

Twenty-one tests, about forty seconds. Deliberately few — a large browser suite is
slow, flaky, and stops being run, and the 153 server tests already cover the
parts. These cover the joins between them.

| Spec | The morning it stops going wrong |
|---|---|
| `first-day.spec.ts` | A teacher loads questions, reviews them, publishes a paper; a child signs up, sits it, hands it in; the mark is held back until released; the reports account for her. If this breaks, the school cannot examine anybody. |
| `mobile.exam.spec.ts` | The same paper on a Pixel 7, because most of these children use a phone. Checks the two things that make a small screen unusable: content wider than the window, and controls too small to press — plus that the timer stays in view while scrolling. |
| `overview.spec.ts` | The overview leads with findings in sentences, above any chart, with the figures folded away until asked for. |
| `served.spec.ts` | The server in front of the app: a deep link surviving a hard refresh, cache headers, compression, security headers. Configuration fails silently and completely, and three of these only run against a real deployment. |
| `llm-settings.spec.ts` | A vendor's per-model settings are saved; invalid JSON and server-owned fields are refused with a reason; the request preview shows what would be sent and never the key. |

## Against a real deployment

`vite preview` serves the right bundle from the wrong server. To exercise the
one a school installs - nginx serving the assets, Caddy routing `/api` - point
the suite at it:

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
E2E_BASE_URL=http://localhost npm test
```

Nothing is started or torn down in that mode, and the six checks in
`served.spec.ts` that skip under preview all run: the SPA fallback on a hard
refresh, the immutable cache headers on `/assets/`, `no-cache` on index.html,
gzip, and the security headers Caddy adds.

**The deployment must be freshly brought up.** These tests describe a first
morning and they leave a school behind them - a paper, a child, a credential -
so a second run against the same stack fails on the first assertion about an
empty database. `docker compose down -v` between runs. CI does exactly one run
per stack, which is why it does not hit this.

This is a separate CI job, gated on `main` and on manual dispatch, because it
builds four images.

## Why the everyday run uses `vite preview`

The dev server would be easier and would test a bundle nobody deploys. Preview
serves the real build, including the admin chunk that only exists after one, so
a lazily loaded route that fails in production fails here too. The preview
server proxies `/api` the way Caddy does — `VITE_API_TARGET` tells it where.

## Three things worth knowing before you add a test

**Playwright starts `webServer` before `globalSetup`.** Preparing the database
in `globalSetup` rebuilds it underneath an API that has already connected, and
the first sign-in comes back 500 with nothing to explain it. That is why
`fixtures/serve.mjs` does both, in order, in one process.

**One administrator session, and a fresh context per child.** Single-device
login is on by default and is left on: the setup project signs the
administrator in once and every admin spec adopts that session, while each child
gets its own browser context. Signing in per test instead both revokes the
administrator mid-run and burns through the login rate limit, which is twenty
attempts per five minutes from one address - both of those protections working
correctly on a suite that was behaving unlike a person.

**Setup goes through the API, journeys go through the screen.** Building a paper
by clicking the builder in every test would make each one slow and make one
change to the builder break all of them. `fixtures/people.ts` has
`importQuestions`, `createPaper`, `publish` and `releaseResults` for the setup;
what is being *tested* is always driven the way a person drives it.

Every test also asserts the page produced no uncaught exception and no failed
request (`watchForBreakage`). A journey that completes while throwing in the
console has not really passed.

## When one fails

`test-results/` gets a trace, a video and a screenshot for that test.

```bash
npx playwright show-trace test-results/<the-failing-test>/trace.zip
```

CI uploads the same thing as an artifact, so a red build on someone else's
machine is still debuggable on yours.
