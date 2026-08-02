import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Alert, Modal, PageLoader, formatDuration } from '../components/ui';
import { ContentRenderer, BlocksRenderer } from '../renderers/BlockRenderer';
import type { AnswerResponse, PaperQuestion } from '../lib/types';

interface Paper {
  attempt: { id: string; startedAt: string; expiresAt: string; remainingMs: number; attemptNumber: number };
  test: { id: string; title: string; subject: string; kind: string; durationMinutes: number; negativeMarks: number; totalMarks: number };
  questions: PaperQuestion[];
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function TakeTest() {
  const { attemptId } = useParams<{ attemptId: string }>();
  const navigate = useNavigate();

  const [paper, setPaper] = useState<Paper | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, AnswerResponse>>({});
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [remainingMs, setRemainingMs] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Time spent per question, so the analytics can show where a student stalls.
  const questionEnteredAt = useRef<number>(Date.now());
  const timeSpent = useRef<Record<string, number>>({});

  useEffect(() => {
    if (!attemptId) return;
    api
      .get<Paper>(`/api/student/attempts/${attemptId}`)
      .then((data) => {
        setPaper(data);
        setRemainingMs(data.attempt.remainingMs);
        const initial: Record<string, AnswerResponse> = {};
        const initialFlags: Record<string, boolean> = {};
        for (const q of data.questions) {
          if (q.yourResponse) initial[q.id] = q.yourResponse;
          if (q.isMarkedForReview) initialFlags[q.id] = true;
        }
        setAnswers(initial);
        setFlags(initialFlags);
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.body?.submitted as boolean)) {
          navigate(`/result/${attemptId}`, { replace: true });
          return;
        }
        setError(err instanceof ApiError ? err.message : 'Could not open this test.');
      });
  }, [attemptId, navigate]);

  const submit = useCallback(
    async (auto: boolean) => {
      if (!attemptId || submitting) return;
      setSubmitting(true);
      try {
        await api.post(`/api/student/attempts/${attemptId}/submit`);
        navigate(`/result/${attemptId}`, { replace: true, state: { justSubmitted: true, auto } });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not submit your test.');
        setSubmitting(false);
      }
    },
    [attemptId, navigate, submitting],
  );

  // The countdown is cosmetic; the server owns the deadline. A tick every 20s
  // re-syncs it, so sleeping the laptop or losing Wi-Fi cannot buy extra time.
  useEffect(() => {
    if (!paper) return;

    const local = setInterval(() => {
      setRemainingMs((ms) => Math.max(0, ms - 1000));
    }, 1000);

    const sync = setInterval(async () => {
      try {
        const res = await api.get<{ submitted: boolean; remainingMs: number }>(`/api/student/attempts/${attemptId}/tick`);
        setRemainingMs(res.remainingMs);
        if (res.submitted) {
          clearInterval(local);
          clearInterval(sync);
          navigate(`/result/${attemptId}`, { replace: true, state: { justSubmitted: true, auto: true } });
        }
      } catch {
        // A failed heartbeat is not fatal - the local countdown carries on.
      }
    }, 20_000);

    return () => {
      clearInterval(local);
      clearInterval(sync);
    };
  }, [paper, attemptId, navigate]);

  // Auto-submit the moment the local clock hits zero; the server agrees.
  useEffect(() => {
    if (paper && remainingMs <= 0 && !submitting) void submit(true);
  }, [remainingMs, paper, submit, submitting]);

  // Warn on accidental tab close while a paper is open.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!submitting) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [submitting]);

  const saveAnswer = useCallback(
    async (questionId: string, response: AnswerResponse, markedForReview?: boolean) => {
      if (!attemptId) return;
      setSaveState('saving');

      const elapsed = Date.now() - questionEnteredAt.current;
      timeSpent.current[questionId] = (timeSpent.current[questionId] ?? 0) + elapsed;
      questionEnteredAt.current = Date.now();

      try {
        const res = await api.post<{ remainingMs: number }>(`/api/student/attempts/${attemptId}/answer`, {
          questionId,
          response,
          timeSpentMs: Math.round(timeSpent.current[questionId]),
          ...(markedForReview !== undefined ? { isMarkedForReview: markedForReview } : {}),
        });
        setRemainingMs(res.remainingMs);
        setSaveState('saved');
        setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1500);
      } catch (err) {
        if (err instanceof ApiError && (err.body?.submitted as boolean)) {
          navigate(`/result/${attemptId}`, { replace: true });
          return;
        }
        setSaveState('error');
      }
    },
    [attemptId, navigate],
  );

  const setAnswer = (questionId: string, response: AnswerResponse) => {
    setAnswers((prev) => ({ ...prev, [questionId]: response }));
    void saveAnswer(questionId, response);
  };

  const toggleFlag = (questionId: string) => {
    const next = !flags[questionId];
    setFlags((prev) => ({ ...prev, [questionId]: next }));
    void saveAnswer(questionId, answers[questionId] ?? null, next);
  };

  const goTo = (next: number) => {
    if (!paper) return;
    const q = paper.questions[index];
    if (q) {
      timeSpent.current[q.id] = (timeSpent.current[q.id] ?? 0) + (Date.now() - questionEnteredAt.current);
    }
    questionEnteredAt.current = Date.now();
    setIndex(Math.max(0, Math.min(paper.questions.length - 1, next)));
  };

  const answeredCount = useMemo(
    () => Object.values(answers).filter((a) => a !== null && a !== undefined).length,
    [answers],
  );

  if (error) {
    return (
      <main className="min-h-full grid place-items-center p-4">
        <div className="max-w-md w-full space-y-3">
          <Alert tone="error">{error}</Alert>
          <button type="button" className="btn-secondary w-full" onClick={() => navigate('/dashboard')}>
            Back to dashboard
          </button>
        </div>
      </main>
    );
  }

  if (!paper) return <PageLoader label="Opening your test" />;

  const question = paper.questions[index];
  const lowTime = remainingMs < 60_000;

  return (
    <div className="min-h-full flex flex-col bg-surface">
      <header className="sticky top-0 z-30 bg-surface/95 backdrop-blur border-b border-line">
        <div className="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-sm font-medium truncate">{paper.test.title}</h1>
            <p className="text-[11px] text-ink-faint">
              {paper.test.subject} · {paper.test.totalMarks} marks
              {paper.test.negativeMarks > 0 && ` · −${paper.test.negativeMarks} per wrong answer`}
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <span className="text-[11px] text-ink-faint hidden sm:inline min-w-[52px] text-right">
              {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Not saved' : ''}
            </span>
            <span
              className={`font-mono text-sm tabular-nums px-2.5 py-1 rounded-lg border ${
                lowTime ? 'border-bad/40 bg-bad/[0.08] text-bad' : 'border-line bg-surface-sunken text-ink'
              }`}
              role="timer"
              aria-live={lowTime ? 'assertive' : 'off'}
            >
              {formatDuration(remainingMs)}
            </span>
            <button type="button" className="btn-primary btn-sm" onClick={() => setConfirmSubmit(true)}>
              Submit
            </button>
          </div>
        </div>
      </header>

      {saveState === 'error' && (
        <div className="mx-auto max-w-5xl w-full px-4 pt-3">
          <Alert tone="warn">
            Your last answer could not be saved. Check your connection — it will be retried when you change your answer.
          </Alert>
        </div>
      )}

      <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-6 grid lg:grid-cols-[1fr_180px] gap-6 items-start">
        <div className="card p-5 min-w-0">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <span className="text-xs font-medium text-ink-muted">
                Question {index + 1} of {paper.questions.length}
              </span>
              <span className="ml-2 badge">{question.marks} mark{question.marks === 1 ? '' : 's'}</span>
            </div>
            <button
              type="button"
              onClick={() => toggleFlag(question.id)}
              className={`btn-sm rounded-lg border ${
                flags[question.id] ? 'border-warn/40 bg-warn/[0.08] text-warn' : 'border-line text-ink-muted hover:bg-surface-sunken'
              }`}
            >
              {flags[question.id] ? 'Marked for review' : 'Mark for review'}
            </button>
          </div>

          <ContentRenderer content={question.content} className="text-[15px]" />

          <div className="mt-5">
            <AnswerInput question={question} value={answers[question.id] ?? null} onChange={(r) => setAnswer(question.id, r)} />
          </div>

          <div className="flex items-center justify-between gap-3 mt-6 pt-4 border-t border-line">
            <button type="button" className="btn-secondary btn-sm" onClick={() => goTo(index - 1)} disabled={index === 0}>
              ← Previous
            </button>

            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => setAnswer(question.id, null)}
              disabled={!answers[question.id]}
            >
              Clear answer
            </button>

            {index === paper.questions.length - 1 ? (
              <button type="button" className="btn-primary btn-sm" onClick={() => setConfirmSubmit(true)}>
                Review &amp; submit
              </button>
            ) : (
              <button type="button" className="btn-secondary btn-sm" onClick={() => goTo(index + 1)}>
                Next →
              </button>
            )}
          </div>
        </div>

        <aside className="card p-4 lg:sticky lg:top-20">
          <h2 className="text-xs font-medium text-ink-muted mb-3">Questions</h2>
          <div className="grid grid-cols-6 lg:grid-cols-5 gap-1.5">
            {paper.questions.map((q, i) => {
              const answered = answers[q.id] !== null && answers[q.id] !== undefined;
              const flagged = flags[q.id];
              return (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => goTo(i)}
                  aria-label={`Question ${i + 1}${answered ? ', answered' : ''}${flagged ? ', marked for review' : ''}`}
                  className={`aspect-square rounded-md text-xs font-medium border transition-colors ${
                    i === index
                      ? 'border-series-1 bg-series-1 text-white'
                      : flagged
                        ? 'border-warn/40 bg-warn/[0.10] text-warn'
                        : answered
                          ? 'border-good/30 bg-good/[0.10] text-good'
                          : 'border-line bg-surface-sunken text-ink-muted hover:border-line-strong'
                  }`}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>

          <dl className="mt-4 space-y-1 text-[11px] text-ink-muted">
            <div className="flex justify-between">
              <dt>Answered</dt>
              <dd className="tabular-nums">{answeredCount}/{paper.questions.length}</dd>
            </div>
            <div className="flex justify-between">
              <dt>Marked</dt>
              <dd className="tabular-nums">{Object.values(flags).filter(Boolean).length}</dd>
            </div>
          </dl>
        </aside>
      </main>

      <Modal open={confirmSubmit} onClose={() => setConfirmSubmit(false)} title="Submit your test?">
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            You have answered <strong className="text-ink">{answeredCount}</strong> of{' '}
            <strong className="text-ink">{paper.questions.length}</strong> questions.
            {answeredCount < paper.questions.length && ' Unanswered questions score zero.'}
          </p>
          <p className="text-sm text-ink-muted">Once submitted you cannot change your answers.</p>

          <div className="flex gap-2 justify-end">
            <button type="button" className="btn-secondary" onClick={() => setConfirmSubmit(false)}>
              Keep working
            </button>
            <button type="button" className="btn-primary" onClick={() => submit(false)} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Submit test'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// --- Answer inputs ---------------------------------------------------------

function AnswerInput({
  question,
  value,
  onChange,
}: {
  question: PaperQuestion;
  value: AnswerResponse;
  onChange: (response: AnswerResponse) => void;
}) {
  switch (question.format) {
    case 'MCQ_SINGLE': {
      const selected = (value as { optionId?: string } | null)?.optionId;
      return (
        <fieldset className="space-y-2">
          <legend className="sr-only">Choose one answer</legend>
          {question.options.map((option) => (
            <label
              key={option.id}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                selected === option.id ? 'border-series-1 bg-series-1/[0.05]' : 'border-line hover:bg-surface-sunken'
              }`}
            >
              <input
                type="radio"
                name={`q-${question.id}`}
                checked={selected === option.id}
                onChange={() => onChange({ optionId: option.id })}
                className="mt-1 accent-series-1"
              />
              <span className="min-w-0 flex-1">
                <span className="text-xs font-medium text-ink-faint mr-1.5">{option.id.toUpperCase()}.</span>
                <BlocksRenderer blocks={option.blocks} className="inline [&>p]:my-0 [&>p]:inline" />
              </span>
            </label>
          ))}
        </fieldset>
      );
    }

    case 'MCQ_MULTI': {
      const selected = new Set(((value as { optionIds?: string[] } | null)?.optionIds) ?? []);
      return (
        <fieldset className="space-y-2">
          <legend className="text-xs text-ink-muted mb-2">Select all that apply.</legend>
          {question.options.map((option) => (
            <label
              key={option.id}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                selected.has(option.id) ? 'border-series-1 bg-series-1/[0.05]' : 'border-line hover:bg-surface-sunken'
              }`}
            >
              <input
                type="checkbox"
                checked={selected.has(option.id)}
                onChange={() => {
                  const next = new Set(selected);
                  if (next.has(option.id)) next.delete(option.id);
                  else next.add(option.id);
                  onChange(next.size ? { optionIds: [...next] } : null);
                }}
                className="mt-1 accent-series-1"
              />
              <span className="min-w-0 flex-1">
                <span className="text-xs font-medium text-ink-faint mr-1.5">{option.id.toUpperCase()}.</span>
                <BlocksRenderer blocks={option.blocks} className="inline [&>p]:my-0 [&>p]:inline" />
              </span>
            </label>
          ))}
        </fieldset>
      );
    }

    case 'TRUE_FALSE': {
      const current = (value as { value?: boolean } | null)?.value;
      return (
        <div className="flex gap-2">
          {[true, false].map((option) => (
            <button
              key={String(option)}
              type="button"
              onClick={() => onChange({ value: option })}
              className={`flex-1 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                current === option ? 'border-series-1 bg-series-1/[0.05] text-ink' : 'border-line text-ink-muted hover:bg-surface-sunken'
              }`}
            >
              {option ? 'True' : 'False'}
            </button>
          ))}
        </div>
      );
    }

    case 'NUMERIC': {
      const current = (value as { value?: number } | null)?.value;
      return (
        <div className="max-w-xs">
          <label className="label">Your answer</label>
          <input
            type="number"
            step="any"
            className="input font-mono"
            value={current ?? ''}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') return onChange(null);
              const parsed = Number(raw);
              if (Number.isFinite(parsed)) onChange({ value: parsed });
            }}
            placeholder="Enter a number"
          />
          <p className="mt-1 text-[11px] text-ink-faint">Enter digits only, for example 3.14 or -12.</p>
        </div>
      );
    }

    default:
      return <p className="text-sm text-bad">This question type cannot be displayed.</p>;
  }
}
