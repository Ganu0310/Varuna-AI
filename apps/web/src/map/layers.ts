import { GeoJsonLayer, PathLayer, ScatterplotLayer, BitmapLayer } from '@deck.gl/layers';
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
  sarTileUrl: string | null;
  sarBounds: [number, number, number, number] | null;
  aoi: { type: 'Polygon'; coordinates: number[][][] } | null;
  originZone: { type: 'Polygon'; coordinates: number[][][] } | null;
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

  // 1 · SAR raster, served by TiTiler from the same COG the analysis ran on.
  if (on('sar-raster') && input.sarTileUrl && input.sarBounds) {
    layers.push(
      new BitmapLayer({
        id: 'sar-raster',
        bounds: input.sarBounds,
        image: input.sarTileUrl,
        opacity: alpha('sar-raster'),
      }) as unknown as Layer,
    );
  }

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
        getFillColor: rgba(color.origin500, 55),
        getLineColor: rgba(color.origin700, 210),
        getLineWidth: 2,
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
