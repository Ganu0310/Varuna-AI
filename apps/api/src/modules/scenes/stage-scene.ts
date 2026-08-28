/**
 * Stage one scene's AOI window into object storage, without an investigation.
 *
 * Used by `pnpm run stage:demo` so the COGs and their provenance exist before the demo
 * begins. Detection is NOT run here: staging caches inputs, never results
 * (13_REAL_DATA_POLICY §13.10).
 */
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { connectMongo, disconnectMongo } from '../../db/connection.js';
import { bootstrapDatabase } from '../../db/bootstrap.js';
import { recordProvenance } from '../provenance/service.js';

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

interface MlIngestResponse {
  product_id: string;
  collection: string;
  acquired_at: string;
  crs: string;
  width: number;
  height: number;
  bucket: string;
  cog_keys: Record<string, string>;
  size_bytes: number;
  valid_pixel_fraction: number;
  preprocessing: string;
  seconds: number;
  provenance: {
    provider: string;
    datasetId: string;
    externalId: string;
    retrievedAt: string;
    licence: string;
    accessUrl?: string;
  };
}

async function main(): Promise<void> {
  const productId = arg('product');
  const aoi = arg('aoi').split(',').map(Number);
  const collection = arg('collection', 'sentinel-1-rtc');

  await connectMongo();
  await bootstrapDatabase();

  const res = await fetch(`${env.ML_SERVICE_URL}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Service-Token': env.ML_SERVICE_TOKEN },
    body: JSON.stringify({ productId, aoi, collection }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logger.error({ status: res.status, detail: detail.slice(0, 400) }, 'scene staging failed');
    await disconnectMongo();
    process.exit(1);
  }

  const ing = (await res.json()) as MlIngestResponse;

  // The provenance record is the PROVIDER's, not ours: staging is caching, so the source of
  // record stays Planetary Computer with its original identifiers and checksum.
  const provenanceId = await recordProvenance({
    sourceType: 'SATELLITE_SCENE',
    provider: ing.provenance.provider,
    datasetId: ing.provenance.datasetId,
    externalId: ing.provenance.externalId,
    retrievedAt: ing.provenance.retrievedAt,
    licence: ing.provenance.licence,
    accessUrl: ing.provenance.accessUrl,
    derivedFrom: [],
  });

  console.log(`
  product        ${ing.product_id}
  collection     ${ing.collection}
  acquired       ${ing.acquired_at}
  crs            ${ing.crs}   ${ing.width} x ${ing.height} px
  preprocessing  ${ing.preprocessing}
  valid pixels   ${(ing.valid_pixel_fraction * 100).toFixed(1)}%
  stored         ${Object.values(ing.cog_keys).join(', ')}
  size           ${(ing.size_bytes / 1e6).toFixed(0)} MB
  elapsed        ${ing.seconds}s
  provenance     ${provenanceId}`);

  await disconnectMongo();
}

main().catch(async (err) => {
  logger.error({ err }, 'stage-scene failed');
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
