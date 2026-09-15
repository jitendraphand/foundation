import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Card, EmptyState, Field, PageLoader, Tabs, formatDate, humanizeTag } from '../../components/ui';

class BuilderErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: string | null }> {
  state = { hasError: false, error: null as string | null };
  static getDerivedStateFromError(err: Error) {
    return { hasError: true, error: err.message || String(err) };
  }
  componentDidCatch(err: Error) {
    console.error('[AdminTestBuilder]', err);
  }
  render() {
    if (this.state.hasError) {
      return <Alert tone="error">Something went wrong loading this test: {this.state.error}. Please refresh or check the browser console (F12).</Alert>;
    }
    return this.props.children;
  }
}
import { BarChart, DataTable, StatTile } from '../../components/charts';
import { WindowEditor, describeWindowValue, type WindowPreset, type WindowValue } from '../../components/WindowEditor';
import {
  ExamRulesEditor, describeExamRules, rulesFromTest, rulesToBody, type ExamRules,
} from '../../components/ExamRules';
import { ContentRenderer } from '../../renderers/BlockRenderer';
import type { BankQuestion } from '../../lib/types';

/**
 * Test builder: pick which approved questions make the final paper, then
 * publish. Also shows the results once students have attempted it.
 */

interface TestDetail {
  id: string;
  publicId: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  subject: string;
  kind: 'REGULAR' | 'PRACTICE';
  status: 'DRAFT' | 'PUBLISHED' | 'CLOSED';
  durationMinutes: number;
  marksPerQuestion: number;
  negativeMarks: number;
  passPercentage: number;
  showAnswersAfter: boolean;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  /** Proctoring lives here rather than in columns; see routes/admin/tests.ts. */
  meta?: { proctoring?: { enabled?: boolean; allowance?: number; requireFullscreen?: boolean } } | null;
  availabilityMode: 'ALWAYS' | 'ALLOW_WINDOW' | 'BLOCK_WINDOW';
  windowStartMinute: number | null;
  windowEndMinute: number | null;
  windowDays: number[];
  autoSubmitOnClose: boolean;
  resultsReleased: boolean;
  resultsReleasedAt: string | null;
  questions: Array<{ id: string; position: number; marks: number; question: BankQuestion; timeLimitSeconds?: number | null }>;
  targetUser: { id: string; username: string; firstName: string; lastName: string } | null;
  _count: { attempts: number };
}

