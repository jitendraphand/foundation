# Foundation — Online Exam System

An online examination system for schools. Students sign up, sit timed tests, and
see their results and progress; administrators generate questions with an LLM,
review them, publish tests, and analyse where each student is falling behind.

Built to run on a single **Oracle Cloud Ampere A1 (2 OCPU / 12 GB, Ubuntu 24.04
ARM)** instance with `docker compose up -d`.

**→ [Deployment guide](deploy/DEPLOYMENT.md)** — start here.

---

## What it does

### For students
- Sign up with name, grade (6–10), division, roll number and date of birth. The
  username is generated as `firstnamelastname` — Ajay Sharma becomes
  `ajaysharma`, and a second Ajay Sharma becomes `ajaysharma1`, then
  `ajaysharma2`.
- Every account also gets a permanent user ID (`USR-00001`). Names, spellings
  and even usernames can be corrected later; the user ID never changes, so
  results stay attached to the right person.
- Dashboard showing live tests, past scores, a percentage trend chart, a
  per-subject breakdown, and the areas they are weakest in.
- Timed test runner showing **one question at a time**, with a numbered pane to
  jump straight to any question — a sidebar on a laptop, a one-line bar under
  the header on a phone that opens the grid where a thumb can reach it. Server-authoritative clock, continuous
  autosave, per-question flagging, and full resume after a dropped connection
  or a closed laptop.
- Submitting confirms the paper was received but shows **no score** — results
  appear only once the teacher releases them (practice tests excepted).
- Result view with score, per-axis breakdown charts, and (if the test allows)
  correct answers with worked explanations.
- **Activities** — a flashcard stack and/or a video the teacher has set. While
  one is outstanding the student is taken straight to it: no dashboard, no
  tests, nothing else until it has been read.

### For administrators
- **Set test** — generate questions from OpenAI, OpenRouter, NVIDIA NIM,
  Hugging Face Inference Providers, or any other OpenAI-compatible endpoint. Full control of
  the system prompt, the model, the difficulty and cognitive mix, and the exact
  user message (with a preview of precisely what will be sent).
- **Import** — when the provider is down, out of credit or unreachable, load
  questions from a JSON file or a pasted reply instead. Same schema, same
  validation, same review queue; a downloadable template shows the format.
- **Review** — every draft renders exactly as a student will see it, maths,
  diagrams and all. Edit anything, then approve. Only approved questions can go
  on a test. Rejecting takes a question out of use: off every test that has not
  been sat, and never served to a new attempt. It stays in the Rejected view so
  a mistake can be put back to draft. Approving keeps them selected and offers **Put on a test** on the
  spot: add them to an existing paper, or create one there and then and land in
  its builder.
- **Tests** — choose the final questions, set marks, negative marking, duration,
  shuffling, and audience; publish when ready.
- **Release results** — one action per test reveals every student's score at
  once, so nobody learns the answers from a classmate who sat it earlier.
  Reversible. Practice tests are exempt and always show results immediately.
- **Daily availability windows** — pause a test outside set hours: "only during
  school hours, Mon–Fri" or "paused between 11pm and 5am". Editable on a live
  test without disturbing anyone's score.
- **Activities** — put a notice, a revision card, a picture or a video in front
  of a class and require it before anything else. Cards use the same content
  blocks as questions, so they can carry maths, diagrams, charts, tables and
  uploaded pictures, and each card takes one of seven colours. YouTube and
  Vimeo play inside the page; any other link opens in a new tab. A per-activity
  roster shows who has done it, who is part way through and who has not
  started, with a one-click "make them do it again".
- **Analytics** — score distribution, trend over time, per-class and per-subject
  comparison, cohort-wide tag mastery, and a weakest-first student ranking.
- **Per-student analysis** — mastery grid across all four tag axes, and one
  button to generate a practice test aimed at exactly the cells they are
  failing. Practice data stays segregated from class-test data everywhere.
