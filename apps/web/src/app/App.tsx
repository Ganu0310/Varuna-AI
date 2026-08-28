import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { SocketProvider } from './providers/SocketProvider.tsx';
import { setUnauthorisedHandler } from '../api/client.ts';
import { useMe } from '../api/hooks.ts';
import { LoginPage } from '../features/auth/LoginPage.tsx';
import { RegisterPage } from '../features/auth/RegisterPage.tsx';
import { InvestigationListPage } from '../features/investigations/InvestigationListPage.tsx';
import { CreateInvestigationPage } from '../features/investigations/CreateInvestigationPage.tsx';
import { CataloguePage } from '../features/catalogue/CataloguePage.tsx';
import { WorkspacePage } from '../features/investigations/WorkspacePage.tsx';
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
                    <WorkspacePage />
                  </AppChrome>
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
