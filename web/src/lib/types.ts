export type Role = 'STUDENT' | 'ADMIN';
export type TestKind = 'REGULAR' | 'PRACTICE';
export type QuestionFormat = 'MCQ_SINGLE' | 'MCQ_MULTI' | 'TRUE_FALSE' | 'NUMERIC';
export type QuestionStatus = 'DRAFT' | 'APPROVED' | 'REJECTED';
export type TestStatus = 'DRAFT' | 'PUBLISHED' | 'CLOSED';

export interface Me {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  grade?: string;
  division?: string;
  rollNo?: string;
  dateOfBirth?: string;
  role: Role;
  mustChangePassword?: boolean;
  lastLoginAt?: string | null;
}

// --- Question content blocks (mirrors server/src/lib/content.ts) -----------

export interface ChartSpec {
  kind: 'line' | 'bar' | 'scatter' | 'pie' | 'numberline' | 'function';
  title?: string;
  xLabel?: string;
  yLabel?: string;
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  expression?: string;
  categories?: string[];
  series?: Array<{ name?: string; points?: [number, number][]; values?: number[] }>;
  marks?: Array<{ at: number; label?: string; filled?: boolean }>;
  intervals?: Array<{ from: number; to: number; label?: string }>;
}

export type Block =
  | { type: 'text'; value: string }
  | { type: 'math'; tex: string; display?: boolean }
  | { type: 'svg'; svg: string; caption?: string }
  | { type: 'mermaid'; code: string; caption?: string }
  | { type: 'chart'; spec: ChartSpec; caption?: string }
  | { type: 'table'; headers: string[]; rows: string[][]; caption?: string }
  | { type: 'image'; assetId: string; alt?: string; caption?: string }
  | { type: 'code'; language?: string; value: string; caption?: string };

export interface Content {
  version: number;
  blocks: Block[];
}

export interface QuestionOption {
  id: string;
  blocks: Block[];
}

export type AnswerResponse =
  | { optionId: string }
  | { optionIds: string[] }
  | { value: boolean }
  | { value: number }
  | null;

export interface AnswerKey {
  correctOptionId?: string;
  correctOptionIds?: string[];
  partialCredit?: boolean;
  value?: boolean | number;
  tolerance?: number;
  toleranceKind?: 'ABSOLUTE' | 'RELATIVE';
  unit?: string;
}

export interface PaperQuestion {
  id: string;
  format: QuestionFormat;
  content: Content;
  options: QuestionOption[];
  marks: number;
  estimatedSeconds: number;
  difficultyTag: string;
  cognitiveTag: string;
  skillTags: string[];
  subject: string;
  topic: string | null;
  subtopic: string | null;
  yourResponse?: AnswerResponse;
  isMarkedForReview?: boolean;
  isCorrect?: boolean | null;
  marksAwarded?: number;
  timeSpentMs?: number;
  answerKey?: AnswerKey;
  explanation?: Content;
}

export interface BankQuestion extends Omit<PaperQuestion, 'marks'> {
  status: QuestionStatus;
  answerKey: AnswerKey;
  explanation: Content;
  sourceModel?: string | null;
  isAdminEdited: boolean;
  reviewNote?: string | null;
  generationRunId?: string | null;
  timesServed: number;
  timesCorrect: number;
  observedP: number;
  createdAt: string;
}

// --- Analytics -------------------------------------------------------------

export interface Cell {
  correct: number;
  total: number;
  answered: number;
  marks: number;
  maxMarks: number;
  accuracy: number;
  avgTimeMs: number;
}

export interface Breakdown {
  byDifficulty: Record<string, Cell>;
  byCognitive: Record<string, Cell>;
  bySkill: Record<string, Cell>;
  byTopic: Record<string, Cell>;
  bySubtopic: Record<string, Cell>;
}

export interface WeakArea {
  axis: 'difficulty' | 'cognitive' | 'skill' | 'topic' | 'subtopic';
  key: string;
  accuracy: number;
  correct: number;
  total: number;
  priority: number;
}

export interface ResultRow {
  attemptId: string;
  testId: string;
  title: string;
  subject: string;
  kind: TestKind;
  score: number;
  maxScore: number;
  percentage: number;
  passed?: boolean;
  correctCount: number;
  incorrectCount: number;
  unansweredCount: number;
  submittedAt: string | null;
}

export interface LiveTest {
  id: string;
  title: string;
  description: string | null;
  kind: TestKind;
  subject: string;
  questionCount: number;
  durationMinutes: number;
  marksPerQuestion: number;
  negativeMarks: number;
  totalMarks: number;
  startsAt: string | null;
  endsAt: string | null;
  attemptsUsed: number;
  maxAttempts: number;
  canAttempt: boolean;
  inProgressAttemptId: string | null;
  lastPercentage: number | null;
}

export interface Tag {
  id: string;
  axis: 'DIFFICULTY' | 'COGNITIVE' | 'SKILL';
  code: string;
  label: string;
  description?: string | null;
  weight: number;
  sortOrder: number;
  isActive: boolean;
}
