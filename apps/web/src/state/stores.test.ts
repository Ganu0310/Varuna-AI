import { describe, it, expect, beforeEach } from 'vitest';
import { useLayerStore, useTimeStore, useSelectionStore, LAYER_ORDER } from './stores.ts';

/**
 * Workspace store behaviour — 05_FRONTEND §5.3.
 *
 * The exit criterion these prove: **a layer without provenance cannot be added to the map**
 * (MVP M12). Everything drawn on the map must be traceable to a real source, so a screenshot
 * of this workspace can always be defended.
 */
const REAL_PROVENANCE = {
  provider: 'Microsoft Planetary Computer',
  datasetId: 'sentinel-1-rtc',
  externalId: 'S1C_IW_GRDH_1SDV_20250921T200737_..._rtc',
  licence: 'Copernicus Sentinel Data',
};

describe('layer store refuses layers without provenance', () => {
  beforeEach(() => {
    useLayerStore.setState({ layers: {}, order: [...LAYER_ORDER], rejectedForNoProvenance: [] });
  });

  it('accepts a layer that names its source', () => {
    useLayerStore.getState().addLayer({
      id: 'sar-raster',
      label: 'SAR',
      visible: true,
      opacity: 1,
      provenance: REAL_PROVENANCE,
    });
    expect(useLayerStore.getState().layers['sar-raster']).toBeTruthy();
    expect(useLayerStore.getState().rejectedForNoProvenance).toHaveLength(0);
  });

  it('REFUSES a layer with no provenance, and records the refusal', () => {
    useLayerStore.getState().addLayer({
      id: 'mystery-layer',
      label: 'Unsourced',
      visible: true,
      opacity: 1,
      provenance: null,
    });
    // Not drawn...
    expect(useLayerStore.getState().layers['mystery-layer']).toBeUndefined();
    // ...and the refusal is visible, so the layer does not merely fail to appear.
    expect(useLayerStore.getState().rejectedForNoProvenance).toContain('mystery-layer');
  });

  it('keeps the fixed draw order regardless of the order layers are added', () => {
    const store = useLayerStore.getState();
    store.addLayer({
      id: 'ais-tracks',
      label: 'AIS',
      visible: true,
      opacity: 1,
      provenance: REAL_PROVENANCE,
    });
    store.addLayer({
      id: 'sar-raster',
      label: 'SAR',
      visible: true,
      opacity: 1,
      provenance: REAL_PROVENANCE,
    });
    // SAR must draw beneath tracks whatever order they arrived in (04_UIUX §4.7.1).
    const order = useLayerStore.getState().order;
    expect(order.indexOf('sar-raster')).toBeLessThan(order.indexOf('ais-tracks'));
  });

  it('toggling and opacity affect only the named layer', () => {
    const store = useLayerStore.getState();
    store.addLayer({
      id: 'aoi',
      label: 'AOI',
      visible: true,
      opacity: 1,
      provenance: REAL_PROVENANCE,
    });
    store.addLayer({
      id: 'ais-tracks',
      label: 'AIS',
      visible: true,
      opacity: 1,
      provenance: REAL_PROVENANCE,
    });
    store.toggle('aoi');
    store.setOpacity('aoi', 0.4);
    const layers = useLayerStore.getState().layers;
    expect(layers.aoi!.visible).toBe(false);
    expect(layers.aoi!.opacity).toBe(0.4);
    expect(layers['ais-tracks']!.visible).toBe(true);
    expect(layers['ais-tracks']!.opacity).toBe(1);
  });
});

describe('time store', () => {
  beforeEach(() => {
    useTimeStore.getState().setWindow('2025-09-21T00:00:00Z', '2025-09-22T00:00:00Z');
  });

  it('clamps the cursor to the investigation window', () => {
    const { setCursor } = useTimeStore.getState();
    setCursor(Date.parse('2020-01-01T00:00:00Z'));
    expect(useTimeStore.getState().cursor).toBe(Date.parse('2025-09-21T00:00:00Z'));

    setCursor(Date.parse('2030-01-01T00:00:00Z'));
    expect(useTimeStore.getState().cursor).toBe(Date.parse('2025-09-22T00:00:00Z'));
  });

  it('setting a window moves the cursor to its start', () => {
    useTimeStore.getState().setWindow('2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z');
    expect(useTimeStore.getState().cursor).toBe(Date.parse('2024-01-01T00:00:00Z'));
  });

  it('steps by a signed delta and stays clamped', () => {
    const { setCursor, step } = useTimeStore.getState();
    setCursor(Date.parse('2025-09-21T12:00:00Z'));
    step(3_600_000);
    expect(useTimeStore.getState().cursor).toBe(Date.parse('2025-09-21T13:00:00Z'));
    step(-99 * 3_600_000);
    expect(useTimeStore.getState().cursor).toBe(Date.parse('2025-09-21T00:00:00Z'));
  });
});

describe('selection store links panels to the map', () => {
  beforeEach(() => useSelectionStore.getState().clear());

  it('carries the mmsi so a candidate row can highlight its track', () => {
    useSelectionStore.getState().select({ kind: 'candidate', id: 'abc', mmsi: 368278840 });
    const s = useSelectionStore.getState().selected;
    expect(s.kind).toBe('candidate');
    if (s.kind === 'candidate') expect(s.mmsi).toBe(368278840);
  });

  it('hover and selection are independent, so hovering does not lose the selection', () => {
    const store = useSelectionStore.getState();
    store.select({ kind: 'candidate', id: 'abc', mmsi: 1 });
    store.hover({ kind: 'vessel', mmsi: 2 });
    expect(useSelectionStore.getState().selected.kind).toBe('candidate');
    expect(useSelectionStore.getState().hovered.kind).toBe('vessel');
  });
});
