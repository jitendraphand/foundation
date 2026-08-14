import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { suggestPassword } from '../../lib/passwords';
import { useAuth } from '../../lib/auth';
import { Alert, Badge, Card, EmptyState, Field, Modal, PageLoader, Spinner, formatDate } from '../../components/ui';
import { PermissionPicker, PermissionSummary } from '../../components/PermissionPicker';
import type { Administrator, PermissionDef, PermissionPreset } from '../../lib/types';

/**
 * Administrators and their privileges.
 *
 * Only someone holding "Manage administrators" reaches this screen; the server
 * enforces that independently.
 */

export default function AdminPeople() {
  const { user, refresh } = useAuth();
  const [admins, setAdmins] = useState<Administrator[]>([]);
  const [catalogue, setCatalogue] = useState<PermissionDef[]>([]);
  const [presets, setPresets] = useState<PermissionPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Administrator | null>(null);
  const [resetting, setResetting] = useState<Administrator | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, perms] = await Promise.all([
        api.get<{ administrators: Administrator[] }>('/api/admin/administrators'),
        api.get<{ permissions: PermissionDef[]; presets: PermissionPreset[] }>('/api/admin/permissions'),
      ]);
      setAdmins(list.administrators);
      setCatalogue(perms.permissions);
      setPresets(perms.presets);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load administrators.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <PageLoader label="Loading administrators" />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Administrators</h1>
          <p className="text-xs text-ink-muted mt-1">
            Each administrator gets only the privileges you tick. Somebody who sets papers does not need the API keys
            or the backups.
          </p>
        </div>
        <button type="button" className="btn-primary btn-sm" onClick={() => setCreating(true)}>
          New administrator
        </button>
      </div>

      {error && <Alert tone="error" onDismiss={() => setError(null)}>{error}</Alert>}
      {notice && <Alert tone="success" onDismiss={() => setNotice(null)}>{notice}</Alert>}

      {admins.length === 0 ? (
        <Card><EmptyState title="No administrators yet" /></Card>
      ) : (
        <Card padded={false}>
          <div className="scroll-x">
            <table className="table-base">
              <thead>
                <tr>
                  <th>User ID</th>
                  <th>Name</th>
                  <th>Username</th>
                  <th>Privileges</th>
                  <th>Last sign-in</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {admins.map((admin) => (
                  <tr key={admin.id} className={admin.isActive ? '' : 'opacity-60'}>
                    <td className="font-mono text-xs text-ink-muted whitespace-nowrap">{admin.publicId}</td>
                    <td className="font-medium">
                      {admin.firstName} {admin.lastName}
                      {admin.id === user?.id && <Badge tone="info">you</Badge>}
                    </td>
                    <td className="font-mono text-xs text-ink-muted">{admin.username}</td>
                    <td><PermissionSummary permissions={admin.permissions} catalogue={catalogue} /></td>
                    <td className="text-xs text-ink-muted whitespace-nowrap">{formatDate(admin.lastLoginAt, true)}</td>
                    <td><Badge tone={admin.isActive ? 'good' : 'neutral'}>{admin.isActive ? 'active' : 'deactivated'}</Badge></td>
                    <td className="text-right whitespace-nowrap">
                      {/*
                        Your own password is changed, not reset: that asks for
                        the current one and keeps you signed in, where a reset
                        would sign you out of this very session and then demand a
                        new password at the door. The server refuses it too.
                      */}
                      {admin.id !== user?.id && (
                        <button type="button" className="btn-ghost btn-sm" onClick={() => setResetting(admin)}>
                          Reset password
                        </button>
                      )}
                      <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(admin)}>
                        Edit privileges
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {creating && (
        <CreateAdminModal
          catalogue={catalogue}
          presets={presets}
          onClose={() => setCreating(false)}
          onCreated={async (message) => {
            setCreating(false);
            setNotice(message);
            await load();
          }}
        />
      )}

      {resetting && (
        <ResetAdminPasswordModal
          admin={resetting}
          onClose={() => setResetting(null)}
          onDone={async (message) => {
            setResetting(null);
            setNotice(message);
            await load();
          }}
        />
      )}

      {editing && (
        <EditPrivilegesModal
          admin={editing}
          catalogue={catalogue}
          presets={presets}
          isSelf={editing.id === user?.id}
          onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            setNotice(message);
            await load();
            // Their own nav may have changed, so re-read the session.
            await refresh();
          }}
        />
      )}
    </div>
  );
}

// --- Create ----------------------------------------------------------------

