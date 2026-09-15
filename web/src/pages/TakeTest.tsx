import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Alert, Modal, PageLoader, formatDuration } from '../components/ui';
import { ContentRenderer, BlocksRenderer } from '../renderers/BlockRenderer';
import type { AnswerResponse, PaperQuestion } from '../lib/types';

interface Paper {
  attempt: { id: string; startedAt: string; expiresAt: string; remainingMs: number; attemptNumber: number };
  test: {
    id: string; title: string; subject: string; kind: string; durationMinutes: number;
    negativeMarks: number; totalMarks: number;
    perQuestionTiming?: boolean;
    proctoring?: { enabled: boolean; allowance: number; requireFullscreen: boolean };
  };
  proctorCount?: number;
  questions: PaperQuestion[];
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function TakeTest() {
  const { attemptId } = useParams<{ attemptId: string }>();
  const navigate = useNavigate();

  const [paper, setPaper] = useState<Paper | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  // Ticks every second so a per-question countdown can read against it.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  const [answers, setAnswers] = useState<Record<string, AnswerResponse>>({});
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [remainingMs, setRemainingMs] = useState(0);
  const [proctorNotice, setProctorNotice] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [paneOpen, setPaneOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [flagReason, setFlagReason] = useState('');
  const [flagCategory, setFlagCategory] = useState('WRONG_ANSWER');
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  const [flagNotice, setFlagNotice] = useState<string | null>(null);
  const [flagFormOpen, setFlagFormOpen] = useState(false);
  // Questions whose per-question time the server has cut off. Only ever
  // populated when the test enforces per-question limits.
  const [perQTimeUp, setPerQTimeUp] = useState<Set<string>>(new Set());

  // Time spent per question, so the analytics can show where a student stalls.
  const questionEnteredAt = useRef<number>(Date.now());
  const timeSpent = useRef<Record<string, number>>({});

  // Reset flag form when navigating questions
  useEffect(() => {
    setFlagFormOpen(false);
    setFlagReason('');
    setFlagNotice(null);
  }, [index]);

  // Load already-flagged questions for this test
  useEffect(() => {
    if (!paper) return;
    api
      .get<{ flags: Array<{ questionId: string }> }>(`/api/student/flags?testId=${paper.test.id}`)
      .then((res) => setFlagged(new Set(res.flags.map((f) => f.questionId))))
      .catch(() => undefined);
  }, [paper]);

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
  useProctoring(paper, attemptId, submitting, (message) => setProctorNotice(message), () => void submit(true));

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
        setPerQTimeUp((prev) => {
          if (!prev.has(questionId)) return prev;
          const next = new Set(prev);
          next.delete(questionId);
          return next;
        });
        setSaveState('saved');
        setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1500);
      } catch (err) {
        if (err instanceof ApiError && (err.body?.submitted as boolean)) {
          navigate(`/result/${attemptId}`, { replace: true });
          return;
        }
        // The server cut this question's time off. Whatever was saved in time
        // still counts; the input goes quiet rather than saving into the void.
        if (err instanceof ApiError && err.body?.code === 'QUESTION_TIME_UP') {
          setPerQTimeUp((prev) => new Set(prev).add(questionId));
          setSaveState('idle');
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

  const flagQuestion = async () => {
    if (!paper) return;
    const q = paper.questions[index];
    if (!q) return;
    setFlagging(true);
    try {
      await api.post('/api/student/flags', {
        questionId: q.id,
        testId: paper.test.id,
        attemptId: paper.attempt.id,
        category: flagCategory,
        reason: flagReason.trim() || undefined,
      });
      setFlagged((prev) => new Set(prev).add(q.id));
      setFlagNotice('Flagged — your teacher will review this question.');
      setFlagReason('');
      setFlagFormOpen(false);
      setTimeout(() => setFlagNotice(null), 3000);
    } catch (err) {
      setFlagNotice(err instanceof ApiError ? err.message : 'Could not flag this question.');
      setTimeout(() => setFlagNotice(null), 4000);
    } finally {
      setFlagging(false);
    }
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
  const proctored = paper.test.proctoring?.enabled === true;

  // Per-question countdown, only when the test enforces it. The clock reads
  // against the server-recorded first save, so it cannot disagree with the
  // cutoff; before the first save it has not started, so nothing ticks.
  const qLimit = paper.test.perQuestionTiming ? question?.timeLimitSeconds ?? null : null;
  const qFirstSeen = question?.firstSeenAt ? Math.floor(new Date(question.firstSeenAt).getTime() / 1000) : null;
  const qRemaining = qLimit != null && qFirstSeen != null ? Math.max(0, qLimit - (nowSec - qFirstSeen)) : null;

  // Informational: when the local countdown reaches zero, show the banner. The
  // server remains the authority — a successful save clears it again.
  useEffect(() => {
    if (question && qRemaining === 0) {
      setPerQTimeUp((prev) => (prev.has(question.id) ? prev : new Set(prev).add(question.id)));
    }
  }, [question, qRemaining]);

  return (
    <div className="min-h-full flex flex-col bg-surface">
      {/*
        Announced rather than silent. A student who does not know the paper is
        watched cannot choose to stay on it, which makes the whole thing a trap
        rather than a deterrent.
      */}
      {proctored && (
        <div className="bg-warn/10 border-b border-warn/30 px-4 py-2 text-center">
          <p className="text-xs text-ink">
            <strong>This is a proctored exam.</strong>{' '}
            Leaving this page — another tab, another app, or leaving fullscreen — is recorded. After{' '}
            {paper.test.proctoring?.allowance} times your paper is submitted automatically.
            {paper.test.proctoring?.requireFullscreen && !document.fullscreenElement && (
              <button
                type="button"
                className="ml-2 underline font-medium"
                onClick={() => void document.documentElement.requestFullscreen().catch(() => undefined)}
              >
                Enter fullscreen
              </button>
            )}
          </p>
        </div>
      )}

      {proctorNotice && (
        <div className="px-4 pt-3">
          <Alert tone="error" onDismiss={() => setProctorNotice(null)}>{proctorNotice}</Alert>
        </div>
      )}
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

      <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-6 grid lg:grid-cols-[1fr_180px] gap-6 items-start content-start">
        <div className="card p-5 sm:p-7 min-w-0">
          <div className="flex items-start justify-between gap-4 mb-5">
            <div>
              <span className="text-[13px] font-medium text-ink-muted">
                Question {index + 1} of {paper.questions.length}
              </span>
              <span className="ml-2 badge">{question.marks} mark{question.marks === 1 ? '' : 's'}</span>
              {qRemaining != null && (
                <span
                  className={`ml-2 font-mono text-xs tabular-nums px-2 py-0.5 rounded-md border ${
                    qRemaining === 0 ? 'border-bad/40 bg-bad/[0.08] text-bad' : 'border-line bg-surface-sunken text-ink-muted'
                  }`}
                  role="timer"
                >
                  {formatDuration(qRemaining * 1000)} left on this question
                </span>
              )}
              {qLimit != null && qRemaining == null && (
                <span className="ml-2 text-xs text-ink-faint">
                  {Math.round(qLimit / 60)} min for this question
                </span>
              )}
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

          <ContentRenderer content={question.content} className="text-base sm:text-[17px] leading-relaxed" />

          <div className="mt-6">
            {perQTimeUp.has(question.id) && (
              <Alert tone="warn">
                Time for this question has run out. Your saved answer still counts — move on and come back if the
                paper's clock allows.
              </Alert>
            )}
            <AnswerInput question={question} value={answers[question.id] ?? null} onChange={(r) => setAnswer(question.id, r)} />
          </div>

          <div className="mt-4">
            {flagNotice && <Alert tone={flagNotice.startsWith('Flagged') ? 'success' : 'warn'}>{flagNotice}</Alert>}
            {!flagged.has(question.id) ? (
              !flagFormOpen ? (
                <button type="button" className="btn-ghost btn-sm text-bad border border-bad/20" onClick={() => setFlagFormOpen(true)}>
                  Flag as inconsistent
                </button>
              ) : (
                <div className="rounded-lg border border-line bg-surface-sunken p-3 space-y-2">
                  <p className="text-xs font-medium">Flag this question</p>
                  <select className="input text-xs" value={flagCategory} onChange={(e) => setFlagCategory(e.target.value)}>
                    <option value="WRONG_ANSWER">Wrong answer key</option>
                    <option value="TYPO">Typo / wording</option>
                    <option value="UNCLEAR">Unclear / ambiguous</option>
                    <option value="OUT_OF_SYLLABUS">Out of syllabus</option>
                    <option value="OTHER">Other</option>
                  </select>
                  <textarea
                    className="input text-xs"
                    rows={2}
                    placeholder="Describe the issue (optional, up to 2000 chars)"
                    value={flagReason}
                    onChange={(e) => setFlagReason(e.target.value)}
                    maxLength={2000}
                  />
                  <div className="flex gap-2">
                    <button type="button" className="btn-primary btn-sm" disabled={flagging} onClick={() => void flagQuestion()}>
                      {flagging ? 'Flagging…' : 'Submit flag'}
                    </button>
                    <button type="button" className="btn-ghost btn-sm" onClick={() => setFlagFormOpen(false)}>Cancel</button>
                  </div>
                </div>
              )
            ) : (
              <span className="text-xs text-bad border border-bad/20 rounded px-2 py-1 bg-bad/5">Flagged — thanks for reporting</span>
            )}
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

        {/*
          On a phone this pane comes first and sticks under the header, showing
          one line until it is tapped. Left where it sits on desktop it ended up
          below the question card, so switching question meant scrolling past
          the whole question to reach the numbers - which is the one thing the
          pane exists to avoid.
        */}
        <aside className="card p-4 order-first lg:order-none sticky top-14 lg:top-20 z-20">
          <button
            type="button"
            className="lg:hidden w-full flex items-center justify-between gap-3 text-left min-h-[40px]"
            onClick={() => setPaneOpen((v) => !v)}
            aria-expanded={paneOpen}
          >
            <span className="text-xs font-medium text-ink-muted">
              Question {index + 1} of {paper.questions.length}
              <span className="text-ink-faint"> · {answeredCount} answered</span>
            </span>
            <span className="text-xs text-series-1 font-medium">{paneOpen ? 'Hide' : 'All questions'}</span>
          </button>

          <h2 className="hidden lg:block text-xs font-medium text-ink-muted mb-3">Questions</h2>

          <div className={`${paneOpen ? 'grid mt-3' : 'hidden lg:grid'} grid-cols-6 lg:grid-cols-5 gap-1.5`}>
            {paper.questions.map((q, i) => {
              const answered = answers[q.id] !== null && answers[q.id] !== undefined;
              const flagged = flags[q.id];
              return (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => {
                    goTo(i);
                    setPaneOpen(false);
                  }}
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

          <dl className={`${paneOpen ? 'block' : 'hidden lg:block'} mt-4 space-y-1 text-[11px] text-ink-muted`}>
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
          <p className="text-sm text-ink-muted">
            Once submitted you cannot change your answers.
            {paper.test.kind !== 'PRACTICE' && ' Your score will be available once your teacher releases the results.'}
          </p>

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
        <fieldset className="space-y-2.5">
          <legend className="sr-only">Choose one answer</legend>
          {question.options.map((option) => (
            <label
              key={option.id}
              className={`flex items-start gap-3 p-3.5 rounded-lg border cursor-pointer transition-colors ${
                selected === option.id ? 'border-series-1 bg-series-1/[0.05] ring-1 ring-series-1/30' : 'border-line hover:bg-surface-sunken'
              }`}
            >
              <input
                type="radio"
                name={`q-${question.id}`}
                checked={selected === option.id}
                onChange={() => onChange({ optionId: option.id })}
                className="mt-1.5 accent-series-1 w-4 h-4"
              />
              <span className="min-w-0 flex-1 text-[15px] leading-relaxed">
                <span className="font-semibold text-ink-muted mr-1.5">{option.id.toUpperCase()}.</span>
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
        <fieldset className="space-y-2.5">
          <legend className="text-[13px] text-ink-muted mb-2">Select all that apply.</legend>
          {question.options.map((option) => (
            <label
              key={option.id}
              className={`flex items-start gap-3 p-3.5 rounded-lg border cursor-pointer transition-colors ${
                selected.has(option.id) ? 'border-series-1 bg-series-1/[0.05] ring-1 ring-series-1/30' : 'border-line hover:bg-surface-sunken'
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
                className="mt-1.5 accent-series-1 w-4 h-4"
              />
              <span className="min-w-0 flex-1 text-[15px] leading-relaxed">
                <span className="font-semibold text-ink-muted mr-1.5">{option.id.toUpperCase()}.</span>
                <BlocksRenderer blocks={option.blocks} className="inline [&>p]:my-0 [&>p]:inline" />
              </span>
            </label>
          ))}
        </fieldset>
      );
    }

    default:
      return <p className="text-sm text-bad">This question type cannot be displayed.</p>;
  }
}

/**
 * Proctoring, as far as a browser can honestly manage it.
 *
 * Watches for the paper being left: another tab or window taking focus, the
 * page being hidden (which is also what switching apps looks like on a phone),
 * and fullscreen being exited. Each is reported to the server, which counts
 * them and decides when the allowance is spent - the page does not get to
 * decide that, because a page can be edited.
 *
 * Deliberately not attempted: blocking copy, paste, right-click or
 * screenshots. They are trivial to work around, they break legitimate use -
 * a student zooming a diagram, or using a screen reader - and they create an
 * impression of security that is not there.
 */
function useProctoring(
  paper: Paper | null,
  attemptId: string | undefined,
  submitting: boolean,
  onNotice: (message: string) => void,
  onAutoSubmit: () => void,
) {
  const settings = paper?.test.proctoring;
  const enabled = !!settings?.enabled && !submitting;
  const leftAt = useRef<number | null>(null);
  // Guards against the same departure being counted twice: hiding a tab fires
  // both blur and visibilitychange in most browsers.
  const reporting = useRef(false);

  useEffect(() => {
    if (!enabled || !attemptId) return;

    const report = async (kind: 'blur' | 'hidden' | 'fullscreen_exit') => {
      if (reporting.current) return;
      reporting.current = true;
      const awayMs = leftAt.current ? Date.now() - leftAt.current : undefined;
      leftAt.current = null;

      try {
        const res = await api.post<{ submitted: boolean; message?: string }>(
          `/api/student/attempts/${attemptId}/proctor`,
          { kind, awayMs },
        );
        if (res.message) onNotice(res.message);
        if (res.submitted) onAutoSubmit();
      } catch {
        // A dropped report must never interrupt the exam. The server counts
        // what reaches it; losing one to a flaky connection favours the
        // student, which is the right way round to be wrong.
      } finally {
        // Long enough that one departure is one event, short enough that a
        // second genuine switch still counts.
        setTimeout(() => { reporting.current = false; }, 1500);
      }
    };

    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        leftAt.current = Date.now();
      } else {
        void report('hidden');
      }
    };
    const onBlur = () => { leftAt.current = Date.now(); };
    const onFocus = () => { if (leftAt.current) void report('blur'); };
    const onFullscreen = () => {
      if (settings?.requireFullscreen && !document.fullscreenElement) void report('fullscreen_exit');
    };

    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('fullscreenchange', onFullscreen);

    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('fullscreenchange', onFullscreen);
    };
  }, [enabled, attemptId, settings?.requireFullscreen, onNotice, onAutoSubmit]);

  return enabled;
}
