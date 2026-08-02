import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import AdminOverview from './AdminOverview';
import AdminGenerate from './AdminGenerate';
import AdminQuestions from './AdminQuestions';
import AdminTests from './AdminTests';
import AdminTestBuilder from './AdminTestBuilder';
import AdminStudents from './AdminStudents';
import AdminStudentDetail from './AdminStudentDetail';
import AdminSettings from './AdminSettings';
import AdminBackups from './AdminBackups';

const NAV = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/generate', label: 'Set test' },
  { to: '/admin/questions', label: 'Question bank' },
  { to: '/admin/tests', label: 'Tests' },
  { to: '/admin/students', label: 'Students' },
  { to: '/admin/backups', label: 'Backups' },
  { to: '/admin/settings', label: 'Settings' },
];

export default function AdminShell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <div className="min-h-full flex flex-col">
      <header className="sticky top-0 z-30 bg-surface/90 backdrop-blur border-b border-line">
        <div className="mx-auto max-w-7xl px-4 h-14 flex items-center justify-between gap-4">
          <Link to="/admin" className="flex items-center gap-2 shrink-0">
            <span className="w-7 h-7 rounded-lg bg-series-1 text-white text-sm font-semibold grid place-items-center">F</span>
            <span className="font-semibold text-sm">Foundation</span>
            <span className="badge">Admin</span>
          </Link>

          <div className="flex items-center gap-3 shrink-0">
            <span className="hidden sm:block text-xs text-ink-muted">{user?.username}</span>
            <Link to="/dashboard" className="btn-ghost btn-sm hidden sm:inline-flex">Student view</Link>
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

        <nav className="mx-auto max-w-7xl px-4 flex gap-1 overflow-x-auto">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `px-3 py-2 text-sm whitespace-nowrap border-b-2 -mb-px ${
                  isActive ? 'border-series-1 text-ink font-medium' : 'border-transparent text-ink-muted hover:text-ink'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-6">
        <Routes>
          <Route index element={<AdminOverview />} />
          <Route path="generate" element={<AdminGenerate />} />
          <Route path="questions" element={<AdminQuestions />} />
          <Route path="tests" element={<AdminTests />} />
          <Route path="tests/:testId" element={<AdminTestBuilder />} />
          <Route path="students" element={<AdminStudents />} />
          <Route path="students/:studentId" element={<AdminStudentDetail />} />
          <Route path="backups" element={<AdminBackups />} />
          <Route path="settings" element={<AdminSettings />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </main>
    </div>
  );
}
