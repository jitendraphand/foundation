import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, Card, PageLoader, formatDate, humanizeTag } from '../components/ui';
import { AccuracyMeter, BarChart, DataTable, StatTile } from '../components/charts';
import { ContentRenderer, BlocksRenderer } from '../renderers/BlockRenderer';
import type { Breakdown, PaperQuestion } from '../lib/types';

interface ResultData {
  attempt: {
    id: string;
    status: string;
    score: number;
    maxScore: number;
    percentage: number;
    correctCount: number;
    incorrectCount: number;
    unansweredCount: number;
    breakdown: Breakdown;
    startedAt: string;
    submittedAt: string | null;
  };
  test: { id: string; title: string; subject: string; kind: string; passPercentage: number; showAnswersAfter: boolean };
  questions: PaperQuestion[];
}

export default function ResultView() {
  const { attemptId } = useParams<{ attemptId: string }>();
  const location = useLocation();
  const state = location.state as { justSubmitted?: boolean; auto?: boolean } | null;

  const [data, setData] = useState<ResultData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ResultData>(`/api/student/attempts/${attemptId}/result`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load this result.'));
  }, [attemptId]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <PageLoader label="Loading your result" />;

  const passed = data.attempt.percentage >= data.test.passPercentage;

  return (
    <div className="space-y-6">
      {state?.justSubmitted && (
        <Alert tone={state.auto ? 'warn' : 'success'}>
          {state.auto ? 'Time ran out, so your test was submitted automatically.' : 'Your test has been submitted.'}
        </Alert>
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">{data.test.title}</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            {data.test.subject} · Submitted {formatDate(data.attempt.submittedAt, true)}
            {data.test.kind === 'PRACTICE' && ' · Practice test'}
          </p>
        </div>
        <Link to="/dashboard" className="text-xs text-series-1 hover:underline">
          ← Back to dashboard
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile
          label="Score"
          value={`${data.attempt.score}/${data.attempt.maxScore}`}
          tone={passed ? 'good' : 'bad'}
          hint={passed ? 'Passed' : `Pass mark is ${data.test.passPercentage}%`}
        />
        <StatTile label="Percentage" value={data.attempt.percentage} unit="%" tone={passed ? 'good' : 'bad'} />
        <StatTile label="Correct" value={data.attempt.correctCount} tone="good" />
        <StatTile
          label="Wrong / skipped"
          value={`${data.attempt.incorrectCount} / ${data.attempt.unansweredCount}`}
          tone={data.attempt.incorrectCount > 0 ? 'warn' : 'neutral'}
        />
      </div>

      <BreakdownCharts breakdown={data.attempt.breakdown} />

      <Card title={data.test.showAnswersAfter ? 'Question review' : 'Your answers'} padded={false}>
        <ul className="divide-y divide-line">
          {data.questions.map((q, i) => (
            <QuestionReview key={q.id} question={q} index={i} showAnswers={data.test.showAnswersAfter} />
          ))}
        </ul>
      </Card>
    </div>
  );
}

// --- Breakdown charts ------------------------------------------------------

function BreakdownCharts({ breakdown }: { breakdown: Breakdown }) {
  if (!breakdown) return null;

  const sections: Array<{ title: string; cells: Record<string, { correct: number; total: number; accuracy: number }> }> = [
    { title: 'By difficulty', cells: breakdown.byDifficulty ?? {} },
    { title: 'By question type', cells: breakdown.byCognitive ?? {} },
    { title: 'By skill', cells: breakdown.bySkill ?? {} },
    { title: 'By topic', cells: breakdown.byTopic ?? {} },
  ].filter((s) => Object.keys(s.cells).length > 0);

  if (sections.length === 0) return null;

  return (
    <div className="grid md:grid-cols-2 gap-4">
      {sections.map((section) => {
        const keys = Object.keys(section.cells);
        const values = keys.map((k) => Math.round(section.cells[k].accuracy * 100));

        return (
          <Card key={section.title} title={section.title}>
            <BarChart
              categories={keys.map(humanizeTag)}
              // One series, one colour - bar length already encodes the value.
              series={[{ name: 'Accuracy', values }]}
              yMax={100}
              formatValue={(n) => `${n}%`}
              horizontal
              width={520}
              reference={{ value: 70, label: 'Target' }}
              table={
                <DataTable
                  headers={['Area', 'Correct', 'Total', 'Accuracy']}
                  rows={keys.map((k) => [
                    humanizeTag(k),
                    section.cells[k].correct,
                    section.cells[k].total,
                    `${Math.round(section.cells[k].accuracy * 100)}%`,
                  ])}
                />
              }
            />
          </Card>
        );
      })}
    </div>
  );
}

// --- Per-question review ---------------------------------------------------

function QuestionReview({ question, index, showAnswers }: { question: PaperQuestion; index: number; showAnswers: boolean }) {
  const [open, setOpen] = useState(false);

  const answered = question.yourResponse !== null && question.yourResponse !== undefined;
  const tone = !answered ? 'neutral' : question.isCorrect ? 'good' : 'bad';
  const statusLabel = !answered ? 'Not answered' : question.isCorrect ? 'Correct' : 'Incorrect';

  return (
    <li className="p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start justify-between gap-3 text-left"
        aria-expanded={open}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 flex-wrap mb-1">
            <span className="text-xs font-medium text-ink-muted">Q{index + 1}</span>
            <Badge tone={tone}>{statusLabel}</Badge>
            <Badge>{humanizeTag(question.difficultyTag)}</Badge>
            <Badge>{humanizeTag(question.cognitiveTag)}</Badge>
            <span className="text-xs text-ink-faint tabular-nums">
              {question.marksAwarded ?? 0}/{question.marks}
            </span>
          </span>
          <span className="block text-sm truncate text-ink-muted">
            {firstLine(question)}
          </span>
        </span>
        <span className="text-ink-faint text-xs shrink-0 mt-0.5">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="mt-4 pl-0 sm:pl-4 sm:border-l-2 border-line">
          <ContentRenderer content={question.content} />

          {question.options.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {question.options.map((option) => {
                const chosen = isChosen(question, option.id);
                const correct = showAnswers && isCorrectOption(question, option.id);

                return (
                  <li
                    key={option.id}
                    className={`flex items-start gap-2 p-2 rounded-lg border text-sm ${
                      correct
                        ? 'border-good/40 bg-good/[0.06]'
                        : chosen
                          ? 'border-bad/40 bg-bad/[0.06]'
                          : 'border-line'
                    }`}
                  >
                    <span className="text-xs font-medium text-ink-faint mt-0.5">{option.id.toUpperCase()}.</span>
                    <span className="min-w-0 flex-1">
                      <BlocksRenderer blocks={option.blocks} className="[&>p]:my-0" />
                    </span>
                    {chosen && <span className="text-[11px] text-ink-muted shrink-0">your answer</span>}
                    {correct && !chosen && <span className="text-[11px] text-good shrink-0">correct</span>}
                  </li>
                );
              })}
            </ul>
          )}

          {showAnswers && question.explanation?.blocks?.length ? (
            <div className="mt-4 rounded-lg bg-surface-sunken border border-line p-3">
              <h4 className="text-xs font-medium text-ink-muted mb-1">Explanation</h4>
              <ContentRenderer content={question.explanation} className="text-sm" />
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {question.skillTags.map((tag) => (
              <Badge key={tag}>{humanizeTag(tag)}</Badge>
            ))}
            {question.topic && <span className="text-[11px] text-ink-faint">{question.topic}</span>}
          </div>
        </div>
      )}
    </li>
  );
}

function firstLine(question: PaperQuestion): string {
  const block = question.content?.blocks?.find((b) => b.type === 'text');
  if (block && block.type === 'text') return block.value.slice(0, 120);
  const math = question.content?.blocks?.find((b) => b.type === 'math');
  if (math && math.type === 'math') return math.tex.slice(0, 80);
  return '(diagram question)';
}

function isChosen(question: PaperQuestion, optionId: string): boolean {
  const r = question.yourResponse as { optionId?: string; optionIds?: string[] } | null;
  if (!r) return false;
  if (r.optionId) return r.optionId === optionId;
  if (r.optionIds) return r.optionIds.includes(optionId);
  return false;
}

function isCorrectOption(question: PaperQuestion, optionId: string): boolean {
  const key = question.answerKey;
  if (!key) return false;
  if (key.correctOptionId) return key.correctOptionId === optionId;
  if (key.correctOptionIds) return key.correctOptionIds.includes(optionId);
  return false;
}

