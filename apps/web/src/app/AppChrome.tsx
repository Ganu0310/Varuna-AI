import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { useLogout, useMe } from '../api/hooks.ts';
import { useSocket } from './providers/SocketProvider.tsx';
import { VarunaMark } from '../components/VarunaMark.tsx';
import { NavIcon, type NavIconName } from '../components/NavIcon.tsx';
import { useTheme } from '../lib/theme.ts';

/**
 * The application shell — 04_UIUX §4.4.1.
 *
 * A left rail rather than a top bar. The nav grew to eight destinations and a horizontal
 * strip stopped being able to hold them without truncating; a rail also leaves the full width
 * for the map, which is the only view that genuinely needs it.
 *
 * Two pieces of state live here rather than in a page, because both must survive navigation:
 *
 *  - the collapse toggle, so the rail stays narrow while someone works across screens;
 *  - the THEME, because the workspace is read in daylight on a projector and in a dark room,
 *    and the tokens already define both palettes.
 *
 * Both persist to localStorage, and both fall back silently: a browser that refuses storage
 * gets the defaults rather than an error.
 */

interface CapabilitySummary {
  overall: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'OPTIONAL';
}

const NAV: ReadonlyArray<{ to: string; label: string; icon: NavIconName; end?: boolean }> = [
  { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  // `end` matters here: without it every `/investigations/:id` route also marks the list
  // active, so the rail claims you are in two places at once.
  { to: '/investigations', label: 'Investigations', icon: 'investigations', end: true },
  { to: '/catalogue', label: 'Satellite Browser', icon: 'satellite' },
  { to: '/discover', label: 'Discover', icon: 'discover' },
  { to: '/globe', label: 'Live Globe', icon: 'globe' },
  { to: '/system', label: 'System Status', icon: 'status' },
  { to: '/guide', label: 'Guide', icon: 'guide' },
];

const RAIL_KEY = 'varuna.rail.collapsed';

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Private windows and blocked site data throw on access, not just on write.
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* a remembered preference is a convenience, never a requirement */
  }
}

export function AppChrome({ children }: { children: ReactNode }) {
  const { data } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const { stale } = useSocket();

  const [collapsed, setCollapsed] = useState(() => readStored(RAIL_KEY) === '1');
  const { theme, toggle: toggleTheme } = useTheme();

  useEffect(() => {
    writeStored(RAIL_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  // The rail's status pill. Polled rather than pushed: it reflects configuration and recorded
  // provider health, which change on a restart, not on a socket event.
  const capabilities = useQuery({
    queryKey: ['system', 'capabilities'],
    queryFn: () => api.get<CapabilitySummary>('/system/capabilities'),
    refetchInterval: 60_000,
    retry: false,
  });

  const signOut = useCallback(() => {
    logout.mutate(undefined, { onSuccess: () => navigate('/login', { replace: true }) });
  }, [logout, navigate]);

  const overall = capabilities.data?.overall;

  return (
    <div className={`app-shell ${collapsed ? 'rail-collapsed' : ''}`}>
      <aside className="rail" aria-label="Primary">
        <div className="rail-head">
          <Link className="rail-brand" to="/dashboard">
            <VarunaMark size={28} title="" />
            <span className="rail-wordmark">VARUNA</span>
          </Link>
          <button
            className="rail-toggle"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            {collapsed ? '›' : '‹'}
          </button>
        </div>

        <nav className="rail-nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} title={n.label} end={n.end} aria-label={n.label}>
              <span className="rail-icon">
                <NavIcon name={n.icon} />
              </span>
              <span className="rail-label">{n.label}</span>
            </NavLink>
          ))}
          {/* Admin only. The routes are guarded server-side regardless — hiding the link just
              avoids offering a door that answers 403. */}
          {data?.permissions.role === 'admin' ? (
            <NavLink to="/admin" title="Administration" aria-label="Administration">
              <span className="rail-icon">
                <NavIcon name="admin" />
              </span>
              <span className="rail-label">Administration</span>
            </NavLink>
          ) : null}
        </nav>

        {/*
          The rail foot states the WEAKEST capability, not an aggregate "healthy". This system
          spends most of its life partially degraded, and a green light that averages a working
          satellite chain with an unavailable one would be the single most misleading pixel on
          the screen.
        */}
        <Link
          className={`rail-status status-${(overall ?? 'UNKNOWN').toLowerCase()}`}
          to="/system"
          title={`System status: ${overall ?? 'checking'} — the weakest capability in the chain`}
        >
          <span className="rail-status-dot" aria-hidden="true" />
          <span className="rail-status-text">
            {overall ?? (capabilities.isError ? 'UNREACHABLE' : '…')}
          </span>
        </Link>
      </aside>

      <div className="shell-main">
        <header className="top-bar">
          <div className="top-right">
            {/* A dropped socket is surfaced, not hidden — the view may be behind (08 §8.7). */}
            <span
              className={`token ${stale ? 'token-warn' : 'token-live'}`}
              title={stale ? 'Live updates disconnected' : 'Live updates connected'}
            >
              {stale ? 'STALE' : 'LIVE'}
            </span>
            <button
              className="btn-ghost icon-btn"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              {theme === 'dark' ? '☼' : '☾'}
            </button>
            {data ? (
              <>
                <span className="mono muted">{data.user.email}</span>
                <span className="token">{data.user.role.toUpperCase()}</span>
                <button className="btn-ghost" onClick={signOut}>
                  Sign out
                </button>
              </>
            ) : null}
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
