import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Card, EmptyState, PageLoader, Tabs, formatDate, humanizeTag } from '../../components/ui';
import { AccuracyMeter, BarChart, DataTable, LineChart, StatTile } from '../../components/charts';
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
  const [tab, setTab] = useState<'regular' | 'practice'>('regular');

  useEffect(() => {
    api
      .get<StudentProfile>(`/api/admin/analytics/students/${studentId}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load this student.'));
  }, [studentId]);

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
                      <td className="text-center tabular-nums text-good">{r.correctCount}</td>
                      <td className="text-center tabular-nums text-bad">{r.incorrectCount}</td>
                      <td className="text-center tabular-nums text-ink-faint">{r.unansweredCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
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
