import { prisma } from './db.js';
import { env } from './env.js';
import { hashPassword } from './lib/password.js';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_USER_TEMPLATE, PRACTICE_SYSTEM_SUFFIX } from './llm/prompts.js';
import { ALL_PERMISSIONS } from './lib/permissions.js';

/**
 * Idempotent seed. Runs on every container start, so a new deployment and an
 * upgrade of an existing one both end up with a complete vocabulary. Nothing
 * here overwrites data an admin has edited.
 */

const DIFFICULTY = [
  { code: 'easy', label: 'Easy', weight: 1, sortOrder: 1, description: 'Single step; direct recall or direct substitution.' },
  { code: 'moderate', label: 'Moderate', weight: 2, sortOrder: 2, description: 'Two or three steps, or one step with a twist.' },
  { code: 'difficult', label: 'Difficult', weight: 3, sortOrder: 3, description: 'Multi-step, or requires combining two ideas.' },
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

  const divisions = ['A', 'B', 'C', 'D', 'E', 'F'].map((d, i) => ({
    kind: 'DIVISION',
    code: d,
    label: `Division ${d}`,
    sortOrder: i + 1,
  }));

  for (const row of [...grades, ...divisions]) {
    await prisma.schoolClass.upsert({
      where: { kind_code: { kind: row.kind, code: row.code } },
      update: {},
      create: row,
    });
  }
  console.log(`[seed] classes: ${grades.length} grades, ${divisions.length} divisions`);
}

async function seedPrompts() {
  const existing = await prisma.promptTemplate.count();
  if (existing > 0) {
    console.log('[seed] prompt templates already present, leaving them alone');
    return;
  }

  await prisma.promptTemplate.create({
    data: {
      name: 'Standard question generator',
      description: 'Default strict-JSON generator for regular tests. Handles maths, SVG diagrams, Mermaid and chart specs.',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      userTemplate: DEFAULT_USER_TEMPLATE,
      kind: 'REGULAR',
      isDefault: true,
    },
  });

  await prisma.promptTemplate.create({
    data: {
      name: 'Remedial practice generator',
      description: 'Targets one student\'s weak areas; ramps difficulty and writes fuller explanations.',
      systemPrompt: DEFAULT_SYSTEM_PROMPT + PRACTICE_SYSTEM_SUFFIX,
      userTemplate: DEFAULT_USER_TEMPLATE,
      kind: 'PRACTICE',
      isDefault: true,
    },
  });

  console.log('[seed] prompt templates: 2 created');
}

async function seedAdmin() {
  const existing = await prisma.user.findFirst({ where: { role: 'ADMIN', deletedAt: null } });
  if (existing) {
    const missing = ALL_PERMISSIONS.filter((p) => !existing.permissions.includes(p));

    if (existing.permissions.length === 0) {
      // Upgrading from a version that had no per-privilege model, where being
      // an ADMIN simply meant full access. Preserve exactly that, otherwise
      // the upgrade would silently lock the only administrator out of
      // everything - including the screen used to grant privileges back.
      await prisma.user.update({ where: { id: existing.id }, data: { permissions: ALL_PERMISSIONS } });
      console.log(`[seed] ${existing.username} predates per-privilege access; granted all ${ALL_PERMISSIONS.length} privileges`);
    } else if (existing.permissions.includes('admins.manage') && missing.length > 0) {
      // A later upgrade added privileges that did not exist before. Top up
      // whoever holds the keys so no area is left unreachable; everyone else
      // keeps exactly what they were given.
      await prisma.user.update({ where: { id: existing.id }, data: { permissions: ALL_PERMISSIONS } });
      console.log(`[seed] granted ${missing.length} new privilege(s) to ${existing.username}: ${missing.join(', ')}`);
    } else {
      console.log(`[seed] administrator already exists (${existing.username})`);
    }
    return;
  }

  const admin = await prisma.user.create({
    data: {
      username: env.ADMIN_USERNAME.toLowerCase(),
      firstName: 'System',
      lastName: 'Administrator',
      grade: 'STAFF',
      division: 'STAFF',
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
