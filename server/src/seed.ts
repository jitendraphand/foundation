import { createHash } from 'node:crypto';
import { prisma } from './db.js';
import { env } from './env.js';
import { hashPassword } from './lib/password.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_USER_TEMPLATE,
  DEFAULT_STEP_UP_TEMPLATE,
  PRACTICE_SYSTEM_SUFFIX,
} from './llm/prompts.js';
import { ALL_PERMISSIONS } from './lib/permissions.js';

/**
 * Idempotent seed. Runs on every container start, so a new deployment and an
 * upgrade of an existing one both end up with a complete vocabulary. Nothing
 * here overwrites data an admin has edited.
 */

const DIFFICULTY = [
  { code: 'easy', label: 'Easy', weight: 1, sortOrder: 1, description: 'Single step; direct recall or direct substitution.' },
  { code: 'medium', label: 'Medium', weight: 2, sortOrder: 2, description: 'Two or three steps, or one step with a twist.' },
  { code: 'hard', label: 'Hard', weight: 3, sortOrder: 3, description: 'Multi-step, or requires combining two ideas.' },
];

const COGNITIVE = [
  { code: 'memory', label: 'Memory based', weight: 1, sortOrder: 1, description: 'Recall a fact, definition, formula or date.' },
  { code: 'conceptual', label: 'Conceptual', weight: 2, sortOrder: 2, description: 'Explain or identify why something is so - understanding, not recall.' },
  { code: 'application', label: 'Application based', weight: 3, sortOrder: 3, description: 'Apply a known method to a new but familiar situation.' },
  { code: 'reasoning', label: 'Reasoning', weight: 4, sortOrder: 4, description: 'Deduce through several linked logical steps.' },
  { code: 'analysis', label: 'Analysis', weight: 5, sortOrder: 5, description: 'Compare, interpret data, or find the flaw in an argument.' },
];

const SKILL = [
  { code: 'numerical_computation', label: 'Numerical computation', sortOrder: 1, description: 'Arithmetic, percentages, ratios, direct calculation.' },
  { code: 'algebraic_manipulation', label: 'Algebraic manipulation', sortOrder: 2, description: 'Rearranging, solving, factorising, simplifying.' },
  { code: 'spatial_visual', label: 'Spatial and visual', sortOrder: 3, description: 'Geometry, shapes, mental rotation, reading a figure.' },
  { code: 'data_interpretation', label: 'Data interpretation', sortOrder: 4, description: 'Reading tables, charts and graphs; averages; trends.' },
  { code: 'logical_deduction', label: 'Logical deduction', sortOrder: 5, description: 'Sequences, patterns, syllogisms, puzzles.' },
  { code: 'language_comprehension', label: 'Language comprehension', sortOrder: 6, description: 'Reading a passage, vocabulary, grammar.' },
  { code: 'factual_gk', label: 'General knowledge', sortOrder: 7, description: 'Current affairs and static general knowledge.' },
  { code: 'procedural', label: 'Procedural', sortOrder: 8, description: 'Following or ordering the steps of a method or experiment.' },
];

async function seedTags() {
  const all = [
    ...DIFFICULTY.map((t) => ({ ...t, axis: 'DIFFICULTY' as const })),
    ...COGNITIVE.map((t) => ({ ...t, axis: 'COGNITIVE' as const })),
    ...SKILL.map((t) => ({ ...t, axis: 'SKILL' as const, weight: 0 })),
  ];

  for (const tag of all) {
    await prisma.tag.upsert({
      where: { axis_code: { axis: tag.axis, code: tag.code } },
      // Only fill in a missing description; never clobber an admin's edit.
      update: { description: tag.description },
      create: tag,
    });
  }
  console.log(`[seed] tag vocabulary: ${all.length} tags`);
}

