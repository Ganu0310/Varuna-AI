import { GeoJsonLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import { color, rgba } from '../design/tokens.ts';
import type { Detection } from '../api/hooks.ts';

/**
 * Layer factory — 05_FRONTEND §5.4.3.
 *
 * Pure functions from data to deck.gl layers. No layer reads a store: everything it needs
 * arrives as an argument, which is what makes the stack testable and keeps a moving time
 * cursor from triggering a store subscription cascade.
 *
 * Draw order is fixed (04_UIUX §4.7.1), bottom to top: raster → AOI → origin field →
 * particles → slicks → tracks → vessels → highlight.
 */

export interface LayerInputs {
  aoi: { type: 'Polygon'; coordinates: number[][][] } | null;
  originZone: { type: 'Polygon'; coordinates: number[][][] } | null;
  /**
   * True when the estimate came from footprint proximity rather than drift back-tracking.
   * Drawn dashed, because a proximity buffer that looks like a probability surface invites
   * exactly the reading the tier cap exists to prevent.
   */
  originDegraded?: boolean;
  detections: Detection[];
  tracks: Array<{ mmsi: number; line: { type: 'LineString'; coordinates: number[][] } | null }>;
  vesselPositions: Array<{ mmsi: number; lon: number; lat: number; cog: number | null }>;
  highlightMmsi: number | null;
  hoveredMmsi: number | null;
  visible: Record<string, boolean>;
  opacity: Record<string, number>;
}

const TRACK_PALETTE = color.track.map((hex) => rgba(hex, 200));

export function buildLayers(input: LayerInputs): Layer[] {
  const layers: Layer[] = [];
  const on = (id: string) => input.visible[id] !== false;
  const alpha = (id: string) => input.opacity[id] ?? 1;

  // 1 · The SAR raster is NOT a deck.gl layer. It is a MapLibre raster source owned by
  // `MapRoot`: a BitmapLayer takes a single image rather than a tile template, and the
  // deck.gl tiling layer would mean another dependency on an over-budget bundle. Draw order
  // is preserved because MapRoot inserts it beneath the graticule, under everything here.

  // 2 · AOI outline — the analyst's declared search area.
  if (on('aoi') && input.aoi) {
    layers.push(
      new GeoJsonLayer({
        id: 'aoi',
        data: { type: 'Feature', geometry: input.aoi, properties: {} },
        stroked: true,
        filled: false,
        getLineColor: rgba(color.accent700, 180),
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        opacity: alpha('aoi'),
      }) as unknown as Layer,
    );
  }

  // 3 · Origin probability support (violet ramp — 04_UIUX §4.3.2).
  if (on('origin-field') && input.originZone) {
    layers.push(
      new GeoJsonLayer({
        id: 'origin-field',
        data: { type: 'Feature', geometry: input.originZone, properties: {} },
        stroked: true,
        filled: true,
        // A degraded zone reads as an OUTLINED REGION; a drift-derived one as a filled
        // probability surface. The first version made degraded nearly transparent, which
        // over bright SAR meant invisible — and an origin estimate the analyst cannot see is
        // worse than one drawn with the wrong emphasis. The distinction is carried by fill
        // weight and by the layer's own label, not by hiding it.
        getFillColor: rgba(color.origin500, input.originDegraded ? 40 : 90),
        getLineColor: rgba(color.origin700, input.originDegraded ? 235 : 210),
        getLineWidth: input.originDegraded ? 3 : 2,
        lineWidthUnits: 'pixels',
        opacity: alpha('origin-field'),
      }) as unknown as Layer,
    );
  }

  // 4 · Slick polygons. An UNREVIEWED detection is drawn differently from a confirmed one:
  // a machine candidate and a human-confirmed finding must never look identical (12 F-04).
  if (on('slick-polygons') && input.detections.length > 0) {
    layers.push(
      new GeoJsonLayer({
        id: 'slick-polygons',
        data: input.detections.map((d) => ({
          type: 'Feature' as const,
          geometry: d.geometry,
          properties: { id: d._id, reviewStatus: d.reviewStatus },
        })),
        stroked: true,
        filled: true,
        getFillColor: (f: { properties: { reviewStatus: string } }) =>
          f.properties.reviewStatus === 'REJECTED'
            ? rgba(color.inkTertiary, 30)
            : rgba(color.oil500, 56),
        getLineColor: (f: { properties: { reviewStatus: string } }) =>
          f.properties.reviewStatus === 'CONFIRMED'
            ? rgba(color.statusOk, 255)
            : f.properties.reviewStatus === 'REJECTED'
              ? rgba(color.inkTertiary, 140)
              : rgba(color.oil400, 255),
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        pickable: true,
        opacity: alpha('slick-polygons'),
      }) as unknown as Layer,
    );
  }

  // 5 · AIS tracks. A hovered or selected vessel stays fully opaque while the rest fade, so
  // one track can be followed through a crowded harbour (05_FRONTEND §5.5.7).
  if (on('ais-tracks') && input.tracks.length > 0) {
    const focus = input.highlightMmsi ?? input.hoveredMmsi;
    layers.push(
      new PathLayer({
        id: 'ais-tracks',
        data: input.tracks.filter((t) => t.line),
        getPath: (t: LayerInputs['tracks'][number]) => t.line!.coordinates as [number, number][],
        getColor: (t: LayerInputs['tracks'][number]) => {
          const base = TRACK_PALETTE[t.mmsi % TRACK_PALETTE.length]!;
          if (focus === null || t.mmsi === focus) return base;
          return [base[0], base[1], base[2], 60];
        },
        getWidth: (t: LayerInputs['tracks'][number]) => (t.mmsi === focus ? 3 : 1.5),
        widthUnits: 'pixels',
        pickable: true,
        opacity: alpha('ais-tracks'),
        updateTriggers: { getColor: [focus], getWidth: [focus] },
      }) as unknown as Layer,
    );
  }

  // 6 · Vessel positions at the time cursor.
  if (on('vessel-positions') && input.vesselPositions.length > 0) {
    layers.push(
      new ScatterplotLayer({
        id: 'vessel-positions',
        data: input.vesselPositions,
        getPosition: (v: LayerInputs['vesselPositions'][number]) => [v.lon, v.lat],
        getFillColor: (v: LayerInputs['vesselPositions'][number]) =>
          v.mmsi === input.highlightMmsi
            ? rgba(color.accent400, 255)
            : rgba(color.inkSecondary, 200),
        getRadius: 4,
        radiusUnits: 'pixels',
        pickable: true,
        opacity: alpha('vessel-positions'),
        updateTriggers: { getFillColor: [input.highlightMmsi] },
      }) as unknown as Layer,
    );
  }

  return layers;
}
