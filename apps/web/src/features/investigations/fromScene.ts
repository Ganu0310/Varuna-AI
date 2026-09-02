import { MAX_AOI_KM2, DRIFT_DEFAULTS } from '@varuna/shared';
import { approxPolygonAreaKm2 } from '../../lib/geo.ts';
import { toLocalInput, type ExtractedMetadata } from '../scenes/sceneFile.ts';

/**
 * Turning a scene file into the scope of a new investigation — 05_FRONTEND §5.5.4.
 *
 * An analyst handed a SAR image and told "there is a slick in this" was made to work
 * backwards: guess an area of interest, guess a time window, create the case, and only then
 * find out whether the file was usable at all. The file already states where the radar looked
 * and when, so it can define the case instead of being checked against one someone invented.
 *
 * Every value this produces is DERIVED and says so, and the two rules from the reader hold
 * here too:
 *
 *  - Nothing is filled in from a signal the file did not state. No acquisition time means no
 *    time window — not a window around "now", which would look filled-in and be wrong.
 *  - The derivation is stated in words next to the value, because the analyst is the one who
 *    has to agree with it. A default nobody can check is a default nobody should accept.
 *
 * These are starting points in an editable form, not decisions. The form's own limits still
 * apply, and the server re-checks all of them.
 */

/** The area of interest offered, and the sentence explaining where it came from. */
export interface DerivedAoi {
  /** `west,south,east,north` — the shorthand the AOI field already speaks. */
  text: string;
  areaKm2: number;
  /** True when the scene is simply bigger than an investigation is allowed to be. */
  overLimit: boolean;
  note: string;
}

export interface DerivedWindow {
  /** `datetime-local` values, read as UTC like every other instant in this app. */
  start: string;
  end: string;
  note: string;
}

export interface DerivedScope {
  name: string;
  aoi: DerivedAoi | null;
  /** Why there is no AOI, when there is none. */
  aoiBlocker: string | null;
  window: DerivedWindow | null;
  /** Why there is no window, when there is none. */
  windowBlocker: string | null;
  /**
   * The instant the window is centred on, and where it came from — carried up because the
   * upload that follows creation needs the same value, and it must be the same value. Two
   * places deriving it independently is how a scene ends up dated differently from the
   * window that was drawn around it.
   */
  acquiredAt: string | null;
  acquiredAtSource: string | null;
}

function bboxOf(ring: number[][]): [number, number, number, number] {
  const lons = ring.map((c) => c[0]!);
  const lats = ring.map((c) => c[1]!);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/** A bbox as the AOI field's shorthand. Four decimals is about eleven metres. */
export function bboxText([w, s, e, n]: [number, number, number, number]): string {
  return [w, s, e, n].map((v) => v.toFixed(4)).join(',');
}

export function bboxAreaKm2([w, s, e, n]: [number, number, number, number]): number {
  return approxPolygonAreaKm2({
    type: 'Polygon',
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  });
}

/**
 * The centre of a scene, shrunk until it fits the investigation area cap.
 *
 * Offered as an explicit action rather than applied silently. A Sentinel-1 IW swath is around
 * 250 km across and an investigation may cover 50,000 km², so the honest first answer for a
 * full scene is "this is bigger than a case is allowed to be" — and then, if the analyst
 * wants it, a real region inside the scene rather than a quietly different one.
 *
 * Bisected on the same approximate area function the form's readout shows, so the number the
 * analyst reads back is the number this aimed at.
 */
export function shrinkToLimit(
  bbox: [number, number, number, number],
  limitKm2 = MAX_AOI_KM2,
): [number, number, number, number] {
  const [w, s, e, n] = bbox;
  const cx = (w + e) / 2;
  const cy = (s + n) / 2;
  const halfLon = (e - w) / 2;
  const halfLat = (n - s) / 2;

  const at = (f: number): [number, number, number, number] => [
    cx - halfLon * f,
    cy - halfLat * f,
    cx + halfLon * f,
    cy + halfLat * f,
  ];

  if (bboxAreaKm2(bbox) <= limitKm2) return bbox;

  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (bboxAreaKm2(at(mid)) > limitKm2) hi = mid;
    else lo = mid;
  }
  // The low end of the bracket, so the result is inside the cap rather than on it.
  return at(lo);
}

