import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Field, Modal, Spinner } from '../components/ui';
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
        <header className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-series-1 text-white font-semibold text-2xl mb-4 shadow-pop">
            F
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Foundation</h1>
          <p className="text-sm text-ink-muted mt-1.5">Online examinations</p>
        </header>

        {/* Why they are back here, when they did not ask to be. */}
        {endedReason && (
          <div className="mb-4">
            <Alert tone="warn" onDismiss={clearEndedReason}>{endedReason}</Alert>
          </div>
        )}

        {mode === 'choose' && (
          <div className="card p-6 sm:p-8 space-y-3">
            <button type="button" className="btn-primary w-full py-3 text-base" onClick={() => setMode('login')}>
              Sign in
            </button>
            <button type="button" className="btn-secondary w-full py-3 text-base" onClick={() => setMode('signup')}>
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
  const [resetting, setResetting] = useState(false);

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
      <button type="button" className="text-xs text-ink-muted hover:text-ink w-full text-center" onClick={() => setResetting(true)}>
        Forgot password?
      </button>

      {resetting && <ForgotPasswordModal onClose={() => setResetting(false)} />}
    </form>
  );
}

// --- Forgot password (WhatsApp / email reset) --------------------------------

/**
 * Self-service reset: a student proves who they are with username, birthday
 * and roll number; staff with username alone. The new password is never shown
 * here — it travels by WhatsApp to the registered mobile, or by email to the
 * registered address, whichever channel the student picks among the ones the
 * school configured.
 */
function ForgotPasswordModal({ onClose }: { onClose: () => void }) {
  const [role, setRole] = useState<'STUDENT' | 'STAFF'>('STUDENT');
  const [username, setUsername] = useState('');
  const [dob, setDob] = useState('');
  const [rollNo, setRollNo] = useState('');
  const [channel, setChannel] = useState<'whatsapp' | 'email'>('whatsapp');
  const [channels, setChannels] = useState<{ whatsapp: boolean; email: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Which delivery legs the school actually configured, so the choice offered
  // here never promises a channel that cannot deliver.
  useEffect(() => {
    api
      .get<{ offered: boolean; channelConfigured: boolean; channels?: { whatsapp: boolean; email: boolean } }>('/api/reset/availability')
      .then((res) => {
        const c = res.channels ?? { whatsapp: res.channelConfigured, email: false };
        setChannels(c);
        if (!c.whatsapp && c.email) setChannel('email');
      })
      .catch(() => undefined);
  }, []);

  const bothOffered = !channels || (channels.whatsapp && channels.email);
  const channelLabel = channel === 'email' ? 'email' : 'WhatsApp';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ message: string }>('/api/reset/request', {
        username: username.trim(),
        role,
        channel,
        ...(role === 'STUDENT' ? { dateOfBirth: dob, rollNo: rollNo.trim() } : {}),
      });
      setDone(res.message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Reset your password">
      {done ? (
        <div className="space-y-4">
          <Alert tone="success">{done}</Alert>
          <div className="flex justify-end">
            <button type="button" className="btn-primary btn-sm" onClick={onClose}>Done</button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && <Alert tone="error">{error}</Alert>}
          <Alert tone="info">
            A new password will be sent by {bothOffered ? 'WhatsApp or email' : channelLabel} to the{' '}
            {bothOffered ? 'mobile number or email address' : channel === 'email' ? 'email address' : 'mobile number'}{' '}
            registered for this account.
          </Alert>

          <Field label="I am a">
            <select className="input" value={role} onChange={(e) => setRole(e.target.value as 'STUDENT' | 'STAFF')}>
              <option value="STUDENT">Student</option>
              <option value="STAFF">Teacher / staff</option>
            </select>
          </Field>

          {bothOffered && (
            <Field label="Send the new password by">
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" checked={channel === 'whatsapp'} onChange={() => setChannel('whatsapp')} />
                  WhatsApp
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" checked={channel === 'email'} onChange={() => setChannel('email')} />
                  Email
                </label>
              </div>
            </Field>
          )}

          <Field label="Username" required>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none" required />
          </Field>

          {role === 'STUDENT' && (
            <>
              <Field label="Date of birth" required>
                <input className="input" type="date" value={dob} onChange={(e) => setDob(e.target.value)} required />
              </Field>
              <Field label="Roll number" required>
                <input className="input" value={rollNo} onChange={(e) => setRollNo(e.target.value)} required />
              </Field>
            </>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? <Spinner label="Sending" /> : `Send new password by ${channelLabel}`}
            </button>
          </div>
        </form>
      )}
    </Modal>
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
