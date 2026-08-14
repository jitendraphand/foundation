import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { suggestPassword } from '../../lib/passwords';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageLoader, formatDate, humanizeTag } from '../../components/ui';
import { AccuracyMeter } from '../../components/charts';
import { useAuth } from '../../lib/auth';
import type { WeakArea } from '../../lib/types';

interface StudentRow {
  id: string;
  publicId: string;
  username: string;
  name: string;
  grade: string;
  division: string;
  rollNo: string;
  isActive: boolean;
  lastLoginAt: string | null;
  attempts: number;
  averagePercentage: number;
  bestPercentage: number;
  lastPercentage: number;
  trend: number;
  weakAreas: WeakArea[];
}

interface UserRow {
  id: string;
  publicId: string;
  username: string;
  firstName: string;
  lastName: string;
  grade: string;
  /** The home division: the one the roll number is unique inside. */
  division: string;
  /** Every division the student is in, home division first. */
  divisions: string[];
  rollNo: string;
  dateOfBirth: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  _count: { attempts: number };
}

interface ClassLists {
  grades: { code: string; label: string }[];
  divisions: { code: string; label: string }[];
}

/**
 * The divisions a student is in beyond their home one.
 *
 * A child can be in the Science Foundation and the Sports Foundation at once,
 * and a paper set for either has to reach them. The home division stays a
 * single choice because the roll number is unique within it; everything else is
 * a membership, so it is a list of ticks rather than a second dropdown.
 */
