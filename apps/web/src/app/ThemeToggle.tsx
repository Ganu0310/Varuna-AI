import { useEffect, useRef, useState } from 'react';
import { useTheme, type ThemePreference } from './providers/ThemeProvider.tsx';

const SUN = (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <circle cx="8" cy="8" r="3.1" fill="currentColor" />
    <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13" />
    </g>
  </svg>
);
const MOON = (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" fill="currentColor" />
  </svg>
);
const AUTO = (
  <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
    <rect
      x="1.5"
      y="2.5"
      width="13"
      height="9"
      rx="1"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
    />
    <path d="M6 14h4M8 11.5V14" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const OPTIONS: { value: ThemePreference; label: string; icon: JSX.Element }[] = [
  { value: 'light', label: 'Light', icon: SUN },
  { value: 'system', label: 'System', icon: AUTO },
  { value: 'dark', label: 'Dark', icon: MOON },
];

/** Compact theme menu for the top bar — one icon button, a small popover with three choices. */
export function ThemeToggle() {
  const { preference, resolved, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const current =
    preference === 'system'
      ? resolved === 'light'
        ? SUN
        : MOON
      : OPTIONS.find((o) => o.value === preference)!.icon;

  return (
    <div className="theme-menu" ref={ref}>
      <button
        type="button"
        className="theme-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Theme: ${preference}`}
        onClick={() => setOpen((o) => !o)}
      >
        {current}
      </button>
      {open ? (
        <div className="theme-menu-pop" role="menu">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              role="menuitemradio"
              aria-checked={preference === o.value}
              className={`theme-menu-item${preference === o.value ? ' is-active' : ''}`}
              onClick={() => {
                setPreference(o.value);
                setOpen(false);
              }}
            >
              <span className="theme-menu-ico">{o.icon}</span>
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