- **User management** — add students by hand, activate, deactivate, edit any
  detail, change the username, set a new password to hand over in person, and
  delete (soft by default so historical results survive).
- **Administrators with granular privileges** — create colleagues with exactly
  the ten privileges you tick, or start from a preset (Teacher, Question
  setter, Invigilator, Office). Someone who writes papers never has to hold the
  API keys or the backups.
- Every test carries a permanent test ID (`TST-0001`) alongside its title.
- **Backups** — one click produces a `.tar.gz` containing everything, ready to
  store on Google Drive.

---

## Architecture

```
Caddy (auto HTTPS)
  ├── /api/*  →  Fastify + TypeScript (Node 22)  →  PostgreSQL 16
  └── /*      →  React 18 + Vite + Tailwind (served by nginx)
```

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node 22 LTS + TypeScript | Native arm64, no emulation on Ampere |
| API | Fastify + Zod | Schema-first validation on every route |
| Database | PostgreSQL 16 | JSONB for content, real constraints, `pg_dump` backups |
| ORM | Prisma | Versioned, reversible migrations |
| Frontend | React + Vite + Tailwind | Minimal light UI; component model suits future simulations |
| Proxy | Caddy | Automatic Let's Encrypt certificates, zero config |

---

## How question content is stored

A question is **not** an HTML string. It is an ordered list of typed blocks:

```jsonc
{
  "version": 1,
  "blocks": [
    { "type": "text",  "value": "A ball is thrown upward. Find the maximum height." },
    { "type": "math",  "tex": "h = \\frac{u^2 \\sin^2\\theta}{2g}", "display": true },
    { "type": "svg",   "svg": "<svg viewBox=\"0 0 200 120\">…</svg>", "caption": "Trajectory" },
    { "type": "chart", "spec": { "kind": "function", "expression": "x^2 - 3*x + 2", "xMin": -2, "xMax": 5 } },
    { "type": "table", "headers": ["t", "h"], "rows": [["0", "0"], ["1", "4.9"]] }
  ]
}
```

This is the decision that makes diagrams and future simulations tractable:
supporting a new kind of content means adding one renderer component and one
entry in the block schema. **Every question already in the database is
untouched.**

### Releasing results

Submitting a paper never reveals a score. `resultsAreVisible()` in
`server/src/services/attempt.ts` is the single rule every route consults:

```ts
test.kind === 'PRACTICE' || test.resultsReleased
```

Until an admin releases a regular test, the student sees only a confirmation
that the paper arrived. The score is withheld from the submit response, the
result endpoint, the dashboard list, the summary tiles, the trend chart and
the weak-area analysis — there is nowhere to read it out of the network
traffic. Practice tests are deliberately exempt: they exist for the student to
learn from, so their results are immediate.

### Availability windows

Separate from `startsAt`/`endsAt`, which bound a test overall, a **daily
window** controls which hours of the day it may be attempted. Two modes,
because the two obvious requests are opposites:

| Mode | Meaning | Example |
|---|---|---|
| `ALLOW_WINDOW` | Attemptable only inside the window | School hours, 08:00–15:00, Mon–Fri |
| `BLOCK_WINDOW` | Paused inside the window | 23:00–05:00 every night |

Times are wall-clock **in the school's timezone** (Settings → School), stored
as minutes from local midnight. The container runs UTC, so evaluating against
the server clock directly would be out by the offset; `lib/availability.ts`
does the conversion with `Intl` — no timezone library, no hard-coded offsets.
A window whose end is before its start wraps past midnight, and the weekday
filter then applies to the day it *opened*, so "Friday 23:00–05:00" still
covers early Saturday.

The window governs **starting** a paper. An attempt already under way is left
alone by default — the clock has been running, so locking someone out mid-paper
would only cost them marks. A per-test switch, *"Submit papers still in
progress when the window closes"*, turns that into a hard cut-off instead.

A malformed window (missing an end, or start equal to end) fails **open** — the
test stays available rather than silently becoming unattemptable.

### Activities: the "do this first" gate

