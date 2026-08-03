import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, Card, EmptyState, PageLoader, Tabs, formatDate, humanizeTag } from '../components/ui';
import { AccuracyMeter, BarChart, DataTable, LineChart, StatTile } from '../components/charts';
import type { ActivitySummary, AwaitingResult, LiveTest, ResultRow, WeakArea } from '../lib/types';

interface Summary {
  count: number;
  avgPercentage: number;
  bestPercentage: number;
  lastPercentage: number;
}

interface DashboardData {
  me: { publicId: string; firstName: string; lastName: string; username: string; grade: string; division: string; rollNo: string };
  liveTests: LiveTest[];
  results: { regular: ResultRow[]; practice: ResultRow[] };
  summary: { regular: Summary; practice: Summary };
  awaitingResults: AwaitingResult[];
  weakAreas: WeakArea[];
}

export default function StudentDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'regular' | 'practice'>('regular');
  const [activities, setActivities] = useState<ActivitySummary[]>([]);
  const location = useLocation();
  const welcome = (location.state as { welcome?: string } | null)?.welcome;

  useEffect(() => {
    api
      .get<DashboardData>('/api/student/dashboard')
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load your dashboard.'));

    // Optional activities and ones already done. Anything still *required*
    // never reaches this screen - the router sends the student to it instead.
    api
      .get<{ activities: ActivitySummary[] }>('/api/activities')
      .then((res) => setActivities(res.activities))
      .catch(() => undefined);
  }, []);

  if (error) return <Alert tone="error">{error}</Alert>;
  if (!data) return <PageLoader label="Loading your dashboard" />;

  const results = tab === 'regular' ? data.results.regular : data.results.practice;
  const summary = tab === 'regular' ? data.summary.regular : data.summary.practice;

  return (
    <div className="space-y-6">
      {welcome && <Alert tone="success">{welcome}</Alert>}

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Hello, {data.me.firstName}</h1>
          <p className="text-xs text-ink-muted mt-0.5">
            Grade {data.me.grade} · Division {data.me.division} · Roll no. {data.me.rollNo} ·{' '}
            <span className="font-mono">{data.me.publicId}</span>
          </p>
        </div>
      </div>

      {activities.length > 0 && <Activities activities={activities} />}

      <LiveTests tests={data.liveTests} />

      {data.awaitingResults.length > 0 && <AwaitingResults items={data.awaitingResults} />}

      {/* A single number is a stat tile, not a one-bar chart. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Tests completed" value={summary.count} />
        <StatTile
          label="Average score"
          value={summary.avgPercentage}
          unit="%"
          tone={summary.avgPercentage >= 60 ? 'good' : summary.avgPercentage >= 40 ? 'warn' : summary.count ? 'bad' : 'neutral'}
        />
        <StatTile label="Best score" value={summary.bestPercentage} unit="%" />
        <StatTile label="Most recent" value={summary.lastPercentage} unit="%" />
      </div>

      <Tabs
        tabs={[
          { id: 'regular', label: 'Class tests', count: data.results.regular.length },
          { id: 'practice', label: 'Practice tests', count: data.results.practice.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {results.length === 0 ? (
        <Card>
          <EmptyState
            title={tab === 'regular' ? 'No test results yet' : 'No practice tests yet'}
            hint={
              tab === 'regular'
                ? 'Once you attempt a test, your score and progress graph will appear here.'
                : 'Your teacher can set you a practice test targeting the topics you find hardest.'
            }
          />
        </Card>
      ) : (
        <>
          <ProgressChart results={results} />
          <SubjectChart results={results} />
          <ResultsTable results={results} />
        </>
      )}

      {data.weakAreas.length > 0 && <WeakAreas areas={data.weakAreas} />}
    </div>
  );
}

// --- Activities ------------------------------------------------------------

/**
 * Only optional activities and ones already completed appear here. A required
 * one that is still outstanding is not a card on a dashboard - the student is
 * taken straight to it.
 */
function Activities({ activities }: { activities: ActivitySummary[] }) {
  return (
    <Card title="Activities" padded={false}>
      <ul className="divide-y divide-line">
        {activities.map((a) => (
          <li key={a.id} className="px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{a.title}</span>
                {a.completedAt ? <Badge tone="good">done</Badge> : a.isMandatory ? <Badge tone="warn">required</Badge> : <Badge>optional</Badge>}
              </div>
              <p className="text-[11px] text-ink-faint mt-0.5">
                {a.cardCount > 0 && `${a.cardCount} card${a.cardCount === 1 ? '' : 's'}`}
                {a.cardCount > 0 && a.hasVideo && ' · '}
                {a.hasVideo && 'video'}
                {a.completedAt && ` · completed ${formatDate(a.completedAt)}`}
              </p>
            </div>
            <Link to={`/activity/${a.id}`} className="btn-secondary btn-sm shrink-0">
              {a.completedAt ? 'Read again' : 'Open'}
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- Submitted, waiting on the teacher -------------------------------------

function AwaitingResults({ items }: { items: AwaitingResult[] }) {
  return (
    <Card title="Submitted - awaiting results" padded={false}>
      <p className="px-4 pt-3 text-xs text-ink-muted">
        You have finished {items.length === 1 ? 'this paper' : 'these papers'}. Your teacher releases the results once
        everyone in the class has sat the test.
      </p>
      <ul className="divide-y divide-line mt-2">
        {items.map((item) => (
          <li key={item.attemptId} className="px-4 py-3 flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0">
              <span className="text-sm font-medium">{item.title}</span>
              <span className="block text-xs text-ink-muted mt-0.5">
                <span className="font-mono">{item.testPublicId}</span> · {item.subject} · submitted{' '}
                {formatDate(item.submittedAt, true)}
              </span>
            </span>
            <Badge tone="warn">Results not released yet</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// --- Live tests ------------------------------------------------------------

function LiveTests({ tests }: { tests: LiveTest[] }) {
  const navigate = useNavigate();
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async (test: LiveTest) => {
    setStarting(test.id);
    setError(null);
    try {
      const res = await api.post<{ attemptId: string; resumed: boolean }>(`/api/student/tests/${test.id}/start`);
      navigate(`/attempt/${res.attemptId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start that test.');
      setStarting(null);
    }
  };

  return (
    <Card title="Live tests" padded={false}>
      {error && (
        <div className="p-4 pb-0">
          <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>
        </div>
      )}

      {tests.length === 0 ? (
        <EmptyState title="No tests are live right now" hint="When your teacher publishes a test, it will appear here." />
      ) : (
        <ul className="divide-y divide-line">
          {tests.map((test) => (
            <li key={test.id} className="p-4 flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-sm font-medium truncate">{test.title}</h3>
                  {test.kind === 'PRACTICE' && <Badge tone="info">Practice</Badge>}
                  {test.inProgressAttemptId && <Badge tone="warn">In progress</Badge>}
                  {!test.isOpenNow && !test.inProgressAttemptId && <Badge tone="warn">Paused</Badge>}
                </div>
                <p className="text-xs text-ink-muted mt-1">
                  {test.subject} · {test.questionCount} question{test.questionCount === 1 ? '' : 's'} ·{' '}
                  {test.totalMarks} mark{test.totalMarks === 1 ? '' : 's'} · {test.durationMinutes} min
                  {test.negativeMarks > 0 && ` · −${test.negativeMarks} per wrong answer`}
                </p>
                {test.endsAt && (
                  <p className="text-[11px] text-ink-faint mt-0.5">Closes {formatDate(test.endsAt, true)}</p>
                )}
                {!test.isOpenNow && test.closedReason && (
                  <p className="text-[11px] text-warn mt-1">{test.closedReason}</p>
                )}
                {test.isOpenNow && test.windowLabel && (
                  <p className="text-[11px] text-ink-faint mt-0.5">Available {test.windowLabel}</p>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {test.attemptsUsed > 0 && (
                  <span className="text-xs text-ink-faint">
                    {test.attemptsUsed}/{test.maxAttempts} used
                  </span>
                )}
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  disabled={(!test.canAttempt && !test.inProgressAttemptId) || starting === test.id}
                  onClick={() => start(test)}
                >
                  {starting === test.id
                    ? 'Opening…'
                    : test.inProgressAttemptId
                      ? 'Resume test'
                      : !test.isOpenNow
                        ? 'Paused'
                        : 'Attempt test'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// --- Charts ----------------------------------------------------------------

function ProgressChart({ results }: { results: ResultRow[] }) {
  // Oldest first, so the line reads left to right as time passes.
  const ordered = [...results].reverse();
  const points = ordered.map((r, i) => [i, r.percentage] as [number, number]);
  const labels = ordered.map((r) => r.title);

  return (
    <Card title="Score trend">
      <LineChart
        series={[{ name: 'Percentage', points }]}
        xTickLabels={labels}
        yMin={0}
        yMax={100}
        yLabel="Percentage"
        formatY={(n) => `${n}%`}
        reference={{ value: 35, label: 'Pass mark' }}
        height={250}
        table={
          <DataTable
            headers={['Test', 'Date', 'Score', 'Percentage']}
            rows={ordered.map((r) => [r.title, formatDate(r.submittedAt), `${r.score}/${r.maxScore}`, `${r.percentage}%`])}
          />
        }
      />
    </Card>
  );
}

function SubjectChart({ results }: { results: ResultRow[] }) {
  const bySubject = new Map<string, { total: number; count: number }>();
  for (const r of results) {
    const entry = bySubject.get(r.subject) ?? { total: 0, count: 0 };
    entry.total += r.percentage;
    entry.count += 1;
    bySubject.set(r.subject, entry);
  }

  const categories = [...bySubject.keys()];
  if (categories.length < 2) return null; // one bar is a stat tile, not a chart

  const values = categories.map((c) => {
    const entry = bySubject.get(c)!;
    return Math.round((entry.total / entry.count) * 10) / 10;
  });

  return (
    <Card title="Average by subject">
      <BarChart
        categories={categories}
        // One series, one colour for every bar - never a value ramp.
        series={[{ name: 'Average percentage', values }]}
        yMax={100}
        yLabel="Percentage"
        formatValue={(n) => `${n}%`}
        showValues={categories.length <= 8}
        reference={{ value: 35, label: 'Pass mark' }}
        height={250}
        table={<DataTable headers={['Subject', 'Average %', 'Tests']} rows={categories.map((c, i) => [c, values[i], bySubject.get(c)!.count])} />}
      />
    </Card>
  );
}

function ResultsTable({ results }: { results: ResultRow[] }) {
  return (
    <Card title="All results" padded={false}>
      <div className="scroll-x">
        <table className="table-base">
          <thead>
            <tr>
              <th>Test</th>
              <th>Subject</th>
              <th>Date</th>
              <th className="text-right">Score</th>
              <th className="text-right">Percentage</th>
              <th className="text-center">Correct</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.attemptId}>
                <td className="font-medium max-w-[220px] truncate">{r.title}</td>
                <td className="text-ink-muted">{r.subject}</td>
                <td className="text-ink-muted whitespace-nowrap">{formatDate(r.submittedAt)}</td>
                <td className="text-right tabular-nums">{r.score}/{r.maxScore}</td>
                <td className="text-right tabular-nums font-medium">{r.percentage}%</td>
                <td className="text-center text-xs text-ink-muted tabular-nums">
                  {r.correctCount}/{r.correctCount + r.incorrectCount + r.unansweredCount}
                </td>
                <td className="text-right">
                  <Link to={`/result/${r.attemptId}`} className="text-xs text-series-1 hover:underline whitespace-nowrap">
                    View
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function WeakAreas({ areas }: { areas: WeakArea[] }) {
  return (
    <Card title="Where to focus next">
      <p className="text-xs text-ink-muted mb-3">
        Based on the questions you have answered so far. Your teacher can set a practice test on any of these.
      </p>
      <ul className="space-y-2">
        {areas.map((area) => (
          <li key={`${area.axis}-${area.key}`} className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1">
              <span className="text-sm">{humanizeTag(area.key)}</span>
              <span className="ml-2 badge">{area.axis}</span>
            </span>
            <span className="flex items-center gap-3 shrink-0">
              <span className="text-xs text-ink-faint tabular-nums">
                {area.correct}/{area.total}
              </span>
              <AccuracyMeter accuracy={area.accuracy} />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