export default function AdminTestBuilder() {
  const { testId } = useParams<{ testId: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'questions' | 'results' | 'flags'>('questions');
  const [flaggedCount, setFlaggedCount] = useState<number | null>(null);
  const [test, setTest] = useState<TestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // All hooks must run before any early return below. Hooks placed after
  // `if (!test) return ...` run on a different count once the test loads,
  // which is React error #310 and unmounts the whole page to blank.
  const [renaming, setRenaming] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ test: TestDetail }>(`/api/admin/tests/${testId}`);
      setTest(res.test);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this test.');
    }
  }, [testId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!testId) return;
    api
      .get<{ openCount: number }>(`/api/admin/tests/${testId}/flags`)
      .then((res) => setFlaggedCount(res.openCount))
      .catch(() => setFlaggedCount(0));
  }, [testId]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!test) return <PageLoader label="Loading test" />;

  // Mirrors compositionLock on the server. Publishing freezes the paper too,
  // not just sitting it: the test is out, and swapping a question underneath
  // students who can already see it is how two of them sit different exams.
  const sat = test._count.attempts > 0;
  const locked = sat || test.status !== 'DRAFT';
  const isPractice = test.kind === 'PRACTICE';

  const setReleased = async (released: boolean) => {
    setError(null);
    try {
      const res = await api.post<{ message: string }>(`/api/admin/tests/${test.id}/release`, { released });
      setNotice(res.message);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the release state.');
    }
  };

  const rename = async () => {
    if (!newTitle.trim() || newTitle.trim() === test.title) {
      setRenaming(false);
      return;
    }
    setRenameBusy(true);
    try {
      await api.patch(`/api/admin/tests/${test.id}`, { title: newTitle.trim() });
      setNotice('Test renamed.');
      setRenaming(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not rename test.');
    } finally {
      setRenameBusy(false);
    }
  };

  const removeTest = async () => {
    if (!confirm(`Delete "${test.title}"? This will delete the test and all ${test._count.attempts} attempt(s) and answers permanently. This cannot be undone.`)) return;
    setDeleteBusy(true);
    setError(null);
    try {
      const res = await api.delete<{ message?: string }>(`/api/admin/tests/${test.id}`);
      setNotice(res.message ?? 'Test deleted.');
      navigate('/admin/tests');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete test.');
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <BuilderErrorBoundary>
      <div className="space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link to="/admin/tests" className="text-xs text-ink-muted hover:text-ink">← All tests</Link>
          {renaming ? (
            <div className="flex items-center gap-2 mt-1">
              <input className="input text-lg font-semibold flex-1" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} autoFocus />
              <button type="button" className="btn-primary btn-sm" disabled={renameBusy} onClick={rename}>{renameBusy ? 'Saving…' : 'Save'}</button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => { setRenaming(false); setNewTitle(test.title); }}>Cancel</button>
            </div>
          ) : (
            <div className="flex items-center gap-2 mt-1">
              <h1 className="text-lg font-semibold">{test.title}</h1>
              <button type="button" className="btn-ghost btn-sm" onClick={() => { setNewTitle(test.title); setRenaming(true); }}>Rename</button>
              <button type="button" className="btn-ghost btn-sm text-bad" disabled={deleteBusy} onClick={() => void removeTest()}>
                {deleteBusy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          )}
          <p className="text-xs text-ink-muted mt-0.5">
            <span className="font-mono">{test.publicId}</span> · 
            {test.subject} · {test.durationMinutes} min · {test.marksPerQuestion} mark/question
            {test.negativeMarks > 0 && ` · −${test.negativeMarks} negative`}
            {test.targetUser && ` · practice for ${test.targetUser.firstName} ${test.targetUser.lastName}`}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge tone={test.status === 'PUBLISHED' ? 'good' : test.status === 'CLOSED' ? 'neutral' : 'warn'}>
            {test.status.toLowerCase()}
          </Badge>
          {!isPractice && (
            <Badge tone={test.resultsReleased ? 'good' : 'warn'}>
              {test.resultsReleased ? 'results released' : 'results held'}
            </Badge>
          )}
        </div>
      </div>

      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <AvailabilityCard test={test} onSaved={async (msg) => { setNotice(msg); await load(); }} onError={setError} />

      <ExamRulesCard
        test={test}
        locked={locked}
        onSaved={async (msg) => { setNotice(msg); await load(); }}
        onError={setError}
      />

      {/* Releasing is the action that lets students see their score at all. */}
      {!isPractice && test._count.attempts > 0 && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">
                {test.resultsReleased ? 'Results are visible to students' : 'Results are held back'}
              </h2>
              <p className="text-xs text-ink-muted mt-1 max-w-xl">
                {test.resultsReleased
                  ? `Released ${formatDate(test.resultsReleasedAt, true)}. Students can see their score, their breakdown${test.showAnswersAfter ? ' and the correct answers' : ''}.`
                  : 'Students have been told their paper was submitted, but cannot see any score. Check the results below, then release them once everyone has finished.'}
              </p>
            </div>
            <button
              type="button"
              className={test.resultsReleased ? 'btn-secondary btn-sm shrink-0' : 'btn-primary btn-sm shrink-0'}
              onClick={() => setReleased(!test.resultsReleased)}
            >
              {test.resultsReleased ? 'Withdraw results' : 'Release results'}
            </button>
          </div>
        </Card>
      )}

      {locked && (
        <Alert tone="info">
          {sat ? (
            <>
              {test._count.attempts} student{test._count.attempts === 1 ? ' has' : 's have'} attempted this test, so its
              questions and marking scheme are now locked. Create a new test to make changes.
            </>
          ) : test.status === 'PUBLISHED' ? (
            <>
              This test is published, so its questions are locked — students can see the paper and may be part-way
              through it. Move it back to draft to change anything, then publish it again.
            </>
          ) : (
            <>This test is closed, so its questions are locked. Move it back to draft to reopen it for editing.</>
          )}
        </Alert>
      )}

      <Tabs
        tabs={[
          { id: 'questions', label: 'Questions', count: test.questions.length },
          { id: 'results', label: 'Results', count: test._count.attempts },
          { id: 'flags', label: 'Flagged', count: flaggedCount ?? undefined },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'questions' ? (
        <QuestionPicker test={test} locked={locked} onChanged={load} />
      ) : tab === 'results' ? (
        <TestResults testId={test.id} />
      ) : (
        <FlaggedQuestions testId={test.id} onCountChange={setFlaggedCount} />
      )}
      </div>
    </BuilderErrorBoundary>
  );
}

