import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import { SocketProvider } from './providers/SocketProvider.tsx';
import { setUnauthorisedHandler } from '../api/client.ts';
import { useMe } from '../api/hooks.ts';
import { LoginPage } from '../features/auth/LoginPage.tsx';
import { RegisterPage } from '../features/auth/RegisterPage.tsx';
import { InvestigationListPage } from '../features/investigations/InvestigationListPage.tsx';
import { CreateInvestigationPage } from '../features/investigations/CreateInvestigationPage.tsx';
import { CataloguePage } from '../features/catalogue/CataloguePage.tsx';
import { GuidePage } from '../features/guide/GuidePage.tsx';
import { AdminPage } from '../features/admin/AdminPage.tsx';
// MapLibre and deck.gl are ~1 MB of the bundle and are only needed inside a workspace.
// Splitting them out keeps the login and list routes small (05_FRONTEND §5.9 budgets).
const ReportPage = lazy(() =>
  import('../features/reports/ReportPage.tsx').then((m) => ({ default: m.ReportPage })),
);
// Lazy like the workspace: the prism pulls deck.gl, which must not load on the login route.
const PrismPage = lazy(() =>
  import('../features/prism/PrismPage.tsx').then((m) => ({ default: m.PrismPage })),
);
const GlobePage = lazy(() =>
  import('../features/globe/GlobePage.tsx').then((m) => ({ default: m.GlobePage })),
);
const ReliefPage = lazy(() =>
  import('../features/relief/ReliefPage.tsx').then((m) => ({ default: m.ReliefPage })),
);
const WorkspacePage = lazy(() =>
  import('../features/investigations/WorkspacePage.tsx').then((m) => ({
    default: m.WorkspacePage,
  })),
);
import { AppChrome } from './AppChrome.tsx';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 30_000 },
  },
});

/**
 * Auth gate. On 401 the client wrapper calls the unauthorised handler, which sends the user
 * to /login while preserving where they were, so re-login returns them there
 * (08_APP_FLOW §8.7).
 */
function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isLoading, isError } = useMe();
  const navigate = useNavigate();

  useEffect(() => {
    setUnauthorisedHandler(() => {
      const from = `${window.location.pathname}${window.location.search}`;
      navigate(`/login?from=${encodeURIComponent(from)}`, { replace: true });
    });
  }, [navigate]);

  if (isLoading) return <main className="page">Loading…</main>;
  if (isError || !data) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SocketProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route
              path="/investigations"
              element={
                <RequireAuth>
                  <AppChrome>
                    <InvestigationListPage />
                  </AppChrome>
                </RequireAuth>
              }
            />
            <Route
              path="/investigations/new"
              element={
                <RequireAuth>
                  <AppChrome>
                    <CreateInvestigationPage />
                  </AppChrome>
                </RequireAuth>
              }
            />
            <Route
              path="/admin"
              element={
                <RequireAuth>
                  <AppChrome>
                    <AdminPage />
                  </AppChrome>
                </RequireAuth>
              }
            />
            <Route
              path="/catalogue"
              element={
                <RequireAuth>
                  <AppChrome>
                    <CataloguePage />
                  </AppChrome>
                </RequireAuth>
              }
            />
            <Route
              path="/investigations/:id"
              element={
                <RequireAuth>
                  <AppChrome>
                    <Suspense
                      fallback={
                        <main className="page">
                          <p className="muted">Loading workspace…</p>
                        </main>
                      }
                    >
                      <WorkspacePage />
                    </Suspense>
                  </AppChrome>
                </RequireAuth>
              }
            />
            <Route
              path="/guide"
              element={
                <RequireAuth>
                  <AppChrome>
                    <GuidePage />
                  </AppChrome>
                </RequireAuth>
              }
            />
            <Route
              path="/globe"
              element={
                <RequireAuth>
                  <Suspense fallback={<main className="page">Loading globe…</main>}>
                    <GlobePage />
                  </Suspense>
                </RequireAuth>
              }
            />
            <Route
              path="/investigations/:id/relief"
              element={
                <RequireAuth>
                  <Suspense fallback={<main className="page">Loading relief…</main>}>
                    <ReliefPage />
                  </Suspense>
                </RequireAuth>
              }
            />
            <Route
              path="/investigations/:id/prism"
              element={
                <RequireAuth>
                  <Suspense fallback={<main className="page">Loading prism…</main>}>
                    <PrismPage />
                  </Suspense>
                </RequireAuth>
              }
            />
            {/* The report renders standalone: no app chrome, so the printed page is only
                the dossier. */}
            <Route
              path="/investigations/:id/report"
              element={
                <RequireAuth>
                  <Suspense fallback={<main className="page">Preparing dossier…</main>}>
                    <ReportPage />
                  </Suspense>
                </RequireAuth>
              }
            />
            <Route path="/" element={<Navigate to="/investigations" replace />} />
            <Route
              path="*"
              element={
                <main className="page">
                  <h1>Not found</h1>
                  <p className="muted">No such page.</p>
                </main>
              }
            />
          </Routes>
        </SocketProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
