import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Card, EmptyState, Modal, PageLoader, Tabs, formatDate, humanizeTag } from '../../components/ui';
import { AccuracyMeter, BarChart, DataTable, LineChart, StatTile } from '../../components/charts';
import { ContentRenderer } from '../../renderers/BlockRenderer';
import type { Breakdown, ResultRow, WeakArea } from '../../lib/types';

/**
 * One student's full picture, and the launching point for a targeted practice
 * test built from exactly the areas they are failing.
 */

interface StudentProfile {
  student: {
    id: string;
    publicId: string;
    username: string;
    firstName: string;
    lastName: string;
    grade: string;
    division: string;
    rollNo: string;
    isActive: boolean;
  };
  regular: ResultRow[];
  practice: ResultRow[];
  tagMastery: Breakdown;
  weakAreas: WeakArea[];
  suggestedFocus: {
    subjects: string[];
    topics: string[];
    skills: string[];
    cognitive: string[];
    difficulty: string[];
  };
}

export default function AdminStudentDetail() {
  const { studentId } = useParams<{ studentId: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<StudentProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<'regular' | 'practice'>('regular');
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api.get<StudentProfile>(`/api/admin/analytics/students/${studentId}`);
      setData(res);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this student.');
    }
  };

  useEffect(() => {
    void load();
  }, [studentId]);

  const deleteAttempt = async (attemptId: string) => {
    if (!confirm('Delete this attempt? This cannot be undone.')) return;
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

  const [selected, setSelected] = useState<{ attemptId: string; filter: 'correct' | 'wrong' | 'skipped' } | null>(null);
  const [detail, setDetail] = useState<{ attempt: { id: string }; test: { title: string }; questions: Array<{ question: { id: string; content: { blocks: never[] }; options: Array<{ id: string; blocks: never[] }>; answerKey: { correctOptionId?: string; correctOptionIds?: string[] } }; isCorrect: boolean | null; response: unknown }> } | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const openDetail = useCallback(async (attemptId: string, filter: 'correct' | 'wrong' | 'skipped') => {
    setSelected({ attemptId, filter });
    setLoadingDetail(true);
    try {
      const res = await api.get<{ attempt: { id: string }; test: { title: string }; questions: Array<{ question: { id: string; content: { blocks: never[] }; options: Array<{ id: string; blocks: never[] }>; answerKey: { correctOptionId?: string; correctOptionIds?: string[] } }; isCorrect: boolean | null; response: unknown }> }>(`/api/admin/analytics/attempts/${attemptId}`);
      setDetail(res);
    } catch {
      setDetail(null);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <PageLoader label="Loading student" />;

  const { student } = data;
  const results = tab === 'regular' ? data.regular : data.practice;

  const avg = (rows: ResultRow[]) =>
    rows.length ? Math.round((rows.reduce((s, r) => s + r.percentage, 0) / rows.length) * 10) / 10 : 0;

  const startPractice = () => {
    const params = new URLSearchParams({
      practiceFor: student.id,
      subject: data.suggestedFocus.subjects[0] ?? '',
      topics: data.suggestedFocus.topics.slice(0, 3).join(', '),
    });
    navigate(`/admin/generate?${params}`);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/admin/students" className="text-xs text-ink-muted hover:text-ink">← All students</Link>
          <h1 className="text-lg font-semibold mt-1">
            {student.firstName} {student.lastName}
            {!student.isActive && <Badge>deactivated</Badge>}
          </h1>
          <p className="text-xs text-ink-muted mt-0.5">
            <span className="font-mono">{student.publicId}</span> · username{' '}
            <span className="font-mono">{student.username}</span> · Grade {student.grade} · Division{' '}
            {student.division} · Roll no. {student.rollNo}
          </p>
        </div>

        <button type="button" className="btn-primary btn-sm" onClick={startPractice}>
          Generate practice test
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Class tests taken" value={data.regular.length} />
        <StatTile
          label="Class test average"
          value={avg(data.regular)}
          unit="%"
          tone={avg(data.regular) >= 60 ? 'good' : avg(data.regular) >= 40 ? 'warn' : data.regular.length ? 'bad' : 'neutral'}
        />
        <StatTile label="Practice tests taken" value={data.practice.length} />
        <StatTile label="Practice average" value={avg(data.practice)} unit="%" />
      </div>

      {data.weakAreas.length > 0 && (
        <Card
          title="Weak areas"
          action={
            <button type="button" className="btn-primary btn-sm" onClick={startPractice}>
              Set practice on these
            </button>
          }
        >
          <p className="text-xs text-ink-muted mb-3">
            Computed from class test results only, so practice attempts do not mask the real gaps. These feed straight
            into the practice-test prompt.
          </p>
          <ul className="space-y-2">
            {data.weakAreas.map((area) => (
              <li key={`${area.axis}-${area.key}`} className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1">
                  <span className="text-sm">{humanizeTag(area.key)}</span>
                  <span className="ml-2 badge">{area.axis}</span>
                </span>
                <span className="flex items-center gap-3 shrink-0">
                  <span className="text-xs text-ink-faint tabular-nums">{area.correct}/{area.total}</span>
                  <AccuracyMeter accuracy={area.accuracy} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <MasteryCard title="By difficulty" cells={data.tagMastery?.byDifficulty} />
        <MasteryCard title="By question type" cells={data.tagMastery?.byCognitive} />
        <MasteryCard title="By skill" cells={data.tagMastery?.bySkill} />
        <MasteryCard title="By topic" cells={data.tagMastery?.byTopic} />
      </div>

      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}

      <Tabs
        tabs={[
          { id: 'regular', label: 'Class tests', count: data.regular.length },
          { id: 'practice', label: 'Practice tests', count: data.practice.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {results.length === 0 ? (
        <Card><EmptyState title={`No ${tab} results yet`} /></Card>
      ) : (
        <>
          <Card title="Score trend">
            <LineChart
              series={[{ name: 'Percentage', points: results.map((r, i) => [i, r.percentage] as [number, number]) }]}
              xTickLabels={results.map((r) => r.title)}
              yMin={0}
              yMax={100}
              yLabel="Percentage"
              formatY={(n) => `${n}%`}
              reference={{ value: 35, label: 'Pass mark' }}
              height={250}
              table={
                <DataTable
                  headers={['Test', 'Date', 'Score', '%']}
                  rows={results.map((r) => [r.title, formatDate(r.submittedAt), `${r.score}/${r.maxScore}`, r.percentage])}
                />
              }
            />
          </Card>

          <Card padded={false}>
            <div className="scroll-x">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>Test</th>
                    <th>Subject</th>
                    <th>Date</th>
                    <th className="text-right">Score</th>
                    <th className="text-right">%</th>
                    <th className="text-center">Correct</th>
                    <th className="text-center">Wrong</th>
                    <th className="text-center">Skipped</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {[...results].reverse().map((r) => (
                    <tr key={r.attemptId}>
                      <td className="font-medium">{r.title}</td>
                      <td className="text-ink-muted">{r.subject}</td>
                      <td className="text-xs text-ink-muted whitespace-nowrap">{formatDate(r.submittedAt)}</td>
                      <td className="text-right tabular-nums">{r.score}/{r.maxScore}</td>
                      <td className="text-right tabular-nums font-medium">{r.percentage}%</td>
                      <td className="text-center">
                        <button type="button" className="tabular-nums text-good hover:underline disabled:opacity-40" disabled={r.correctCount === 0} onClick={() => void openDetail(r.attemptId, 'correct')}>{r.correctCount}</button>
                      </td>
                      <td className="text-center">
                        <button type="button" className="tabular-nums text-bad hover:underline disabled:opacity-40" disabled={r.incorrectCount === 0} onClick={() => void openDetail(r.attemptId, 'wrong')}>{r.incorrectCount}</button>
                      </td>
                      <td className="text-center">
                        <button type="button" className="tabular-nums text-ink-faint hover:underline disabled:opacity-40" disabled={r.unansweredCount === 0} onClick={() => void openDetail(r.attemptId, 'skipped')}>{r.unansweredCount}</button>
                      </td>
                      <td className="text-right">
                        <button type="button" className="btn-ghost btn-sm text-bad" disabled={deleting === r.attemptId} onClick={() => void deleteAttempt(r.attemptId)}>
                          {deleting === r.attemptId ? 'Deleting…' : 'Delete'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          {selected && (
            <Modal open onClose={() => { setSelected(null); setDetail(null); }} title={`${selected.filter === 'correct' ? 'Correct' : selected.filter === 'wrong' ? 'Wrong' : 'Skipped'} questions — ${detail?.test.title ?? ''}`} wide>
              {loadingDetail ? (
                <PageLoader label="Loading questions" />
              ) : !detail ? (
                <Alert tone="error">Could not load questions.</Alert>
              ) : (
                <div className="space-y-4 max-h-[60vh] overflow-y-auto pr-1">
                  {detail.questions
                    .filter((q) => (selected.filter === 'correct' ? q.isCorrect === true : selected.filter === 'wrong' ? q.isCorrect === false : q.isCorrect === null))
                    .map((q, idx) => (
                      <div key={q.question.id ?? idx} className="border border-line rounded p-3">
                        <div className="flex items-start gap-2">
                          <span className="text-xs text-ink-faint mt-1">{idx + 1}.</span>
                          <div className="flex-1 min-w-0">
                            <ContentRenderer content={q.question.content as never} className="text-sm [&>p]:my-0" />
                            <div className="mt-2 space-y-1">
                              {(q.question.options as Array<{ id: string; blocks: never[] }>).map((opt) => {
                                const ak = q.question.answerKey as { correctOptionId?: string; correctOptionIds?: string[] };
                                const isCorrect = ak?.correctOptionId === opt.id || ak?.correctOptionIds?.includes(opt.id);
                                const isChosen = (() => {
                                  const r = q.response as { optionId?: string; optionIds?: string[] } | null;
                                  if (!r) return false;
                                  if ('optionId' in r && r.optionId) return r.optionId === opt.id;
                                  if ('optionIds' in r && Array.isArray(r.optionIds)) return r.optionIds.includes(opt.id);
                                  return false;
                                })();
                                return (
                                  <div key={opt.id} className={`flex gap-2 text-sm border rounded px-2 py-1 ${isCorrect ? 'border-good/40 bg-good/5' : isChosen ? 'border-bad/40 bg-bad/5' : 'border-line bg-surface-sunken'}`}>
                                    <span className="font-mono text-xs">{opt.id}.</span>
                                    <ContentRenderer content={{ version: 1, blocks: opt.blocks as never[] }} className="text-sm flex-1 [&>p]:my-0" />
                                    {isCorrect && <Badge tone="good">answer</Badge>}
                                    {isChosen && !isCorrect && <Badge tone="bad">your choice</Badge>}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  {detail.questions.filter((q) => (selected.filter === 'correct' ? q.isCorrect === true : selected.filter === 'wrong' ? q.isCorrect === false : q.isCorrect === null)).length === 0 && (
                    <EmptyState title="No questions in this category" />
                  )}
                </div>
              )}
            </Modal>
          )}
        </>
      )}
    </div>
  );
}

function MasteryCard({ title, cells }: { title: string; cells?: Record<string, { correct: number; total: number; accuracy: number }> }) {
  const keys = Object.keys(cells ?? {});
  if (keys.length === 0) return null;

  return (
    <Card title={title}>
      <BarChart
        categories={keys.map(humanizeTag)}
        series={[{ name: 'Accuracy', values: keys.map((k) => Math.round(cells![k].accuracy * 100)) }]}
        yMax={100}
        formatValue={(n) => `${n}%`}
        horizontal
        width={520}
        reference={{ value: 70, label: 'Target' }}
        table={
          <DataTable
            headers={['Area', 'Correct', 'Total', 'Accuracy']}
            rows={keys.map((k) => [humanizeTag(k), cells![k].correct, cells![k].total, `${Math.round(cells![k].accuracy * 100)}%`])}
          />
        }
      />
    </Card>
  );
}
