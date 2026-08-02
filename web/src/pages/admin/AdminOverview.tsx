import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Alert, Card, EmptyState, PageLoader, humanizeTag } from '../../components/ui';
import { AccuracyMeter, BarChart, DataTable, LineChart, StatTile } from '../../components/charts';
import type { Breakdown, WeakArea } from '../../lib/types';

interface Overview {
  totals: {
    students: number;
    activeStudents: number;
    inactiveStudents: number;
    tests: number;
    publishedTests: number;
    questions: { draft: number; approved: number; rejected: number };
    attempts: number;
    averagePercentage: number;
  };
  distribution: Array<{ band: string; from: number; count: number }>;
  trend: Array<{ date: string; attempts: number; avgPercentage: number }>;
  classPerformance: Array<{ grade: string; division: string; attempts: number; avgPercentage: number }>;
  subjectPerformance: Array<{ subject: string; attempts: number; avgPercentage: number }>;
  tagMastery: Breakdown;
  cohortWeakAreas: WeakArea[];
  filter: { kind: string; days: number };
}

export default function AdminOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'REGULAR' | 'PRACTICE' | 'ALL'>('REGULAR');
  const [days, setDays] = useState(90);

  useEffect(() => {
    setData(null);
    api
      .get<Overview>(`/api/admin/analytics/overview?kind=${kind}&days=${days}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the analytics.'));
  }, [kind, days]);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <PageLoader label="Loading analytics" />;

  const { totals } = data;

  return (
    <div className="space-y-6">
      {/* Filters live in one row above the charts. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Overview</h1>
        <div className="flex items-center gap-2">
          <select className="input w-auto text-xs py-1.5" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="REGULAR">Class tests</option>
            <option value="PRACTICE">Practice tests</option>
            <option value="ALL">Both</option>
          </select>
          <select className="input w-auto text-xs py-1.5" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
            <option value={3650}>All time</option>
          </select>
          <a href={`/api/admin/analytics/export.csv?kind=${kind}`} className="btn-secondary btn-sm">
            Export CSV
          </a>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatTile label="Students" value={totals.students} hint={`${totals.activeStudents} active · ${totals.inactiveStudents} inactive`} />
        <StatTile label="Tests" value={totals.tests} hint={`${totals.publishedTests} published`} />
        <StatTile
          label="Questions"
          value={totals.questions.approved}
          hint={`${totals.questions.draft} awaiting review`}
          tone={totals.questions.draft > 0 ? 'warn' : 'neutral'}
        />
        <StatTile label="Attempts" value={totals.attempts} />
        <StatTile
          label="Average score"
          value={totals.averagePercentage}
          unit="%"
          tone={totals.averagePercentage >= 60 ? 'good' : totals.averagePercentage >= 40 ? 'warn' : totals.attempts ? 'bad' : 'neutral'}
        />
      </div>

      {totals.attempts === 0 ? (
        <Card>
          <EmptyState
            title="No results yet"
            hint="Once students attempt a published test, the charts here will fill in."
            action={<Link to="/admin/generate" className="btn-primary btn-sm">Set your first test</Link>}
          />
        </Card>
      ) : (
        <>
          <div className="grid lg:grid-cols-2 gap-4">
            <Card title="Score distribution">
              <BarChart
                categories={data.distribution.map((d) => d.band)}
                series={[{ name: 'Students', values: data.distribution.map((d) => d.count) }]}
                xLabel="Percentage band"
                yLabel="Attempts"
                height={250}
                table={<DataTable headers={['Band', 'Attempts']} rows={data.distribution.map((d) => [d.band, d.count])} />}
              />
            </Card>

            <Card title="Attempts over time">
              <LineChart
                series={[{ name: 'Average percentage', points: data.trend.map((t, i) => [i, t.avgPercentage] as [number, number]) }]}
                xTickLabels={data.trend.map((t) => t.date.slice(5))}
                yMin={0}
                yMax={100}
                yLabel="Average %"
                formatY={(n) => `${n}%`}
                height={250}
                table={<DataTable headers={['Date', 'Attempts', 'Average %']} rows={data.trend.map((t) => [t.date, t.attempts, t.avgPercentage])} />}
              />
            </Card>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            {data.classPerformance.length > 0 && (
              <Card title="Performance by class">
                <BarChart
                  categories={data.classPerformance.map((c) => `${c.grade}-${c.division}`)}
                  series={[{ name: 'Average percentage', values: data.classPerformance.map((c) => c.avgPercentage) }]}
                  yMax={100}
                  formatValue={(n) => `${n}%`}
                  horizontal
                  width={520}
                  table={
                    <DataTable
                      headers={['Class', 'Attempts', 'Average %']}
                      rows={data.classPerformance.map((c) => [`Grade ${c.grade} ${c.division}`, c.attempts, c.avgPercentage])}
                    />
                  }
                />
              </Card>
            )}

            {data.subjectPerformance.length > 0 && (
              <Card title="Performance by subject">
                <BarChart
                  categories={data.subjectPerformance.map((s) => s.subject)}
                  series={[{ name: 'Average percentage', values: data.subjectPerformance.map((s) => s.avgPercentage) }]}
                  yMax={100}
                  formatValue={(n) => `${n}%`}
                  horizontal
                  width={520}
                  table={
                    <DataTable
                      headers={['Subject', 'Attempts', 'Average %']}
                      rows={data.subjectPerformance.map((s) => [s.subject, s.attempts, s.avgPercentage])}
                    />
                  }
                />
              </Card>
            )}
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <MasteryCard title="Mastery by question type" cells={data.tagMastery?.byCognitive} />
            <MasteryCard title="Mastery by skill" cells={data.tagMastery?.bySkill} />
          </div>

          {data.cohortWeakAreas.length > 0 && (
            <Card title="Where the cohort is weakest">
              <p className="text-xs text-ink-muted mb-3">
                Areas where students collectively fall below 65% accuracy. Use these to plan the next class test, or set
                targeted practice from a student&apos;s page.
              </p>
              <ul className="space-y-2">
                {data.cohortWeakAreas.map((area) => (
                  <li key={`${area.axis}-${area.key}`} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="text-sm">{humanizeTag(area.key)}</span>
                      <span className="ml-2 badge">{area.axis}</span>
                    </span>
                    <span className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-ink-faint tabular-nums">{area.correct}/{area.total}</span>
                      <AccuracyMeter accuracy={area.accuracy} threshold={0.65} />
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
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
