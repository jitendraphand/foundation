import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageLoader, formatDate } from '../../components/ui';
import { WindowEditor, describeWindowValue, type WindowPreset, type WindowValue } from '../../components/WindowEditor';

interface TestRow {
  id: string;
  publicId: string;
  title: string;
  kind: 'REGULAR' | 'PRACTICE';
  status: 'DRAFT' | 'PUBLISHED' | 'CLOSED';
  subject: string;
  durationMinutes: number;
  marksPerQuestion: number;
  negativeMarks: number;
  targetGrades: string[];
  targetDivisions: string[];
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
  availabilityMode: 'ALWAYS' | 'ALLOW_WINDOW' | 'BLOCK_WINDOW';
  windowStartMinute: number | null;
  windowEndMinute: number | null;
  windowDays: number[];
  autoSubmitOnClose: boolean;
  resultsReleased: boolean;
  resultsReleasedAt: string | null;
  _count: { questions: number; attempts: number };
  targetUser: { id: string; username: string; firstName: string; lastName: string } | null;
}

export default function AdminTests() {
  const [tests, setTests] = useState<TestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [kind, setKind] = useState<'REGULAR' | 'PRACTICE' | ''>('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ pageSize: '50' });
      if (kind) query.set('kind', kind);
      const res = await api.get<{ tests: TestRow[] }>(`/api/admin/tests?${query}`);
      setTests(res.tests);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load tests.');
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const setStatus = async (id: string, status: 'DRAFT' | 'PUBLISHED' | 'CLOSED') => {
    try {
      await api.post(`/api/admin/tests/${id}/publish`, { status });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the status.');
    }
  };

  const setReleased = async (id: string, released: boolean) => {
    setError(null);
    try {
      const res = await api.post<{ message: string }>(`/api/admin/tests/${id}/release`, { released });
      setNotice(res.message);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the release state.');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Tests</h1>
        <div className="flex items-center gap-2">
          <select className="input w-auto text-xs py-1.5" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="">All</option>
            <option value="REGULAR">Class tests</option>
            <option value="PRACTICE">Practice tests</option>
          </select>
          <button type="button" className="btn-primary btn-sm" onClick={() => setCreating(true)}>
            New test
          </button>
        </div>
      </div>

      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {loading ? (
        <PageLoader label="Loading tests" />
      ) : tests.length === 0 ? (
        <Card>
          <EmptyState
            title="No tests yet"
            hint="Create a test, then add approved questions to it from the builder."
            action={<button type="button" className="btn-primary btn-sm" onClick={() => setCreating(true)}>New test</button>}
          />
        </Card>
      ) : (
        <Card padded={false}>
          <div className="scroll-x">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Test ID</th>
                  <th>Title</th>
                  <th>Subject</th>
                  <th>Audience</th>
                  <th className="text-center">Questions</th>
                  <th className="text-center">Attempts</th>
                  <th>Status</th>
                  <th>Available</th>
                  <th>Results</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tests.map((test) => (
                  <tr key={test.id}>
                    {/* Stable identifier; unaffected by later title edits. */}
                    <td className="font-mono text-xs text-ink-muted whitespace-nowrap">{test.publicId}</td>
                    <td>
                      <Link to={`/admin/tests/${test.id}`} className="font-medium hover:text-series-1">
                        {test.title}
                      </Link>
                      {test.kind === 'PRACTICE' && <Badge tone="info">practice</Badge>}
                    </td>
                    <td className="text-ink-muted">{test.subject}</td>
                    <td className="text-xs text-ink-muted">
                      {test.targetUser
                        ? `${test.targetUser.firstName} ${test.targetUser.lastName}`
                        : test.targetGrades.length || test.targetDivisions.length
                          ? `Grade ${test.targetGrades.join(', ') || 'any'} · Div ${test.targetDivisions.join(', ') || 'any'}`
                          : 'Everyone'}
                    </td>
                    <td className="text-center tabular-nums">{test._count.questions}</td>
                    <td className="text-center tabular-nums">{test._count.attempts}</td>
                    <td>
                      <Badge tone={test.status === 'PUBLISHED' ? 'good' : test.status === 'CLOSED' ? 'neutral' : 'warn'}>
                        {test.status.toLowerCase()}
                      </Badge>
                    </td>
                    <td className="text-xs text-ink-muted max-w-[190px]">
                      {test.availabilityMode === 'ALWAYS'
                        ? 'any time'
                        : describeWindowValue({
                            availabilityMode: test.availabilityMode,
                            windowStartMinute: test.windowStartMinute,
                            windowEndMinute: test.windowEndMinute,
                            windowDays: test.windowDays,
                            autoSubmitOnClose: test.autoSubmitOnClose,
                          })}
                    </td>
                    <td>
                      {test.kind === 'PRACTICE' ? (
                        <span className="text-xs text-ink-faint">immediate</span>
                      ) : test.resultsReleased ? (
                        <Badge tone="good">released</Badge>
                      ) : (
                        <Badge tone="warn">held</Badge>
                      )}
                    </td>
                    <td className="text-xs text-ink-muted whitespace-nowrap">{formatDate(test.createdAt)}</td>
                    <td className="text-right whitespace-nowrap">
                      {test.status === 'DRAFT' && (
                        <button type="button" className="btn-primary btn-sm" onClick={() => setStatus(test.id, 'PUBLISHED')} disabled={test._count.questions === 0}>
                          Publish
                        </button>
                      )}
                      {test.status === 'PUBLISHED' && (
                        <button type="button" className="btn-secondary btn-sm" onClick={() => setStatus(test.id, 'CLOSED')}>
                          Close
                        </button>
                      )}
                      {test.status === 'CLOSED' && (
                        <button type="button" className="btn-ghost btn-sm" onClick={() => setStatus(test.id, 'PUBLISHED')}>
                          Reopen
                        </button>
                      )}
                      {test.kind !== 'PRACTICE' && test._count.attempts > 0 && (
                        <button
                          type="button"
                          className={test.resultsReleased ? 'btn-ghost btn-sm' : 'btn-secondary btn-sm'}
                          onClick={() => setReleased(test.id, !test.resultsReleased)}
                        >
                          {test.resultsReleased ? 'Withdraw results' : 'Release results'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {creating && <CreateTestModal onClose={() => setCreating(false)} onCreated={load} />}
    </div>
  );
}

function CreateTestModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    title: '',
    subject: '',
    description: '',
    durationMinutes: 30,
    marksPerQuestion: 1,
    negativeMarks: 0,
    passPercentage: 35,
    maxAttempts: 1,
    shuffleQuestions: true,
    shuffleOptions: true,
    proctored: false,
    proctorAllowance: 3,
    proctorFullscreen: true,
    showAnswersAfter: true,
    targetGrades: '',
    targetDivisions: '',
  });
  const [availability, setAvailability] = useState<WindowValue>({
    availabilityMode: 'ALWAYS',
    windowStartMinute: null,
    windowEndMinute: null,
    windowDays: [],
    autoSubmitOnClose: false,
  });
  const [tz, setTz] = useState<{ timezone: string; localTimeNow: string; windowPresets: WindowPreset[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Only an admin with settings.manage can read this; without it the editor
    // still works, it just cannot name the timezone.
    api.get<{ timezone: string; localTimeNow: string; windowPresets: WindowPreset[] }>('/api/admin/timezone')
      .then(setTz)
      .catch(() => undefined);
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/admin/tests', {
        title: form.title.trim(),
        subject: form.subject.trim(),
        description: form.description.trim() || null,
        kind: 'REGULAR',
        durationMinutes: form.durationMinutes,
        marksPerQuestion: form.marksPerQuestion,
        negativeMarks: form.negativeMarks,
        passPercentage: form.passPercentage,
        maxAttempts: form.maxAttempts,
        shuffleQuestions: form.shuffleQuestions,
        shuffleOptions: form.shuffleOptions,
        proctoring: {
          enabled: form.proctored,
          allowance: form.proctorAllowance,
          requireFullscreen: form.proctorFullscreen,
        },
        showAnswersAfter: form.showAnswersAfter,
        targetGrades: form.targetGrades.split(',').map((s) => s.trim()).filter(Boolean),
        targetDivisions: form.targetDivisions.split(',').map((s) => s.trim()).filter(Boolean),
        ...availability,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the test.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="New test">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}

        <Field label="Title" required>
          <input className="input" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} required autoFocus />
        </Field>

        <Field label="Subject" required>
          <input className="input" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} required />
        </Field>

        <Field label="Description">
          <textarea className="input" rows={2} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
        </Field>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="Duration (min)">
            <input type="number" min={1} className="input" value={form.durationMinutes} onChange={(e) => setForm((f) => ({ ...f, durationMinutes: Number(e.target.value) }))} />
          </Field>
          <Field label="Marks / question">
            <input type="number" min={0.25} step={0.25} className="input" value={form.marksPerQuestion} onChange={(e) => setForm((f) => ({ ...f, marksPerQuestion: Number(e.target.value) }))} />
          </Field>
          <Field label="Negative marks" hint="0 = none">
            <input type="number" min={0} step={0.25} className="input" value={form.negativeMarks} onChange={(e) => setForm((f) => ({ ...f, negativeMarks: Number(e.target.value) }))} />
          </Field>
          <Field label="Pass %">
            <input type="number" min={0} max={100} className="input" value={form.passPercentage} onChange={(e) => setForm((f) => ({ ...f, passPercentage: Number(e.target.value) }))} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Grades" hint="Comma separated. Empty = everyone.">
            <input className="input" value={form.targetGrades} onChange={(e) => setForm((f) => ({ ...f, targetGrades: e.target.value }))} placeholder="8, 9" />
          </Field>
          <Field label="Divisions" hint="Comma separated. Empty = everyone.">
            <input className="input" value={form.targetDivisions} onChange={(e) => setForm((f) => ({ ...f, targetDivisions: e.target.value }))} placeholder="A, B" />
          </Field>
        </div>

        <div className="pt-3 border-t border-line">
          <WindowEditor
            value={availability}
            onChange={setAvailability}
            presets={tz?.windowPresets ?? []}
            timezone={tz?.timezone}
            localTimeNow={tz?.localTimeNow}
          />
        </div>

        <div className="grid grid-cols-2 gap-2 text-sm pt-3 border-t border-line">
          {([
            ['shuffleQuestions', 'Shuffle question order'],
            ['shuffleOptions', 'Shuffle option order'],
            ['showAnswersAfter', 'Show correct answers once released'],
          ] as const).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-series-1"
                checked={form[key]}
                onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.checked }))}
              />
              <span className="text-ink-muted">{label}</span>
            </label>
          ))}
        </div>

        <div className="pt-3 border-t border-line space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="accent-series-1"
              checked={form.proctored}
              onChange={(e) => setForm((f) => ({ ...f, proctored: e.target.checked }))}
            />
            <span>Proctored exam</span>
          </label>

          {form.proctored && (
            <div className="pl-6 space-y-2">
              <p className="text-xs text-ink-muted">
                Records when a student leaves the paper — another tab, another app, or leaving fullscreen — and
                submits automatically once the allowance is used up. It cannot see a second device, a phone, or
                notes on the desk, so it is a deterrent and a record, not a substitute for invigilation.
              </p>
              <div className="flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <span className="text-ink-muted">Allowed departures</span>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    className="input w-20"
                    value={form.proctorAllowance}
                    onChange={(e) => setForm((f) => ({ ...f, proctorAllowance: Number(e.target.value) || 1 }))}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-series-1"
                    checked={form.proctorFullscreen}
                    onChange={(e) => setForm((f) => ({ ...f, proctorFullscreen: e.target.checked }))}
                  />
                  <span className="text-ink-muted">Leaving fullscreen counts too</span>
                </label>
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create test'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
