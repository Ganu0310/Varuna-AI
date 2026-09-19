import { buildCapabilityReport, type Capability } from './capabilities.js';

/**
 * The Settings page's provider table — a per-PROVIDER reshape of the same capability data
 * `/system/capabilities` reports per STAGE (03_ARCHITECTURE §3.9, 11_API_KEYS).
 *
 * No second source of truth: every `configured` flag here comes from the capability report,
 * which reads it straight off `env` and provider health. This module only regroups it into
 * the three provider families the Settings page shows, and attaches a link into
 * `docs/DATA-AND-CREDENTIALS.md` — the real setup instructions, not a fabricated URL.
 */

export interface Integration {
  key: string;
  label: string;
  category: 'satellite' | 'forcing' | 'ais';
  required: boolean;
  configured: boolean;
  status: string;
  enables: string;
  docs: string;
}

const DOCS_FILE = 'https://github.com/Ganu0310/Varuna-AI/blob/main/docs/DATA-AND-CREDENTIALS.md';

/** Anchors that exist in `docs/DATA-AND-CREDENTIALS.md`, keyed by a substring of the provider name. */
const DOC_ANCHORS: Array<[match: string, anchor: string]> = [
  ['PLANETARY_COMPUTER', '#microsoft-planetary-computer--sentinel-1-rtc-primary-no-credential'],
  ['CDSE', '#copernicus-data-space-ecosystem--sentinel-1-secondary-credential'],
  ['CMEMS', '#copernicus-marine-cmems--ocean-currents-unlocks-real-origin-back-track'],
  ['ERA5', '#climate-data-store-era5--winds-unlocks-non-degraded-origin'],
  ['AISSTREAM', '#aisstreamio--live-ais-unlocks-real-vessel-data'],
  ['GLOBAL FISHING WATCH', '#global-fishing-watch--vessel-metadata-optional'],
];

function docsFor(providerName: string): string {
  const hit = DOC_ANCHORS.find(([match]) => providerName.toUpperCase().includes(match));
  return hit ? `${DOCS_FILE}${hit[1]}` : DOCS_FILE;
}

const CATEGORY_BY_CAPABILITY: Partial<Record<string, Integration['category']>> = {
  satellite: 'satellite',
  ocean_current: 'forcing',
  wind: 'forcing',
  ais: 'ais',
};

/**
 * Only the three capabilities the Settings page groups providers under. Detection,
 * attribution and vessel enrichment are capabilities but not credentialed data SOURCES in
 * the sense this table exists to document, so they are left out rather than shoehorned in.
 */
function flattenProviders(capability: Capability): Integration[] {
  const category = CATEGORY_BY_CAPABILITY[capability.key];
  if (!category) return [];

  return capability.providers.map((p) => ({
    key: `${capability.key}:${p.name}`,
    label: p.name,
    category,
    required: p.role === 'PRIMARY',
    configured: p.configured,
    status: p.configured ? 'CONNECTED' : p.role === 'PRIMARY' ? 'NOT_CONFIGURED' : 'OPTIONAL',
    enables: p.note ?? capability.reason,
    docs: docsFor(p.name),
  }));
}

export async function buildIntegrationsReport(): Promise<{ items: Integration[] }> {
  const report = await buildCapabilityReport();
  return { items: report.capabilities.flatMap(flattenProviders) };
}
