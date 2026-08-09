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
  | { type: 'image'; assetId: string; alt?: string; caption?: string; width?: number; height?: number }
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
  /** Set when the question has been retired. Kept for papers already sat. */
  deletedAt?: string | null;
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
  /** False while a daily availability window has the test paused. */
  isOpenNow: boolean;
  closedReason: string | null;
  windowLabel: string | null;
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

// --- Activities ------------------------------------------------------------

export type ActivityKind = 'FLASHCARD' | 'VIDEO' | 'MIXED';
export type ActivityStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';

/** The card colour vocabulary. Mirrors CARD_ACCENTS on the server. */
export const CARD_ACCENTS = ['slate', 'blue', 'green', 'amber', 'rose', 'violet', 'teal'] as const;
export type CardAccent = (typeof CARD_ACCENTS)[number];

/** A flashcard is a titled stack of the same blocks a question is made of. */
export interface ActivityCard {
  id: string;
  title?: string;
  /** Colour scheme. See .accent-* in index.css. */
  accent?: CardAccent;
  /** A short line above the title — "Remember this", "Step 2 of 4". */
  eyebrow?: string;
  blocks: Block[];
}

export interface ActivityContent {
  version: number;
  cards: ActivityCard[];
}

/** The shape the 428 gate hands back — just enough to redirect. */
export interface PendingActivity {
  id: string;
  publicId: string;
  title: string;
  description: string | null;
  kind: ActivityKind;
}

/** What the student's runner receives. */
export interface ActivityDetail {
  id: string;
  publicId: string;
  title: string;
  description: string | null;
  kind: ActivityKind;
  content: ActivityContent;
  videoUrl: string | null;
  /** Only ever set for YouTube/Vimeo; anything else opens in a new tab. */
  videoEmbedUrl: string | null;
  videoProvider: string | null;
  minSeconds: number;
  isMandatory: boolean;
  cardCount: number;
}

export interface ActivityProgress {
  startedAt: string;
  completedAt: string | null;
  secondsSpent: number;
  cardsSeen: number;
  videoOpened: boolean;
}

/** A row in the student's dashboard list. */
export interface ActivitySummary {
  id: string;
  publicId: string;
  title: string;
  description: string | null;
  kind: ActivityKind;
  isMandatory: boolean;
  cardCount: number;
  hasVideo: boolean;
  completedAt: string | null;
}

/** The admin's view of an activity, with completion counts. */
export interface AdminActivity {
  id: string;
  publicId: string;
  title: string;
  description: string | null;
  kind: ActivityKind;
  status: ActivityStatus;
  content: ActivityContent;
  videoUrl: string | null;
  videoEmbedUrl: string | null;
  videoProvider: string | null;
  minSeconds: number;
  isMandatory: boolean;
  targetGrades: string[];
  targetDivisions: string[];
  targetUserId: string | null;
  targetUser?: { id: string; username: string; firstName: string; lastName: string } | null;
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  cardCount: number;
  startedCount?: number;
  completedCount?: number;
}

export interface ActivityCompletionRow {
  user: {
    id: string;
    publicId: string;
    username: string;
    firstName: string;
    lastName: string;
    grade: string | null;
    division: string | null;
    rollNo: string | null;
  };
  startedAt: string | null;
  completedAt: string | null;
  secondsSpent: number;
  cardsSeen: number;
  videoOpened: boolean;
  state: 'not_started' | 'in_progress' | 'completed';
}
