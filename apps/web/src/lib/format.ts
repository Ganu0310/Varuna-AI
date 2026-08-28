/**
 * Display formatters — 04_UIUX §4.2.2 (T1–T9).
 *
 * The typographic rules here are error-prevention measures, not aesthetics:
 * timestamps always carry an explicit `Z`, coordinates use hemisphere letters rather than
 * signs, and units are always rendered.
 */

/** `2023-08-14 06:12:47 Z` — ISO order, space-separated, explicit Z (T4). */
export function formatUtc(iso: string | Date | undefined | null): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 19).replace('T', ' ')} Z`;
}

/** Date only, still explicitly UTC. */
export function formatUtcDate(iso: string | Date | undefined | null): string {
  if (!iso) return '—';
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().slice(0, 10)} Z`;
}

/**
 * Latitude/longitude to 5 decimal places (~1 m) with an explicit hemisphere letter (T3).
 * Sign-based notation is a well-known source of transcription error.
 */
export function formatLat(lat: number): string {
  const hemi = lat >= 0 ? 'N' : 'S';
  return `${Math.abs(lat).toFixed(5)}° ${hemi}`;
}

export function formatLon(lon: number): string {
  const hemi = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lon).toFixed(5).padStart(9, '0')}° ${hemi}`;
}

export function formatLonLat(lonLat: readonly [number, number]): string {
  return `${formatLat(lonLat[1])}, ${formatLon(lonLat[0])}`;
}

/** Units are always rendered, never implied (T5). */
export function formatAreaKm2(km2: number | undefined | null): string {
  if (km2 == null || Number.isNaN(km2)) return '—';
  const value = km2 >= 100 ? km2.toFixed(0) : km2.toFixed(2);
  return `${Number(value).toLocaleString('en-GB')} km²`;
}

export function formatDistanceKm(km: number | undefined | null): string {
  if (km == null || Number.isNaN(km)) return '—';
  return `${km.toFixed(km < 10 ? 2 : 1)} km`;
}

export function formatKnots(kn: number | undefined | null): string {
  if (kn == null || Number.isNaN(kn)) return '—';
  return `${kn.toFixed(1)} kn`;
}

export function formatBearing(deg: number | undefined | null): string {
  if (deg == null || Number.isNaN(deg)) return '—';
  return `${deg.toFixed(0)}°`;
}

/** Duration in minutes → a compact human string, units explicit. */
export function formatDurationMin(min: number | undefined | null): string {
  if (min == null || Number.isNaN(min)) return '—';
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