function deriveName(meta: ExtractedMetadata, originalName: string): string {
  const base = originalName.replace(/\.[A-Za-z0-9]+$/, '').trim();

  // When the file names its platform and its overpass, that reads as a case: an analyst
  // scanning a list recognises "S1A 2023-01-15 01:23 UTC" faster than a 67-character product
  // identifier. Otherwise the filename is what they will recognise, so it is used as-is.
  if (meta.platform && meta.acquiredAt) {
    return `${meta.platform} ${meta.acquiredAt.slice(0, 10)} ${meta.acquiredAt.slice(11, 16)} UTC`;
  }
  return (base || 'Uploaded scene').slice(0, 200);
}

/**
 * How much of the run-up to the observation the window should hold.
 *
 * The back-track integrates for `DRIFT_DEFAULTS.horizonHours` by default, so AIS from that
 * far back is exactly the evidence the origin estimate will need — a shorter window would
 * import positions that stop before the release could have happened. The trailing hours keep
 * vessels that were still in the area at the overpass visible on the scrubber.
 */
const LEAD_HOURS = DRIFT_DEFAULTS.horizonHours;
const TRAIL_HOURS = 6;

export function deriveScopeFromScene(meta: ExtractedMetadata, originalName: string): DerivedScope {
  const scope: DerivedScope = {
    name: deriveName(meta, originalName),
    aoi: null,
    aoiBlocker: null,
    window: null,
    windowBlocker: null,
    acquiredAt: meta.acquiredAt,
    acquiredAtSource: meta.acquiredAtSource,
  };

  // ── where ───────────────────────────────────────────────────────────
  const ring = meta.footprint?.coordinates[0];
  if (!ring || ring.length < 4) {
    scope.aoiBlocker =
      meta.footprintNote ??
      'This file does not say where its pixels sit on the Earth, so no area of interest could ' +
        'be derived from it. Enter one, or use a file that carries its georeferencing.';
  } else {
    const bbox = bboxOf(ring);
    const areaKm2 = bboxAreaKm2(bbox);
    const overLimit = areaKm2 > MAX_AOI_KM2;
    scope.aoi = {
      text: bboxText(bbox),
      areaKm2,
      overLimit,
      note: overLimit
        ? `The scene's bounding box covers ${Math.round(areaKm2).toLocaleString()} km², more than ` +
          `the ${MAX_AOI_KM2.toLocaleString()} km² an investigation may cover. Narrow it to the ` +
          'part you care about, or take the centre of the scene.'
        : "The scene's bounding box, read from its georeferencing. Narrow it if the slick is " +
          'in one part of the swath — a tighter area is a faster and cleaner correlation.',
    };
  }

  // ── when ────────────────────────────────────────────────────────────
  if (!meta.acquiredAt) {
    scope.windowBlocker = meta.acquisitionConflict
      ? `${meta.acquisitionConflict} Set the window yourself once you know which is right.`
      : 'This file does not state, unambiguously, when the radar observed the scene, so no ' +
        'time window was derived. Set one around the overpass — AIS is searched inside it, ' +
        'so a window around the wrong day ranks vessels that were nowhere near the spill.';
  } else {
    const acquired = Date.parse(meta.acquiredAt);
    scope.window = {
      start: toLocalInput(new Date(acquired - LEAD_HOURS * 3600_000).toISOString()),
      end: toLocalInput(new Date(acquired + TRAIL_HOURS * 3600_000).toISOString()),
      note:
        `Centred on the acquisition (${meta.acquiredAtSource}): ${LEAD_HOURS} hours before it, ` +
        `which is how far the drift model back-tracks by default, and ${TRAIL_HOURS} after, so ` +
        'vessels still in the area at the overpass stay visible.',
    };
  }

  return scope;
}
