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
- Sign up with name, grade, division, roll number and date of birth; the
  username is generated as `firstnamelastname`, with `1`, `2`, … appended only
  when that name is already taken.
- Dashboard showing live tests, past scores, a percentage trend chart, a
  per-subject breakdown, and the areas they are weakest in.
- Timed test runner with a server-authoritative clock, continuous autosave,
  per-question flagging, and full resume after a dropped connection or a closed
  laptop.
- Result view with score, per-axis breakdown charts, and (if the test allows)
  correct answers with worked explanations.

### For administrators
- **Set test** — generate questions from OpenRouter, NVIDIA NIM, or any
  OpenAI-compatible endpoint. Full control of the system prompt, the model, the
  difficulty and cognitive mix, and the exact user message (with a preview of
  precisely what will be sent).
- **Review** — every draft renders exactly as a student will see it, maths,
  diagrams and all. Edit anything, then approve. Only approved questions can go
  on a test.
- **Tests** — choose the final questions, set marks, negative marking, duration,
  shuffling, and audience; publish when ready.
- **Analytics** — score distribution, trend over time, per-class and per-subject
  comparison, cohort-wide tag mastery, and a weakest-first student ranking.
- **Per-student analysis** — mastery grid across all four tag axes, and one
  button to generate a practice test aimed at exactly the cells they are
  failing. Practice data stays segregated from class-test data everywhere.
- **User management** — activate, deactivate, edit, reset password, delete
  (soft by default so historical results survive).
- **Backups** — one click produces an encrypted archive containing everything,
  ready to store on Google Drive.

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
| A photo, or a figure needing a numerical library | `image` | Admin uploads it |

Nothing is executed anywhere. `chart` specs with `kind: "function"` are plotted
by a small hand-written expression parser (`web/src/lib/expr.ts`) — never
`eval`. SVG is filtered against an allow-list of elements and attributes
**before it is stored**, and again in the browser before rendering.

When a figure genuinely cannot be drawn any of those ways, the model is told to
emit a matplotlib script plus a `FIGURE NEEDED:` note. The admin sees both in
the review screen and attaches a rendered image. Server-side code execution is
deliberately not part of the system.

---

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
upgrade or a schema change.

---

## Local development

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

## Security

- Argon2id password hashing (64 MB, 3 passes)
- httpOnly + SameSite=Lax session cookies, Secure in production
- LLM API keys AES-256-GCM encrypted at rest, never returned to any client
- SVG allow-list sanitisation on write and on render
- KaTeX macro expansion capped, so a crafted formula cannot hang a browser
  mid-exam
- Rate limiting on login, signup and generation; account lockout after 8 failed
  logins
- Server-authoritative exam timer — the client clock is never trusted
- Answer keys are stripped from every student-facing payload
- Full audit log of administrative actions
