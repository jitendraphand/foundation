import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageLoader, formatDate } from '../../components/ui';

interface TestRow {
  id: string;
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
  _count: { questions: number; attempts: number };
  targetUser: { id: string; username: string; firstName: string; lastName: string } | null;
}

export default function AdminTests() {
  const [tests, setTests] = useState<TestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
                  <th>Title</th>
                  <th>Subject</th>
                  <th>Audience</th>
                  <th className="text-center">Questions</th>
                  <th className="text-center">Attempts</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tests.map((test) => (
                  <tr key={test.id}>
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
    showResultsAfter: true,
    showAnswersAfter: true,
    targetGrades: '',
    targetDivisions: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        showResultsAfter: form.showResultsAfter,
        showAnswersAfter: form.showAnswersAfter,
        targetGrades: form.targetGrades.split(',').map((s) => s.trim()).filter(Boolean),
        targetDivisions: form.targetDivisions.split(',').map((s) => s.trim()).filter(Boolean),
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

        <div className="grid grid-cols-2 gap-2 text-sm">
          {([
            ['shuffleQuestions', 'Shuffle question order'],
            ['shuffleOptions', 'Shuffle option order'],
            ['showResultsAfter', 'Show score on submit'],
            ['showAnswersAfter', 'Show correct answers'],
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
