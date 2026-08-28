import { useEffect, useRef, type ReactNode } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import type { Layer } from '@deck.gl/core';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useMapStore, timeChannel, useTimeStore } from '../state/stores.ts';
import { DARK_STYLE } from './style.ts';

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
interface Props {
  layers: Layer[];
  children?: ReactNode;
}

export function MapRoot({ layers, children }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const overlay = useRef<MapboxOverlay | null>(null);
  const raf = useRef<number | null>(null);

  const setReady = useMapStore((s) => s.setReady);
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

    m.on('load', () => setReady(true));
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

    return () => {
      // Only on real teardown (app unmount), never on navigation.
      if (raf.current) cancelAnimationFrame(raf.current);
      m.remove();
      map.current = null;
      overlay.current = null;
    };
  }, [setReady, registerCamera]);

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
