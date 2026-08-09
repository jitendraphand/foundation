import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Card, EmptyState, PageLoader, Tabs, formatDate, humanizeTag } from '../../components/ui';
import { AccuracyMeter, StatTile } from '../../components/charts';

/**
 * The two questions the rest of the admin screens cannot answer.
 *
 * Every other view here is built from attempts, which means every other view
 * can only describe children who turned up. "Who has not sat Friday's paper"
 * and "who in this class is weak at fractions" are both questions about the
 * people *missing* from that data - the first about children absent from a
 * paper's attempts, the second about reading one tag down a column instead of
 * a child across a row.
 *
 * Both end in a list of names a teacher acts on, so both offer the same last
 * step: a CSV to work down.
 */

type Report = 'participation' | 'weakness';

interface TestRow {
  id: string;
  publicId: string;
  title: string;
  subject: string;
  kind: string;
  status: string;
  createdAt: string;
  audience: string;
}

type CellState = 'not_started' | 'in_progress' | 'abandoned' | 'submitted';

interface ParticipationRow {
  student: {
    id: string; publicId: string; username: string; name: string;
    grade: string; division: string; rollNo: string; lastLoginAt: string | null;
  };
  setFor: number;
  sat: number;
  missing: number;
  missingTestIds: string[];
  cells: Array<{ testId: string; state: CellState; percentage: number | null; submittedAt: string | null; passed: boolean | null }>;
}

interface ParticipationReport {
  tests: TestRow[];
  students: ParticipationRow[];
  totals: { audience: number; missing: number; partial: number; complete: number };
}

interface TagRow {
  key: string;
  correct: number;
  total: number;
  students: number;
  weak: number;
  accuracy: number;
}

interface WeakRow {
  student: { id: string; publicId: string; username: string; name: string; grade: string; division: string; rollNo: string };
  correct: number;
  total: number;
  accuracy: number;
  thin: boolean;
  papers: Array<{ testId: string; title: string; correct: number; total: number }>;
}

interface WeaknessReport {
  axis: string;
  key: string | null;
  tags: TagRow[];
  students: WeakRow[];
}

const AXES = [
  { id: 'skill', label: 'Skill' },
  { id: 'cognitive', label: 'What they had to do' },
  { id: 'difficulty', label: 'Difficulty' },
  { id: 'topic', label: 'Topic' },
  { id: 'subtopic', label: 'Subtopic' },
] as const;

/** Opens a CSV. Not fetch: the browser's own download is what is wanted. */
function download(path: string) {
  window.location.href = path;
}

export default function AdminReports() {
  const [report, setReport] = useState<Report>('participation');

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold">Reports</h1>

      <Tabs
        tabs={[
          { id: 'participation' as const, label: 'Who has not sat a test' },
          { id: 'weakness' as const, label: 'Who is weak at one thing' },
        ]}
        active={report}
        onChange={setReport}
      />

      {report === 'participation' ? <Participation /> : <Weakness />}
    </div>
  );
}

// --- Who has not sat a test -------------------------------------------------

