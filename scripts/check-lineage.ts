/**
 * Provenance lineage gate — 14 §14.6 Phase 13, 13_REAL_DATA_POLICY §13.5.1.
 *
 * `pnpm check:lineage`
 *
 * Every hop in the pipeline has its own unit and integration tests. What none of them can
 * check is the property that actually matters: that the chain from a named vessel back to a
 * retrievable provider product is unbroken. Each link can be individually correct while the
 * chain has a gap, and a gap means a number in a dossier nobody can trace to a source.
 *
 * This runs against the OPERATIONAL database rather than the test one, on purpose. It
 * asserts nothing about fixtures — it inspects the artefacts the real pipeline actually
 * produced. That is why it is a gate and not a `*.integration.test.ts`: the integration
 * suite builds its own world in `varuna_test`, and a lineage check over a world the test
 * just built proves only that the test can build a world.
 *
 * It is READ-ONLY. It performs no writes of any kind.
 *
 * If no completed chain exists it FAILS rather than skipping. A lineage check that passes
 * green on an empty database is worse than no check at all.
 */
import mongoose, { Types } from 'mongoose';
import { connectMongo, disconnectMongo } from '../apps/api/src/db/connection.js';
import { InvestigationModel } from '../apps/api/src/modules/investigations/model.js';
import { SatelliteSceneModel } from '../apps/api/src/modules/scenes/model.js';
import { SpillDetectionModel } from '../apps/api/src/modules/detections/model.js';
import { OriginEstimateModel } from '../apps/api/src/modules/origin/model.js';
import { CandidateVesselModel } from '../apps/api/src/modules/candidates/model.js';
import { ProvenanceRecordModel } from '../apps/api/src/modules/provenance/model.js';
import { buildReportData } from '../apps/api/src/modules/reports/service.js';
import { toGeoJson, toCsv, toManifest } from '../apps/api/src/modules/reports/exports.js';

const problems: string[] = [];
const notes: string[] = [];

function check(label: string, ok: boolean, detail: string) {
  if (ok) notes.push(label);
  else problems.push(`${label} — ${detail}`);
}

