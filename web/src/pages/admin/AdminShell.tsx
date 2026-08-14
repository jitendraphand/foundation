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
import AdminPeople from './AdminPeople';
import AdminActivities from './AdminActivities';
import AdminReports from './AdminReports';

/**
 * Nav entries carry the privilege they need. A user only sees what they can
 * actually use - the server refuses the rest independently, this just avoids
 * offering buttons that would only say no.
 */
const NAV: Array<{ to: string; label: string; end?: boolean; needs: string[] }> = [
  { to: '/admin', label: 'Overview', end: true, needs: ['analytics.view'] },
  { to: '/admin/generate', label: 'Set test', needs: ['questions.generate'] },
  { to: '/admin/questions', label: 'Question bank', needs: ['questions.review'] },
  { to: '/admin/tests', label: 'Tests', needs: ['tests.manage', 'results.release'] },
  { to: '/admin/activities', label: 'Activities', needs: ['activities.manage'] },
  { to: '/admin/students', label: 'Students', needs: ['users.manage', 'analytics.view'] },
  { to: '/admin/reports', label: 'Reports', needs: ['analytics.view'] },
  { to: '/admin/people', label: 'Administrators', needs: ['admins.manage'] },
  { to: '/admin/backups', label: 'Backups', needs: ['backups.manage'] },
  { to: '/admin/settings', label: 'Settings', needs: ['settings.manage'] },
];

export default function AdminShell() {
  const { user, logout, canAny } = useAuth();
  const navigate = useNavigate();

  const visible = NAV.filter((item) => canAny(...item.needs));
  // Land on the first area they can actually reach, which may not be Overview.
  const home = visible[0]?.to ?? '/admin/none';

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
            {/*
              The only route to it. An administrator signing in with the password
              from .env had nowhere to change it: the seed applies that password
              once, on the first boot of an empty database, and never looks at it
              again - so editing .env afterwards does nothing and this link is
              what actually replaces it.
            */}
            <Link to="/change-password" className="btn-ghost btn-sm">
              {/* Two words is too many beside Sign out on a phone. */}
              <span className="sm:hidden">Password</span>
              <span className="hidden sm:inline">Change password</span>
            </Link>
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
          {visible.map((item) => (
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
          <Route index element={<Guard needs={['analytics.view']} home={home}><AdminOverview /></Guard>} />
          <Route path="generate" element={<Guard needs={['questions.generate']} home={home}><AdminGenerate /></Guard>} />
          <Route path="questions" element={<Guard needs={['questions.review']} home={home}><AdminQuestions /></Guard>} />
          <Route path="tests" element={<Guard needs={['tests.manage', 'results.release']} home={home}><AdminTests /></Guard>} />
          <Route path="tests/:testId" element={<Guard needs={['tests.manage', 'results.release']} home={home}><AdminTestBuilder /></Guard>} />
          <Route path="activities" element={<Guard needs={['activities.manage']} home={home}><AdminActivities /></Guard>} />
          <Route path="students" element={<Guard needs={['users.manage', 'analytics.view']} home={home}><AdminStudents /></Guard>} />
          <Route path="students/:studentId" element={<Guard needs={['users.manage', 'analytics.view']} home={home}><AdminStudentDetail /></Guard>} />
          <Route path="reports" element={<Guard needs={['analytics.view']} home={home}><AdminReports /></Guard>} />
          <Route path="people" element={<Guard needs={['admins.manage']} home={home}><AdminPeople /></Guard>} />
          <Route path="backups" element={<Guard needs={['backups.manage']} home={home}><AdminBackups /></Guard>} />
          <Route path="settings" element={<Guard needs={['settings.manage']} home={home}><AdminSettings /></Guard>} />
          <Route path="none" element={<NoPrivileges />} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </main>
    </div>
  );
}

/** Sends a user to somewhere they can actually use, rather than a dead screen. */
function Guard({ needs, home, children }: { needs: string[]; home: string; children: React.ReactNode }) {
  const { canAny } = useAuth();
  if (!canAny(...needs)) return <Navigate to={home} replace />;
  return <>{children}</>;
}

function NoPrivileges() {
  return (
    <div className="max-w-md mx-auto text-center py-16">
      <h1 className="text-base font-semibold">No privileges assigned</h1>
      <p className="text-sm text-ink-muted mt-2">
        Your account can sign in but has not been given access to any part of the admin area yet. Ask an administrator
        to grant you the privileges you need.
      </p>
      <Link to="/dashboard" className="btn-secondary btn-sm mt-5 inline-flex">Go to the student view</Link>
    </div>
  );
}
