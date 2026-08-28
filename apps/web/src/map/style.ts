import type { StyleSpecification } from 'maplibre-gl';

/**
 * A minimal dark basemap defined inline — 03_ARCHITECTURE ADR, 02_TRD TR-7.
 *
 * No tile-provider token, no third-party request. That matters for two reasons beyond
 * convenience: the client must never hold a credential, and a demo must not fail because a
 * map vendor is unreachable. The ocean is a flat token colour and the data layers carry the
 * information — for a SAR analysis surface, a decorative basemap would compete with the
 * imagery rather than help read it.
 */
export const DARK_STYLE: StyleSpecification = {
  version: 8,
  name: 'VARUNA dark',
  glyphs: undefined,
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#05080d' },
    },
  ],
};
