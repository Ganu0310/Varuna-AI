/**
 * The navigation icon set.
 *
 * These replaced Unicode glyphs (▦ ▤ ✦ ◍ ◈ ⚙). Those were never a real icon set: each one is
 * whatever the first font in the stack happens to draw, so they arrive at different optical
 * weights and different baselines, and several fall back to a box on Windows. The collapsed
 * rail — where the icon is the ONLY thing identifying a destination — is exactly where that
 * fails hardest.
 *
 * Drawn on one 24-unit grid at one stroke weight so they read as a family, and stroked in
 * `currentColor` so they inherit the rail's hover, active and theme colours without a second
 * set of rules.
 */

export type NavIconName =
  | 'dashboard'
  | 'investigations'
  | 'satellite'
  | 'globe'
  | 'discover'
  | 'status'
  | 'guide'
  | 'admin';

const PATHS: Record<NavIconName, JSX.Element> = {
  // Four panels — the dashboard's own tile layout.
  dashboard: (
    <>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
    </>
  ),
  // A case file.
  investigations: (
    <>
      <path d="M5 3.5h9l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 4 20V5a1.5 1.5 0 0 1 1-1.5Z" />
      <path d="M14 3.5V8a1 1 0 0 0 1 1h4" />
      <path d="M8 13h8M8 17h5" />
    </>
  ),
  // A satellite dish with its beam.
  satellite: (
    <>
      <path d="M4 20a9 9 0 0 1 9-9" />
      <path d="M4 20l6.5-6.5" />
      <circle cx="4" cy="20" r="1.6" />
      <path d="M14.5 3.5a7 7 0 0 1 6 6" />
      <path d="M14 8a3.5 3.5 0 0 1 2.5 2.5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.4 2.5 3.6 5.4 3.6 8.5S14.4 18 12 20.5C9.6 18 8.4 15.1 8.4 12S9.6 6 12 3.5Z" />
    </>
  ),
  // A magnifying glass over a marked region — browsing for something, not yet holding it.
  discover: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M15.3 15.3 20.5 20.5" />
      <path d="M8 10.5h5" />
    </>
  ),
  // A trace with a step in it — state that changes and is worth watching.
  status: (
    <>
      <path d="M3 12.5h4l2.5-6 4 12 2.5-6h5" />
    </>
  ),
  guide: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.7.3-1 .9-1 1.6v.4" />
      <path d="M12 17.2h.01" />
    </>
  ),
  admin: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.2 14.4a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.8-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7h-.2a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3h.1a1.6 1.6 0 0 0 1-1.5v-.2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
    </>
  ),
};

export function NavIcon({ name, size = 19 }: { name: NavIconName; size?: number }) {
  return (
    <svg
      className="nav-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative: every icon sits beside its own text label, and the label is what a screen
      // reader should read. Collapsed, the link still carries `title` and an accessible name.
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