function FlaggedQuestions({ testId, onCountChange }: { testId: string; onCountChange?: (n: number) => void }) {
  const [flags, setFlags] = useState<Array<{
    id: string;
    questionId: string;
    category: string | null;
    reason: string | null;
    status: string;
    createdAt: string;
    flaggedBy: { id: string; username: string; firstName: string; lastName: string; grade: string; division: string };
    question: { id: string; content: unknown; subject: string; topic: string | null };
  }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<'OPEN' | 'RESOLVED' | 'DISMISSED' | ''>('');

  const load = useCallback(async () => {
    try {
      const query = filter ? `?status=${filter}` : '';
      const res = await api.get<{ flags: typeof flags }>(`/api/admin/tests/${testId}/flags${query}`);
      setFlags(res.flags);
      if (onCountChange) {
        const open = res.flags?.filter((f) => f!.status === 'OPEN').length ?? 0;
        // Only auto-update when showing OPEN or all; keep manual count otherwise
        if (!filter || filter === 'OPEN') onCountChange(open);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load flags.');
    }
  }, [testId, filter, onCountChange]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, status: 'RESOLVED' | 'DISMISSED') => {
    const note = status === 'DISMISSED' ? prompt('Reason for dismissing (optional):') ?? undefined : undefined;
    setBusy(id);
    try {
      await api.patch(`/api/admin/flags/${id}`, { status, resolutionNote: note || undefined });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update flag.');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this flag?')) return;
    setBusy(id);
    try {
      await api.delete(`/api/admin/flags/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete flag.');
    } finally {
      setBusy(null);
    }
  };

  if (error && !flags) return <Alert tone="error">{error}</Alert>;
  if (!flags) return <PageLoader label="Loading flags" />;

  if (flags.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex gap-2">
          <select className="input w-auto text-xs" value={filter} onChange={(e) => setFilter(e.target.value as never)}>
            <option value="">All</option>
            <option value="OPEN">Open</option>
            <option value="RESOLVED">Resolved</option>
            <option value="DISMISSED">Dismissed</option>
          </select>
        </div>
        <Card>
          <EmptyState title="No flagged questions" hint={filter ? `No ${filter.toLowerCase()} flags.` : 'When a student flags a question for inconsistency, it will appear here for the test creator.'} />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <select className="input w-auto text-xs" value={filter} onChange={(e) => setFilter(e.target.value as never)}>
          <option value="">All</option>
          <option value="OPEN">Open</option>
          <option value="RESOLVED">Resolved</option>
          <option value="DISMISSED">Dismissed</option>
        </select>
        <span className="text-xs text-ink-muted">{flags.length} flag{flags.length === 1 ? '' : 's'}</span>
      </div>
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      <div className="space-y-3">
        {flags.map((flag) => (
          <Card key={flag.id} padded>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge tone={flag.status === 'OPEN' ? 'warn' : flag.status === 'RESOLVED' ? 'good' : 'neutral'}>{flag.status.toLowerCase()}</Badge>
                {flag.category && <Badge>{flag.category.replace('_', ' ').toLowerCase()}</Badge>}
                <span className="text-xs text-ink-muted">{formatDate(flag.createdAt, true)}</span>
              </div>
              <span className="text-xs text-ink-muted">
                by {flag.flaggedBy.firstName} {flag.flaggedBy.lastName} ({flag.flaggedBy.username} · {flag.flaggedBy.grade}-{flag.flaggedBy.division})
              </span>
            </div>
            <div className="mt-2">
              <p className="text-xs text-ink-muted">Question {flag.question.id.slice(0, 8)} · {flag.question.subject}{flag.question.topic ? ` · ${flag.question.topic}` : ''}</p>
              <div className="mt-1.5 rounded border border-line bg-surface-sunken p-2">
                <ContentRenderer content={flag.question.content as never} className="text-sm" />
              </div>
            </div>
            {flag.reason && <p className="text-sm mt-2"><span className="font-medium">Reason:</span> {flag.reason}</p>}
            <div className="flex gap-2 mt-3">
              {flag.status === 'OPEN' && (
                <>
                  <button type="button" className="btn-primary btn-sm" disabled={busy === flag.id} onClick={() => void act(flag.id, 'RESOLVED')}>
                    Mark resolved
                  </button>
                  <button type="button" className="btn-secondary btn-sm" disabled={busy === flag.id} onClick={() => void act(flag.id, 'DISMISSED')}>
                    Dismiss
                  </button>
                </>
              )}
              <button type="button" className="btn-ghost btn-sm text-bad" disabled={busy === flag.id} onClick={() => void remove(flag.id)}>
                Delete flag
              </button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// --- Choosing the final questions -----------------------------------------

function QuestionPicker({ test, locked, onChanged }: { test: TestDetail; locked: boolean; onChanged: () => void }) {
  const [pool, setPool] = useState<BankQuestion[]>([]);
  const [subjects, setSubjects] = useState<Array<{ subject: string; count: number }>>([]);
  const [chosen, setChosen] = useState<string[]>(() => [...test.questions].sort((a, b) => a.position - b.position).map((tq) => tq.question.id));
  const [timeLimits, setTimeLimits] = useState<Record<string, number>>(() => {
    const m: Record<string, number> = {};
    for (const tq of test.questions) if (tq.timeLimitSeconds != null) m[tq.question.id] = tq.timeLimitSeconds;
    return m;
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The test's own subject is the sensible default, but only a default. It
  // used to be a hard filter, so a test called "Maths" could not see questions
  // filed as "Mathematics" and the bank looked empty for no stated reason.
  const [subjectFilter, setSubjectFilter] = useState<string>(test.subject);
  const [search, setSearch] = useState('');

  useEffect(() => {
    setLoading(true);
    // bucket rather than status: a question already on another paper is not
    // available to add to this one, and listing it only invites the admin to
    // pick something that is spoken for. This paper's own questions come from
    // test.questions and are merged in below.
    const query = new URLSearchParams({ bucket: 'APPROVED', pageSize: '100' });
    if (subjectFilter) query.set('subject', subjectFilter);
    api
      .get<{ questions: BankQuestion[]; subjects: Array<{ subject: string; count: number }> }>(
        `/api/admin/questions?${query}`,
      )
      .then((res) => {
        setPool(res.questions);
        setSubjects(res.subjects ?? []);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load approved questions.'))
      .finally(() => setLoading(false));
  }, [subjectFilter]);

  const toggle = (id: string) => {
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const move = (index: number, delta: number) => {
    setChosen((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/admin/tests/${test.id}/questions`, { questionIds: chosen, timeLimitSeconds: timeLimits });
      setNotice(`${chosen.length} question${chosen.length === 1 ? '' : 's'} set on this test.`);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the question list.');
    } finally {
      setBusy(false);
    }
  };

  const byId = new Map<string, BankQuestion>();
  for (const q of pool) byId.set(q.id, q);
  for (const tq of test.questions) byId.set(tq.question.id, tq.question);

  const approvedEverywhere = subjects.reduce((sum, x) => sum + x.count, 0);
  const matchesSearch = (q: BankQuestion) =>
    !search.trim() ||
    JSON.stringify(q.content).toLowerCase().includes(search.trim().toLowerCase()) ||
    (q.topic ?? '').toLowerCase().includes(search.trim().toLowerCase());

  // The pool holds only unplaced questions, so this paper's own are added back
  // in - otherwise taking one off the paper would make it vanish until the page
  // was reloaded, and the admin could not undo a mis-click.
  const own = test.questions.map((tq) => tq.question);
  const selectable = [...pool, ...own.filter((q) => !pool.some((p) => p.id === q.id))];
  const available = selectable.filter((q) => !chosen.includes(q.id)).filter(matchesSearch);

  return (
    <div className="space-y-4">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <div className="grid grid-cols-3 gap-3">
        <StatTile label="On this paper" value={chosen.length} />
        <StatTile label="Total marks" value={Math.round(chosen.length * test.marksPerQuestion * 100) / 100} />
        <StatTile label="Available to add" value={available.length} />
      </div>

      {!locked && (
        <div className="flex justify-end">
          <button type="button" className="btn-primary btn-sm" onClick={save} disabled={busy || chosen.length === 0}>
            {busy ? 'Saving…' : `Save paper (${chosen.length})`}
          </button>
        </div>
      )}

      <Card title="Final paper" padded={false}>
        {chosen.length === 0 ? (
          <EmptyState title="No questions on this test yet" hint="Choose from the approved questions below." />
        ) : (
          <ol className="divide-y divide-line">
            {chosen.map((id, index) => {
              const question = byId.get(id);
              if (!question) return null;
              const tq = test.questions.find((x) => x.question.id === id);
              return (
                <li key={id} className="p-3 flex items-start gap-3">
                  <span className="text-xs text-ink-faint w-6 shrink-0 mt-1 tabular-nums">{index + 1}.</span>
                  <div className="min-w-0 flex-1">
                    <ContentRenderer content={question.content} className="text-sm [&>p]:my-0" />
                    {Array.isArray(question.options) && question.options.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {(question.options as Array<{ id: string; blocks: unknown[] }>).map((opt) => {
                          const ak = question.answerKey as { correctOptionId?: string; correctOptionIds?: string[] } | null;
                          const isCorrect = ak?.correctOptionId === opt.id || ak?.correctOptionIds?.includes(opt.id);
                          const blocks = Array.isArray(opt.blocks) ? opt.blocks : [];
                          return (
                            <div key={opt.id} className="flex items-start gap-2 text-sm border border-line rounded px-2 py-1 bg-surface-sunken">
                              <span className="font-mono text-xs mt-0.5 w-5 shrink-0">{opt.id}.</span>
                              <div className="flex-1 min-w-0">
                                {blocks.length > 0 ? (
                                  <ContentRenderer content={{ version: 1, blocks: blocks as never[] }} className="text-sm [&>p]:my-0" />
                                ) : (
                                  <span className="text-xs text-ink-faint">No content</span>
                                )}
                              </div>
                              {isCorrect && <Badge tone="good">correct</Badge>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {/* Retired questions stay listed so they can be taken
                          off, but students starting a new paper never see
                          them - say so rather than leaving it a mystery. */}
                      {question.deletedAt && <Badge tone="bad">retired — not served to students</Badge>}
                      <Badge>{humanizeTag(question.difficultyTag)}</Badge>
                      <Badge>{humanizeTag(question.cognitiveTag)}</Badge>
                      {question.skillTags.map((t) => <Badge key={t}>{humanizeTag(t)}</Badge>)}
                      <Badge>{tq?.marks ?? test.marksPerQuestion} mark{tq?.marks !== 1 && test.marksPerQuestion !== 1 ? 's' : ''}</Badge>
                    </div>
                  </div>
                  {!locked && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button type="button" className="btn-ghost btn-sm px-2" onClick={() => move(index, -1)} disabled={index === 0} aria-label="Move up">↑</button>
                      <button type="button" className="btn-ghost btn-sm px-2" onClick={() => move(index, 1)} disabled={index === chosen.length - 1} aria-label="Move down">↓</button>
                      <button type="button" className="btn-ghost btn-sm text-bad" onClick={() => toggle(id)} aria-label="Remove">×</button>
                    </div>
                  )}
                  {!locked && (
                    <div className="flex items-center gap-2 shrink-0">
                      <label className="text-xs text-ink-muted">Time limit (s):</label>
                      <input
                        type="number"
                        min="1"
                        className="input input-sm w-16"
                        value={timeLimits[id] ?? tq?.timeLimitSeconds ?? question.estimatedSeconds ?? 60}
                        onChange={(e) => setTimeLimits((prev) => ({ ...prev, [id]: Number(e.target.value) }))}
                        aria-label="Per-question time limit in seconds"
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      {!locked && (
        <Card
          title="Approved questions"
          padded={false}
          action={
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="input w-auto py-1.5 text-xs"
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search approved questions"
              />
              <select
                className="input w-auto py-1.5 text-xs"
                value={subjectFilter}
                onChange={(e) => setSubjectFilter(e.target.value)}
                aria-label="Subject"
              >
                <option value="">All subjects ({approvedEverywhere})</option>
                {subjects.map((x) => (
                  <option key={x.subject} value={x.subject}>
                    {x.subject} ({x.count})
                  </option>
                ))}
                {/* The test's subject may have no approved questions at all;
                    it still belongs in the list so the filter looks honest. */}
                {!subjects.some((x) => x.subject.toLowerCase() === test.subject.toLowerCase()) && (
                  <option value={test.subject}>{test.subject} (0)</option>
                )}
              </select>
            </div>
          }
        >
          {loading ? (
            <div className="p-6"><PageLoader label="Loading approved questions" /></div>
          ) : available.length === 0 ? (
            <EmptyState
              title={
                search.trim()
                  ? 'Nothing matches that search'
                  : subjectFilter
                    ? `No approved questions filed under "${subjectFilter}"`
                    : 'No approved questions yet'
              }
              hint={
                search.trim()
                  ? 'Clear the search to see the rest.'
                  : subjectFilter && approvedEverywhere > 0
                    ? `There ${approvedEverywhere === 1 ? 'is' : 'are'} ${approvedEverywhere} approved question${approvedEverywhere === 1 ? '' : 's'} under other subjects — switch to "All subjects" above to use them. Subjects are free text, so "Maths" and "Mathematics" are different.`
                    : 'Generate questions, then approve them in the question bank. Only approved questions can go on a paper.'
              }
              action={
                subjectFilter && approvedEverywhere > 0 ? (
                  <button type="button" className="btn-primary btn-sm" onClick={() => { setSubjectFilter(''); setSearch(''); }}>
                    Show all subjects
                  </button>
                ) : (
                  <Link to="/admin/generate" className="btn-primary btn-sm">Generate questions</Link>
                )
              }
            />
          ) : (
            <ul className="divide-y divide-line max-h-[520px] overflow-y-auto">
              {available.map((question) => (
                <li key={question.id} className="p-3 flex items-start gap-3">
                  <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => toggle(question.id)}>
                    Add
                  </button>
                  <div className="min-w-0 flex-1">
                    <ContentRenderer content={question.content} className="text-sm [&>p]:my-0" />
                    {Array.isArray(question.options) && question.options.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {(question.options as Array<{ id: string; blocks: unknown[] }>).map((opt) => {
                          const ak = question.answerKey as { correctOptionId?: string; correctOptionIds?: string[] } | null;
                          const isCorrect = ak?.correctOptionId === opt.id || ak?.correctOptionIds?.includes(opt.id);
                          const blocks = Array.isArray(opt.blocks) ? opt.blocks : [];
                          return (
                            <div key={opt.id} className="flex items-start gap-2 text-sm border border-line rounded px-2 py-1 bg-surface-sunken">
                              <span className="font-mono text-xs mt-0.5 w-5 shrink-0">{opt.id}.</span>
                              <div className="flex-1 min-w-0">
                                {blocks.length > 0 ? (
                                  <ContentRenderer content={{ version: 1, blocks: blocks as never[] }} className="text-sm [&>p]:my-0" />
                                ) : (
                                  <span className="text-xs text-ink-faint">No content</span>
                                )}
                              </div>
                              {isCorrect && <Badge tone="good">correct</Badge>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      <Badge>{question.format.replace('_', ' ').toLowerCase()}</Badge>
                      <Badge>{humanizeTag(question.difficultyTag)}</Badge>
                      <Badge>{humanizeTag(question.cognitiveTag)}</Badge>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

// --- Results ---------------------------------------------------------------

interface ResultsPayload {
  stats: {
    attempted: number;
    completed: number;
    inProgress: number;
    average: number;
    median: number;
    highest: number;
    lowest: number;
    passed: number;
  };
  attempts: Array<{
    id: string;
    status: string;
    score: number;
    maxScore: number;
    percentage: number;
    correctCount: number;
    incorrectCount: number;
    unansweredCount: number;
    submittedAt: string | null;
    user: { id: string; username: string; firstName: string; lastName: string; grade: string; division: string; rollNo: string };
  }>;
  questionStats: Record<string, { correct: number; incorrect: number; unanswered: number }>;
}

function TestResults({ testId }: { testId: string }) {
  const [data, setData] = useState<ResultsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [purgeConfirm, setPurgeConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api.get<ResultsPayload>(`/api/admin/tests/${testId}/results`);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load results.');
    }
  }, [testId]);

  useEffect(() => {
    void load();
  }, [load]);

  const deleteAttempt = async (attemptId: string) => {
    if (!confirm('Delete this attempt? The student will be able to retake if attempts remain. This cannot be undone.')) return;
    setDeleting(attemptId);
    try {
      await api.delete(`/api/admin/attempts/${attemptId}`);
      setNotice('Attempt deleted.');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete attempt.');
    } finally {
      setDeleting(null);
    }
  };

  const purgeAll = async () => {
    if (!purgeConfirm) {
      setPurgeConfirm(true);
      return;
    }
    setDeleting('purge');
    try {
      const res = await api.delete<{ deleted: number; message: string }>(`/api/admin/tests/${testId}/attempts`, { confirm: 'DELETE' });
      setNotice(res.message);
      setPurgeConfirm(false);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not purge test data.');
    } finally {
      setDeleting(null);
    }
  };

  if (error && !data) return <Alert tone="error">{error}</Alert>;
  if (!data) return <PageLoader label="Loading results" />;

  if (data.attempts.length === 0) {
    return (
      <div className="space-y-4">
        <Card>
          <EmptyState title="No attempts yet" hint="Results will appear here as students submit." />
        </Card>
        <DownloadLinks testId={testId} />
        <StillToSit testId={testId} />
      </div>
    );
  }

  const questionIds = Object.keys(data.questionStats);
  const accuracy = questionIds.map((id) => {
    const s = data.questionStats[id];
    const total = s.correct + s.incorrect;
    return total > 0 ? Math.round((s.correct / total) * 100) : 0;
  });

  return (
    <div className="space-y-4">
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Completed" value={data.stats.completed} hint={data.stats.inProgress ? `${data.stats.inProgress} in progress` : undefined} />
        <StatTile label="Average" value={data.stats.average} unit="%" />
        <StatTile label="Highest / lowest" value={`${data.stats.highest} / ${data.stats.lowest}`} unit="%" />
        <StatTile label="Passed" value={data.stats.passed} hint={`of ${data.stats.completed}`} tone="good" />
      </div>

      <DownloadLinks testId={testId} />

      {data.attempts.length > 0 && (
        <div className="flex justify-end">
          {!purgeConfirm ? (
            <button type="button" className="btn-ghost btn-sm text-bad" onClick={() => setPurgeConfirm(true)}>
              Delete all test data
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-bad">This will delete all {data.attempts.length} attempt(s) and answers for this test. Cannot be undone.</span>
              <button type="button" className="btn-primary btn-sm bg-bad text-white" disabled={deleting === 'purge'} onClick={() => void purgeAll()}>
                {deleting === 'purge' ? 'Deleting…' : 'Confirm delete all'}
              </button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => setPurgeConfirm(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {questionIds.length > 0 && (
        <Card title="Accuracy per question">
          <p className="text-xs text-ink-muted mb-2">
            A question that almost nobody answers correctly is usually badly worded or mis-keyed. Check any bar near zero.
          </p>
          <BarChart
            categories={questionIds.map((_, i) => `Q${i + 1}`)}
            series={[{ name: 'Correct %', values: accuracy }]}
            yMax={100}
            formatValue={(n) => `${n}%`}
            yLabel="Correct %"
            height={240}
            table={
              <DataTable
                headers={['Question', 'Correct', 'Incorrect', 'Accuracy']}
                rows={questionIds.map((id, i) => [
                  `Q${i + 1}`,
                  data.questionStats[id].correct,
                  data.questionStats[id].incorrect,
                  `${accuracy[i]}%`,
                ])}
              />
            }
          />
        </Card>
      )}

      <Card title="Student results" padded={false}>
        <div className="scroll-x">
          <table className="table-base">
            <thead>
              <tr>
                <th>Student</th>
                <th>Class</th>
                <th className="text-right">Score</th>
                <th className="text-right">%</th>
                <th className="text-center">Correct</th>
                <th className="text-center">Wrong</th>
                <th className="text-center">Skipped</th>
                <th>Submitted</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.attempts.map((attempt) => (
                <tr key={attempt.id}>
                  <td>
                    <Link to={`/admin/students/${attempt.user.id}`} className="font-medium hover:text-series-1">
                      {attempt.user.firstName} {attempt.user.lastName}
                    </Link>
                    <span className="text-xs text-ink-faint ml-1">{attempt.user.username}</span>
                  </td>
                  <td className="text-xs text-ink-muted">
                    {attempt.user.grade}-{attempt.user.division} · {attempt.user.rollNo}
                  </td>
                  <td className="text-right tabular-nums">{attempt.score}/{attempt.maxScore}</td>
                  <td className="text-right tabular-nums font-medium">{attempt.percentage}%</td>
                  <td className="text-center tabular-nums text-good">{attempt.correctCount}</td>
                  <td className="text-center tabular-nums text-bad">{attempt.incorrectCount}</td>
                  <td className="text-center tabular-nums text-ink-faint">{attempt.unansweredCount}</td>
                  <td className="text-xs text-ink-muted whitespace-nowrap">
                    {attempt.status === 'IN_PROGRESS' ? <Badge tone="warn">in progress</Badge> : formatDate(attempt.submittedAt, true)}
                  </td>
                  <td className="text-right">
                    <button
                      type="button"
                      className="btn-ghost btn-sm text-bad"
                      disabled={deleting === attempt.id}
                      onClick={() => void deleteAttempt(attempt.id)}
                    >
                      {deleting === attempt.id ? 'Deleting…' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <StillToSit testId={testId} />
    </div>
  );
}

/**
 * The three per-test downloads: who sat it, who did not, and the marks.
 * Plain links — the session cookie authenticates them, and the server names
 * the file after the test's own public ID. Email and mobile appear in the
 * download only for a System Administrator, the same rule the on-screen
 * lists apply.
 */
function DownloadLinks({ testId }: { testId: string }) {
  return (
    <Card title="Downloads">
      <p className="text-xs text-ink-muted mb-3">
        Spreadsheets of this paper: who attempted it, who has not, and the results. Email and mobile are included
        only for System Administrators.
      </p>
      <div className="flex flex-wrap gap-2">
        <a href={`/api/admin/tests/${testId}/attempts.csv`} className="btn-secondary btn-sm">
          Attempted students
        </a>
        <a href={`/api/admin/tests/${testId}/non-attempts.csv`} className="btn-secondary btn-sm">
          Non-attempted students
        </a>
        <a href={`/api/admin/tests/${testId}/results.csv`} className="btn-secondary btn-sm">
          Results
        </a>
      </div>
    </Card>
  );
}

/**
 * Who has not sat this paper.
 *
 * The table above is built from attempts, so it can only ever list the children
 * who turned up - and "who is missing" is the question a teacher has the
 * morning after, not "who came". Same data as Reports, scoped to this one
 * paper, put where somebody looking at the paper will find it.
 */
function StillToSit({ testId }: { testId: string }) {
  const [rows, setRows] = useState<MissingRow[] | null>(null);
  const [totals, setTotals] = useState<{ audience: number; missing: number } | null>(null);

  useEffect(() => {
    api
      .get<{ students: MissingRow[]; totals: { audience: number; missing: number; partial: number; complete: number } }>(
        `/api/admin/analytics/participation?testIds=${testId}&missingOnly=true`,
      )
      .then((res) => {
        setRows(res.students);
        setTotals({ audience: res.totals.audience, missing: res.totals.missing + res.totals.partial });
      })
      // A roster that cannot be built is not worth an error banner over the
      // results a teacher came here for.
      .catch(() => setRows([]));
  }, [testId]);

  if (!rows) return null;

  if (rows.length === 0) {
    return (
      <Card title="Still to sit it">
        <p className="text-sm text-ink-muted">
          Everybody this paper was set for has sat it{totals ? ` — all ${totals.audience}` : ''}.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title={
        <div>
          <h2 className="text-sm font-semibold">Still to sit it</h2>
          <p className="text-[11px] text-ink-faint">
            {rows.length} of {totals?.audience ?? rows.length} students this paper was set for
          </p>
        </div>
      }
      action={
        <a className="btn-secondary btn-sm" href={`/api/admin/analytics/participation.csv?testIds=${testId}`}>
          Download
        </a>
      }
      padded={false}
    >
      <div className="scroll-x">
        <table className="table-base">
          <thead>
            <tr>
              <th>Student</th>
              <th>Class</th>
              <th>Where they got to</th>
              <th>Last sign-in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.student.id}>
                <td>
                  <Link to={`/admin/students/${row.student.id}`} className="font-medium hover:text-series-1">
                    {row.student.name}
                  </Link>
                  <span className="ml-1 text-[11px] text-ink-faint">#{row.student.rollNo}</span>
                </td>
                <td className="text-ink-muted whitespace-nowrap">{row.student.grade}-{row.student.division}</td>
                <td>
                  {row.cells[0]?.state === 'in_progress'
                    ? <Badge tone="warn">writing it now</Badge>
                    : row.cells[0]?.state === 'abandoned'
                      ? <Badge tone="warn">started, then left it</Badge>
                      : <Badge tone="bad">not started</Badge>}
                </td>
                <td className="text-xs text-ink-muted whitespace-nowrap">{formatDate(row.student.lastLoginAt, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

interface MissingRow {
  student: {
    id: string; publicId: string; username: string; name: string;
    grade: string; division: string; rollNo: string; lastLoginAt: string | null;
  };
  missing: number;
  cells: Array<{ testId: string; state: string }>;
}

// --- Daily availability ----------------------------------------------------

/**
 * Editing when a live test may be attempted, e.g. pausing it overnight. This
 * stays editable after students have started, unlike the marking scheme:
 * changing the hours does not invalidate anybody's score.
 */
/**
 * Shuffling, proctoring and what a student sees afterwards.
 *
 * These could only ever be chosen on the "New test" form, so a paper created
 * from the question bank - where the dialog says the builder covers everything
 * else - could never be proctored at all, and shuffling could never be turned
 * off for a paper whose questions build on each other.
 *
 * Editable while students are still writing, unlike the question list.
 * Shuffling is decided when an attempt starts, so changing it now affects who
 * starts next and cannot renumber a paper underneath somebody; proctoring is
 * read the same way. Neither changes anybody's marks.
 */
function ExamRulesCard({
  test, locked, onSaved, onError,
}: {
  test: TestDetail;
  locked: boolean;
  onSaved: (message: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rules, setRules] = useState<ExamRules>(() => rulesFromTest(test));

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/admin/tests/${test.id}`, rulesToBody(rules));
      setEditing(false);
      await onSaved('Exam rules updated.');
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not save the exam rules.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Exam rules</h2>
          <p className="text-xs text-ink-muted mt-1">{describeExamRules(rules)}</p>
        </div>
        {!editing && (
          <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setEditing(true)}>
            Change
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-4 pt-4 border-t border-line space-y-3">
          <ExamRulesEditor value={rules} onChange={setRules} />
          {locked && (
            <p className="text-[11px] text-ink-faint">
              This paper's questions are locked, but these are not: shuffling and proctoring are read when a student
              starts, so changing them affects who starts next and never alters a mark already given.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => {
                setRules(rulesFromTest(test));
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn-primary btn-sm" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save rules'}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** ISO instant → the value a datetime-local input expects (local wall-clock). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function AvailabilityCard({
  test, onSaved, onError,
}: {
  test: TestDetail;
  onSaved: (message: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tz, setTz] = useState<{ timezone: string; localTimeNow: string; windowPresets: WindowPreset[] } | null>(null);
  const [value, setValue] = useState<WindowValue>({
    availabilityMode: test.availabilityMode,
    windowStartMinute: test.windowStartMinute,
    windowEndMinute: test.windowEndMinute,
    windowDays: test.windowDays,
    autoSubmitOnClose: test.autoSubmitOnClose,
  });
  // Absolute open/close instants, separate from the daily window: "opens Monday
  // 9am, closes Friday 5pm" rather than "school hours every day". The server
  // and the student dashboard have always honoured these; this is the first UI
  // that sets them.
  const [startsAt, setStartsAt] = useState(test.startsAt ? toLocalInput(test.startsAt) : '');
  const [endsAt, setEndsAt] = useState(test.endsAt ? toLocalInput(test.endsAt) : '');

  useEffect(() => {
    api.get<{ timezone: string; localTimeNow: string; windowPresets: WindowPreset[] }>('/api/admin/timezone')
      .then(setTz)
      .catch(() => undefined);
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      await api.patch(`/api/admin/tests/${test.id}`, {
        ...value,
        // datetime-local gives local wall-clock; the API wants ISO instants.
        startsAt: startsAt ? new Date(startsAt).toISOString() : null,
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      });
      setEditing(false);
      await onSaved('Availability updated.');
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not save the availability window.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">Availability</h2>
          <p className="text-xs text-ink-muted mt-1">
            {describeWindowValue(value)}
            {tz?.timezone && value.availabilityMode !== 'ALWAYS' && (
              <span className="text-ink-faint"> ({tz.timezone}{tz.localTimeNow ? `, now ${tz.localTimeNow}` : ''})</span>
            )}
          </p>
          {(test.startsAt || test.endsAt) && (
            <p className="text-xs text-ink-muted mt-1">
              {test.startsAt && `Opens ${formatDate(test.startsAt, true)}`}
              {test.startsAt && test.endsAt && ' · '}
              {test.endsAt && `Closes ${formatDate(test.endsAt, true)}`}
            </p>
          )}
          {value.availabilityMode !== 'ALWAYS' && (
            <p className="text-[11px] text-ink-faint mt-1">
              {value.autoSubmitOnClose
                ? 'Papers still in progress are submitted when the window closes.'
                : 'A student who started in time may finish after the window closes.'}
            </p>
          )}
        </div>
        {!editing && (
          <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setEditing(true)}>
            Change
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-4 pt-4 border-t border-line space-y-3">
          <WindowEditor
            value={value}
            onChange={setValue}
            presets={tz?.windowPresets ?? []}
            timezone={tz?.timezone}
            localTimeNow={tz?.localTimeNow}
          />

          <div className="pt-3 border-t border-line grid sm:grid-cols-2 gap-3">
            <Field label="Opens at" hint="Absolute instant. Blank = open as soon as published.">
              <input type="datetime-local" className="input" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
            </Field>
            <Field label="Closes at" hint="Blank = stays open until closed manually.">
              <input type="datetime-local" className="input" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </Field>
          </div>
          <p className="text-[11px] text-ink-faint">
            These are one-off bounds on the paper as a whole — independent of the daily window above, which controls
            which hours of the day it may be attempted.
          </p>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => {
                setValue({
                  availabilityMode: test.availabilityMode,
                  windowStartMinute: test.windowStartMinute,
                  windowEndMinute: test.windowEndMinute,
                  windowDays: test.windowDays,
                  autoSubmitOnClose: test.autoSubmitOnClose,
                });
                setStartsAt(test.startsAt ? toLocalInput(test.startsAt) : '');
                setEndsAt(test.endsAt ? toLocalInput(test.endsAt) : '');
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn-primary btn-sm" onClick={save} disabled={busy}>
              {busy ? 'Saving…' : 'Save availability'}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
