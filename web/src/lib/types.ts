export type Role = 'STUDENT' | 'ADMIN';
export type TestKind = 'REGULAR' | 'PRACTICE';
export type QuestionFormat = 'MCQ_SINGLE' | 'MCQ_MULTI';
export type QuestionStatus = 'DRAFT' | 'APPROVED' | 'REJECTED';
export type TestStatus = 'DRAFT' | 'PUBLISHED' | 'CLOSED';

export interface Me {
  id: string;
  /** Stable USR-00001 identity; never changes, even after a rename. */
  publicId: string;
  username: string;
  firstName: string;
  lastName: string;
  grade?: string;
  division?: string;
  rollNo?: string;
  dateOfBirth?: string;
  role: Role;
  /** Which admin areas this account may use. Empty for a student. */
  permissions: string[];
  mustChangePassword?: boolean;
  lastLoginAt?: string | null;
}

export interface PermissionDef {
  code: string;
  label: string;
  group: string;
  description: string;
  sensitive?: boolean;
}

export interface PermissionPreset {
  code: string;
  label: string;
  description: string;
  permissions: string[];
}

export interface Administrator {
  id: string;
  publicId: string;
  username: string;
  firstName: string;
  lastName: string;
  isActive: boolean;
  permissions: string[];
  lastLoginAt: string | null;
  createdAt: string;
  mustChangePassword: boolean;
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
  | null;

export interface AnswerKey {
  correctOptionId?: string;
  correctOptionIds?: string[];
  partialCredit?: boolean;
}

/**
 * Supplied by the generator whenever a question needs a real picture that no
 * text model can draw. The admin pastes `prompt` into any image generator,
 * then uploads the result against the question.
 */
export interface ImagePrompt {
  version?: number;
  prompt: string;
  description: string;
  details: string[];
  style: string;
  widthPx: number;
  heightPx: number;
  aspectRatio?: string;
  altText: string;
  placement: 'STEM' | 'OPTION';
  optionId?: string | null;
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
  imageRequired?: boolean;
  imagePrompt?: ImagePrompt | null;
  imageFulfilled?: boolean;
}

export interface BankQuestion extends Omit<PaperQuestion, 'marks'> {
  status: QuestionStatus;
  answerKey: AnswerKey;
  explanation: Content;
  imageRequired: boolean;
  imagePrompt: ImagePrompt | null;
  imageFulfilled: boolean;
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

export interface AwaitingResult {
  attemptId: string;
  testId: string;
  testPublicId: string;
  title: string;
  subject: string;
  submittedAt: string | null;
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
  /** Stable TST-0001 identity, shown on the paper and in every report. */
  publicId: string;
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