function Participation() {
  const [data, setData] = useState<ParticipationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<'REGULAR' | 'PRACTICE' | 'ALL'>('REGULAR');
  const [days, setDays] = useState(90);
  const [grade, setGrade] = useState('');
  const [division, setDivision] = useState('');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [onlyMissing, setOnlyMissing] = useState(true);

  const query = useMemo(() => {
    const p = new URLSearchParams({ kind, days: String(days) });
    if (grade) p.set('grade', grade);
    if (division) p.set('division', division);
    if (search.trim()) p.set('search', search.trim());
    if (chosen.length) p.set('testIds', chosen.join(','));
    // Server-side, so the downloaded file is the list on the screen.
    if (onlyMissing) p.set('missingOnly', 'true');
    return p.toString();
  }, [kind, days, grade, division, search, chosen, onlyMissing]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<ParticipationReport>(`/api/admin/analytics/participation?${query}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build that report.');
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  const rows = data?.students ?? [];
  const tests = data?.tests ?? [];

  return (
    <div className="space-y-4">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-muted">
            <span className="block mb-1">Papers</span>
            <select className="input w-auto text-xs py-1.5" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="REGULAR">Class tests</option>
              <option value="PRACTICE">Practice tests</option>
              <option value="ALL">Both</option>
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            <span className="block mb-1">Set in the last</span>
            <select className="input w-auto text-xs py-1.5" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={7}>week</option>
              <option value={30}>month</option>
              <option value={90}>term</option>
              <option value={365}>year</option>
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            <span className="block mb-1">Grade</span>
            <input className="input w-24 text-xs py-1.5" value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="any" />
          </label>
          <label className="text-xs text-ink-muted">
            <span className="block mb-1">Division</span>
            <input className="input w-24 text-xs py-1.5" value={division} onChange={(e) => setDivision(e.target.value)} placeholder="any" />
          </label>
          {/* Only the newest few papers fit in a readable grid, so this is how
              one particular paper is reached rather than the latest ones. */}
          <label className="text-xs text-ink-muted">
            <span className="block mb-1">Paper title contains</span>
            <input
              className="input w-44 text-xs py-1.5"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setChosen([]); }}
              placeholder="e.g. mid-term"
            />
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-muted pb-1.5">
            <input type="checkbox" className="accent-series-1" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} />
            Only those still owing work
          </label>
          <button
            type="button"
            className="btn-secondary btn-sm ml-auto"
            onClick={() => download(`/api/admin/analytics/participation.csv?${query}`)}
            disabled={!data || data.students.length === 0}
          >
            Download the list
          </button>
        </div>

        {/* Papers are picked from the ones the filters found, so narrowing to
            "just Friday's test" never needs a second search. */}
        {tests.length > 0 && (
          <div className="mt-3 pt-3 border-t border-line">
            <span className="text-[11px] font-medium text-ink-muted">
              {chosen.length ? `${chosen.length} paper${chosen.length === 1 ? '' : 's'} chosen` : `All ${tests.length} papers found`}
            </span>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {tests.map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    className="accent-series-1"
                    checked={chosen.length === 0 || chosen.includes(t.id)}
                    onChange={(e) => {
                      const base = chosen.length === 0 ? tests.map((x) => x.id) : chosen;
                      const next = e.target.checked ? [...new Set([...base, t.id])] : base.filter((id) => id !== t.id);
                      setChosen(next.length === tests.length ? [] : next);
                    }}
                  />
                  <span className="text-ink-muted">
                    {t.title}
                    <span className="text-ink-faint"> · {t.audience}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
      </Card>

      {loading ? (
        <PageLoader label="Building the report" />
      ) : tests.length === 0 ? (
        <Card>
          <EmptyState
            title={search ? `No papers matching “${search}”` : 'No papers in that window'}
            hint="Only published or closed papers count — a draft is not one anybody could have missed."
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
            <StatTile label="In the audience" value={data!.totals.audience} hint="students these papers were set for" />
            <StatTile label="Sat none of them" value={data!.totals.missing} tone={data!.totals.missing ? 'bad' : 'good'} />
            <StatTile label="Sat some" value={data!.totals.partial} tone={data!.totals.partial ? 'warn' : 'good'} />
            <StatTile label="All done" value={data!.totals.complete} tone="good" />
          </div>

          {rows.length === 0 ? (
            <Card>
              <EmptyState title="Everybody has sat everything" hint="Nothing to chase in this window." />
            </Card>
          ) : (
            <Card padded={false}>
              <div className="scroll-x">
                <table className="table-base">
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Class</th>
                      <th className="text-center">Still owing</th>
                      {tests.map((t) => (
                        <th key={t.id} className="text-center whitespace-nowrap">
                          <Link to={`/admin/tests/${t.id}`} className="hover:text-series-1">{t.title}</Link>
                        </th>
                      ))}
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
                        <td className="text-center">
                          {row.missing === 0
                            ? <Badge tone="good">none</Badge>
                            : <Badge tone={row.missing === row.setFor ? 'bad' : 'warn'}>{row.missing} of {row.setFor}</Badge>}
                        </td>
                        {tests.map((t) => {
                          const cell = row.cells.find((c) => c.testId === t.id);
                          return <td key={t.id} className="text-center"><StateCell cell={cell} /></td>;
                        })}
                        <td className="text-xs text-ink-muted whitespace-nowrap">{formatDate(row.student.lastLoginAt, true)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/**
 * One student against one paper.
 *
 * "Not set for them" and "did not sit it" have to look different: a dash where
 * a child was never in the audience, so nobody is chased for a paper that was
 * never theirs.
 */
function StateCell({ cell }: { cell: ParticipationRow['cells'][number] | undefined }) {
  if (!cell) return <span className="text-ink-faint" title="This paper was not set for them">—</span>;
  if (cell.state === 'submitted') {
    return (
      <span className={`text-xs tabular-nums ${cell.passed ? 'text-good' : 'text-warn'}`}>
        {cell.percentage}%
      </span>
    );
  }
  if (cell.state === 'in_progress') return <Badge tone="warn">writing</Badge>;
  if (cell.state === 'abandoned') return <Badge tone="warn">left it</Badge>;
  return <Badge tone="bad">not sat</Badge>;
}

// --- Who is weak at one thing -----------------------------------------------

function Weakness() {
  const [data, setData] = useState<WeaknessReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [axis, setAxis] = useState<(typeof AXES)[number]['id']>('skill');
  const [key, setKey] = useState('');
  const [threshold, setThreshold] = useState(0.6);
  const [minQuestions, setMinQuestions] = useState(4);
  const [grade, setGrade] = useState('');
  const [division, setDivision] = useState('');

  const query = useMemo(() => {
    const p = new URLSearchParams({
      axis, threshold: String(threshold), minQuestions: String(minQuestions),
    });
    if (key) p.set('key', key);
    if (grade) p.set('grade', grade);
    if (division) p.set('division', division);
    return p.toString();
  }, [axis, key, threshold, minQuestions, grade, division]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.get<WeaknessReport>(`/api/admin/analytics/weakness?${query}`));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not build that report.');
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  // Changing axis invalidates the tag, which belongs to the old one.
  useEffect(() => { setKey(''); }, [axis]);

  const judged = (data?.students ?? []).filter((r) => !r.thin);
  const thin = (data?.students ?? []).filter((r) => r.thin);

  return (
    <div className="space-y-4">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-muted">
            <span className="block mb-1">Look at</span>
            <select className="input w-auto text-xs py-1.5" value={axis} onChange={(e) => setAxis(e.target.value as typeof axis)}>
              {AXES.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            <span className="block mb-1">Weak means below</span>
            <select className="input w-auto text-xs py-1.5" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
              {[0.4, 0.5, 0.6, 0.7, 0.8].map((t) => <option key={t} value={t}>{Math.round(t * 100)}%</option>)}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            <span className="block mb-1">Over at least</span>
            <select className="input w-auto text-xs py-1.5" value={minQuestions} onChange={(e) => setMinQuestions(Number(e.target.value))}>
              {[2, 4, 6, 10, 20].map((n) => <option key={n} value={n}>{n} questions</option>)}
            </select>
          </label>
          <label className="text-xs text-ink-muted">
            <span className="block mb-1">Grade</span>
            <input className="input w-24 text-xs py-1.5" value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="any" />
          </label>
          <label className="text-xs text-ink-muted">
            <span className="block mb-1">Division</span>
            <input className="input w-24 text-xs py-1.5" value={division} onChange={(e) => setDivision(e.target.value)} placeholder="any" />
          </label>
          {key && (
            <button
              type="button"
              className="btn-secondary btn-sm ml-auto"
              onClick={() => download(`/api/admin/analytics/weakness.csv?${query}`)}
              disabled={!data || data.students.length === 0}
            >
              Download the list
            </button>
          )}
        </div>
      </Card>

      {loading ? (
        <PageLoader label="Building the report" />
      ) : (data?.tags.length ?? 0) === 0 ? (
        <Card>
          <EmptyState
            title="Nothing measured yet"
            hint="This fills in once students have sat papers carrying these tags."
          />
        </Card>
      ) : (
        <>
          {/* The column headings, worst first: which thing the school is
              weakest at, before anybody has chosen one. */}
          <Card title={`Across everybody, worst first`} padded={false}>
            <div className="scroll-x">
              <table className="table-base">
                <thead>
                  <tr>
                    <th>{AXES.find((a) => a.id === axis)?.label}</th>
                    <th className="text-right">Whole-school accuracy</th>
                    <th className="text-center">Students below {Math.round(threshold * 100)}%</th>
                    <th className="text-center">Students measured</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data!.tags.map((tag) => (
                    <tr key={tag.key} className={tag.key === key ? 'bg-surface-sunken' : ''}>
                      <td className="font-medium">{humanizeTag(tag.key)}</td>
                      <td className="text-right"><AccuracyMeter accuracy={tag.accuracy} threshold={threshold} /></td>
                      <td className="text-center">
                        {tag.weak > 0 ? <Badge tone="warn">{tag.weak}</Badge> : <span className="text-ink-faint">—</span>}
                      </td>
                      <td className="text-center tabular-nums text-ink-muted">{tag.students}</td>
                      <td className="text-right">
                        <button
                          type="button"
                          className="btn-ghost btn-sm"
                          onClick={() => setKey(tag.key === key ? '' : tag.key)}
                        >
                          {tag.key === key ? 'Hide' : 'Who?'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {key && (
            <Card
              title={
                <div>
                  <h2 className="text-sm font-semibold">Weak at {humanizeTag(key)}</h2>
                  <p className="text-[11px] text-ink-faint">
                    Below {Math.round(threshold * 100)}% over at least {minQuestions} questions. Worst first.
                  </p>
                </div>
              }
              padded={false}
            >
              {judged.length === 0 && thin.length === 0 ? (
                <div className="p-4">
                  <EmptyState title="Nobody is below that line" hint="Try a higher threshold, or a different tag." />
                </div>
              ) : (
                <div className="scroll-x">
                  <table className="table-base">
                    <thead>
                      <tr>
                        <th>Student</th>
                        <th>Class</th>
                        <th className="text-right">Accuracy</th>
                        <th className="text-center">Right</th>
                        <th className="text-center">Answered</th>
                        <th>Where it was measured</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {[...judged, ...thin].map((row) => (
                        <tr key={row.student.id} className={row.thin ? 'opacity-60' : ''}>
                          <td>
                            <Link to={`/admin/students/${row.student.id}`} className="font-medium hover:text-series-1">
                              {row.student.name}
                            </Link>
                            <span className="ml-1 text-[11px] text-ink-faint">#{row.student.rollNo}</span>
                          </td>
                          <td className="text-ink-muted whitespace-nowrap">{row.student.grade}-{row.student.division}</td>
                          <td className="text-right"><AccuracyMeter accuracy={row.accuracy} threshold={threshold} /></td>
                          <td className="text-center tabular-nums">{row.correct}</td>
                          <td className="text-center tabular-nums">{row.total}</td>
                          <td className="text-xs text-ink-muted">
                            {row.papers.slice(0, 3).map((p) => (
                              <Link key={p.testId} to={`/admin/tests/${p.testId}`} className="mr-2 hover:text-series-1 whitespace-nowrap">
                                {p.title} <span className="text-ink-faint tabular-nums">{p.correct}/{p.total}</span>
                              </Link>
                            ))}
                            {row.papers.length > 3 && <span className="text-ink-faint">+{row.papers.length - 3} more</span>}
                          </td>
                          <td className="text-right">
                            {/* Said plainly rather than hidden: three questions
                                is not evidence, and a list that quietly drops
                                them looks like the child is fine. */}
                            {row.thin && <Badge>too few to judge</Badge>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
