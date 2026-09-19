import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useLogout, useMe, useSystemStatus } from '../api/hooks.ts';
import { useSocket } from './providers/SocketProvider.tsx';
import { VarunaMark } from '../components/VarunaMark.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';

/**
 * Application shell — collapsible left rail + context top bar (04_UIUX §4.4).
 * The rail is always meaningful: every primary surface is reachable before an
 * investigation exists.
 */

type IconProps = { d: string };
const Icon = ({ d }: IconProps) => (
  <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" className="nav-icon">
    <path
      d={d}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const ICONS = {
  dashboard: 'M3 3h6v7H3zM11 3h6v4h-6zM11 10h6v7h-6zM3 13h6v4H3z',
  investigations: 'M4 4h9l3 3v9H4zM8 4v3h5M6 11h8M6 14h6',
  satellite: 'M10 3v3M10 14v3M3 10h3M14 10h3M10 7a3 3 0 100 6 3 3 0 000-6z',
  // A stack of layers — an archive to search, distinct from the live browser's dish.
  catalogue: 'M10 3l7 4-7 4-7-4 7-4zM3 11l7 4 7-4M3 15l7 4 7-4',
  vessels: 'M3 12l2-5h10l2 5M4 12h12l-1 4H5zM10 3v4',
  globe: 'M10 3a7 7 0 100 14 7 7 0 000-14zM3 10h14M10 3c2.5 2 2.5 12 0 14M10 3c-2.5 2-2.5 12 0 14',
  // A magnifying glass over a marked region — browsing the sweep's watch regions.
  discover: 'M9 4a5 5 0 100 10 5 5 0 000-10zM13 13l4 4',
  reports: 'M5 3h7l3 3v11H5zM9 3v4h6M8 11h4M8 14h4',
  status: 'M3 10h3l2-5 3 10 2-5h4',
  settings:
    'M10 7a3 3 0 100 6 3 3 0 000-6zM10 2v2M10 16v2M4 4l1.5 1.5M14.5 14.5L16 16M2 10h2M16 10h2M4 16l1.5-1.5M14.5 5.5L16 4',
  guide: 'M10 4a3 3 0 013 3c0 2-3 2.5-3 4.5M10 15v.5M5 5a7 7 0 1010 0',
  admin: 'M10 3l6 2v4c0 4-3 7-6 8-3-1-6-4-6-8V5z',
};

interface NavEntry {
  to: string;
  label: string;
  icon: keyof typeof ICONS;
  end?: boolean;
  adminOnly?: boolean;
}
const NAV: NavEntry[] = [
  { to: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
  { to: '/investigations', label: 'Investigations', icon: 'investigations', end: true },
  { to: '/catalogue', label: 'Catalogue', icon: 'catalogue' },
  { to: '/browser', label: 'Satellite Browser', icon: 'satellite' },
  { to: '/discover', label: 'Discover', icon: 'discover' },
  { to: '/vessels', label: 'Vessels', icon: 'vessels' },
  { to: '/globe', label: 'Live Globe', icon: 'globe' },
  { to: '/status', label: 'System Status', icon: 'status' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
  { to: '/guide', label: 'Guide', icon: 'guide' },
  { to: '/admin', label: 'Administration', icon: 'admin', adminOnly: true },
];

const RAIL_KEY = 'varuna.rail.collapsed';

export function AppChrome({ children }: { children: ReactNode }) {
  const { data } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const { stale } = useSocket();
  const status = useSystemStatus();

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0');
    } catch {
      /* a remembered preference is a convenience, never a requirement */
    }
  }, [collapsed]);

  const overall = status.data?.overall ?? null;
  const health =
    overall === 'AVAILABLE'
      ? 'status-ok'
      : overall === 'DEGRADED'
        ? 'status-warn'
        : overall === 'UNAVAILABLE'
          ? 'status-danger'
          : 'status-ok';

  return (
    <div className={`app-shell${collapsed ? ' app-shell--collapsed' : ''}`}>
      <aside className="app-rail" aria-label="Primary">
        <div className="rail-top">
          <Link className="rail-wordmark" to="/dashboard" title="VARUNA">
            <VarunaMark size={24} title="" />
            <span className="rail-name">VARUNA</span>
          </Link>
          <button
            className="rail-collapse"
            type="button"
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-pressed={collapsed}
            onClick={() => setCollapsed((c) => !c)}
          >
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
              <path
                d={collapsed ? 'M7 4l6 6-6 6' : 'M13 4l-6 6 6 6'}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <nav className="rail-nav">
          {NAV.filter((n) => !n.adminOnly || data?.permissions.role === 'admin').map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => `rail-item${isActive ? ' rail-item--active' : ''}`}
              title={n.label}
            >
              <Icon d={ICONS[n.icon]} />
              <span className="rail-label">{n.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="rail-foot">
          <span className={`rail-health token ${health}`} title="System status">
            <span className="rail-health-dot" />
            <span className="rail-label">{overall ? overall.toUpperCase() : 'CHECKING…'}</span>
          </span>
        </div>
      </aside>

      <div className="app-main">
        <header className="app-topbar">
          <div className="topbar-left" />
          <div className="topbar-right">
            {stale ? (
              <span className="token token-warn" title="Live updates disconnected">
                LIVE OFFLINE
              </span>
            ) : (
              <span className="token status-ok" title="Live updates connected">
                LIVE
              </span>
            )}
            <ThemeToggle />
            {data ? (
              <>
                <span className="topbar-user">
                  <span className="topbar-email mono">{data.user.email}</span>
                  <span className="token">{data.user.role.toUpperCase()}</span>
                </span>
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
        <div className="app-content">{children}</div>
      </div>
    </div>
  );
}
