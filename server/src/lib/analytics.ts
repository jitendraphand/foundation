import { round2 } from './grading.js';

/**
 * Turns raw answers into the per-axis breakdown that drives both the student
 * dashboard and the admin's weak-area detection.
 *
 * The whole point of tagging questions on three orthogonal axes is this
 * function: it produces a cell-by-cell mastery grid, and the practice-test
 * generator seeds its prompt from the weakest cells.
 */

export interface GradedRow {
  questionId: string;
  isCorrect: boolean;
  marksAwarded: number;
  maxMarks: number;
  answered: boolean;
  timeSpentMs: number;
  difficultyTag: string;
  cognitiveTag: string;
  skillTags: string[];
  subject: string;
  topic: string | null;
  subtopic: string | null;
}

export interface Cell {
  correct: number;
  total: number;
  answered: number;
  marks: number;
  maxMarks: number;
  accuracy: number; // correct / total, 0..1
  avgTimeMs: number;
}

export interface Breakdown {
  byDifficulty: Record<string, Cell>;
  byCognitive: Record<string, Cell>;
  bySkill: Record<string, Cell>;
  byTopic: Record<string, Cell>;
  bySubtopic: Record<string, Cell>;
}

function emptyCell(): Cell {
  return { correct: 0, total: 0, answered: 0, marks: 0, maxMarks: 0, accuracy: 0, avgTimeMs: 0 };
}

function add(map: Record<string, Cell>, key: string, row: GradedRow, timeAcc: Record<string, number>) {
  if (!key) return;
  const cell = (map[key] ??= emptyCell());
  cell.total += 1;
  if (row.isCorrect) cell.correct += 1;
  if (row.answered) cell.answered += 1;
  cell.marks = round2(cell.marks + row.marksAwarded);
  cell.maxMarks = round2(cell.maxMarks + row.maxMarks);
  timeAcc[key] = (timeAcc[key] ?? 0) + row.timeSpentMs;
}

function finalize(map: Record<string, Cell>, timeAcc: Record<string, number>) {
  for (const [key, cell] of Object.entries(map)) {
    cell.accuracy = cell.total > 0 ? round2(cell.correct / cell.total) : 0;
    cell.avgTimeMs = cell.total > 0 ? Math.round((timeAcc[key] ?? 0) / cell.total) : 0;
  }
}

export function buildBreakdown(rows: GradedRow[]): Breakdown {
  const out: Breakdown = {
    byDifficulty: {}, byCognitive: {}, bySkill: {}, byTopic: {}, bySubtopic: {},
  };
  const t = { d: {} as Record<string, number>, c: {} as Record<string, number>, s: {} as Record<string, number>, tp: {} as Record<string, number>, st: {} as Record<string, number> };

  for (const row of rows) {
    add(out.byDifficulty, row.difficultyTag, row, t.d);
    add(out.byCognitive, row.cognitiveTag, row, t.c);
    for (const skill of row.skillTags) add(out.bySkill, skill, row, t.s);
    if (row.topic) add(out.byTopic, row.topic, row, t.tp);
    if (row.subtopic) add(out.bySubtopic, row.subtopic, row, t.st);
  }

  finalize(out.byDifficulty, t.d);
  finalize(out.byCognitive, t.c);
  finalize(out.bySkill, t.s);
  finalize(out.byTopic, t.tp);
  finalize(out.bySubtopic, t.st);
  return out;
}

// --- Weak-area detection ---------------------------------------------------

export interface WeakArea {
  axis: 'difficulty' | 'cognitive' | 'skill' | 'topic' | 'subtopic';
  key: string;
  accuracy: number;
  correct: number;
  total: number;
  /** 0..100, higher = more urgent. Drives the practice-test prompt. */
  priority: number;
}

/**
 * Ranks weak areas across many attempts.
 *
 * Two guards keep this honest:
 *  - a minimum sample size, so one unlucky question doesn't become a "weakness"
 *  - a confidence weight by sample size, so 4/10 outranks 1/3
 */
export function findWeakAreas(
  breakdowns: Breakdown[],
  opts: { minSample?: number; accuracyThreshold?: number; limit?: number } = {},
): WeakArea[] {
  const minSample = opts.minSample ?? 3;
  const threshold = opts.accuracyThreshold ?? 0.7;
  const limit = opts.limit ?? 12;

  const merged: Record<string, Record<string, { correct: number; total: number }>> = {
    difficulty: {}, cognitive: {}, skill: {}, topic: {}, subtopic: {},
  };

  const axisMap: Array<[keyof Breakdown, string]> = [
    ['byDifficulty', 'difficulty'],
    ['byCognitive', 'cognitive'],
    ['bySkill', 'skill'],
    ['byTopic', 'topic'],
    ['bySubtopic', 'subtopic'],
  ];

  for (const b of breakdowns) {
    for (const [field, axis] of axisMap) {
      for (const [key, cell] of Object.entries(b[field] ?? {})) {
        const acc = (merged[axis][key] ??= { correct: 0, total: 0 });
        acc.correct += cell.correct;
        acc.total += cell.total;
      }
    }
  }

  const results: WeakArea[] = [];
  for (const [axis, keys] of Object.entries(merged)) {
    for (const [key, { correct, total }] of Object.entries(keys)) {
      if (total < minSample) continue;
      const accuracy = correct / total;
      if (accuracy >= threshold) continue;

      // Confidence rises with sample size and saturates around n = 20.
      const confidence = Math.min(1, total / 20);
      const priority = Math.round((1 - accuracy) * 100 * (0.5 + 0.5 * confidence));

      results.push({
        axis: axis as WeakArea['axis'],
        key,
        accuracy: round2(accuracy),
        correct,
        total,
        priority,
      });
    }
  }

  return results.sort((a, b) => b.priority - a.priority).slice(0, limit);
}

/**
 * Renders weak areas as the plain-English focus paragraph injected into the
 * practice-test generation prompt.
 */
export function weakAreasToPromptHint(areas: WeakArea[]): string {
  if (areas.length === 0) {
    return 'No specific weak areas identified yet; produce a balanced mix across the given topics.';
  }
  const lines = areas.map(
    (a) => `- ${a.axis}: "${a.key}" - currently ${a.correct}/${a.total} correct (${Math.round(a.accuracy * 100)}%)`,
  );
  return `This student is weakest in the following areas. Target them:\n${lines.join('\n')}`;
}
