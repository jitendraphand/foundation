import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, Card, PageLoader, Spinner, formatDate, humanizeTag } from '../components/ui';
import { AccuracyMeter, BarChart, DataTable, StatTile } from '../components/charts';
import { ContentRenderer, BlocksRenderer } from '../renderers/BlockRenderer';
import type { Breakdown, PaperQuestion } from '../lib/types';

/** Returned while the test's results are still held back by the admin. */
interface PendingResult {
  released: false;
  attempt: { id: string; status: string; startedAt: string; submittedAt: string | null };
  test: { id: string; publicId: string; title: string; subject: string; kind: string };
  message: string;
}

interface ResultData {
  released: true;
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

  const [data, setData] = useState<ResultData | PendingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<ResultData | PendingResult>(`/api/student/attempts/${attemptId}/result`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load this result.'));
  }, [attemptId]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <PageLoader label="Loading your result" />;

  // Submitted, but the teacher has not released this test's results yet.
  if (!data.released) return <AwaitingRelease data={data} justSubmitted={!!state?.justSubmitted} auto={!!state?.auto} />;

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

// --- Awaiting release ------------------------------------------------------

function AwaitingRelease({ data, justSubmitted, auto }: { data: PendingResult; justSubmitted: boolean; auto: boolean }) {
  return (
    <div className="max-w-xl mx-auto space-y-4">
      {justSubmitted && (
        <Alert tone={auto ? 'warn' : 'success'}>
          {auto ? 'Time ran out, so your paper was submitted automatically.' : 'Your paper has been submitted.'}
        </Alert>
      )}

      <Card>
        <div className="text-center py-6 px-2">
          <div className="w-11 h-11 rounded-full bg-surface-sunken border border-line grid place-items-center mx-auto mb-4">
            <span className="text-xl" aria-hidden>✓</span>
          </div>

          <h1 className="text-base font-semibold">{data.test.title}</h1>
          <p className="text-xs text-ink-muted mt-1">
            <span className="font-mono">{data.test.publicId}</span> · {data.test.subject} · submitted{' '}
            {formatDate(data.attempt.submittedAt, true)}
          </p>

          <p className="text-sm text-ink-muted mt-5 max-w-sm mx-auto">{data.message}</p>
          <p className="text-xs text-ink-faint mt-2 max-w-sm mx-auto">
            Results are usually held back until everybody in the class has finished. Your dashboard will show the score
            as soon as it is released.
          </p>

          <Link to="/dashboard" className="btn-primary btn-sm mt-6 inline-flex">
            Back to dashboard
          </Link>
        </div>
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
    // No topic breakdown here. A topic split on one paper is three or four
    // questions per row, which is too little to mean anything - a student
    // reading "Kinematics 33%" off one wrong answer draws a conclusion the
    // data does not support. Difficulty, question type and skill hold across
    // the whole paper, so they survive that objection.
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
          {/* Only a preview while collapsed - the full text renders below once
              expanded, and showing both reads as the question printed twice. */}
          {!open && (
            <span className="block text-sm truncate text-ink-muted">
              {firstLine(question)}
            </span>
          )}
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
                      <BlocksRenderer blocks={option.blocks} className="[&>p]:my-0" dense />
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
          </div>

          <StepUp questionId={question.id} />
        </div>
      )}
    </li>
  );
}

/**
 * Five more questions, generated from this one and sat straight away.
 *
 * Two buttons rather than one because "more of these" means different things
 * depending on how the question went. Someone who was nearly right wants
 * another five of the same; someone who had no idea where to start wants the
 * steps that lead up to it.
 *
 * The paper opens in a new tab, so the result being read stays put - a student
 * comparing their working against the explanation should not lose it by
 * clicking through.
 */
interface Allowance {
  /** Papers a day; 0 means no limit. */
  quota: number;
  used: number;
  /** null when there is no limit. */
  remaining: number | null;
}

function StepUp({ questionId }: { questionId: string }) {
  const [busy, setBusy] = useState<'SAME' | 'LADDER' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [allowance, setAllowance] = useState<Allowance | null>(null);

  // Asked once. A student out of Step-ups should be told before pressing the
  // button, not after waiting for a tab that then reports a refusal.
  useEffect(() => {
    api
      .get<{ allowance: Allowance }>('/api/step-up/allowance')
      .then((res) => setAllowance(res.allowance))
      .catch(() => undefined);
  }, []);

  const spent = allowance?.remaining === 0;

  const start = async (mode: 'SAME' | 'LADDER') => {
    setBusy(mode);
    setError(null);
    // Opened before the request, because a tab opened later - after an await -
    // is a pop-up as far as the browser is concerned and gets blocked.
    const tab = window.open('', '_blank');
    if (tab) tab.document.write('<title>Building your Step-up test…</title><p style="font:14px system-ui;padding:2rem">Writing five questions for you. This takes a few seconds.</p>');

    try {
      const built = await api.post<{ testId: string; allowance?: Allowance }>('/api/step-up', { questionId, mode });
      if (built.allowance) setAllowance(built.allowance);
      // Start it here rather than server-side, so the paper opens through the
      // same route as any other test and keeps its checks - attempt limits,
      // availability, the activity gate.
      const started = await api.post<{ attemptId: string }>(`/api/student/tests/${built.testId}/start`, {});
      const url = `${window.location.origin}/attempt/${started.attemptId}`;
      if (tab) tab.location.href = url;
      else window.location.href = url;
    } catch (err) {
      tab?.close();
      setError(err instanceof ApiError ? err.message : 'Could not build a Step-up test just now.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-line bg-surface-sunken p-3">
      <p className="text-xs text-ink-muted mb-2">
        {spent ? 'You have used all of today’s practice tests.' : 'Want more practice on this?'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={busy !== null || spent}
          onClick={() => void start('SAME')}
        >
          {busy === 'SAME' ? <Spinner label="Writing" /> : '5 more like this'}
        </button>
        <button
          type="button"
          className="btn-secondary btn-sm"
          disabled={busy !== null || spent}
          onClick={() => void start('LADDER')}
        >
          {busy === 'LADDER' ? <Spinner label="Writing" /> : 'Build up to this'}
        </button>
        {/* Only when there is a limit, and only once it is worth knowing. */}
        {allowance?.remaining !== null && allowance !== null && (
          <span className="text-[11px] text-ink-faint">
            {allowance.remaining === 0
              ? 'Come back tomorrow.'
              : `${allowance.remaining} left today`}
          </span>
        )}
      </div>
      {error && <p className="text-xs text-bad mt-2">{error}</p>}
    </div>
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

