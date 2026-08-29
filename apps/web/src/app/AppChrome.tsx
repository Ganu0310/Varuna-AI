import { Link, NavLink, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useLogout, useMe } from '../api/hooks.ts';
import { useSocket } from './providers/SocketProvider.tsx';

/** Top bar — 04_UIUX §4.4.1. Full workspace chrome (rail, panels) lands in Phase 10. */
export function AppChrome({ children }: { children: ReactNode }) {
  const { data } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const { stale } = useSocket();

  return (
    <div className="app-shell">
      <header className="top-bar">
        <Link className="wordmark" to="/investigations">
          VARUNA
        </Link>
        {/*
          NavLink, not Link. Every item looked identical whatever page you were on, so the
          chrome gave no answer to "where am I" — and with seven routes that is a question
          people ask constantly.
        */}
        <nav className="top-nav">
          <NavLink to="/investigations">Investigations</NavLink>
          <NavLink to="/catalogue">Catalogue</NavLink>
          <NavLink to="/globe">Globe</NavLink>
          <NavLink to="/guide">Guide</NavLink>
          {/* Shown only to admins. The route is guarded server-side regardless — this just
              avoids offering a link that leads to a 403. */}
          {data?.permissions.role === 'admin' ? (
            <NavLink to="/admin">Administration</NavLink>
          ) : null}
        </nav>
        <div className="top-right">
          {/* A dropped socket is surfaced, not hidden — the view may be behind (08 §8.7). */}
          {stale ? (
            <span className="token token-warn" title="Live updates disconnected">
              STALE
            </span>
          ) : null}
          {data ? (
            <>
              <span className="mono muted">{data.user.email}</span>
              <span className="token">{data.user.role.toUpperCase()}</span>
              <button
                className="btn-ghost"
                onClick={() =>
                  logout.mutate(undefined, {
                    onSuccess: () => navigate('/login', { replace: true }),
                  })
                }
              >
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </header>
      {children}
    </div>
  );
}
