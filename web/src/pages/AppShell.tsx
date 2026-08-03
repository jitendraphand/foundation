import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export default function AppShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-full flex flex-col">
      <header className="sticky top-0 z-30 bg-surface/90 backdrop-blur border-b border-line">
        <div className="mx-auto max-w-6xl px-4 h-14 flex items-center justify-between gap-4">
          <Link to="/dashboard" className="tap-link flex items-center gap-2 shrink-0">
            <span className="w-7 h-7 rounded-lg bg-series-1 text-white text-sm font-semibold grid place-items-center">F</span>
            <span className="font-semibold text-sm">Foundation</span>
          </Link>

          <nav className="flex items-center gap-1 text-sm">
            <NavLink
              to="/dashboard"
              className={({ isActive }) =>
                `tap-link px-3 py-1.5 rounded-lg ${isActive ? 'bg-surface-sunken text-ink font-medium' : 'text-ink-muted hover:text-ink'}`
              }
            >
              Dashboard
            </NavLink>
            {user?.role === 'ADMIN' && (
              <NavLink to="/admin" className="tap-link px-3 py-1.5 rounded-lg text-ink-muted hover:text-ink">
                Admin
              </NavLink>
            )}
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <span className="hidden sm:block text-xs text-ink-muted">
              {user?.firstName} {user?.lastName}
              <span className="text-ink-faint"> · {user?.username}</span>
            </span>
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={async () => {
                await logout();
                navigate('/');
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-6xl px-4 py-6">
        <Outlet />
      </main>

      <footer className="border-t border-line py-4">
        <div className="mx-auto max-w-6xl px-4 text-xs text-ink-faint flex items-center justify-between gap-4">
          <span>Foundation Exam System</span>
          <Link to="/change-password" className="tap-link hover:text-ink-muted">Change password</Link>
        </div>
      </footer>
    </div>
  );
}
