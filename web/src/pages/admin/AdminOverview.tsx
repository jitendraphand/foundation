import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Alert, Card, EmptyState, PageLoader, Spinner, humanizeTag } from '../../components/ui';
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
    studentsSat: number;
    averagePercentage: number;
    medianPercentage: number;
    passRate: number;
  };
  distribution: Array<{ band: string; from: number; count: number }>;
  trend: Array<{ date: string; attempts: number; avgPercentage: number }>;
  classPerformance: Array<{ grade: string; division: string; attempts: number; students: number; avgPercentage: number }>;
  subjectPerformance: Array<{ subject: string; attempts: number; avgPercentage: number }>;
  tagMastery: Breakdown;
  cohortWeakAreas: WeakArea[];
  hardestQuestions: Array<{
    id: string; subject: string; difficultyTag: string;
    served: number; correct: number; accuracy: number; preview: string;
  }>;
  filter: { kind: string; days: number };
}

/** One thing worth a teacher's attention, already worked out by the server. */
interface Finding {
  id: string;
  severity: 'high' | 'medium' | 'low';
  headline: string;
  detail: string;
  action: { label: string; to: string };
}

export default function AdminOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'REGULAR' | 'PRACTICE' | 'ALL'>('REGULAR');
  const [days, setDays] = useState(90);
  const [showCharts, setShowCharts] = useState(false);

  useEffect(() => {
    setData(null);
    setFindings(null);
    const query = `kind=${kind}&days=${days}`;
    api
      .get<Overview>(`/api/admin/analytics/overview?${query}`)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load the analytics.'));
    // The briefing is a second request on purpose: it is the part worth
    // reading, so it must not wait for the charts underneath it.
    api
      .get<{ findings: Finding[] }>(`/api/admin/analytics/briefing?${query}`)
      .then((r) => setFindings(r.findings))
      .catch(() => setFindings([]));
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

      {/*
        What needs attention, before anything that needs interpreting.

        The charts below answer questions somebody already has. This answers the
        question they came with - "is anything wrong?" - which previously meant
        reading a histogram, a mastery grid and a ranked table and joining them
        up by eye, every single time.
      */}
      <Briefing findings={findings} attempts={totals.attempts} />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <StatTile label="Students" value={totals.students} hint={`${totals.activeStudents} active · ${totals.inactiveStudents} inactive`} />
        <StatTile label="Tests" value={totals.tests} hint={`${totals.publishedTests} published`} />
        <StatTile
          label="Questions"
          value={totals.questions.approved}
          hint={`${totals.questions.draft} awaiting review`}
          tone={totals.questions.draft > 0 ? 'warn' : 'neutral'}
        />
        <StatTile
          label="Papers sat"
          value={totals.attempts}
          // An average over 8,000 papers means something different depending on
          // whether forty children or two hundred are behind it.
          hint={totals.studentsSat > 0 ? `by ${totals.studentsSat} student${totals.studentsSat === 1 ? '' : 's'}` : undefined}
        />
        <StatTile
          label="Average score"
          value={totals.averagePercentage}
          unit="%"
          // The median next to the mean, because one child on 4% drags an
          // average down in a way that misrepresents the class.
          hint={totals.attempts ? `median ${totals.medianPercentage}% · ${totals.passRate}% passed` : undefined}
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
          {/*
            The charts are evidence for the briefing above, not a substitute for
            it, so they start folded away. Somebody checking a finding opens
            them; somebody who just wanted to know whether anything was wrong
            has already been told.
          */}
          <button
            type="button"
            className="btn-secondary btn-sm"
            aria-expanded={showCharts}
            onClick={() => setShowCharts((v) => !v)}
          >
            {showCharts ? 'Hide the figures' : 'Show the figures behind this'}
          </button>

          {showCharts && (
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

          {data.hardestQuestions.length > 0 && (
            <Card title="Questions the class found hardest">
              <p className="text-xs text-ink-muted mb-3">
                Answered by at least ten students, lowest score first. A question far below the rest is usually
                worded ambiguously or keyed wrongly rather than genuinely difficult.
              </p>
              <ul className="space-y-2">
                {data.hardestQuestions.map((q) => (
                  <li key={q.id} className="flex items-start justify-between gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="text-sm">{q.preview || '(no text)'}</span>
                      <span className="ml-2 badge">{q.subject}</span>
                    </span>
                    <span className="flex items-center gap-3 shrink-0">
                      <span className="text-xs text-ink-faint tabular-nums">{q.correct}/{q.served}</span>
                      <AccuracyMeter accuracy={q.accuracy} threshold={0.5} />
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

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
        </>
      )}
    </div>
  );
}

/**
 * The findings, in the order they matter.
 *
 * Deliberately plain: a coloured strip, a sentence with the number in it, the
 * evidence underneath, and one link to the place where something can be done.
 * No chart, because a chart here would be asking the reader to work out again
 * what has already been worked out for them.
 */
function Briefing({ findings, attempts }: { findings: Finding[] | null; attempts: number }) {
  if (attempts === 0) return null;

  if (findings === null) {
    return (
      <Card>
        <div className="py-2"><Spinner label="Checking for anything that needs attention" /></div>
      </Card>
    );
  }

  if (findings.length === 0) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-good" aria-hidden />
          <div>
            <p className="text-sm font-medium">Nothing needs your attention.</p>
            <p className="text-xs text-ink-muted mt-0.5">
              No child is far behind, no skill stands out as weak, every paper&rsquo;s results are released, and
              nothing is waiting to be reviewed.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const tone = {
    high: { dot: 'bg-bad', label: 'Needs attention' },
    medium: { dot: 'bg-warn', label: 'Worth a look' },
    low: { dot: 'bg-ink-faint', label: 'When you have a moment' },
  } as const;

  return (
    <Card title={`What needs your attention (${findings.length})`}>
      <ul className="divide-y divide-line -my-1">
        {findings.map((f) => (
          <li key={f.id} className="py-3 first:pt-1 last:pb-1">
            <div className="flex items-start gap-3">
              <span
                className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${tone[f.severity].dot}`}
                aria-label={tone[f.severity].label}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{f.headline}</p>
                <p className="text-xs text-ink-muted mt-0.5">{f.detail}</p>
              </div>
              <Link to={f.action.to} className="btn-secondary btn-sm shrink-0">
                {f.action.label}
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </Card>
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
