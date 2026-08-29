import { useEffect, useState } from 'react';
import type maplibregl from 'maplibre-gl';

/**
 * Place and sea names, drawn as HTML over the map.
 *
 * Not a MapLibre `symbol` layer. Symbols need a glyph endpoint, and every readily available
 * one is third-party — which the client is not allowed to call (02_TRD TR-7), and which would
 * also make the map fail offline. HTML labels need no glyphs, style with the same tokens as
 * the rest of the app, and stay under our control.
 *
 * They are capped and prioritised rather than drawn exhaustively. A coastline carrying every
 * settlement is harder to read than one carrying none, and the point of a label here is
 * orientation — "this is Apra Harbour, that is the Philippine Sea" — not completeness.
 */

interface Place {
  name: string;
  pop: number;
  capital: boolean;
  lon: number;
  lat: number;
}
interface Sea {
  name: string;
  lon: number;
  lat: number;
}

interface Positioned {
  key: string;
  name: string;
  x: number;
  y: number;
  kind: 'place' | 'sea';
}

/** Above this the map is a regional view and sea names carry more than town names. */
const SEA_MAX_ZOOM = 7;
const MAX_PLACES = 14;
const MAX_SEAS = 4;

export function MapLabels({ map, ready }: { map: maplibregl.Map | null; ready: boolean }) {
  const [data, setData] = useState<{ places: Place[]; seas: Sea[] } | null>(null);
  const [labels, setLabels] = useState<Positioned[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch('/basemap/labels.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setData(d);
      })
      // A missing basemap asset must not break the map. Labels are orientation, not evidence.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!map || !ready || !data) return;

    const recompute = () => {
      const b = map.getBounds();
      const zoom = map.getZoom();
      const within = (lon: number, lat: number) =>
        lon >= b.getWest() && lon <= b.getEast() && lat >= b.getSouth() && lat <= b.getNorth();

      const out: Positioned[] = [];

      // Sea names only when zoomed out. Close in they name water the analyst is already
      // looking at, and they compete with the tracks for the same pixels.
      if (zoom <= SEA_MAX_ZOOM) {
        for (const s of data.seas) {
          if (!within(s.lon, s.lat) || out.length >= MAX_SEAS) continue;
          const p = map.project([s.lon, s.lat]);
          out.push({ key: `sea:${s.name}`, name: s.name, x: p.x, y: p.y, kind: 'sea' });
        }
      }

      // Places are pre-sorted by population, so taking the first N that are in view keeps the
      // largest rather than whichever happened to be listed first.
      let placed = 0;
      for (const p of data.places) {
        if (placed >= MAX_PLACES) break;
        if (!within(p.lon, p.lat)) continue;
        const pt = map.project([p.lon, p.lat]);
        out.push({
          key: `place:${p.name}:${p.lon}`,
          name: p.name,
          x: pt.x,
          y: pt.y,
          kind: 'place',
        });
        placed++;
      }

      setLabels(out);
    };

    recompute();
    map.on('move', recompute);
    map.on('zoom', recompute);
    return () => {
      map.off('move', recompute);
      map.off('zoom', recompute);
    };
  }, [map, ready, data]);

  if (labels.length === 0) return null;

  return (
    <div className="map-labels" aria-hidden="true">
      {labels.map((l) => (
        <span
          key={l.key}
          className={`map-label map-label-${l.kind}`}
          style={{ transform: `translate(${l.x}px, ${l.y}px)` }}
        >
          {l.name}
        </span>
      ))}
    </div>
  );
}
