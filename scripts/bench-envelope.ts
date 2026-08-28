/**
 * Envelope-query benchmark — 01_PRD NFR-6, 14 §14.6 Phase 13.
 *
 * "Envelope query p95 < 400 ms at 10⁷ real positions."
 *
 * `pnpm bench:envelope`
 *
 * This measures the query the whole AIS subsystem rests on: a `$geoWithin` box intersected
 * with a time range over the `ais_positions` time-series collection. It runs against whatever
 * is really in the database and prints that count, so the result can never be quoted at a
 * scale it was not measured at.
 *
 * Two deliberate choices:
 *
 *  - Windows and boxes are RANDOMISED across the archive's full extent. Re-running one window
 *    measures the WiredTiger cache rather than the index, which produces a number the system
 *    cannot reproduce on the first query after a restart.
 *  - A cold-ish pass runs first, then a warm pass. Reporting only the warm figure would be
 *    true of a demo already in progress and false of the demo's opening minute.
 *  - A third pass targets the DENSE traffic corridor. Boxes scattered over the archive's
 *    extent land mostly in empty ocean and return a few dozen rows, so their latency measures
 *    how quickly the index rejects — not how quickly the system reads a real AOI. An
 *    investigation is always drawn where there is shipping, so that is the case that has to
 *    meet the target.
 */
import mongoose from 'mongoose';

const URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const DB = process.env.MONGODB_DB_NAME ?? 'VARUNA';
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 60);
const TARGET_P95_MS = 400;

/** The real extent of the imported Marine Cadastre archive (Guam / Marianas). */
const EXTENT = { west: 141.0, south: 10.75, east: 149.75, north: 23.85 };

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (pos - lo) * (sorted[hi]! - sorted[lo]!);
}

function boxAround(lon: number, lat: number, deg: number) {
  return ring(lon - deg / 2, lat - deg / 2, deg);
}

function randomBox(deg: number) {
  const west = EXTENT.west + Math.random() * (EXTENT.east - EXTENT.west - deg);
  const south = EXTENT.south + Math.random() * (EXTENT.north - EXTENT.south - deg);
  return ring(west, south, deg);
}

function ring(west: number, south: number, deg: number) {
  // Wound counter-clockwise: MongoDB reads a clockwise ring as the polygon's COMPLEMENT,
  // which would silently select the rest of the planet and time a completely different query.
  return [
    [west, south],
    [west + deg, south],
    [west + deg, south + deg],
    [west, south + deg],
    [west, south],
  ];
}

async function main() {
  await mongoose.connect(URI, { dbName: DB });
  const db = mongoose.connection.db!;
  const positions = db.collection('ais_positions');

  const total = await positions.estimatedDocumentCount();
  const span = await positions
    .aggregate([{ $group: { _id: null, min: { $min: '$t' }, max: { $max: '$t' } } }])
    .toArray();
  const tMin = (span[0]?.min as Date | undefined) ?? new Date();
  const tMax = (span[0]?.max as Date | undefined) ?? new Date();

  console.log('\nenvelope query benchmark');
  console.log(`  collection      ais_positions (time-series)`);
  console.log(`  documents       ${total.toLocaleString()}`);
  console.log(`  archive span    ${tMin.toISOString()} .. ${tMax.toISOString()}`);
  console.log(`  iterations      ${ITERATIONS} per pass\n`);

  const windowHours = 6;
  const boxDeg = 1.5;

  // Where the traffic actually is, discovered from the data rather than assumed: the modal
  // half-degree cell of a large sample. Anchoring the dense pass on a guess would produce
  // another sparse-box benchmark wearing a different label.
  const busiest = await positions
    .aggregate([
      { $sample: { size: 200_000 } },
      {
        $group: {
          _id: {
            lon: { $floor: { $multiply: [{ $arrayElemAt: ['$position.coordinates', 0] }, 2] } },
            lat: { $floor: { $multiply: [{ $arrayElemAt: ['$position.coordinates', 1] }, 2] } },
          },
          n: { $sum: 1 },
        },
      },
      { $sort: { n: -1 } },
      { $limit: 1 },
    ])
    .toArray();
  const hot = busiest[0]?._id as { lon: number; lat: number } | undefined;
  const hotLon = hot ? hot.lon / 2 : 144.6;
  const hotLat = hot ? hot.lat / 2 : 13.45;
  console.log(
    `  busiest cell    ${hotLon.toFixed(2)}E ${hotLat.toFixed(2)}N ` +
      `(${(busiest[0]?.n ?? 0).toLocaleString()} of a 200k sample)
`,
  );

  async function pass(label: string, dense = false): Promise<number[]> {
    const timings: number[] = [];
    let matched = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const from = new Date(
        tMin.getTime() + Math.random() * (tMax.getTime() - tMin.getTime() - windowHours * 3600e3),
      );
      const to = new Date(from.getTime() + windowHours * 3600e3);
      // The dense pass jitters around the busiest cell so it still varies between iterations
      // rather than re-running one cached query.
      const polygon = dense
        ? boxAround(
            hotLon + (Math.random() - 0.5) * 0.4,
            hotLat + (Math.random() - 0.5) * 0.4,
            boxDeg,
          )
        : randomBox(boxDeg);

      const started = performance.now();
      const n = await positions.countDocuments({
        t: { $gte: from, $lte: to },
        position: { $geoWithin: { $geometry: { type: 'Polygon', coordinates: [polygon] } } },
      });
      timings.push(performance.now() - started);
      matched += n;
    }
    const sorted = [...timings].sort((a, b) => a - b);
    console.log(
      `  ${label.padEnd(6)} p50 ${quantile(sorted, 0.5).toFixed(0).padStart(5)} ms   ` +
        `p95 ${quantile(sorted, 0.95).toFixed(0).padStart(5)} ms   ` +
        `p99 ${quantile(sorted, 0.99).toFixed(0).padStart(5)} ms   ` +
        `max ${sorted[sorted.length - 1]!.toFixed(0).padStart(5)} ms   ` +
        `(${matched.toLocaleString()} rows matched across the pass)`,
    );
    return sorted;
  }

  const cold = await pass('cold');
  const warm = await pass('warm');
  const dense = await pass('dense', true);

  const p95 = quantile(cold, 0.95);
  const warmP95 = quantile(warm, 0.95);
  const denseP95 = quantile(dense, 0.95);

  console.log('');
  // The dense figure decides the verdict. A box scattered over open ocean returns tens of
  // rows; an investigation's AOI returns thousands, and that is the query an analyst waits on.
  const verdict = denseP95 < TARGET_P95_MS ? 'MEETS' : 'MISSES';
  console.log(
    `  NFR-6 target: envelope p95 < ${TARGET_P95_MS} ms at 10,000,000 positions.\n` +
      `  Measured at ${total.toLocaleString()} positions — scattered cold p95 ` +
      `${p95.toFixed(0)} ms, warm p95 ${warmP95.toFixed(0)} ms;\n` +
      `  over the busy corridor p95 ${denseP95.toFixed(0)} ms, which is the figure the ` +
      `verdict uses: ${verdict}.`,
  );
  if (total < 10_000_000) {
    console.log(
      `  NOT a verification of NFR-6 as written: that target is stated at 10,000,000\n` +
        `  positions and this database holds ${total.toLocaleString()}. Latency does not scale\n` +
        `  linearly, so the figure above must be quoted with its document count attached.`,
    );
  }
  console.log('');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