async function seedClasses() {
  // Grades 6 to 10 only. An admin can add more from Settings without a
  // migration, because classes are rows rather than an enum.
  const grades = [6, 7, 8, 9, 10].map((n, i) => ({
    kind: 'GRADE',
    code: String(n),
    label: `Grade ${n}`,
    sortOrder: i + 1,
  }));

  // The school runs two streams rather than lettered classes. Still rows
  // rather than an enum, so more can be added from Settings without a
  // migration.
  const divisions = [
    { kind: 'DIVISION', code: 'SCIENCE', label: 'Science Foundation', sortOrder: 1 },
    { kind: 'DIVISION', code: 'SPORTS', label: 'Sports Foundation', sortOrder: 2 },
  ];

  for (const row of [...grades, ...divisions]) {
    await prisma.schoolClass.upsert({
      where: { kind_code: { kind: row.kind, code: row.code } },
      update: {},
      create: row,
    });
  }
  console.log(`[seed] classes: ${grades.length} grades, ${divisions.length} divisions`);
}

/**
 * The starting prompt for each generator.
 *
 * Per kind, not "are there any templates at all". An upgrade that adds a new
 * generator has to reach a database that already holds the other two, and the
 * old all-or-nothing check meant the new one silently never appeared - the
 * Prompts screen would simply be missing a card, with nothing to say why.
 *
 * A kind that already has a template is left completely alone, edits included.
 */
/**
 * How an improved default prompt reaches an install that already has the old
 * one, without ever overwriting an administrator's own wording.
 *
 * The prompt is editable, so it lives in the database, and the seed used to
 * refuse to touch a kind that already existed. That was safe and wrong: the
 * shipped prompt is where the drawing contract and the JSON schema are stated,
 * so an install that upgraded kept generating against last year's rules for
 * ever, with nothing to say so.
 *
 * A fingerprint of the text as shipped is stored beside it. On the next seed,
 * a field that still hashes to what we shipped is text nobody has touched, and
 * is brought up to date; anything else is the admin's and is left exactly as it
 * is. The two hashes below are the prompts shipped before this mechanism
 * existed, so the first upgrade recognises them too.
 */
const PREVIOUSLY_SHIPPED = new Set([
  'ab21e2e41fb75ccb', // REGULAR and STEP_UP, before a diagram had to be planned
  '1b1e15725966255d', // PRACTICE - the same prompt plus the practice suffix
]);

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function shippedMark(row: { systemPrompt: string; userTemplate: string }) {
  return { shipped: { systemPrompt: fingerprint(row.systemPrompt), userTemplate: fingerprint(row.userTemplate) } };
}

function stillAsShipped(stored: string, recorded: string | undefined): boolean {
  const hash = fingerprint(stored);
  return hash === recorded || PREVIOUSLY_SHIPPED.has(hash);
}

async function seedPrompts() {
  const wanted = [
    {
      kind: 'REGULAR',
      name: 'Standard question generator',
      description: 'Default strict-JSON generator for regular tests. Handles maths, SVG diagrams, Mermaid and chart specs.',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      userTemplate: DEFAULT_USER_TEMPLATE,
    },
    {
      kind: 'PRACTICE',
      name: 'Remedial practice generator',
      description: "Targets one student's weak areas; ramps difficulty and writes fuller explanations.",
      systemPrompt: DEFAULT_SYSTEM_PROMPT + PRACTICE_SYSTEM_SUFFIX,
      userTemplate: DEFAULT_USER_TEMPLATE,
    },
    {
      kind: 'STEP_UP',
      name: 'Step-up Test generator',
      description:
        'Used when a student asks for five more questions on one they got wrong. {{modeInstructions}} becomes ' +
        '"more like this" or "build up to it" depending on which the student chose; {{source}} is the original ' +
        'question and its options.',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      userTemplate: DEFAULT_STEP_UP_TEMPLATE,
    },
  ];

  let created = 0;
  let refreshed = 0;
  let kept = 0;

  for (const row of wanted) {
    const existing = await prisma.promptTemplate.findMany({ where: { kind: row.kind } });

    if (existing.length === 0) {
      await prisma.promptTemplate.create({ data: { ...row, isDefault: true, meta: shippedMark(row) } });
      created++;
      continue;
    }

    for (const template of existing) {
      const recorded = (template.meta as { shipped?: Record<string, string> } | null)?.shipped ?? {};
      const changes: Record<string, string> = {};
      for (const field of ['systemPrompt', 'userTemplate'] as const) {
        if (template[field] === row[field]) continue;
        if (stillAsShipped(template[field], recorded[field])) changes[field] = row[field];
      }
      if (Object.keys(changes).length === 0) {
        // Either already current, or the admin has made it their own.
        if (template.systemPrompt !== row.systemPrompt || template.userTemplate !== row.userTemplate) kept++;
        continue;
      }
      await prisma.promptTemplate.update({
        where: { id: template.id },
        data: { ...changes, version: { increment: 1 }, meta: shippedMark({ ...template, ...changes }) },
      });
      refreshed++;
    }
  }

  const parts = [
    created ? `${created} created` : '',
    refreshed ? `${refreshed} updated to the current default` : '',
    kept ? `${kept} left alone because they have been edited` : '',
  ].filter(Boolean);
  console.log(`[seed] prompt templates: ${parts.length ? parts.join(', ') : 'already current'}`);
}

