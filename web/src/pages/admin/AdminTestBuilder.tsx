import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Card, EmptyState, PageLoader, Tabs, formatDate, humanizeTag } from '../../components/ui';
import { BarChart, DataTable, StatTile } from '../../components/charts';
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
  subject: string;
  kind: 'REGULAR' | 'PRACTICE';
  status: 'DRAFT' | 'PUBLISHED' | 'CLOSED';
  durationMinutes: number;
  marksPerQuestion: number;
  negativeMarks: number;
  passPercentage: number;
  questions: Array<{ id: string; position: number; marks: number; question: BankQuestion }>;
  targetUser: { id: string; username: string; firstName: string; lastName: string } | null;
  _count: { attempts: number };
}

export default function AdminTestBuilder() {
  const { testId } = useParams<{ testId: string }>();
  const [tab, setTab] = useState<'questions' | 'results'>('questions');
  const [test, setTest] = useState<TestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!test) return <PageLoader label="Loading test" />;

  const locked = test._count.attempts > 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/admin/tests" className="text-xs text-ink-muted hover:text-ink">← All tests</Link>
          <h1 className="text-lg font-semibold mt-1">{test.title}</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            <span className="font-mono">{test.publicId}</span> · 
            {test.subject} · {test.durationMinutes} min · {test.marksPerQuestion} mark/question
            {test.negativeMarks > 0 && ` · −${test.negativeMarks} negative`}
            {test.targetUser && ` · practice for ${test.targetUser.firstName} ${test.targetUser.lastName}`}
          </p>
        </div>
        <Badge tone={test.status === 'PUBLISHED' ? 'good' : test.status === 'CLOSED' ? 'neutral' : 'warn'}>
          {test.status.toLowerCase()}
        </Badge>
      </div>

      {locked && (
        <Alert tone="info">
          {test._count.attempts} student{test._count.attempts === 1 ? ' has' : 's have'} attempted this test, so its
          questions and marking scheme are now locked. Create a new test to make changes.
        </Alert>
      )}

      <Tabs
        tabs={[
          { id: 'questions', label: 'Questions', count: test.questions.length },
          { id: 'results', label: 'Results', count: test._count.attempts },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'questions' ? <QuestionPicker test={test} locked={locked} onChanged={load} /> : <TestResults testId={test.id} />}
    </div>
  );
}

// --- Choosing the final questions -----------------------------------------

function QuestionPicker({ test, locked, onChanged }: { test: TestDetail; locked: boolean; onChanged: () => void }) {
  const [pool, setPool] = useState<BankQuestion[]>([]);
  const [chosen, setChosen] = useState<string[]>(() => test.questions.sort((a, b) => a.position - b.position).map((tq) => tq.question.id));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const query = new URLSearchParams({ status: 'APPROVED', pageSize: '100', subject: test.subject });
    api
      .get<{ questions: BankQuestion[] }>(`/api/admin/questions?${query}`)
      .then((res) => setPool(res.questions))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load approved questions.'))
      .finally(() => setLoading(false));
  }, [test.subject]);

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
      await api.put(`/api/admin/tests/${test.id}/questions`, { questionIds: chosen });
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

  if (loading) return <PageLoader label="Loading approved questions" />;

  const available = pool.filter((q) => !chosen.includes(q.id));

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
              return (
                <li key={id} className="p-3 flex items-start gap-3">
                  <span className="text-xs text-ink-faint w-6 shrink-0 mt-1 tabular-nums">{index + 1}.</span>
                  <div className="min-w-0 flex-1">
                    <ContentRenderer content={question.content} className="text-sm [&>p]:my-0" />
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      <Badge>{humanizeTag(question.difficultyTag)}</Badge>
                      <Badge>{humanizeTag(question.cognitiveTag)}</Badge>
                      {question.skillTags.map((t) => <Badge key={t}>{humanizeTag(t)}</Badge>)}
                    </div>
                  </div>
                  {!locked && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button type="button" className="btn-ghost btn-sm px-2" onClick={() => move(index, -1)} disabled={index === 0} aria-label="Move up">↑</button>
                      <button type="button" className="btn-ghost btn-sm px-2" onClick={() => move(index, 1)} disabled={index === chosen.length - 1} aria-label="Move down">↓</button>
                      <button type="button" className="btn-ghost btn-sm text-bad" onClick={() => toggle(id)} aria-label="Remove">×</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      {!locked && (
        <Card title={`Approved questions in ${test.subject}`} padded={false}>
          {available.length === 0 ? (
            <EmptyState
              title="No more approved questions in this subject"
              hint="Generate and approve more questions from the Set test screen."
              action={<Link to="/admin/generate" className="btn-primary btn-sm">Generate questions</Link>}
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
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      <Badge>{question.format.replace('_', ' ').toLowerCase()}</Badge>
                      <Badge>{humanizeTag(question.difficultyTag)}</Badge>
                      <Badge>{humanizeTag(question.cognitiveTag)}</Badge>
                      {question.topic && <span className="text-[11px] text-ink-faint">{question.topic}</span>}
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

  useEffect(() => {
    api
      .get<ResultsPayload>(`/api/admin/tests/${testId}/results`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load results.'));
  }, [testId]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <PageLoader label="Loading results" />;

  if (data.attempts.length === 0) {
    return (
      <Card>
        <EmptyState title="No attempts yet" hint="Results will appear here as students submit." />
      </Card>
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Completed" value={data.stats.completed} hint={data.stats.inProgress ? `${data.stats.inProgress} in progress` : undefined} />
        <StatTile label="Average" value={data.stats.average} unit="%" />
        <StatTile label="Highest / lowest" value={`${data.stats.highest} / ${data.stats.lowest}`} unit="%" />
        <StatTile label="Passed" value={data.stats.passed} hint={`of ${data.stats.completed}`} tone="good" />
      </div>

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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
