import { useEffect, useRef, useState, type ReactNode } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer } from '@deck.gl/core';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useMapStore, timeChannel, useTimeStore } from '../state/stores.ts';
import { DARK_STYLE } from './style.ts';

const SAR_SOURCE_ID = 'sar-scene';
const SAR_LAYER_ID = 'sar-scene-raster';
import { graticuleFor, chooseStep } from './graticule.ts';

/**
 * The single MapLibre instance — 05_FRONTEND §5.4.1, 12 F-23.
 *
 * This component mounts once at the app root and NEVER unmounts. Route changes and panel
 * navigation render around it, not over it. The reason is concrete: re-creating a WebGL
 * context costs hundreds of milliseconds and throws away every cached tile, so a map that
 * remounts on navigation makes the whole application feel broken even though nothing failed.
 *
 * deck.gl is attached in INTERLEAVED mode, so data layers sit inside the basemap's own
 * render order rather than floating above it — labels and coastlines can draw on top of a
 * SAR raster, which is what makes the composite readable.
 */
export interface SarTile {
  tileUrlTemplate: string;
  bounds: [number, number, number, number] | null;
  minZoom: number;
  maxZoom: number;
  attribution: string | null;
}

interface Props {
  layers: Layer[];
  /**
   * The SAR raster, served by TiTiler from the SAME COG the detector read.
   *
   * Handled by MapLibre rather than deck.gl: a `BitmapLayer` takes one image, not a tile
   * template, and the tiling layer lives in `@deck.gl/geo-layers` which this app does not
   * depend on and which would add to a bundle already over budget. MapLibre tiles rasters
   * natively, and imagery belongs under the vector overlay anyway.
   */
  sarTile?: SarTile | null;
  sarVisible?: boolean;
  sarOpacity?: number;
  children?: ReactNode;
}