async function main() {
  await connectMongo();
  const dbName = mongoose.connection.db?.databaseName;

  const anchor = await CandidateVesselModel.findOne().sort({ createdAt: -1 }).lean();
  if (!anchor) {
    console.error(
      `\nNo candidate vessels in "${dbName}", so there is no completed chain to trace.\n` +
        'Run the pipeline first: ingest → origin → correlate.\n' +
        'This gate deliberately does not fabricate one — the point is to check real artefacts.\n',
    );
    await disconnectMongo();
    process.exit(1);
  }
  const investigationId = String(anchor.investigationId);
  const oid = new Types.ObjectId(investigationId);
  const inv = await InvestigationModel.findById(oid).lean();

  console.log(`\nprovenance lineage — database "${dbName}"`);
  console.log(`  investigation   ${investigationId}${inv ? ` (${inv.name})` : ''}\n`);

  // ── 1. The provenance DAG has no dangling edges ──────────────────────────
  const records = await ProvenanceRecordModel.find().lean();
  const ids = new Set(records.map((r) => String(r._id)));
  const dangling: string[] = [];
  for (const r of records) {
    for (const parent of r.derivedFrom ?? []) {
      // A derived record pointing at a parent that no longer exists is a broken chain: the
      // value still renders, and the trail to its source ends in nothing.
      if (!ids.has(String(parent))) {
        dangling.push(`${r.datasetId} → missing parent ${String(parent)}`);
      }
    }
  }
  check(
    `${records.length} provenance records, every derivedFrom edge resolves`,
    dangling.length === 0,
    dangling.join('; '),
  );

  // ── 2. Nothing stored claims a fabricated source ─────────────────────────
  // The Zod schema forbids this on the WRITE path; this checks what is actually stored,
  // which is what a reader would be shown.
  const forbidden = /MOCK|SYNTHETIC|FAKE|DEMO|TEST|PLACEHOLDER|SAMPLE|DUMMY/i;
  const offenders = records.filter(
    (r) => forbidden.test(String(r.sourceType)) || forbidden.test(String(r.provider)),
  );
  check(
    'no stored provenance record names a fabricated source',
    offenders.length === 0,
    offenders.map((r) => `${r.sourceType}/${r.provider}`).join('; '),
  );

  // ── 3. Every artefact in the chain carries provenance, hop by hop ────────
  const [scenes, detections, candidates, origin] = await Promise.all([
    SatelliteSceneModel.find({ investigationId: oid }).lean(),
    SpillDetectionModel.find({ investigationId: oid }).lean(),
    CandidateVesselModel.find({ investigationId: oid }).lean(),
    OriginEstimateModel.findOne({ investigationId: oid }).sort({ createdAt: -1 }).lean(),
  ]);

  check(`${scenes.length} scene(s) ingested`, scenes.length > 0, 'none');
  check(`${detections.length} detection(s) produced`, detections.length > 0, 'none');
  check(`${candidates.length} candidate(s) ranked`, candidates.length > 0, 'none');

  // A satellite scene must name a product an independent party can retrieve. An empty
  // externalId satisfies a presence check and traces to nothing.
  const unsourcedScenes = scenes.filter(
    (s) => !s.provenance?.externalId || !s.provenance?.provider,
  );
  check(
    'every scene names a retrievable provider product',
    unsourcedScenes.length === 0,
    unsourcedScenes.map((s) => String(s.productId)).join('; '),
  );

  // A detection is DERIVED — it must point back at the scene it came from, or the shape on
  // the map has no observational basis.
  const orphanDetections = detections.filter((d) => (d.provenance?.derivedFrom?.length ?? 0) === 0);
  check(
    'every detection links back to the scene it came from',
    orphanDetections.length === 0,
    `${orphanDetections.length} detection(s) with an empty derivedFrom`,
  );

  // A DEGRADED origin must carry its reason in the DATABASE, not only in a log line the
  // report cannot read.
  if (origin) {
    check(
      `origin estimate present (${origin.status} / ${origin.method})`,
      origin.status !== 'DEGRADED' || Boolean(origin.degradationReason),
      'origin is DEGRADED but stores no reason — the report and UI cannot explain it',
    );
  }

  // ── 4. No candidate reports a score outside its own interval ─────────────
  // Found on the real Guam incident: rank 1 scored 80.6 with a percentile CI of [72.0, 75.1].
  // The cause was a boundary — a 0 km closest approach cannot get closer, so every resample
  // scored lower — but a dossier cannot ship an interval that excludes its own number.
  const incoherent = candidates
    .filter((c) => Array.isArray(c.scoreCI) && c.scoreCI.length === 2)
    .filter((c) => c.score < c.scoreCI![0]! || c.score > c.scoreCI![1]!)
    .map((c) => `mmsi ${c.mmsi}: ${c.score} outside [${c.scoreCI![0]}, ${c.scoreCI![1]}]`);
  check(
    'every score sits inside its own confidence interval',
    incoherent.length === 0,
    incoherent.join('; '),
  );

  // ── 5. A degraded origin caps every tier at MODERATE ─────────────────────
  if (origin?.status === 'DEGRADED') {
    const strong = candidates.filter((c) => c.tier === 'STRONG');
    check(
      'origin is DEGRADED, so no candidate is tiered STRONG',
      strong.length === 0,
      `${strong.length} STRONG candidate(s) — a proximity zone cannot separate a discharging ` +
        'vessel from passing traffic, and the cap has regressed',
    );
  }

  // ── 6. The dossier carries its mandatory sections, with content ──────────
  // Asking for a dossier WITHOUT the mandatory sections must be REFUSED, not quietly
  // corrected. Silently adding them back would be safe output from a caller who believes
  // they opted out — and the next caller would build on that belief.
  let refused = false;
  try {
    await buildReportData(investigationId, ['SUMMARY', 'CANDIDATES']);
  } catch (err) {
    refused = (err as { status?: number }).status === 422;
  }
  check(
    'a dossier requested without UNCERTAINTY/PROVENANCE is refused with 422',
    refused,
    'the request was accepted — the caveats would have been silently omitted or silently added',
  );

  const data = await buildReportData(investigationId, [
    'SUMMARY',
    'CANDIDATES',
    'UNCERTAINTY',
    'PROVENANCE',
  ]);
  // Headings are not enough. An empty uncertainty statement passes a structural check while
  // telling the reader nothing.
  check(
    `${data.uncertainty.statements.length} uncertainty statement(s) with real content`,
    data.uncertainty.statements.length > 0 &&
      /not a determination of responsibility/i.test(data.uncertainty.overall),
    'the uncertainty section is empty or has lost its framing sentence',
  );
  // Guards the `provenance` key collision that once blanked this whole object: the guard
  // validates any key named `provenance` as a provenance RECORD, so the appendix must not be
  // published under that name.
  check(
    'the provenance appendix is not published under the reserved key `provenance`',
    (data as unknown as Record<string, unknown>).provenance === undefined,
    'the appendix would be stripped from the response as a malformed provenance record',
  );

  // ── 7. Exports stay traceable once detached from the report ──────────────
  const geojson = toGeoJson(data) as { features: Array<{ properties: Record<string, unknown> }> };
  const detectionFeatures = geojson.features.filter((f) => f.properties.kind === 'DETECTION');
  check(
    `${detectionFeatures.length} exported detection(s) carry provenance inline`,
    detectionFeatures.length > 0 && detectionFeatures.every((f) => f.properties.provenance),
    'a GeoJSON opened in QGIS, separated from the report, could not say where it came from',
  );

  const header = toCsv(data).split('\n')[0] ?? '';
  // The long format exists so a MISSING feature is distinguishable from a zero one. Without
  // a status column, a blank cell reads as "measured, and it was nil".
  check(
    'the CSV distinguishes an unmeasured feature from a zero one',
    header.includes('feature_status') && header.includes('raw_value'),
    header,
  );

  const manifest = toManifest(data) as Record<string, unknown>;
  check(
    'the manifest pins the inputs and travels with the uncertainty statement',
    Boolean(manifest.uncertainty) &&
      Boolean(manifest.provenanceAppendix) &&
      (manifest.sceneProductIds as string[]).length > 0,
    'the manifest is missing its uncertainty, appendix or scene product IDs',
  );

  // ── report ───────────────────────────────────────────────────────────────
  for (const n of notes) console.log(`  ok   ${n}`);
  for (const p of problems) console.log(`  FAIL ${p}`);
  console.log('');

  await disconnectMongo();

  if (problems.length) {
    console.error(`${problems.length} broken link(s) in the provenance chain.\n`);
    process.exit(1);
  }
  console.log('The chain from a named vessel back to a provider product is unbroken.\n');
}

main().catch(async (err) => {
  console.error(err);
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
