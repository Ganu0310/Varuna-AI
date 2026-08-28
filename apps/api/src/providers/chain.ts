import { logger } from '../lib/logger.js';
import { ProviderUnavailable } from '../errors.js';
import { PlanetaryComputerClient } from './planetaryComputer.js';
import { CdseClient } from './cdse.js';
import { AsfClient } from './asf.js';
import type {
  CatalogueItem,
  CatalogueSearchParams,
  CatalogueSearchResult,
  ProviderStatus,
  SatelliteCatalogueProvider,
} from './types.js';

/**
 * Provider chains — 06_BACKEND §6.5.1.
 *
 * THE CHAIN RULE, and the reason this file exists:
 *   • a provider FAILURE (transport, circuit open, quota, not configured) advances the chain
 *   • a provider returning ZERO RESULTS does **not** advance it — an empty result is a real
 *     answer, and hiding it behind another provider's data would misrepresent coverage
 *     (13_REAL_DATA_POLICY §13.8, 04_UIUX §4.11)
 *
 * Chain exhaustion produces a structured error stating the CONSEQUENCE, not just the fault.
 */
export const planetaryComputer = new PlanetaryComputerClient();
export const cdse = new CdseClient();
export const asf = new AsfClient();

/** Catalogue order: CDSE is authoritative, MPC is fastest, ASF is the fallback. */
export const SATELLITE_CATALOGUE_CHAIN: SatelliteCatalogueProvider[] = [
  cdse,
  planetaryComputer,
  asf,
];

/** Download order: MPC first — its RTC products are already preprocessed (07_AIML §7.2.4). */
export const SATELLITE_DOWNLOAD_CHAIN: SatelliteCatalogueProvider[] = [
  planetaryComputer,
  cdse,
  asf,
];

export const ALL_SATELLITE_PROVIDERS = [cdse, planetaryComputer, asf];

/**
 * Query every configured provider in the chain **in parallel**, then merge.
 *
 * Parallel rather than sequential because the analyst is waiting and a slow provider must
 * not delay a fast one; the per-provider status makes a partial failure visible instead of
 * silently reducing the result set.
 */
export async function searchCatalogue(
  params: CatalogueSearchParams,
  chain: SatelliteCatalogueProvider[] = SATELLITE_CATALOGUE_CHAIN,
): Promise<CatalogueSearchResult> {
  const settled = await Promise.all(
    chain.map(async (provider): Promise<{ status: ProviderStatus; items: CatalogueItem[] }> => {
      const started = Date.now();

      if (!provider.isConfigured()) {
        return {
          status: {
            provider: provider.name,
            status: 'NOT_CONFIGURED',
            count: 0,
            latencyMs: null,
            reason: `No credentials configured for ${provider.name}.`,
          },
          items: [],
        };
      }

      try {
        const items = await provider.search(params);
        return {
          status: {
            provider: provider.name,
            // Zero results is OK, not an error — it is a real statement about coverage.
            status: items.length === 0 ? 'NO_RESULTS' : 'OK',
            count: items.length,
            latencyMs: Date.now() - started,
          },
          items,
        };
      } catch (err) {
        const latencyMs = Date.now() - started;
        if (err instanceof ProviderUnavailable) {
          return {
            status: {
              provider: provider.name,
              status: mapReason(err.reason),
              count: 0,
              latencyMs,
              reason: err.detail ?? err.reason,
              ...(err.retryAt ? { retryAt: String(err.retryAt) } : {}),
            },
            items: [],
          };
        }
        logger.error({ err, provider: provider.name }, 'unexpected catalogue provider error');
        return {
          status: {
            provider: provider.name,
            status: 'ERROR',
            count: 0,
            latencyMs,
            reason: err instanceof Error ? err.message : String(err),
          },
          items: [],
        };
      }
    }),
  );

  const providerStatus = settled.map((s) => s.status);
  const items = dedupeByProductId(
    settled.flatMap((s) => s.items),
    chain,
  );

  // Every provider failed for a transport-ish reason — nothing answered, so we cannot say
  // anything about coverage. That is UNAVAILABLE, and it is different from "no scenes".
  const anyAnswered = providerStatus.some((s) => s.status === 'OK' || s.status === 'NO_RESULTS');
  if (!anyAnswered) {
    throw new ProviderUnavailable(
      'SATELLITE_CATALOGUE',
      'CHAIN_EXHAUSTED',
      undefined,
      'No satellite catalogue provider could be reached.',
      providerStatus.map((s) => ({ provider: s.provider, outcome: s.status })),
      'Scene search is unavailable. Previously ingested scenes remain usable. ' +
        'No results are shown rather than results from an unverified source.',
    );
  }

  items.sort((a, b) => a.acquiredAt.localeCompare(b.acquiredAt));
  return { items, providerStatus };
}

/**
 * The same acquisition is often listed by several providers. Keep one record per product,
 * preferring the provider earliest in the chain — except that an already-preprocessed
 * (RTC) item wins, because it removes ~10 minutes of SNAP work per scene.
 */
function dedupeByProductId(
  items: CatalogueItem[],
  chain: SatelliteCatalogueProvider[],
): CatalogueItem[] {
  const rank = new Map(chain.map((p, i) => [p.name, i]));
  const best = new Map<string, CatalogueItem>();

  for (const item of items) {
    const key = normaliseProductId(item.productId);
    const existing = best.get(key);
    if (!existing) {
      best.set(key, item);
      continue;
    }
    if (item.preprocessed && !existing.preprocessed) {
      best.set(key, item);
      continue;
    }
    if (item.preprocessed === existing.preprocessed) {
      const a = rank.get(item.provider) ?? 99;
      const b = rank.get(existing.provider) ?? 99;
      if (a < b) best.set(key, item);
    }
  }
  return [...best.values()];
}

/**
 * Providers spell the same product differently — CDSE appends `.SAFE`, MPC drops the
 * trailing unique-id block. Compare on the acquisition-identifying prefix.
 */
function normaliseProductId(id: string): string {
  return id
    .replace(/\.SAFE$/i, '')
    .toUpperCase()
    .slice(0, 62);
}

function mapReason(reason: string): ProviderStatus['status'] {
  if (reason === 'CIRCUIT_OPEN') return 'CIRCUIT_OPEN';
  if (reason === 'QUOTA_EXHAUSTED') return 'QUOTA_EXHAUSTED';
  if (reason === 'NOT_CONFIGURED') return 'NOT_CONFIGURED';
  if (reason.startsWith('HTTP_')) return 'ERROR';
  return 'TIMEOUT';
}