export function MapRoot({
  layers,
  sarTile = null,
  sarVisible = true,
  sarOpacity = 1,
  children,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  const raf = useRef<number | null>(null);
  const currentTemplate = useRef<string | null>(null);

  const setReady = useMapStore((s) => s.setReady);
  /**
   * Readiness of THIS map instance.
   *
   * The store's `ready` cannot be used for this. It is a module singleton, so after the map
   * is torn down and rebuilt — StrictMode's double mount, or navigating to the prism and
   * back — it is still true from the PREVIOUS instance. The effect below then ran against a
   * brand-new map whose style had not loaded and MapLibre threw "Style is not done loading",
   * which unmounted the whole workspace.
   */
  const [styleReady, setStyleReady] = useState(false);
  const registerCamera = useMapStore((s) => s.registerCamera);

  useEffect(() => {
    if (!container.current || map.current) return;

    const m = new maplibregl.Map({
      container: container.current,
      // A local style object, so the map needs no API token and no third-party request
      // (02_TRD TR-7: the client never holds a provider credential).
      style: DARK_STYLE,
      center: [144.75, 13.45],
      zoom: 9,
      attributionControl: false,
    });

    m.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.addControl(
      new maplibregl.AttributionControl({
        customAttribution: 'Basemap: Natural Earth (public domain) · Imagery: Copernicus',
      }),
      'bottom-right',
    );

    const o = new MapboxOverlay({ interleaved: true, layers: [] });
    m.addControl(o as unknown as maplibregl.IControl);

    /**
     * Redraw the graticule for whatever is on screen.
     *
     * Runs on `move`, not only `moveend`, so the grid stays put under the cursor during a
     * drag instead of snapping into place when the gesture finishes.
     */
    const redrawGraticule = () => {
      const b = m.getBounds();
      const bounds = {
        west: b.getWest(),
        south: b.getSouth(),
        east: b.getEast(),
        north: b.getNorth(),
      };
      const step = chooseStep(Math.max(bounds.east - bounds.west, bounds.north - bounds.south));
      const src = m.getSource('graticule') as maplibregl.GeoJSONSource | undefined;
      src?.setData(graticuleFor(bounds, step));
    };

    m.on('load', () => {
      redrawGraticule();
      setStyleReady(true);
      setReady(true);
    });
    m.on('move', redrawGraticule);
    m.on('moveend', () => {
      const c = m.getCenter();
      useMapStore.getState().setView({
        longitude: c.lng,
        latitude: c.lat,
        zoom: m.getZoom(),
        pitch: m.getPitch(),
        bearing: m.getBearing(),
      });
    });

    registerCamera(
      (lon, lat, zoom) => m.flyTo({ center: [lon, lat], zoom: zoom ?? m.getZoom(), duration: 900 }),
      (b) =>
        m.fitBounds(
          [
            [b[0], b[1]],
            [b[2], b[3]],
          ],
          { padding: 80, duration: 900 },
        ),
    );

    map.current = m;
    overlay.current = o;
    // Dev-only handle so the map can be inspected from a browser harness or the console.
    // Guarded on DEV so it is absent from a production bundle.
    if (import.meta.env.DEV) (window as unknown as { __varunaMap?: unknown }).__varunaMap = m;

    return () => {
      // Only on real teardown (app unmount), never on navigation.
      if (raf.current) cancelAnimationFrame(raf.current);
      // Readiness belongs to the map being destroyed. Leaving either flag true lets the next
      // instance's effects fire before its style has loaded — the bug this replaced.
      setStyleReady(false);
      setReady(false);
      currentTemplate.current = null;
      m.remove();
      map.current = null;
      overlay.current = null;
    };
  }, [setReady, registerCamera]);

  /**
   * The SAR raster source/layer, kept in sync with whichever scene is selected.
   *
   * Inserted directly above the graticule so it sits at the BOTTOM of the stack: detections,
   * tracks and the AOI must draw over the imagery, never under it.
   */
  useEffect(() => {
    const m = map.current;
    if (!m) return;

    const apply = () => {
      const hasLayer = Boolean(m.getLayer(SAR_LAYER_ID));
      const hasSource = Boolean(m.getSource(SAR_SOURCE_ID));

      if (!sarTile) {
        if (hasLayer) m.removeLayer(SAR_LAYER_ID);
        if (hasSource) m.removeSource(SAR_SOURCE_ID);
        return;
      }

      // A changed template means a different scene: tear the source down rather than trying
      // to mutate it, so no tile from the previous scene can survive on screen.
      const current = currentTemplate.current;
      if (hasSource && current !== sarTile.tileUrlTemplate) {
        if (hasLayer) m.removeLayer(SAR_LAYER_ID);
        m.removeSource(SAR_SOURCE_ID);
      }

      if (!m.getSource(SAR_SOURCE_ID)) {
        m.addSource(SAR_SOURCE_ID, {
          type: 'raster',
          tiles: [sarTile.tileUrlTemplate],
          tileSize: 256,
          minzoom: sarTile.minZoom,
          maxzoom: sarTile.maxZoom,
          ...(sarTile.bounds ? { bounds: sarTile.bounds } : {}),
          ...(sarTile.attribution ? { attribution: sarTile.attribution } : {}),
        });
        currentTemplate.current = sarTile.tileUrlTemplate;
      }

      if (!m.getLayer(SAR_LAYER_ID)) {
        m.addLayer(
          { id: SAR_LAYER_ID, type: 'raster', source: SAR_SOURCE_ID, paint: {} },
          m.getLayer('graticule') ? 'graticule' : undefined,
        );
      }

      m.setLayoutProperty(SAR_LAYER_ID, 'visibility', sarVisible ? 'visible' : 'none');
      m.setPaintProperty(SAR_LAYER_ID, 'raster-opacity', sarOpacity);
    };

    // Gated on THIS instance's readiness, which is in the dependency list, so the effect
    // re-runs the moment the map is usable.
    //
    // The try/catch is not superstition. MapLibre throws from `addSource`/`addLayer` if the
    // style is not settled, and an uncaught throw inside a passive effect unmounts the entire
    // workspace — the analyst loses the whole screen because a raster overlay was early. A
    // missing overlay is recoverable; a blank page is not.
    if (!styleReady) return;
    try {
      apply();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('SAR overlay deferred:', err);
    }
  }, [sarTile, sarVisible, sarOpacity, styleReady]);

  // Layers are pushed straight to the overlay. `setProps` is deliberately outside React's
  // render cycle so a moving time cursor does not re-render the panels around the map.
  useEffect(() => {
    overlay.current?.setProps({ layers });
  }, [layers]);

  /**
   * The animation loop — 05_FRONTEND §5.3.3.
   *
   * Advances `timeChannel.cursor` at frame rate and syncs the React store at 4 Hz. Panels
   * showing a timestamp update four times a second, which is imperceptible in text; layers
   * bound to the channel update every frame.
   */
  useEffect(() => {
    let lastSync = 0;
    let lastFrame = performance.now();

    const tick = (now: number) => {
      const { playing, speed, windowEnd, windowStart } = useTimeStore.getState();
      const dt = now - lastFrame;
      lastFrame = now;

      if (playing) {
        timeChannel.cursor += dt * speed;
        if (timeChannel.cursor > windowEnd) {
          timeChannel.cursor = windowStart;
        }
        if (now - lastSync > 250) {
          lastSync = now;
          useTimeStore.getState().setCursor(timeChannel.cursor);
        }
      } else {
        timeChannel.cursor = useTimeStore.getState().cursor;
      }
      raf.current = requestAnimationFrame(tick);
    };

    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, []);

  return (
    <div className="map-root">
      <div ref={container} className="map-canvas" />
      {children}
    </div>
  );
}
