import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { PageLoader } from './components/ui';
import Landing from './pages/Landing';
import StudentDashboard from './pages/StudentDashboard';
import TakeTest from './pages/TakeTest';
import ResultView from './pages/ResultView';
import ChangePassword from './pages/ChangePassword';
import AppShell from './pages/AppShell';

// The admin bundle is only ever loaded for an admin, keeping the student's
// first paint small - which matters on a school Wi-Fi connection.
const AdminShell = lazy(() => import('./pages/admin/AdminShell'));

function RequireAuth({ children, adminOnly = false }: { children: React.ReactNode; adminOnly?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <PageLoader label="Signing you in" />;
  if (!user) return <Navigate to="/" replace state={{ from: location.pathname }} />;

  // A forced password change blocks everything else.
  if (user.mustChangePassword && location.pathname !== '/change-password') {
    return <Navigate to="/change-password" replace />;
  }
  if (adminOnly && user.role !== 'ADMIN') return <Navigate to="/dashboard" replace />;

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
