import type { FeatureCollection } from 'geojson';

/**
 * A viewport-adaptive graticule, generated in the browser.
 *
 * Built locally rather than fetched so the map keeps its promise of making no third-party
 * request and needing no token (02_TRD TR-7).
 *
 * It is regenerated for the visible bounds on every camera move rather than produced once at
 * a fixed spacing. A fixed 1° grid is the obvious approach and it fails in the case that
 * matters: an investigation AOI is typically well under a degree across, so at working zoom
 * the viewport falls *between* gridlines and the ocean renders as an unbroken black
 * rectangle — indistinguishable from a failed render. Choosing the step from the visible span
 * keeps roughly the same number of lines on screen at every zoom.
 */

/**
 * Steps in degrees, coarse to fine, all round numbers so a gridline label reads cleanly.
 *
 * The ladder runs down to 0.0005° (~55 m) because zooming to a single vessel is a normal
 * thing to do here: at 0.01° across, a ladder stopping at 0.01 yields one line and the grid
 * effectively disappears just as the view gets tightest.
 */
const STEPS = [30, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001, 0.0005];

/**
 * The coarsest step that still puts at least `minLines` gridlines across `spanDeg`.
 *
 * Walking coarse→fine and taking the first step that produces ENOUGH lines is the direction
 * that matters. Testing instead for "at most N lines" is satisfied immediately by the
 * coarsest entry — 30° trivially yields under 8 lines across half a degree — and the grid
 * silently disappears at exactly the zoom an analyst works at.
 */
export function chooseStep(spanDeg: number, minLines = 4): number {
  for (const s of STEPS) {
    if (spanDeg / s >= minLines) return s;
  }
  return STEPS[STEPS.length - 1]!;
}

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Meridians and parallels covering `bounds`, at `step` degrees.
 *
 * Lines are extended one step beyond the viewport so they do not visibly pop in at the edge
 * while panning.
 */
export function graticuleFor(bounds: Bounds, step: number): FeatureCollection {
  const features: FeatureCollection['features'] = [];

  const west = Math.floor(bounds.west / step) * step - step;
  const east = Math.ceil(bounds.east / step) * step + step;
  const south = Math.max(-85, Math.floor(bounds.south / step) * step - step);
  const north = Math.min(85, Math.ceil(bounds.north / step) * step + step);

  // Guard against a degenerate camera producing an unbounded loop.
  const maxLines = 400;

  let n = 0;
  for (let lon = west; lon <= east && n < maxLines; lon += step, n++) {
    features.push({
      type: 'Feature',
      properties: { kind: 'meridian', value: round(lon) },
      geometry: {
        type: 'LineString',
        coordinates: [
          [lon, south],
          [lon, north],
        ],
      },
    });
  }

  n = 0;
  for (let lat = south; lat <= north && n < maxLines; lat += step, n++) {
    features.push({
      type: 'Feature',
      properties: { kind: 'parallel', value: round(lat) },
      geometry: {
        type: 'LineString',
        coordinates: [
          [west, lat],
          [east, lat],
        ],
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

/** Floating-point accumulation makes 13.299999999 out of 13.3; keep the labels honest. */
function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
