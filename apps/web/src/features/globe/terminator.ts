import type { Feature, Polygon } from 'geojson';

/**
 * The real solar terminator — 04_UIUX §4.6.1.
 *
 * The day/night line is computed from the sun's actual position at a given instant, not
 * approximated by a tilted great circle. A decorative terminator would be a fabricated
 * observation dressed as a real one, which is the one thing this project does not do — and it
 * would be wrong by up to 23° at the solstices, which is most of the year.
 *
 * The astronomy is the standard low-precision solar position (NOAA / Astronomical Almanac),
 * accurate to well under a degree — far better than the pixel it is drawn at, and it needs no
 * ephemeris data.
 */

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Days since J2000.0 (2000-01-01 12:00 UTC). */
function julianCenturies(atMs: number): number {
  return (atMs / 86_400_000 + 2440587.5 - 2451545.0) / 36525;
}

export interface SubsolarPoint {
  lat: number;
  lon: number;
  declination: number;
}

/**
 * Where the sun is directly overhead.
 *
 * Latitude is the solar declination; longitude follows from the equation of time, which is
 * why the sun is not over 0° at noon UTC — it runs up to ~16 minutes fast or slow depending on
 * the date, and ignoring it misplaces the terminator by up to 4° of longitude.
 */
export function subsolarPoint(atMs: number): SubsolarPoint {
  const t = julianCenturies(atMs);

  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const ecc = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const centre =
    Math.sin(rad(meanAnom)) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(rad(2 * meanAnom)) * (0.019993 - 0.000101 * t) +
    Math.sin(rad(3 * meanAnom)) * 0.000289;

  const trueLong = meanLong + centre;
  const omega = 125.04 - 1934.136 * t;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));

  const obliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorr = obliq + 0.00256 * Math.cos(rad(omega));

  const declination = deg(Math.asin(Math.sin(rad(obliqCorr)) * Math.sin(rad(appLong))));

  const y = Math.tan(rad(obliqCorr / 2)) ** 2;
  const eqTimeMin =
    4 *
    deg(
      y * Math.sin(2 * rad(meanLong)) -
        2 * ecc * Math.sin(rad(meanAnom)) +
        4 * ecc * y * Math.sin(rad(meanAnom)) * Math.cos(2 * rad(meanLong)) -
        0.5 * y * y * Math.sin(4 * rad(meanLong)) -
        1.25 * ecc * ecc * Math.sin(2 * rad(meanAnom)),
    );

  const utcMinutes = (((atMs / 60_000) % 1440) + 1440) % 1440;
  // Solar noon is where local apparent time is 12:00; every minute away from it is 0.25° of
  // longitude.
  let lon = -((utcMinutes + eqTimeMin) / 4 - 180);
  lon = ((lon + 540) % 360) - 180;

  return { lat: declination, lon, declination };
}

/**
 * The night hemisphere as a polygon.
 *
 * Built as the ring of points where the sun is on the horizon, closed over whichever pole is
 * in darkness. Closing over the wrong pole would shade the lit hemisphere instead — the
 * failure is total rather than subtle, and it flips at every equinox.
 */
export function solarTerminator(atMs: number, stepDeg = 2): Feature<Polygon> {
  const { declination, lon: subLon } = subsolarPoint(atMs);

  const ring: number[][] = [];
  for (let i = 0; i <= 360; i += stepDeg) {
    const lon = -180 + (i * 360) / 360;
    // Latitude where the sun's altitude is zero for this longitude.
    const hourAngle = rad(lon - subLon);
    const lat = deg(Math.atan(-Math.cos(hourAngle) / Math.tan(rad(declination || 1e-6))));
    ring.push([lon, lat]);
  }

  // North is dark when the sun is south of the equator.
  const darkPole = declination > 0 ? -90 : 90;
  ring.push([180, darkPole], [-180, darkPole], [ring[0]![0]!, ring[0]![1]!]);

  return {
    type: 'Feature',
    properties: { atMs, declination },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}