An activity is a stack of flashcards, a video link, or both. Published and
marked required, it becomes a gate: every student route refuses with
`428 Precondition Required` and `code: ACTIVITY_REQUIRED` until it is done, and
the browser sends the student to the activity rather than showing them an error
they cannot act on. Administrators are never gated by their own material.

Time spent is **credited by the server** from the gap between heartbeats,
capped at two minutes per beat, so a tab left open overnight is not counted as
engagement and `{"secondsSpent": 9999}` from a crafted request buys nothing.
Finishing needs every card seen *and* the minimum time met.

Cards are coloured from a fixed vocabulary — `slate`, `blue`, `green`,
`amber`, `rose`, `violet`, `teal` — stored as a name, never a colour value, so
the palette can be restyled once in CSS without touching stored cards and a
card can never carry an arbitrary colour string into the page. Each accent's
title colour clears 4.5:1 against its own background.

Pictures on cards are ordinary assets: the same upload, the same content
addressing, the same `/uploads/:id` route and the same backup as a figure
attached to a question.

Video links go through `server/src/lib/video.ts` before they are stored. Only
YouTube and Vimeo are ever framed, and only on their own player origins —
`youtube-nocookie.com` and `player.vimeo.com`, in a sandboxed iframe. A
lookalike host such as `youtube.com.evil.tld` is not recognised as YouTube and
becomes an ordinary link that opens in a new tab; `javascript:` and `data:`
URLs are refused outright.

An activity that could not be finished is refused at publish time — cards
required but none written, video required but no link — and a live activity
cannot be edited into that state either. The alternative is a whole class stuck
behind a gate with no way through.

### Question types

Multiple choice only, and both variants are graded automatically:

| Format | Meaning |
|---|---|
| `MCQ_SINGLE` | Exactly one of the four options is correct |
| `MCQ_MULTI` | Two or three options are correct, with optional partial credit |

Partial credit gives marks for correct ticks minus wrong ticks, floored at
zero. Negative marking (configurable per test) applies only to an answered
question that scored nothing — never to a blank.

### Diagrams

The LLM is instructed to express every figure as *code that generates it*, in
one of three forms, all rendered directly in the browser:

| Content | Block type | Rendered by |
|---|---|---|
| Fractions, roots, integrals, matrices | `math` (LaTeX) | KaTeX |
| Geometry, figures, labelled apparatus | `svg` | Sanitised inline SVG |
| Flow charts, trees, processes | `mermaid` | Mermaid (lazy-loaded) |
| Plots, graphs, number lines | `chart` (JSON spec) | Hand-rolled SVG charts |
| Data | `table` | HTML table |
| A photo or realistic illustration | `image` | Admin uploads it — see below |

Nothing is executed anywhere. `chart` specs with `kind: "function"` are plotted
by a small hand-written expression parser (`web/src/lib/expr.ts`) — never
`eval`. SVG is filtered against an allow-list of elements and attributes
**before it is stored**, and again in the browser before rendering.

### Images

None of the supported providers generate pictures, so the system does not
pretend otherwise. Every question is tagged **image required: yes or no**.

When a question genuinely needs a photograph or realistic illustration that line
art cannot convey, the model must set `imageRequired: true` and supply a
complete image-generation prompt with it:

```jsonc
{
  "imageRequired": true,
  "imagePrompt": {
    "prompt":      "A colour photograph of a laboratory beaker on a bench, side view…",
    "description": "Shows a beaker containing blue liquid at the 250 ml mark.",
    "details":     ["label the 250 ml graduation", "liquid must be clearly blue"],
    "style":       "realistic colour photograph, neutral background",
    "widthPx": 800, "heightPx": 600, "aspectRatio": "4:3",
    "altText":     "Beaker of blue liquid",
    "placement":   "STEM"          // or "OPTION" + optionId
  }
}
```

The review screen shows that prompt with a **Copy prompt** button — one paste
into any image generator — and an **Upload** button for the result. The picture
is inserted above the question (or the named option) automatically.

