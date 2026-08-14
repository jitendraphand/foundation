# Tests

```bash
npm test          # everything
npm run test:unit # no database needed, ~2 seconds
npm run test:db   # needs Postgres, see below
npm run test:watch
```

No test framework: Node 22 has a runner built in, and `tsx` was already here for
`npm run dev`. Adding Jest or Vitest to a school deployment would mean hundreds
of dependencies to keep patched for no capability this suite lacks.

## The two tiers

**`test/unit`** and **`test/llm`** need nothing but Node. Marking, the per-axis
breakdown, weak-area ranking, CSV escaping, SVG filtering, the diagram check,
and the whole streaming reader — the last against a mock endpoint the suite
starts on an ephemeral port.

**`test/db`** needs a real Postgres, and asks for one:

```bash
createdb foundation_test
TEST_DATABASE_URL=postgresql://localhost:5432/foundation_test npm run test:db
```

Without `TEST_DATABASE_URL` every suite in it reports `# SKIP` with that
instruction, so a contributor without a database gets a clear message rather
than a screen of connection errors.

These cannot be usefully mocked. What they check — a conditional `UPDATE`
claiming exactly one row under contention, aggregates over `jsonb`, a route's
reply after every hook has run — exists only in the database and in Fastify. A
mock of either would be a test of the mock.

The database is **dropped clean between test files**, so `test:db` runs them one
at a time. Point it at something you do not mind losing.

## What the tests are for

Each file guards something that has actually gone wrong here, and most of them
were written before the fix and watched to fail:

| File | The thing it stops happening again |
|---|---|
| `db/attempt.test.ts` | A paper graded once per open dashboard, inflating `timesServed` on every question and with it `observedP`, the figure a teacher uses to spot a badly worded question. Eight concurrent finalisations, counted once. |
| `db/aggregate.test.ts` | The analytics moving into SQL and quietly changing the numbers. Every figure is checked against one worked out by hand in the test — including that a child on 59.74% counts as below 60%, which rounding first said they were not. |
| `db/exam-routes.test.ts` | An answer key reaching a student. Checked on the serialised reply, because a key nested anywhere in it is still a key on the wire. Also: unreleased marks, one child reading another's attempt, and an administrator reaching an area they were not granted. |
| `db/briefing.test.ts` | A screen that states conclusions stating wrong ones — and an empty school being shown zeroes dressed up as findings. |
| `llm/streaming.test.ts` | The week NVIDIA NIM connected, showed green, and never produced a question: reasoning read as an empty answer, a silence timeout that was really a stopwatch, and a vendor name deciding whether a model thinks. |
| `unit/grading.test.ts` | Marks. Nobody can check a mark by eye once it is in the database. |
| `unit/csv.test.ts` | `=HYPERLINK(...)` as a child's first name, becoming code on a teacher's laptop when they open the class list. That one was real. |
| `unit/content.test.ts` | Script tags, event handlers and `foreignObject` in model-generated SVG, rendered on a page where a teacher is signed in. |

## What is not here

Browser journeys. Those live in [`../../e2e`](../../e2e/README.md) — Playwright,
a real Chromium, against the built app: a teacher publishing a paper, a child
sitting it on a phone, the mark being released. They are kept separate because
they need a browser and a build, and because they answer a different question:
this suite asks whether each part is right, that one asks whether the parts add
up to a school being able to run an exam.

## Writing another one

`test/helpers/factories.ts` builds the smallest school that can be examined —
`makeAdmin`, `makeStudent`, `makePaper`, `startAttempt`, `recordResult` — so a
test says only what makes its case different.

`test/helpers/api.ts` runs a request through the real app with `inject()`: no
socket, no port, and every hook in place. Use it whenever the thing being
checked is a property of the *reply* rather than of a function.

Write the test first and watch it fail. Two of the tests here passed against the
broken code the first time, which is how it was discovered they were asserting
the wrong thing.