async function seedAdmin() {
  // Every administrator, not the first one that happens to come back. This used
  // to be findFirst, which meant that on a school with three administrators the
  // top-up below landed on whichever row Postgres returned - usually a
  // colleague without admins.manage - and the actual system administrator was
  // never given the privileges a new release added.
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN', deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });

  if (admins.length > 0) {
    for (const admin of admins) {
      const missing = ALL_PERMISSIONS.filter((p) => !admin.permissions.includes(p));

      if (admin.permissions.length === 0) {
        // Upgrading from a version that had no per-privilege model, where being
        // an ADMIN simply meant full access. Preserve exactly that, otherwise
        // the upgrade would silently lock an administrator out of everything -
        // including the screen used to grant privileges back.
        await prisma.user.update({ where: { id: admin.id }, data: { permissions: ALL_PERMISSIONS } });
        console.log(`[seed] ${admin.username} predates per-privilege access; granted all ${ALL_PERMISSIONS.length} privileges`);
      } else if (admin.permissions.includes('admins.manage') && missing.length > 0) {
        // A later release added privileges that did not exist before. Top up
        // whoever holds the keys so no area is left unreachable; everyone else
        // keeps exactly what they were given, which is the point of the
        // privilege model.
        await prisma.user.update({ where: { id: admin.id }, data: { permissions: ALL_PERMISSIONS } });
        console.log(`[seed] granted ${missing.length} new privilege(s) to ${admin.username}: ${missing.join(', ')}`);
      }
    }
    console.log(`[seed] ${admins.length} administrator(s) already exist`);
    return;
  }

  const admin = await prisma.user.create({
    data: {
      username: env.ADMIN_USERNAME.toLowerCase(),
      firstName: 'System',
      lastName: 'Administrator',
      grade: 'STAFF',
      division: 'STAFF',
      divisions: ['STAFF'],
      rollNo: 'ADMIN',
      dateOfBirth: new Date('2000-01-01'),
      passwordHash: await hashPassword(env.ADMIN_PASSWORD),
      role: 'ADMIN',
      // The founding account holds every privilege, including the ability to
      // create further administrators with narrower ones.
      permissions: ALL_PERMISSIONS,
      isActive: true,
      // Not forced, because the specified default credentials must work as-is.
      mustChangePassword: false,
    },
  });

  // A STAFF pseudo-class keeps the admin out of every student-facing filter.
  await prisma.schoolClass.upsert({
    where: { kind_code: { kind: 'GRADE', code: 'STAFF' } },
    update: {},
    create: { kind: 'GRADE', code: 'STAFF', label: 'Staff', sortOrder: 999, isActive: false },
  });
  await prisma.schoolClass.upsert({
    where: { kind_code: { kind: 'DIVISION', code: 'STAFF' } },
    update: {},
    create: { kind: 'DIVISION', code: 'STAFF', label: 'Staff', sortOrder: 999, isActive: false },
  });

  console.log(`[seed] administrator created: ${admin.username}`);
  if (env.ADMIN_PASSWORD === 'foundation_123') {
    console.log('[seed] WARNING: the administrator is using the default password. Change it after your first sign-in.');
  }
}

async function main() {
  console.log('[seed] starting');
  await seedClasses();
  await seedTags();
  await seedPrompts();
  await seedAdmin();
  console.log('[seed] done');
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
