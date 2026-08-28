/**
 * End-to-end attribution run on a real incident.
 *
 *   pnpm --filter @varuna/api attribute -- --detections <file.json> \
 *     --scene-time 2025-09-21T20:07:48Z --bbox w,s,e,n [--detection 0]
 *
 * Takes a real detection polygon, derives the origin zone and release window, loads the
 * real AIS already in `ais_positions`, reconstructs tracks, and ranks candidate vessels.
 *
 * The origin estimate here uses FOOTPRINT_PROXIMITY and is reported as DEGRADED, because no
 * ocean-current forcing is configured on this machine (11_API_KEYS A4). That is stated in
 * the output rather than hidden: a proximity-derived zone is a much weaker basis for
 * attribution than a back-tracked drift field, and the numbers must not pretend otherwise.
 */
import { readFileSync } from 'node:fs';
import type { Polygon } from 'geojson';
import { buffer as turfBuffer, centroid as turfCentroid } from '@turf/turf';
import { logger } from '../../lib/logger.js';
import { connectMongo, disconnectMongo } from '../../db/connection.js';
import { rewindPolygon } from '../../geo/envelope.js';
import { reconstructTracks } from '../ais/tracks.js';
import { rankCandidates, type CandidateInput, type ScoringContext } from './features.js';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > -1 ? process.argv[i + 1] : undefined;
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
}

interface DetectionFile {
  rank: number;
  geometry: Polygon;
  areaKm2: number;
  morphology: { orientationDeg: number; elongationRatio: number };
  confidence: number;
  lookAlikeRisk: number;
}

async function main() {
  const detections = JSON.parse(readFileSync(arg('detections'), 'utf8')) as DetectionFile[];
  const which = Number(arg('detection', '0'));
  const sceneTime = arg('scene-time');
  const bbox = arg('bbox').split(',').map(Number) as [number, number, number, number];

  const det = detections[which];
  if (!det) throw new Error(`no detection at index ${which}`);

  await connectMongo();

  // ── origin estimate (degraded: proximity, not drift) ──────────────
  // Without a current field we cannot back-track. The honest fallback is to treat the
  // slick's own footprint, buffered, as the plausible release area, and to widen the
  // release window to the whole pre-acquisition period we can defend.
  const buffered = turfBuffer(det.geometry, 5, { units: 'kilometers' });
  if (!buffered) throw new Error('failed to buffer the detection footprint');
  const originZone = rewindPolygon(buffered.geometry as Polygon);
  const originCentroid = turfCentroid(det.geometry).geometry;

  const sceneMs = Date.parse(sceneTime);
  const releaseEarliest = new Date(sceneMs - 12 * 3_600_000).toISOString();
  const releaseLatest = new Date(sceneMs).toISOString();

  const ctx: ScoringContext = {
    originZone,
    originCentroid,
    releaseEarliest,
    releaseLatest,
    slickOrientationDeg: det.morphology.orientationDeg,
    originDegraded: true,
  };

  // ── candidates from the real AIS ──────────────────────────────────
  const tracks = await reconstructTracks(releaseEarliest, releaseLatest, bbox);
  const candidates: CandidateInput[] = tracks.map((t) => ({
    mmsi: t.mmsi,
    shipType: t.shipType,
    fixes: t.fixes,
    gaps: t.gaps,
    trackLine: t.line,
    priorIncidents: null,
  }));

  const ranked = rankCandidates(candidates, ctx);

  // ── report ────────────────────────────────────────────────────────
  const ring = det.geometry.coordinates[0]!;
  const lon = ring.reduce((s, c) => s + c[0]!, 0) / ring.length;
  const lat = ring.reduce((s, c) => s + c[1]!, 0) / ring.length;

  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
  VARUNA — attribution run
╚══════════════════════════════════════════════════════════════════════════════╝

DETECTION #${det.rank}
  centre            ${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(5)}° ${lon >= 0 ? 'E' : 'W'}
  area              ${det.areaKm2} km²
  elongation        ${det.morphology.elongationRatio}
  slick axis        ${det.morphology.orientationDeg}°
  detector conf.    ${det.confidence}
  look-alike risk   ${det.lookAlikeRisk}

ORIGIN ESTIMATE
  method            FOOTPRINT_PROXIMITY
  status            DEGRADED
  reason            No ocean-current forcing configured, so backward Lagrangian
                    drift could not be run. The origin zone is the detection
                    footprint buffered by 5 km, which is a substantially weaker
                    basis for attribution than a back-tracked drift field.
  release window    ${releaseEarliest}  →  ${releaseLatest}

AIS
  vessels in window ${tracks.length}
  total fixes       ${tracks.reduce((s, t) => s + t.fixes.length, 0).toLocaleString()}
  outliers removed  ${tracks.reduce((s, t) => s + t.removedOutlierCount, 0)}

RANKED CANDIDATES
`);

  const header = `  ${'#'.padStart(2)} ${'MMSI'.padEnd(10)} ${'score'.padStart(6)} ${'tier'.padEnd(22)} ${'feat'.padStart(5)} ${'fixes'.padStart(6)}`;
  console.log(header);
  console.log('  ' + '─'.repeat(header.length));

  ranked.slice(0, 10).forEach((r, i) => {
    const t = tracks.find((x) => x.mmsi === r.mmsi)!;
    console.log(
      `  ${String(i + 1).padStart(2)} ${String(r.mmsi).padEnd(10)} ${r.score.toFixed(1).padStart(6)} ${r.tier.padEnd(22)} ${`${r.measuredFeatureCount}/12`.padStart(5)} ${String(t.fixes.length).padStart(6)}`,
    );
  });

  const top = ranked[0];
  if (top) {
    console.log(`\n  ── evidence for MMSI ${top.mmsi} ─────────────────────────────────────────`);
    for (const f of top.features) {
      const mark = f.status === 'MEASURED' ? '●' : '○';
      const val =
        f.status === 'MEASURED'
          ? `${f.rawValue!.toFixed(2)} ${f.rawUnit} → ${f.normalised!.toFixed(2)} × ${f.weight} = ${f.contribution!.toFixed(3)}`
          : f.status;
      console.log(`  ${mark} ${f.key.padEnd(24)} ${val}`);
      console.log(`    ${f.explanation}`);
    }
    console.log(
      `\n  measured weight ${top.measuredWeight} of 1.000 — score renormalised over measured features only`,
    );
    if (top.insufficientReason) console.log(`  ${top.insufficientReason}`);
  }

  const insufficient = ranked.filter((r) => r.tier === 'INSUFFICIENT_EVIDENCE').length;
  console.log(`
  ${insufficient} of ${ranked.length} candidates returned INSUFFICIENT_EVIDENCE.
  This is a ranking of investigative leads, not a determination of guilt.
`);

  await disconnectMongo();
}

main().catch(async (err) => {
  logger.error({ err }, 'attribution run failed');
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
