import { create } from 'zustand';

/**
 * Workspace state — 05_FRONTEND §5.3.
 *
 * Four small stores rather than one, because they change at wildly different rates. The time
 * cursor moves at 60 Hz during playback; the layer stack changes when a human clicks. Putting
 * them together would re-render the layer panel sixty times a second.
 */

// ── time ──────────────────────────────────────────────────────────────

export interface TimeState {
  /** UTC ms. The single source of truth for every time-aware layer. */
  cursor: number;
  windowStart: number;
  windowEnd: number;
  playing: boolean;
  speed: 1 | 10 | 60 | 300;
  setCursor: (ms: number) => void;
  setWindow: (startIso: string, endIso: string) => void;
  play: () => void;
  pause: () => void;
  setSpeed: (s: 1 | 10 | 60 | 300) => void;
  step: (deltaMs: number) => void;
}

export const useTimeStore = create<TimeState>((set, get) => ({
  cursor: Date.now(),
  windowStart: Date.now() - 86_400_000,
  windowEnd: Date.now(),
  playing: false,
  speed: 60,
  setCursor: (ms) => {
    const { windowStart, windowEnd } = get();
    set({ cursor: Math.min(windowEnd, Math.max(windowStart, ms)) });
  },
  setWindow: (startIso, endIso) => {
    const s = Date.parse(startIso);
    const e = Date.parse(endIso);
    set({ windowStart: s, windowEnd: e, cursor: s });
  },
  play: () => set({ playing: true }),
  pause: () => set({ playing: false }),
  setSpeed: (speed) => set({ speed }),
  step: (deltaMs) => get().setCursor(get().cursor + deltaMs),
}));

/**
 * THE ANIMATION CHANNEL — 05_FRONTEND §5.3.3, 12 F-24.
 *
 * A plain mutable object, deliberately outside React. The rAF loop writes `cursor` here at
 * 60 Hz and hands it straight to deck.gl; the React store is synced at 4 Hz for text panels
 * only. Routing 60 Hz through a React store would re-render every panel sixty times a second
 * and drop the frame rate on a 250k-point AIS slice.
 */
export const timeChannel = { cursor: Date.now() };

// ── selection (the cross-cutting link between panels and the map) ──────

export type Selection =
  | { kind: 'none' }
  | { kind: 'detection'; id: string }
  | { kind: 'candidate'; id: string; mmsi: number }
  | { kind: 'vessel'; mmsi: number }
  | { kind: 'scene'; id: string };

export interface SelectionState {
  selected: Selection;
  hovered: Selection;
  select: (s: Selection) => void;
  hover: (s: Selection) => void;
  clear: () => void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  selected: { kind: 'none' },
  hovered: { kind: 'none' },
  select: (selected) => set({ selected }),
  hover: (hovered) => set({ hovered }),
  clear: () => set({ selected: { kind: 'none' }, hovered: { kind: 'none' } }),
}));

// ── layers ────────────────────────────────────────────────────────────

export interface LayerConfig {
  id: string;
  label: string;
  visible: boolean;
  opacity: number;
  /**
   * Where this layer's data came from. A layer with no provenance CANNOT be added
   * (13_REAL_DATA_POLICY §13.4 L4) — see `useLayerStore.addLayer`.
   */
  provenance: { provider: string; datasetId: string; externalId: string; licence: string } | null;
}

export interface LayerState {
  layers: Record<string, LayerConfig>;
  /** Fixed draw order, bottom to top — 04_UIUX §4.7.1. */
  order: string[];
  /**
   * Which investigation the current layers belong to.
   *
   * This store is a module singleton and nothing used to clear it, so layers registered in
   * one investigation survived navigation to another. Opening an investigation with no
   * origin estimate still listed "Origin zone (proximity, degraded)" in the panel, left over
   * from the last one — a control claiming data that does not exist here, which is precisely
   * the confusion the provenance rules elsewhere exist to prevent.
   */
  ownerId: string | null;
  addLayer: (config: LayerConfig, ownerId: string) => void;
  toggle: (id: string) => void;
  setOpacity: (id: string, opacity: number) => void;
  rejectedForNoProvenance: string[];
}

export const LAYER_ORDER = [
  'sar-raster',
  'aoi',
  'origin-field',
  'drift-particles',
  'slick-polygons',
  'ais-tracks',
  'vessel-positions',
  'candidate-highlight',
] as const;

export const useLayerStore = create<LayerState>((set, get) => ({
  layers: {},
  order: [...LAYER_ORDER],
  ownerId: null,
  rejectedForNoProvenance: [],
  addLayer: (config, ownerId) => {
    // Ownership is checked on every add rather than cleared by a separate effect. A reset
    // effect would have to be guaranteed to run before every registration, and React gives
    // that only by declaration order — one effect added above it later and stale layers come
    // back silently. Doing it here makes a mixed-investigation layer set unrepresentable.
    const stale = get().ownerId !== ownerId;
    const layers = stale ? {} : get().layers;
    const rejected = stale ? [] : get().rejectedForNoProvenance;

    if (!config.provenance) {
      // Refused, and the refusal is recorded so it surfaces in the UI rather than the layer
      // simply never appearing.
      set({ ownerId, layers, rejectedForNoProvenance: [...rejected, config.id] });
      return;
    }
    set({ ownerId, layers: { ...layers, [config.id]: config }, rejectedForNoProvenance: rejected });
  },
  toggle: (id) => {
    const l = get().layers[id];
    if (!l) return;
    set({ layers: { ...get().layers, [id]: { ...l, visible: !l.visible } } });
  },
  setOpacity: (id, opacity) => {
    const l = get().layers[id];
    if (!l) return;
    set({ layers: { ...get().layers, [id]: { ...l, opacity } } });
  },
}));

// ── map ───────────────────────────────────────────────────────────────

export interface ViewState {
  longitude: number;
  latitude: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface MapState {
  view: ViewState;
  ready: boolean;
  setView: (v: Partial<ViewState>) => void;
  setReady: (r: boolean) => void;
  flyTo: (lon: number, lat: number, zoom?: number) => void;
  fitBounds: (b: [number, number, number, number]) => void;
  /** Set by MapRoot so panels can drive the camera without holding the map instance. */
  _flyImpl: ((lon: number, lat: number, zoom?: number) => void) | null;
  _fitImpl: ((b: [number, number, number, number]) => void) | null;
  registerCamera: (
    fly: (lon: number, lat: number, zoom?: number) => void,
    fit: (b: [number, number, number, number]) => void,
  ) => void;
}

export const useMapStore = create<MapState>((set, get) => ({
  view: { longitude: 144.75, latitude: 13.45, zoom: 9, pitch: 0, bearing: 0 },
  ready: false,
  _flyImpl: null,
  _fitImpl: null,
  setView: (v) => set({ view: { ...get().view, ...v } }),
  setReady: (ready) => set({ ready }),
  registerCamera: (fly, fit) => set({ _flyImpl: fly, _fitImpl: fit }),
  flyTo: (lon, lat, zoom) => get()._flyImpl?.(lon, lat, zoom),
  fitBounds: (b) => get()._fitImpl?.(b),
}));
