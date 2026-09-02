import { MAX_AOI_KM2 } from './constants.js';
import type { GeoPolygon } from './schemas/geojson.js';

/**
 * The regions Discover watches — 01_PRD FR-1 F1 (extended), 06_BACKEND §6.4.10.
 *
 * A handful, not the globe. A Sentinel-1 scene is roughly 250×170 km and a live provider
 * read costs real seconds even for a windowed one; sweeping "anywhere, any time" would
 * exhaust the shared provider quota (`apps/api/src/providers/quota.ts`) in minutes and could
 * never honestly promise coverage it does not have. So Discover is explicit about its own
 * boundary instead: these four regions, and nowhere else, are swept on a schedule — the map
 * draws their outlines for exactly this reason.
 *
 * Every bbox here is real, not a plausible-looking placeholder — chosen either because a
 * real scene is already staged for it (`guam-apra`), or because it is a documented cluster
 * of confirmed-oil scenes in the Trujillo-Acatitla evaluation dataset (CC-BY-4.0). The same
 * four bboxes the AOI picker already offers a human typing a location by hand
 * (`apps/web/src/lib/aoiPresets.ts`) — this file is the subset of those the system watches
 * on its own, defined once here so the API/worker and the web app can never disagree about
 * what "watched" means.
 */

export interface WatchRegion {
  id: string;
  label: string;
  region: string;
  /** west, south, east, north — the same shorthand the AOI field speaks. */
  bbox: [number, number, number, number];
  aisCoverage: 'STAGED' | 'OBTAINABLE' | 'NONE';
  note: string;
}

export const WATCH_REGIONS: WatchRegion[] = [
  {
    id: 'guam-apra',
    label: 'Guam — Apra Harbour',
    region: 'Western Pacific',
    bbox: [144.55, 13.3, 144.95, 13.6],
    aisCoverage: 'STAGED',
    note:
      'The staged demo incident. A real Sentinel-1C RTC acquisition (2025-09-21) is already ' +
      'ingested and real AIS positions are loaded locally — the one watch region where the ' +
      'full chain, sweep through candidate ranking, runs end to end with nothing left to ' +
      'download.',
  },
  {
    id: 'baniyas-syria',
    label: 'Baniyas, Syria',
    region: 'Eastern Mediterranean',
    bbox: [34.6, 35.1, 35.1, 35.8],
    aisCoverage: 'NONE',
    note:
      '12 confirmed-oil scenes in the evaluation dataset, including the 2021 Baniyas ' +
      'refinery discharges. Imagery and detection work here; attribution will not, because ' +
      'no free AIS archive covers this coast.',
  },
  {
    id: 'iskenderun',
    label: 'İskenderun Bay',
    region: 'Eastern Mediterranean',
    bbox: [35.0, 35.3, 35.8, 36.2],
    aisCoverage: 'NONE',
    note:
      'The densest oil cluster in the evaluation dataset — 21 confirmed-oil scenes. No free ' +
      'AIS.',
  },
  {
    id: 'gulf-of-mexico',
    label: 'Gulf of Mexico — Mississippi Delta',
    region: 'US waters',
    bbox: [-90.6, 28.6, -88.9, 29.05],
    aisCoverage: 'OBTAINABLE',
    note:
      '11 confirmed-oil scenes, and US waters — so Marine Cadastre AIS is downloadable for ' +
      'it, unlike the other three. The best candidate for a second fully end-to-end watch ' +
      'region once that AIS slice is imported.',
  },
];

export function watchRegionAoi(r: WatchRegion): GeoPolygon {
  const [w, s, e, n] = r.bbox;
  // Same corner order `boundsToPolygon` uses in apps/api/src/modules/scenes/ingest.ts —
  // counter-clockwise for w<e, s<n, which every bbox above satisfies. MongoDB reads a
  // clockwise ring as the polygon's COMPLEMENT rather than erroring, so the order here is
  // load-bearing, not cosmetic.
  return {
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
  };
}

export function watchRegionById(id: string): WatchRegion | undefined {
  return WATCH_REGIONS.find((r) => r.id === id);
}

/**
 * Guards against a future watch region large enough to blow the investigation area cap.
 * The actual geodesic area check runs in `apps/api/src/modules/sweep/*.test.ts`, against the
 * same GeographicLib routine every other area figure in the system uses
 * (`apps/api/src/geo/geodesy.ts`) — not duplicated here, since this package stays free of
 * Node/browser globals and geodesic computation needs GeographicLib.
 */
export const WATCH_REGION_AREA_CAP_KM2 = MAX_AOI_KM2;