function ExtraDivisions({
  home, value, options, onChange,
}: {
  home: string;
  value: string[];
  options: { code: string; label: string }[];
  onChange: (next: string[]) => void;
}) {
  const others = options.filter((d) => d.code !== home);
  if (others.length === 0) return null;

  return (
    <Field label="Also in">
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {others.map((d) => (
          <label key={d.code} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              className="accent-series-1"
              checked={value.includes(d.code)}
              onChange={(e) =>
                onChange(e.target.checked ? [...value, d.code] : value.filter((c) => c !== d.code))
              }
            />
            <span className="text-ink-muted">{d.label}</span>
          </label>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-ink-faint">
        Optional. A test or activity set for any of these divisions will reach this student as well.
      </p>
    </Field>
  );
}

export default function AdminStudents() {
  const [view, setView] = useState<'manage' | 'performance'>('manage');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Students</h1>
        <div className="flex gap-1 rounded-lg border border-line p-0.5">
          {(['manage', 'performance'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-3 py-1 text-xs rounded-md ${view === v ? 'bg-surface-sunken text-ink font-medium' : 'text-ink-muted'}`}
            >
              {v === 'manage' ? 'Manage' : 'Performance'}
            </button>
          ))}
        </div>
      </div>

      {view === 'manage' ? <ManageStudents /> : <PerformanceTable />}
    </div>
  );
}

// --- Manage ----------------------------------------------------------------

function ManageStudents() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [deleting, setDeleting] = useState<UserRow | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ pageSize: '100', status });
      if (search.trim()) query.set('search', search.trim());
      const res = await api.get<{ users: UserRow[]; total: number }>(`/api/admin/users?${query}`);
      setUsers(res.users);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load students.');
    } finally {
      setLoading(false);
    }
  }, [search, status]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  const toggleActive = async (user: UserRow) => {
    try {
      await api.post(`/api/admin/users/${user.id}/activate`, { isActive: !user.isActive });
      setNotice(`${user.username} has been ${user.isActive ? 'deactivated' : 'activated'}.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that account.');
    }
  };

  return (
    <div className="space-y-4">
      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      <div className="flex flex-wrap gap-2">
        <input
          className="input max-w-xs"
          placeholder="Search by name, username, roll no. or user ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          <option value="all">All accounts</option>
          <option value="active">Active only</option>
          <option value="inactive">Deactivated only</option>
        </select>
        <button type="button" className="btn-primary btn-sm ml-auto" onClick={() => setCreating(true)}>
          New student
        </button>
      </div>

      {loading ? (
        <PageLoader label="Loading students" />
      ) : users.length === 0 ? (
        <Card><EmptyState title="No students found" hint="Students appear here once they sign up." /></Card>
      ) : (
        <Card padded={false}>
          <div className="scroll-x">
            <table className="table-base">
              <thead>
                <tr>
                  <th>User ID</th>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Class</th>
                  <th>Roll no.</th>
                  <th>Date of birth</th>
                  <th className="text-center">Tests</th>
                  <th>Last sign-in</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className={user.isActive ? '' : 'opacity-60'}>
                    {/* Never changes, no matter how the name or username is edited. */}
                    <td className="font-mono text-xs text-ink-muted whitespace-nowrap">{user.publicId}</td>
                    <td>
                      <Link to={`/admin/students/${user.id}`} className="font-medium hover:text-series-1">
                        {user.firstName} {user.lastName}
                      </Link>
                    </td>
                    <td className="font-mono text-xs text-ink-muted">{user.username}</td>
                    <td className="text-ink-muted whitespace-nowrap">
                      {user.grade}-{user.division}
                      {/* The home division is in the class code above; only the
                          extra memberships need saying. */}
                      {(user.divisions ?? [])
                        .filter((d) => d !== user.division)
                        .map((d) => <span key={d} className="ml-1 text-xs text-ink-faint">+{d}</span>)}
                    </td>
                    <td className="tabular-nums">{user.rollNo}</td>
                    <td className="text-xs text-ink-muted whitespace-nowrap">{formatDate(user.dateOfBirth)}</td>
                    <td className="text-center tabular-nums">{user._count.attempts}</td>
                    <td className="text-xs text-ink-muted whitespace-nowrap">{formatDate(user.lastLoginAt, true)}</td>
                    <td>
                      <Badge tone={user.isActive ? 'good' : 'neutral'}>{user.isActive ? 'active' : 'deactivated'}</Badge>
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(user)}>Edit</button>
                      <button type="button" className="btn-ghost btn-sm" onClick={() => toggleActive(user)}>
                        {user.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                      <button type="button" className="btn-ghost btn-sm" onClick={() => setResetting(user)}>Reset password</button>
                      <button type="button" className="btn-ghost btn-sm text-bad" onClick={() => setDeleting(user)}>Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-2 text-xs text-ink-faint border-t border-line">
            Showing {users.length} of {total}
          </p>
        </Card>
      )}

      {creating && (
        <CreateStudentModal
          onClose={() => setCreating(false)}
          onCreated={async (msg) => { setCreating(false); setNotice(msg); await load(); }}
        />
      )}

      {editing && <EditUserModal user={editing} onClose={() => setEditing(null)} onSaved={async (msg) => { setEditing(null); if (msg) setNotice(msg); await load(); }} />}
      {resetting && <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} onDone={(msg) => { setResetting(null); setNotice(msg); }} />}
      {deleting && <DeleteUserModal user={deleting} onClose={() => setDeleting(null)} onDone={async (msg) => { setDeleting(null); setNotice(msg); await load(); }} />}
    </div>
  );
}

/** Enrols a student by hand, for anyone who cannot sign themselves up. */
function CreateStudentModal({ onClose, onCreated }: { onClose: () => void; onCreated: (message: string) => void }) {
  const [form, setForm] = useState({ firstName: '', lastName: '', grade: '', division: '', rollNo: '', dateOfBirth: '', password: '' });
  const [extraDivisions, setExtraDivisions] = useState<string[]>([]);
  const [classes, setClasses] = useState<ClassLists>({ grades: [], divisions: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<typeof classes>('/api/auth/classes').then(setClasses).catch(() => undefined);
  }, []);

  const suggest = () => setForm((f) => ({ ...f, password: suggestPassword() }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ message: string }>('/api/admin/users', {
        ...form,
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        // The home division is sent on its own as well; the server puts it at
        // the front of the list, so order here does not matter.
        divisions: extraDivisions,
        role: 'STUDENT',
        permissions: [],
        mustChangePassword: true,
      });
      onCreated(`${res.message} Password: ${form.password}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create that student.');
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Modal open onClose={onClose} title="New student">
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" required><input className="input" value={form.firstName} onChange={set('firstName')} required autoFocus /></Field>
          <Field label="Last name" required><input className="input" value={form.lastName} onChange={set('lastName')} required /></Field>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Grade" required>
            <select className="input" value={form.grade} onChange={set('grade')} required>
              <option value="">—</option>
              {classes.grades.map((g) => <option key={g.code} value={g.code}>{g.label}</option>)}
            </select>
          </Field>
          <Field label="Division" required>
            <select className="input" value={form.division} onChange={set('division')} required>
              <option value="">—</option>
              {classes.divisions.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}
            </select>
          </Field>
          <Field label="Roll no." required><input className="input" value={form.rollNo} onChange={set('rollNo')} required /></Field>
        </div>

        <ExtraDivisions
          home={form.division}
          value={extraDivisions.filter((d) => d !== form.division)}
          options={classes.divisions}
          onChange={setExtraDivisions}
        />

        <Field label="Date of birth" required>
          <input type="date" className="input" value={form.dateOfBirth} onChange={set('dateOfBirth')} required max={new Date().toISOString().slice(0, 10)} />
        </Field>

        <Field label="Temporary password" required hint="Give this to the student in person; they must change it at first sign-in.">
          <div className="flex gap-2">
            <input className="input font-mono" value={form.password} onChange={set('password')} required minLength={8} />
            <button type="button" className="btn-secondary btn-sm shrink-0" onClick={suggest}>Suggest</button>
          </div>
        </Field>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create student'}</button>
        </div>
      </form>
    </Modal>
  );
}

function EditUserModal({ user, onClose, onSaved }: { user: UserRow; onClose: () => void; onSaved: (message?: string) => void }) {
  const [form, setForm] = useState({
    firstName: user.firstName,
    lastName: user.lastName,
    grade: user.grade,
    division: user.division,
    rollNo: user.rollNo,
    dateOfBirth: user.dateOfBirth.slice(0, 10),
  });
  const [extraDivisions, setExtraDivisions] = useState<string[]>(
    () => (user.divisions ?? []).filter((d) => d !== user.division),
  );
  const [usernameMode, setUsernameMode] = useState<'keep' | 'set' | 'regenerate'>('keep');
  const [username, setUsername] = useState(user.username);
  const [availability, setAvailability] = useState<{ available: boolean; reason?: string } | null>(null);
  const [classes, setClasses] = useState<ClassLists>({ grades: [], divisions: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<ClassLists>('/api/auth/classes').then(setClasses).catch(() => undefined);
  }, []);

  // Check the new username as it is typed, so the admin is never surprised by
  // a conflict only after pressing Save.
  useEffect(() => {
    if (usernameMode !== 'set' || username === user.username) {
      setAvailability(null);
      return;
    }
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ username, excludeUserId: user.id });
      api
        .get<{ available: boolean; reason?: string }>(`/api/admin/users/username-available?${query}`)
        .then(setAvailability)
        .catch(() => setAvailability(null));
    }, 300);
    return () => clearTimeout(timer);
  }, [username, usernameMode, user.id, user.username]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.patch<{ message?: string }>(`/api/admin/users/${user.id}`, {
        ...form,
        // Always the whole set, never a delta - see the note on the edit
        // schema for why.
        divisions: extraDivisions.filter((d) => d !== form.division),
        ...(usernameMode === 'set' && username !== user.username ? { username } : {}),
        ...(usernameMode === 'regenerate' ? { regenerateUsername: true } : {}),
      });
      onSaved(res.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Edit ${user.username}`}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="First name"><input className="input" value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} /></Field>
          <Field label="Last name"><input className="input" value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} /></Field>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Grade">
            <select className="input" value={form.grade} onChange={(e) => setForm((f) => ({ ...f, grade: e.target.value }))}>
              {classes.grades.map((g) => <option key={g.code} value={g.code}>{g.label}</option>)}
            </select>
          </Field>
          <Field label="Division">
            <select className="input" value={form.division} onChange={(e) => setForm((f) => ({ ...f, division: e.target.value }))}>
              {classes.divisions.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}
            </select>
          </Field>
          <Field label="Roll no."><input className="input" value={form.rollNo} onChange={(e) => setForm((f) => ({ ...f, rollNo: e.target.value }))} /></Field>
        </div>

        <ExtraDivisions
          home={form.division}
          value={extraDivisions.filter((d) => d !== form.division)}
          options={classes.divisions}
          onChange={setExtraDivisions}
        />

        <Field label="Date of birth">
          <input type="date" className="input" value={form.dateOfBirth} onChange={(e) => setForm((f) => ({ ...f, dateOfBirth: e.target.value }))} />
        </Field>

        <fieldset className="rounded-lg border border-line p-3 space-y-2">
          <legend className="px-1 text-xs font-medium text-ink-muted">Username</legend>

          <p className="text-[11px] text-ink-faint">
            User ID <span className="font-mono text-ink-muted">{user.publicId}</span> never changes, so results stay
            attached to this student however the username is edited.
          </p>

          {([
            ['keep', `Keep ${user.username}`],
            ['set', 'Set it myself'],
            ['regenerate', 'Re-generate it from the name'],
          ] as const).map(([mode, label]) => (
            <label key={mode} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="username-mode"
                className="accent-series-1"
                checked={usernameMode === mode}
                onChange={() => setUsernameMode(mode)}
              />
              <span className="text-ink-muted">{label}</span>
            </label>
          ))}

          {usernameMode === 'set' && (
            <div>
              <input
                className="input font-mono"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ''))}
                autoCapitalize="none"
                spellCheck={false}
              />
              {availability && (
                <p className={`mt-1 text-[11px] ${availability.available ? 'text-good' : 'text-bad'}`}>
                  {availability.available ? `${username} is available.` : availability.reason}
                </p>
              )}
            </div>
          )}

          {usernameMode !== 'keep' && (
            <Alert tone="warn">
              The student signs in with their username, so tell them the new one in person.
            </Alert>
          )}
        </fieldset>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="submit"
            className="btn-primary"
            disabled={busy || (usernameMode === 'set' && availability !== null && !availability.available)}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose, onDone }: { user: UserRow; onClose: () => void; onDone: (message: string) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const suggest = () => setPassword(suggestPassword());

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ message: string }>(`/api/admin/users/${user.id}/reset-password`, { newPassword: password });
      onDone(`${res.message} Temporary password: ${password}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Reset password for ${user.username}`}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}

        <p className="text-sm text-ink-muted">
          Set a temporary password and give it to the student. They will be asked to choose their own the next time
          they sign in.
        </p>

        <Field label="Temporary password" required>
          <div className="flex gap-2">
            <input className="input font-mono" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
            <button type="button" className="btn-secondary btn-sm shrink-0" onClick={suggest}>Suggest</button>
          </div>
        </Field>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Resetting…' : 'Reset password'}</button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteUserModal({ user, onClose, onDone }: { user: UserRow; onClose: () => void; onDone: (message: string) => void }) {
  const [hard, setHard] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.delete<{ message: string }>(`/api/admin/users/${user.id}${hard ? '?hard=true' : ''}`);
      onDone(res.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete that account.');
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Delete ${user.username}?`}>
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}

        <p className="text-sm text-ink-muted">
          By default the account is removed but their past results are kept, so class averages and reports stay
          correct. Their username and roll number are freed for reuse.
        </p>

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="accent-bad mt-0.5" checked={hard} onChange={(e) => setHard(e.target.checked)} />
          <span className="text-ink-muted">
            Permanently erase everything, including all {user._count.attempts} of their test results. This cannot be
            undone.
          </span>
        </label>

        {hard && (
          <Field label={`Type ${user.username} to confirm`} required>
            <input className="input font-mono" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn-danger"
            onClick={remove}
            disabled={busy || (hard && confirm !== user.username)}
          >
            {busy ? 'Deleting…' : hard ? 'Permanently delete' : 'Delete'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// --- Performance table -----------------------------------------------------

function PerformanceTable() {
  const [students, setStudents] = useState<StudentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'REGULAR' | 'PRACTICE' | 'ALL'>('REGULAR');

  useEffect(() => {
    setLoading(true);
    api
      .get<{ students: StudentRow[] }>(`/api/admin/analytics/students?kind=${kind}`)
      .then((res) => setStudents(res.students))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load performance data.'))
      .finally(() => setLoading(false));
  }, [kind]);

  if (error) return <Alert tone="error">{error}</Alert>;

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-3">
        <p className="text-xs text-ink-muted">Sorted weakest first, so the students who need help are at the top.</p>
        <select className="input w-auto text-xs py-1.5" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="REGULAR">Class tests</option>
          <option value="PRACTICE">Practice tests</option>
          <option value="ALL">Both</option>
        </select>
      </div>

      {loading ? (
        <PageLoader label="Loading" />
      ) : students.length === 0 ? (
        <Card><EmptyState title="No results yet" hint="Performance appears once students have attempted a test." /></Card>
      ) : (
        <Card padded={false}>
          <div className="scroll-x">
            <table className="table-base">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Class</th>
                  <th className="text-center">Tests</th>
                  <th className="text-right">Average</th>
                  <th className="text-right">Best</th>
                  <th className="text-right">Trend</th>
                  <th>Weakest areas</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {students.map((student) => (
                  <tr key={student.id}>
                    <td>
                      <Link to={`/admin/students/${student.id}`} className="font-medium hover:text-series-1">{student.name}</Link>
                      {!student.isActive && <Badge>inactive</Badge>}
                    </td>
                    <td className="text-ink-muted">{student.grade}-{student.division}</td>
                    <td className="text-center tabular-nums">{student.attempts}</td>
                    <td className="text-right">
                      <AccuracyMeter accuracy={student.averagePercentage / 100} threshold={0.6} />
                    </td>
                    <td className="text-right tabular-nums">{student.bestPercentage}%</td>
                    <td className={`text-right tabular-nums ${student.trend > 0 ? 'text-good' : student.trend < 0 ? 'text-bad' : 'text-ink-faint'}`}>
                      {student.trend > 0 ? '+' : ''}{student.trend}
                    </td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        {student.weakAreas.slice(0, 3).map((area) => (
                          <Badge key={`${area.axis}-${area.key}`} tone="warn">{humanizeTag(area.key)}</Badge>
                        ))}
                        {student.weakAreas.length === 0 && <span className="text-xs text-ink-faint">—</span>}
                      </span>
                    </td>
                    <td className="text-right">
                      <Link to={`/admin/students/${student.id}`} className="text-xs text-series-1 hover:underline whitespace-nowrap">
                        Analyse
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