Two guardrails make this safe:

- A question flagged `imageRequired` **cannot be approved** until an image is
  attached, so an unanswerable question can never reach a student. Bulk-approve
  skips them and says how many it skipped.
- The generator is told to aim for at most one in ten questions needing a real
  picture, and a **Text and drawn diagrams only** switch on the generation
  screen forbids them outright. Practice tests always use that switch, so
  remedial work is never blocked waiting for artwork.

Server-side code execution is deliberately not part of the system.

---

## Administrator privileges

"Admin" is not one thing. Each privilege is granted separately with a checkbox,
and `server/src/lib/permissions.ts` is the single source of truth:

| Privilege | Reaches |
|---|---|
| `users.manage` | Students: add, edit, rename, reset password, deactivate, delete |
| `admins.manage` | Create administrators and set anyone's privileges |
| `questions.generate` | Run the LLM generator — **spends money** |
| `questions.review` | Edit, approve, reject questions; attach images |
| `tests.manage` | Create tests, choose questions, publish |
| `results.release` | Reveal or withhold a test's results |
| `analytics.view` | Class and per-student performance, CSV export |
| `backups.manage` | Generate and download full backups |
| `activities.manage` | Create activities and see who has completed them |
| `settings.manage` | API keys, prompts, tags, grades and divisions |

Enforcement is server-side: every admin area is registered inside a scope
carrying its privilege (`index.ts`), and routes that span two — generate vs
review, manage vs release — re-check the specific one. The UI hides what a user
cannot reach, but that is only a courtesy; the API refuses regardless.

Three safeguards stop the system being bricked:

- Nobody can revoke their own `admins.manage`.
- The last active holder of `admins.manage` cannot be deactivated or deleted —
  including by someone who only holds `users.manage`.
- Unrecognised privilege codes are dropped on write, so a retired or invented
  code can never grant access.

Upgrading from a version without this model grants the existing administrator
every privilege, because `ADMIN` used to mean exactly that. Anything less would
lock the only account out of the very screen used to grant privileges back.

## The tag taxonomy

Every question carries tags on **four independent axes**. Orthogonality is the
whole point: it is what lets the system say *"weak at application-level
algebraic manipulation in Quadratics, at moderate difficulty"* instead of just
*"scored 40%"*.

| Axis | Values |
|---|---|
| **Difficulty** | easy · moderate · difficult |
| **Cognitive level** | memory · conceptual · application · reasoning · analysis |
| **Skill** | numerical computation · algebraic manipulation · spatial/visual · data interpretation · logical deduction · language comprehension · general knowledge · procedural |
| **Curriculum** | subject → topic → subtopic |

Every answer lands in a cell of that grid. Weak cells are ranked by a
confidence-weighted priority score (so 4/10 outranks 1/3), and the
practice-test generator seeds its prompt straight from them.

Tags live in a database table, not an enum — adding "very difficult" later is an
`INSERT`, not a migration.

---

## Designed to survive upgrades

The schema follows six rules, documented at the top of
[`server/prisma/schema.prisma`](server/prisma/schema.prisma):

1. UUID primary keys everywhere, so rows merge across databases on restore.
2. Anything whose *shape* may change lives in versioned JSONB.
3. Anything queried or aggregated is a real typed column with a real index.
4. Every table has a `meta Json` escape hatch for new optional fields.
5. Vocabularies are rows, not enum types.
6. Deletes are soft wherever history references the row.

Backups contain **two** copies of the data: a native `pg_dump` for a fast exact
restore, and a plain-JSON export that stays readable across a PostgreSQL major
upgrade or a schema change. The archive is an ordinary `.tar.gz`, so it can be
opened and inspected with any unzip tool.

Stable identifiers reinforce this: `User.publicId` (`USR-00001`),
`Test.publicId` (`TST-0001`) and `Activity.publicId` (`ACT-0001`) are assigned
by a database sequence at insert time and never updated, so external records
and printed papers keep pointing at the right row no matter what is edited
later.

