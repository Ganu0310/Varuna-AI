/**
 * Typed token mirror for deck.gl / Three.js, which cannot read CSS custom properties.
 * MUST stay in sync with tokens.css — a CI check asserts this (04_UIUX §4.13,
 * scripts/tokens-sync-check.ts).
 */
export const color = {
  surface0: '#05080d',
  surface1: '#0a0f16',
  surface2: '#101823',
  surface3: '#17212e',
  surface4: '#1f2c3c',
  surfaceInset: '#04070b',

  borderSubtle: '#1a2431',
  borderDefault: '#243243',
  borderStrong: '#34465c',
  borderFocus: '#45e0e6',

  inkPrimary: '#e8eff7',
  inkSecondary: '#9fb2c6',
  inkTertiary: '#6b7f94',

  accent400: '#45e0e6',
  accent500: '#22c9d1',
  accent700: '#0c7a84',

  oil400: '#ffc163',
  oil500: '#f0a73c',
  oil600: '#c9821f',

  origin100: '#2a1d46',
  origin300: '#5b3fa0',
  origin500: '#8b63e8',
  origin700: '#b99bff',

  statusOk: '#3ed598',
  statusWarn: '#f5b944',
  statusDanger: '#f2564b',

  tierStrong: '#f2564b',
  tierModerate: '#f0a73c',
  tierWeak: '#4fa3d1',
  tierInsufficient: '#6b7f94',

  track: ['#45e0e6', '#ffb454', '#7fd97f', '#e389d8', '#7ea6ff', '#f2a0a0', '#c9b458', '#9fb2c6'],
} as const;

/** deck.gl wants RGBA [0-255]. */
export function rgba(hex: string, alpha = 255): [number, number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    alpha,
  ];
}
