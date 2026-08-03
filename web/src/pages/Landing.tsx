import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Field, Spinner } from '../components/ui';
import type { Me } from '../lib/types';

/**
 * The home page. Exactly two options, as specified: sign in or sign up.
 */

interface ClassOption {
  code: string;
  label: string;
}

type Mode = 'choose' | 'login' | 'signup';

export default function Landing() {
  const [mode, setMode] = useState<Mode>('choose');
  const { endedReason, clearEndedReason } = useAuth();

  return (
    <main className="min-h-full flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <header className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-11 h-11 rounded-xl bg-series-1 text-white font-semibold text-lg mb-3">
            F
          </div>
          <h1 className="text-xl font-semibold">Foundation</h1>
          <p className="text-sm text-ink-muted mt-1">Online examinations</p>
        </header>

        {/* Why they are back here, when they did not ask to be. */}
        {endedReason && (
          <div className="mb-4">
            <Alert tone="warn" onDismiss={clearEndedReason}>{endedReason}</Alert>
          </div>
        )}

        {mode === 'choose' && (
          <div className="card p-6 space-y-3">
            <button type="button" className="btn-primary w-full py-2.5" onClick={() => setMode('login')}>
              Sign in
            </button>
            <button type="button" className="btn-secondary w-full py-2.5" onClick={() => setMode('signup')}>
              Create an account
            </button>
          </div>
        )}

        {mode === 'login' && <LoginForm onBack={() => setMode('choose')} onSignup={() => setMode('signup')} />}
        {mode === 'signup' && <SignupForm onBack={() => setMode('choose')} onLogin={() => setMode('login')} />}

        <p className="text-center text-xs text-ink-faint mt-6">
          Trouble signing in? Ask your teacher to reset your password.
        </p>
      </div>
    </main>
  );
}

// --- Sign in ---------------------------------------------------------------

function LoginForm({ onBack, onSignup }: { onBack: () => void; onSignup: () => void }) {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const user = await login(username, password);
      if (user.mustChangePassword) navigate('/change-password');
      else navigate(user.role === 'ADMIN' ? '/admin' : '/dashboard');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card p-6 space-y-4">
      <h2 className="text-sm font-semibold">Sign in</h2>

      {error && <Alert tone="error">{error}</Alert>}

      <Field label="Username" hint="Your first name and last name joined together, for example rahulsharma.">
        <input
          className="input"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoFocus
          required
        />
      </Field>

      <Field label="Password">
        <input
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </Field>

      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? <Spinner label="Signing in" /> : 'Sign in'}
      </button>

      <div className="flex items-center justify-between text-xs">
        <button type="button" className="text-ink-muted hover:text-ink" onClick={onBack}>
          ← Back
        </button>
        <button type="button" className="text-series-1 hover:underline" onClick={onSignup}>
          Create an account
        </button>
      </div>
    </form>
  );
}

// --- Sign up ---------------------------------------------------------------

interface PasswordCheck {
  ok: boolean;
  errors: string[];
  score: 'weak' | 'fair' | 'good' | 'strong';
}

function SignupForm({ onBack, onLogin }: { onBack: () => void; onLogin: () => void }) {
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const [form, setForm] = useState({
    firstName: '', lastName: '', grade: '', division: '', rollNo: '', dateOfBirth: '', password: '', confirm: '',
  });
  const [classes, setClasses] = useState<{ grades: ClassOption[]; divisions: ClassOption[] }>({ grades: [], divisions: [] });
  const [check, setCheck] = useState<PasswordCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ grades: ClassOption[]; divisions: ClassOption[] }>('/api/auth/classes')
      .then(setClasses)
      .catch(() => setError('Could not load the class list. Please refresh the page.'));
  }, []);

  // Live password feedback, debounced so it does not fire on every keystroke.
  useEffect(() => {
    if (!form.password) {
      setCheck(null);
      return;
    }
    const timer = setTimeout(() => {
      api.post<PasswordCheck>('/api/auth/check-password', { password: form.password }).then(setCheck).catch(() => undefined);
    }, 250);
    return () => clearTimeout(timer);
  }, [form.password]);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    if (form.password !== form.confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      const res = await api.post<{ user: Me; message: string }>('/api/auth/signup', {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        grade: form.grade,
        division: form.division,
        rollNo: form.rollNo.trim(),
        dateOfBirth: form.dateOfBirth,
        password: form.password,
      });
      setUser(res.user);
      navigate('/dashboard', { state: { welcome: res.message } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create your account.');
    } finally {
      setBusy(false);
    }
  };

  const strengthWidth = { weak: '25%', fair: '50%', good: '75%', strong: '100%' }[check?.score ?? 'weak'];
  const strengthColor =
    check?.score === 'strong' || check?.score === 'good' ? '#1a7f4b' : check?.score === 'fair' ? '#b06a00' : '#c0392b';

  return (
    <form onSubmit={submit} className="card p-6 space-y-4">
      <h2 className="text-sm font-semibold">Create an account</h2>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="grid grid-cols-2 gap-3">
        <Field label="First name" required>
          <input className="input" value={form.firstName} onChange={set('firstName')} required autoFocus />
        </Field>
        <Field label="Last name" required>
          <input className="input" value={form.lastName} onChange={set('lastName')} required />
        </Field>
      </div>

      {form.firstName && form.lastName && (
        <p className="text-[11px] text-ink-faint -mt-1">
          Your username will be{' '}
          <span className="font-mono text-ink">
            {`${form.firstName}${form.lastName}`.toLowerCase().replace(/[^a-z0-9]/g, '')}
          </span>
          {' '}(a number is added if someone already has it).
        </p>
      )}

      <div className="grid grid-cols-3 gap-3">
        <Field label="Grade" required>
          <select className="input" value={form.grade} onChange={set('grade')} required>
            <option value="">—</option>
            {classes.grades.map((g) => (
              <option key={g.code} value={g.code}>{g.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Division" required>
          <select className="input" value={form.division} onChange={set('division')} required>
            <option value="">—</option>
            {classes.divisions.map((d) => (
              <option key={d.code} value={d.code}>{d.label}</option>
            ))}
          </select>
        </Field>
        <Field label="Roll no." required>
          <input className="input" value={form.rollNo} onChange={set('rollNo')} required inputMode="numeric" />
        </Field>
      </div>

      <Field label="Date of birth" required>
        <input className="input" type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} required max={new Date().toISOString().slice(0, 10)} />
      </Field>

      <Field label="Password" required hint="At least 8 characters, including a letter and a number.">
        <input className="input" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" required />
      </Field>

      {check && (
        <div className="-mt-2">
          <div className="h-1 rounded-full bg-line overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: strengthWidth, background: strengthColor }} />
          </div>
          {check.errors.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {check.errors.map((e) => (
                <li key={e} className="text-[11px] text-bad">{e}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Field
        label="Confirm password"
        required
        error={form.confirm && form.password !== form.confirm ? 'The two passwords do not match.' : null}
      >
        <input className="input" type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required />
      </Field>

      <button type="submit" className="btn-primary w-full" disabled={busy || (check ? !check.ok : false)}>
        {busy ? <Spinner label="Creating account" /> : 'Create account'}
      </button>

      <div className="flex items-center justify-between text-xs">
        <button type="button" className="text-ink-muted hover:text-ink" onClick={onBack}>
          ← Back
        </button>
        <button type="button" className="text-series-1 hover:underline" onClick={onLogin}>
          I already have an account
        </button>
      </div>
    </form>
  );
}