---

## Running it on your own machine

Two ways, depending on what you want.

**A trial that behaves exactly like the server** — same containers, same
database, same migrations, over plain HTTP with no domain name:

```bash
cp .env.example .env      # set PUBLIC_HOST=localhost and the two secrets
sudo docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

Then open http://localhost. Other devices on the same Wi-Fi can join at
`http://<your-ip>` — `hostname -I` will tell you the address. Full walkthrough
in [deploy/DEPLOYMENT.md](deploy/DEPLOYMENT.md#0-trying-it-on-your-own-machine-first).

The override serves plain HTTP and turns off the Secure cookie flag, because
neither can work without a certificate. That is fine on your own machine and on
a school LAN, and must never be used on a public server.

**Development, with hot reload:**

```bash
# 1. PostgreSQL
docker run -d --name foundation-db -p 5432:5432 \
  -e POSTGRES_PASSWORD=devpass -e POSTGRES_USER=foundation -e POSTGRES_DB=foundation \
  postgres:16-alpine

# 2. API on :4000
cd server
npm install
export DATABASE_URL="postgresql://foundation:devpass@localhost:5432/foundation?schema=public"
export JWT_SECRET=dev-secret-at-least-16-chars
export ENCRYPTION_KEY=dev-encryption-key-16-chars-min
export UPLOAD_DIR=./uploads BACKUP_DIR=./backups NODE_ENV=development
npx prisma migrate deploy
npx tsc && node dist/seed.js
npm run dev

# 3. Frontend on :5173 (proxies /api to :4000)
cd ../web
npm install
npm run dev
```

Sign in as `admin` / `foundation_123`.

---

## Repository layout

```
server/          Fastify API
  prisma/        schema + migrations
  src/lib/       content blocks, grading, analytics, crypto, passwords
  src/llm/       provider adapters, strict-JSON contract, prompts
  src/routes/    auth, student, admin/*
  src/services/  attempt lifecycle, backup/restore
web/             React frontend
  src/renderers/ the block renderers (text, math, svg, mermaid, chart, …)
  src/components/charts.tsx   hand-rolled SVG charts
  src/pages/     landing, dashboard, test runner, result, admin/*
docs/            GitHub Pages landing page (the "Enter" button)
deploy/          bootstrap.sh, backup.sh, restore.sh, DEPLOYMENT.md
```

---

## On a phone

Students sit papers on whatever they have, so the student side is built for a
390px screen first: no horizontal scrolling anywhere, and every control a
student taps during an exam is at least 40px tall.

The touch sizing keys on `@media (pointer: coarse)` rather than a width
breakpoint, so it follows the input device rather than the window — a narrow
browser window on a laptop keeps its compact controls, and a large tablet gets
the bigger ones.

The one layout that genuinely differs is the test runner's question pane: a
sticky sidebar on a laptop, and on a phone a one-line bar directly under the
header that expands into the grid and closes again when a question is picked.
Left where the sidebar sits, it landed below the question card — so switching
question meant scrolling past the whole question to reach the numbers, which is
the one thing the pane exists to avoid.

Admin tables scroll inside their own card rather than the page, so the admin
screens are usable on a phone even though they are meant for a desk.

---

## Security

- Argon2id password hashing (64 MB, 3 passes)
- httpOnly + SameSite=Lax session cookies, Secure in production
- LLM API keys AES-256-GCM encrypted at rest, never returned to any client
- Backup archives are unencrypted by choice — keep them in a private folder,
  they contain password hashes
- SVG allow-list sanitisation on write and on render
- KaTeX macro expansion capped, so a crafted formula cannot hang a browser
  mid-exam
- Uploaded SVG is served as a download, never inline, so it cannot script our
  own origin
- Rate limiting on login, signup and generation; account lockout after 8 failed
  logins
- Server-authoritative exam timer — the client clock is never trusted
- Answer keys are stripped from every student-facing payload
- Full audit log of administrative actions
