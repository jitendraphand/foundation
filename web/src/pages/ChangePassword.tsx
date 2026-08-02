import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Field, Spinner } from '../components/ui';

export default function ChangePassword() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const forced = !!user?.mustChangePassword;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (newPassword !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      await api.post('/api/auth/change-password', { currentPassword, newPassword });
      await refresh();
      navigate(user?.role === 'ADMIN' ? '/admin' : '/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change your password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-full flex items-center justify-center px-4 py-12">
      <form onSubmit={submit} className="card p-6 w-full max-w-md space-y-4">
        <div>
          <h1 className="text-sm font-semibold">Change your password</h1>
          {forced && (
            <p className="text-xs text-ink-muted mt-1">
              Your password was reset by an administrator. Please choose a new one to continue.
            </p>
          )}
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <Field label={forced ? 'Temporary password' : 'Current password'} required>
          <input
            className="input"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            autoComplete="current-password"
            required
            autoFocus
          />
        </Field>

        <Field label="New password" required hint="At least 8 characters, including a letter and a number.">
          <input
            className="input"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>

        <Field label="Confirm new password" required error={confirm && newPassword !== confirm ? 'The two passwords do not match.' : null}>
          <input
            className="input"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </Field>

        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? <Spinner label="Saving" /> : 'Update password'}
        </button>

        {!forced && (
          <button type="button" className="btn-ghost w-full" onClick={() => navigate(-1)}>
            Cancel
          </button>
        )}
      </form>
    </main>
  );
}
