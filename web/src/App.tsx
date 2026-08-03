import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { useActivityGate } from './lib/activityGate';
import { PageLoader } from './components/ui';
import Landing from './pages/Landing';
import StudentDashboard from './pages/StudentDashboard';
import TakeTest from './pages/TakeTest';
import ResultView from './pages/ResultView';
import ChangePassword from './pages/ChangePassword';
import ActivityRunner from './pages/ActivityRunner';
import AppShell from './pages/AppShell';

// The admin bundle is only ever loaded for an admin, keeping the student's
// first paint small - which matters on a school Wi-Fi connection.
const AdminShell = lazy(() => import('./pages/admin/AdminShell'));

function RequireAuth({ children, adminOnly = false }: { children: React.ReactNode; adminOnly?: boolean }) {
  const { user, loading } = useAuth();
  const { next, loading: gateLoading } = useActivityGate();
  const location = useLocation();

  if (loading) return <PageLoader label="Signing you in" />;
  if (!user) return <Navigate to="/" replace state={{ from: location.pathname }} />;

  // A forced password change blocks everything else, including activities.
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  if (adminOnly && user.role !== 'ADMIN') return <Navigate to="/dashboard" replace />;

  // Then any activity the admin has set. The server refuses every student
  // route while one is outstanding; this sends them to it rather than showing
  // them an error they cannot act on.
  //
  // Waiting for the answer before rendering matters: without it the dashboard
  // mounts, fires a request the server is bound to refuse, and shows an error
  // for a moment before the redirect lands.
  //
  // A paper already open is left alone, exactly as the server leaves it alone:
  // an activity published mid-test must not throw the class out of it, and a
  // refresh during the exam must not either.
  if (user.role === 'STUDENT' && gateLoading) return <PageLoader label="Checking for activities" />;
  const inExam = location.pathname.startsWith('/attempt/');
  if (next && !inExam && !location.pathname.startsWith('/activity/')) {
    return <Navigate to={`/activity/${next.id}`} replace />;
  }

  return <>{children}</>;
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route
        path="/"
        element={
          loading ? (
            <PageLoader />
          ) : user ? (
            <Navigate to={user.role === 'ADMIN' ? '/admin' : '/dashboard'} replace />
          ) : (
            <Landing />
          )
        }
      />

      <Route
        path="/change-password"
        element={
          <RequireAuth>
            <ChangePassword />
          </RequireAuth>
        }
      />

      {/* Also outside the shell: while a required activity is open there is
          nowhere else to navigate to. */}
      <Route
        path="/activity/:activityId"
        element={
          <RequireAuth>
            <ActivityRunner />
          </RequireAuth>
        }
      />

      {/* The test runner sits outside the shell: no navigation while a paper is open. */}
      <Route
        path="/attempt/:attemptId"
        element={
          <RequireAuth>
            <TakeTest />
          </RequireAuth>
        }
      />

      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<StudentDashboard />} />
        <Route path="/result/:attemptId" element={<ResultView />} />
      </Route>

      <Route
        path="/admin/*"
        element={
          <RequireAuth adminOnly>
            <Suspense fallback={<PageLoader label="Loading admin" />}>
              <AdminShell />
            </Suspense>
          </RequireAuth>
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