function CreateAdminModal({
  catalogue, presets, onClose, onCreated,
}: {
  catalogue: PermissionDef[];
  presets: PermissionPreset[];
  onClose: () => void;
  onCreated: (message: string) => void;
}) {
  const [form, setForm] = useState({ firstName: '', lastName: '', username: '', dateOfBirth: '2000-01-01', password: '' });
  const [permissions, setPermissions] = useState<string[]>(
    presets.find((p) => p.code === 'teacher')?.permissions ?? [],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const suggest = () => setForm((f) => ({ ...f, password: suggestPassword() }));

  const derived = `${form.firstName}${form.lastName}`.toLowerCase().replace(/[^a-z0-9]/g, '');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ message: string }>('/api/admin/users', {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        dateOfBirth: form.dateOfBirth,
        password: form.password,
        role: 'ADMIN',
        permissions,
        mustChangePassword: true,
        ...(form.username.trim() ? { username: form.username.trim().toLowerCase() } : {}),
      });
      onCreated(`${res.message} Password: ${form.password}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create that administrator.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="New administrator" wide>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}

        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="First name" required>
            <input className="input" value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} required autoFocus />
          </Field>
          <Field label="Last name" required>
            <input className="input" value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} required />
          </Field>
        </div>

        <Field
          label="Username"
          hint={form.username.trim() ? undefined : derived ? `Leave blank to use "${derived}".` : 'Leave blank to derive it from the name.'}
        >
          <input
            className="input font-mono"
            value={form.username}
            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '') }))}
            placeholder={derived || 'e.g. rmehta'}
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>

        <Field label="Temporary password" required hint="Give this to them in person. They must change it at first sign-in.">
          <div className="flex gap-2">
            <input className="input font-mono" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} required minLength={8} />
            <button type="button" className="btn-secondary btn-sm shrink-0" onClick={suggest}>Suggest</button>
          </div>
        </Field>

        <div className="pt-2 border-t border-line">
          <PermissionPicker catalogue={catalogue} presets={presets} value={permissions} onChange={setPermissions} />
        </div>

        {permissions.includes('admins.manage') && (
          <Alert tone="warn">
            This account will be able to create further administrators and change anybody&apos;s privileges, including
            yours.
          </Alert>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-line">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || permissions.length === 0}>
            {busy ? <Spinner label="Creating" /> : 'Create administrator'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// --- Reset a colleague's password ------------------------------------------

/**
 * For the administrator who has forgotten theirs, or the one who has left.
 *
 * Without this the only way out was the database: administrators never appear
 * in the Students list, which is where the reset for everybody else lives, so
 * their account was unreachable from every screen in the app.
 */
function ResetAdminPasswordModal({
  admin, onClose, onDone,
}: {
  admin: Administrator;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ message: string }>(`/api/admin/users/${admin.id}/reset-password`, {
        newPassword: password,
      });
      onDone(`${res.message} Temporary password: ${password}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset that password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Reset password for ${admin.username}`}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}

        <p className="text-sm text-ink-muted">
          Set a temporary password and give it to {admin.firstName} in person. They will be asked to choose their own
          the next time they sign in.
        </p>

        <Alert tone="warn">
          This signs {admin.firstName} out everywhere immediately. Anyone holding the old password loses access, which
          is the point if the account has been compromised.
        </Alert>

        <Field label="Temporary password" required>
          <div className="flex gap-2">
            <input
              className="input font-mono"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoFocus
            />
            <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => setPassword(suggestPassword())}>
              Suggest
            </button>
          </div>
        </Field>

        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? <Spinner label="Resetting" /> : 'Reset password'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// --- Edit ------------------------------------------------------------------

function EditPrivilegesModal({
  admin, catalogue, presets, isSelf, onClose, onSaved,
}: {
  admin: Administrator;
  catalogue: PermissionDef[];
  presets: PermissionPreset[];
  isSelf: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [permissions, setPermissions] = useState<string[]>(admin.permissions);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Nobody may revoke their own ability to manage administrators; the server
  // refuses it too, but locking the box explains why up front.
  const locked = isSelf && admin.permissions.includes('admins.manage') ? ['admins.manage'] : [];

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.patch<{ message: string }>(`/api/admin/users/${admin.id}/permissions`, {
        role: 'ADMIN',
        permissions,
      });
      onSaved(res.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save those privileges.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Privileges for ${admin.firstName} ${admin.lastName}`} wide>
      <div className="space-y-4">
        {error && <Alert tone="error">{error}</Alert>}

        <p className="text-xs text-ink-muted">
          <span className="font-mono">{admin.publicId}</span> · username{' '}
          <span className="font-mono">{admin.username}</span>
        </p>

        <PermissionPicker
          catalogue={catalogue}
          presets={presets}
          value={permissions}
          onChange={setPermissions}
          disabledCodes={locked}
          disabledReason="You cannot remove this from your own account."
        />

        <div className="flex justify-end gap-2 pt-2 border-t border-line">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn-primary" onClick={save} disabled={busy || permissions.length === 0}>
            {busy ? <Spinner label="Saving" /> : 'Save privileges'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
