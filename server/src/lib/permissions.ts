/**
 * Administrator privileges.
 *
 * "Admin" is not one thing. A colleague who sets question papers has no
 * business holding the LLM API keys or downloading a full database backup, and
 * whoever handles student records does not need to touch the question bank.
 * Each privilege below is granted separately with a checkbox.
 *
 * Rules that keep this honest:
 *  - Codes are stable strings stored on the user row. Renaming one would
 *    silently revoke access, so add a new code and retire the old instead.
 *  - `admins.manage` is the keys-to-the-kingdom privilege: only a holder can
 *    create other administrators or change anybody's privileges, including
 *    their own. It is guarded so the last holder cannot be removed.
 *  - A student always has an empty list.
 */

export const PERMISSIONS = [
  {
    code: 'users.manage',
    label: 'Manage students',
    group: 'People',
    description: 'Add and edit students, change usernames, reset passwords, activate, deactivate and delete accounts.',
  },
  {
    code: 'admins.manage',
    label: 'Manage administrators',
    group: 'People',
    description:
      'Create other administrators and decide what each one can do. Grant this only to someone you would trust with the whole system.',
    sensitive: true,
  },
  {
    code: 'questions.generate',
    label: 'Generate questions',
    group: 'Questions',
    description: 'Run the question generator against the LLM provider. This spends money on the API account.',
    sensitive: true,
  },
  {
    code: 'questions.review',
    label: 'Review questions',
    group: 'Questions',
    description: 'Edit, approve and reject draft questions, and attach images to questions that need one.',
  },
  {
    code: 'tests.manage',
    label: 'Manage tests',
    group: 'Tests',
    description: 'Create tests, choose the questions, set the marking scheme, publish and close.',
  },
  {
    code: 'results.release',
    label: 'Release results',
    group: 'Tests',
    description: 'Reveal or withhold the results of a test for the whole class.',
  },
  {
    code: 'activities.manage',
    label: 'Manage activities',
    group: 'Questions',
    description:
      'Create flashcard and video activities, and decide whether students must complete them before doing anything else.',
  },
  {
    code: 'analytics.view',
    label: 'View analytics',
    group: 'Reporting',
    description: 'See class and per-student performance, weak areas, and export results to CSV.',
  },
  {
    code: 'backups.manage',
    label: 'Manage backups',
    group: 'System',
    description:
      'Generate and download full backups. An archive contains every record in the system, so this is effectively read access to everything.',
    sensitive: true,
  },
  {
    code: 'settings.manage',
    label: 'Manage settings',
    group: 'System',
    description:
      'Add and remove LLM API keys, edit generation prompts, and change the tag, grade and division lists.',
    sensitive: true,
  },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['code'];

export const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((p) => p.code);

const VALID = new Set<string>(ALL_PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return VALID.has(value);
}

/** Drops anything unrecognised, so a stale code can never widen access. */
export function sanitizePermissions(input: readonly string[]): Permission[] {
  return [...new Set(input.filter(isPermission))].sort();
}

export function hasPermission(granted: readonly string[], required: Permission): boolean {
  return granted.includes(required);
}

export function hasAnyPermission(granted: readonly string[], required: readonly Permission[]): boolean {
  return required.some((r) => granted.includes(r));
}

/**
 * Ready-made bundles for the common jobs, so an admin does not have to reason
 * about every checkbox to add a colleague. The UI ticks the boxes and the
 * admin can then adjust any of them.
 */
export const PRESETS: Array<{ code: string; label: string; description: string; permissions: Permission[] }> = [
  {
    code: 'full',
    label: 'Full administrator',
    description: 'Everything, including managing other administrators and the API keys.',
    permissions: [...ALL_PERMISSIONS],
  },
  {
    code: 'teacher',
    label: 'Teacher',
    description: 'Set and run tests, review questions, release results and see how the class is doing.',
    permissions: ['questions.generate', 'questions.review', 'activities.manage', 'tests.manage', 'results.release', 'analytics.view'],
  },
  {
    code: 'question_setter',
    label: 'Question setter',
    description: 'Write and review questions only. Cannot publish tests or see student data.',
    permissions: ['questions.generate', 'questions.review', 'activities.manage'],
  },
  {
    code: 'invigilator',
    label: 'Invigilator',
    description: 'Watch tests in progress and release results. Cannot change questions.',
    permissions: ['tests.manage', 'results.release', 'analytics.view'],
  },
  {
    code: 'office',
    label: 'Office / records',
    description: 'Student records and reporting only. No access to questions or system settings.',
    permissions: ['users.manage', 'analytics.view'],
  },
];
