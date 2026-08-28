import type { StyleSpecification } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
/**
 * `glyphs` is OMITTED, not set to `undefined`. MapLibre validates the style on load and
 * rejects an explicit `undefined` with "glyphs: string expected, undefined found", which
 * aborts the whole style — the map then renders nothing at all. The key may simply be absent,
 * and it is safe to omit here because no layer below uses `text-field`; deck.gl draws its own
 * labels and does not need a glyph endpoint.
 */
export const DARK_STYLE: StyleSpecification = {
  version: 8,
  name: 'VARUNA dark',
  sources: {
    // Populated by MapRoot on every camera move — see `graticule.ts` for why the spacing
    // cannot be fixed at build time.
    graticule: { type: 'geojson', data: EMPTY },
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: { 'background-color': '#05080d' },
    },
    // A graticule, generated locally. Without it the ocean is an unbroken black rectangle
    // that reads as a failed render rather than as open water, and an analyst has no sense of
    // scale or orientation until a data layer happens to be in view.
    {
      id: 'graticule',
      type: 'line',
      source: 'graticule',
      paint: { 'line-color': '#1c2836', 'line-width': 1 },
    },
  ],
};
