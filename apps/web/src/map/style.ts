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
    /**
     * Natural Earth land, vendored and served from our own origin.
     *
     * No provider token and no third-party request (02_TRD TR-7), and the map still works
     * with the network down. Two resolutions because one cannot do both jobs: the 50 m
     * outline is a crude blob beside 10 m SAR imagery, and a coastline that disagrees with
     * the raster under it is worse than none.
     */
    'land-world': { type: 'geojson', data: '/basemap/land-50m.json' },
    'land-detail': { type: 'geojson', data: '/basemap/land-10m.json' },
    // Populated by MapRoot on every camera move — see `graticule.ts` for why the spacing
    // cannot be fixed at build time.
    graticule: { type: 'geojson', data: EMPTY },
  },
  layers: [
    {
      id: 'background',
      type: 'background',
      // Open water. Dark enough that a SAR raster and AIS tracks read over it, but not the
      // near-black it used to be, which made an ocean indistinguishable from a failed render.
      paint: { 'background-color': '#07131f' },
    },
    {
      id: 'land-world',
      type: 'fill',
      source: 'land-world',
      // Handed over to the 10 m layer where that exists, so the two never draw on top of one
      // another and disagree about where the coast is.
      maxzoom: 7,
      paint: { 'fill-color': '#0e1a24', 'fill-outline-color': '#243243' },
    },
    {
      id: 'land-detail',
      type: 'fill',
      source: 'land-detail',
      minzoom: 7,
      paint: { 'fill-color': '#0e1a24' },
    },
    {
      id: 'coastline',
      type: 'line',
      source: 'land-detail',
      minzoom: 7,
      paint: {
        'line-color': '#37506a',
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.6, 12, 1.4],
      },
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
