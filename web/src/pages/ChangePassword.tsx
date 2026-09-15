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
      <div className="w-full max-w-md space-y-4">
      <form onSubmit={submit} className="card p-6 w-full max-w-md space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Change your password</h1>
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
      <EmailCard />
      </div>
    </main>
  );
}

/**
 * Your own email address for password resets. A System Administrator can set
 * it for you, but anything you type here costs your current password first —
 * otherwise anyone holding your unlocked device could redirect your resets.
 */
function EmailCard() {
  const { user, refresh } = useAuth();
  const [email, setEmail] = useState(user?.email ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.patch<{ message: string; email: string | null }>('/api/auth/profile', {
        email: email.trim() === '' ? null : email.trim(),
        currentPassword,
      });
      setNotice(res.message);
      setCurrentPassword('');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your email address.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="card p-6 w-full max-w-md space-y-4">
      <div>
        <h2 className="text-sm font-semibold">Email for password resets</h2>
        <p className="text-xs text-ink-muted mt-1">
          {user?.email
            ? `Resets currently go to ${user.email}.`
            : 'No email on file — resets can only go by WhatsApp, if a mobile number is on file.'}
        </p>
      </div>

      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="error">{error}</Alert>}

      <Field label="Email address" hint="Clear it to remove. Takes effect for the next reset.">
        <input
          className="input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          placeholder="name@example.com"
        />
      </Field>

      <Field label="Current password" required hint="Proof it is really you making this change.">
        <input
          className="input"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </Field>

      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? <Spinner label="Saving" /> : 'Save email address'}
      </button>
    </form>
  );
}
