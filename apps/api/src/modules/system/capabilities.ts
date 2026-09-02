import mongoose from 'mongoose';
import { env } from '../../env.js';
import { logger } from '../../lib/logger.js';
import { ALL_SATELLITE_PROVIDERS } from '../../providers/chain.js';
import { OriginEstimateModel } from '../origin/model.js';

/**
 * The system capability matrix — 14 Phase 17, 02_TRD §2.9, 13_REAL_DATA_POLICY §13.8.
 *
 * One question, answered for every stage of the chain: **can this stage do its job right
 * now, and if not, what exactly is missing and what does that cost the answer?**
 *
 * Three states, and the middle one is the point:
 *
 *   AVAILABLE   the stage runs on real data from a real provider
 *   DEGRADED    the stage runs, but on a weaker footing that changes what may be claimed
 *   UNAVAILABLE the stage cannot run at all
 *
 * A binary up/down would collapse DEGRADED into one of the other two, and DEGRADED is the
 * state this system spends most of its life in. Every degraded capability carries both a
 * `reason` (what is missing) and a `consequence` (what it costs the conclusion), because a
 * judge, an analyst and a regulator all need the second one and only an operator needs the
 * first.
 *
 * Nothing here probes a provider over the network. Reporting configuration and recorded
 * health is fast, safe to call on every page load, and cannot itself fail in a way that
 * makes the status panel lie. Live reachability belongs to `/health/deep` and to the
 * per-provider circuit-breaker state, which this surfaces rather than duplicates.
 */

export type CapabilityState = 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'OPTIONAL';

export interface Capability {
  key: string;
  label: string;
  state: CapabilityState;
  /** What is configured or missing. Operator-facing. */
  reason: string;
  /** What this state costs the conclusion. Analyst- and judge-facing. */
  consequence: string;
  /** The providers behind this capability, in chain order. */
  providers: Array<{
    name: string;
    configured: boolean;
    role: 'PRIMARY' | 'FALLBACK' | 'ENRICHMENT';
    note?: string;
  }>;
}

export interface CapabilityReport {
  generatedAt: string;
  /** The weakest link, because the chain is only as strong as it. */
  overall: CapabilityState;
  capabilities: Capability[];
  note: string;
}

/**
 * Whether any AIS has actually been imported.
 *
 * Configuration cannot answer this one: the bulk archives need no credential, so "AIS is
 * configured" is trivially true and tells nobody anything. What matters is whether positions
 * exist to correlate against, so this asks the collection.
 *
 * `ais_positions` is a TIME-SERIES collection, which is why this counts a capped sample
 * rather than calling `estimatedDocumentCount()`. That method reports the metadata of the
 * underlying bucket collection, so on a time-series collection it returns the number of
 * BUCKETS, not measurements — a number some orders of magnitude below the truth, which the
 * panel would then print as the size of the evidence base. The panel only needs "some" or
 * "none", so it asks for at most one document and says so.
 */
async function aisCapability(): Promise<Capability> {
  const base = {
    key: 'ais',
    label: 'AIS',
    providers: [
      {
        name: 'NOAA Marine Cadastre',
        configured: true,
        role: 'PRIMARY' as const,
        note: 'Bulk historical archive, no credential required. US waters only.',
      },
      {
        name: 'Danish Maritime Authority',
        configured: Boolean(env.DMA_AIS_BASE_URL),
        role: 'FALLBACK' as const,
        note: 'Danish waters.',
      },
      {
        name: 'AISStream',
        configured: Boolean(env.AISSTREAM_API_KEY),
        role: 'FALLBACK' as const,
        note: 'Live stream, server-side only. Not used for historical attribution.',
      },
    ],
  };

  let present = false;
  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error('no mongo connection');
    present =
      (await db.collection('ais_positions').findOne({}, { projection: { _id: 1 } })) !== null;
  } catch (err) {
    logger.warn({ err }, 'AIS capability probe could not reach the position store');
    return {
      ...base,
      state: 'UNAVAILABLE',
      reason: 'The AIS store could not be reached to count positions.',
      consequence:
        'Correlation cannot run. No candidate list is produced — which is a statement about ' +
        'our data, not about the vessels that were there.',
    };
  }

  if (!present) {
    return {
      ...base,
      state: 'UNAVAILABLE',
      reason: 'No AIS positions have been imported.',
      consequence:
        'No AIS evidence is available for any region or time window. The system returns an ' +
        'explicit reason rather than an empty candidate list, because "no vessels found" and ' +
        '"we could not look" are different claims.',
    };
  }

  return {
    ...base,
    state: 'AVAILABLE',
    reason:
      'AIS positions are held in the store, imported from the NOAA Marine Cadastre archive. ' +
      'Per-area counts come from the coverage endpoint, which measures rather than estimates.',
    consequence:
      'Coverage is US waters only. Outside it, imagery and detections still work and the ' +
      'candidate list is empty for want of receivers, not for want of vessels — the AOI ' +
      'picker states this per region before an area is committed to.',
  };
}

function satelliteCapability(): Capability {
  const providers = ALL_SATELLITE_PROVIDERS.map((p) => {
    const health = p.health();
    return {
      name: p.name,
      configured: p.isConfigured(),
      role: (p.name === 'PLANETARY_COMPUTER' ? 'PRIMARY' : 'FALLBACK') as 'PRIMARY' | 'FALLBACK',
      ...(health.circuit && health.circuit.state !== 'CLOSED'
        ? { note: `circuit ${health.circuit.state}` }
        : {}),
    };
  });

  const configured = providers.filter((p) => p.configured);

  if (configured.length === 0) {
    return {
      key: 'satellite',
      label: 'Satellite',
      state: 'UNAVAILABLE',
      reason: 'No satellite catalogue provider is configured.',
      consequence: 'No scene can be searched or ingested, so the chain cannot start.',
      providers,
    };
  }

  return {
    key: 'satellite',
    label: 'Satellite',
    // One working provider is enough to run; fewer than the full chain is a resilience
    // question, not a data-quality one, so it does not degrade the ANSWER.
    state: 'AVAILABLE',
    reason:
      `${configured.length} of ${providers.length} catalogue providers configured ` +
      `(${configured.map((p) => p.name).join(', ')}).`,
    consequence:
      configured.length === providers.length
        ? 'Full provider redundancy: a single outage does not stop scene ingest.'
        : 'Scene ingest works. With fewer providers configured, a single outage is more ' +
          'likely to stop it — this affects availability, not the quality of any result.',
    providers,
  };
}

function oceanCurrentCapability(): Capability {
  const cmems = Boolean(env.CMEMS_USERNAME && env.CMEMS_PASSWORD);
  const providers = [
    {
      name: 'Copernicus Marine (CMEMS)',
      configured: cmems,
      role: 'PRIMARY' as const,
      note: 'GLOBAL_ANALYSISFORECAST_PHY_001_024 — 1/12°, hourly surface uo/vo.',
    },
    {
      name: 'HYCOM',
      configured: true,
      role: 'FALLBACK' as const,
      note: 'Keyless OPeNDAP. Archive ends 2024-09-05; operational feed covers ~2 weeks. Dates between are uncovered.',
    },
  ];

  if (cmems) {
    return {
      key: 'ocean_current',
      label: 'Ocean Current',
      state: 'AVAILABLE',
      reason: 'CMEMS credentials are configured; the drift model integrates a real current field.',
      consequence:
        'Back-tracking produces a drift-derived origin probability surface and a bounded ' +
        'release-time window, rather than a proximity buffer around the observed slick.',
      providers,
    };
  }

  return {
    key: 'ocean_current',
    label: 'Ocean Current',
    state: 'DEGRADED',
    reason:
      'No CMEMS credentials. Only the keyless HYCOM chain remains, and it has a coverage gap ' +
      'between its reanalysis archive and its operational feed.',
    consequence:
      'For a date inside that gap the origin estimate falls back to FOOTPRINT_PROXIMITY — a ' +
      'buffer around the observed slick, which cannot distinguish upstream from downstream. ' +
      'Every candidate is then capped at MODERATE.',
    providers,
  };
}

/**
 * What the wind chain ACTUALLY returned on the most recent drift run.
 *
 * Configuration is not capability, and wind is where the gap bites hardest. A CDS key can be
 * present, valid, and still refused: ERA5 requires a per-dataset licence acceptance on the
 * Climate Data Store website, and until someone clicks it every retrieval answers
 * `403 required licences not accepted`. Reporting "Wind: AVAILABLE" off the presence of a key
 * would put a green light on the judge's status panel while every origin estimate in the
 * system carried `windStatus: UNKNOWN`.
 *
 * So the panel prefers evidence over configuration: the last recorded run wins, and only
 * falls back to configuration when nothing has run yet.
 */
async function lastWindOutcome(): Promise<{ status: string; detail: string | null } | null> {
  try {
    const latest = await OriginEstimateModel.findOne({}, { windStatus: 1, providerAttempts: 1 })
      .sort({ createdAt: -1 })
      .lean();
    if (!latest?.windStatus) return null;
    const attempt = (latest.providerAttempts ?? []).find(
      (a) => a.provider?.startsWith('ERA5') && a.outcome !== 'NOT_CONFIGURED',
    );
    return {
      status: String(latest.windStatus),
      detail: attempt ? `${attempt.provider}: ${attempt.outcome}` : null,
    };
  } catch (err) {
    logger.warn({ err }, 'could not read the last recorded wind outcome');
    return null;
  }
}

async function windCapability(): Promise<Capability> {
  const local = Boolean(env.ERA5_LOCAL_PATH);
  const cds = Boolean(env.CDSAPI_KEY);
  const providers = [
    {
      name: 'ERA5 (operator-supplied file)',
      configured: local,
      role: 'PRIMARY' as const,
      note: 'A real ERA5 GRIB/NetCDF already on disk. Used only where it covers the requested box and window.',
    },
    {
      name: 'ERA5 (Climate Data Store API)',
      configured: cds,
      role: 'FALLBACK' as const,
      note: 'reanalysis-era5-single-levels — 0.25°, hourly 10 m u/v.',
    },
  ];

  if (local || cds) {
    const last = await lastWindOutcome();

    // A run happened and came back without wind. That is a measurement, and it beats the
    // fact that a credential exists.
    if (last && last.status !== 'OBSERVED' && last.status !== 'NOT_ATTEMPTED') {
      return {
        key: 'wind',
        label: 'Wind',
        state: 'DEGRADED',
        reason:
          'A wind source is configured, but the last drift run could not obtain a field' +
          (last.detail ? ` — ${last.detail}.` : '.') +
          (last.detail?.includes('FORBIDDEN')
            ? ' ERA5 needs its licence accepted once, per dataset, on the Climate Data Store' +
              ' website before any retrieval succeeds.'
            : ''),
        consequence:
          'The wind-drift coefficient is set to zero, so a slick that was in fact wind-driven ' +
          'has its origin under-displaced. The detector’s wind-suitability term reads 0.5 ' +
          '("unknown"), never 1.0 — absence of a measurement is not evidence of good conditions.',
        providers,
      };
    }

    return {
      key: 'wind',
      label: 'Wind',
      state: last?.status === 'OBSERVED' ? 'AVAILABLE' : 'DEGRADED',
      reason:
        last?.status === 'OBSERVED'
          ? 'The last drift run integrated a real ERA5 10 m wind field.'
          : (local
              ? 'A local ERA5 file is configured, but no drift run has yet confirmed it covers a requested window.'
              : 'CDS credentials are configured, but no drift run has yet confirmed ERA5 returns data.') +
            ' Until one does, wind is reported as unconfirmed rather than available.',
      consequence:
        'When a field is obtained the drift model includes the wind-induced term and the ' +
        'detector’s wind-suitability gate reads an observed speed instead of "unknown". ' +
        'Coverage is checked per run: a window the source does not span is reported UNKNOWN ' +
        'rather than filled in.',
      providers,
    };
  }

  return {
    key: 'wind',
    label: 'Wind',
    state: 'DEGRADED',
    reason: 'No ERA5 source configured — neither a local file nor a Climate Data Store key.',
    consequence:
      'The wind-drift coefficient is set to zero, so a slick that was in fact wind-driven has ' +
      'its origin under-displaced. The detector’s wind-suitability term reads 0.5 ("unknown"), ' +
      'never 1.0 — absence of a measurement is not evidence of good conditions.',
    providers,
  };
}

function enrichmentCapability(): Capability {
  const gfw = Boolean(env.GFW_API_TOKEN);
  return {
    key: 'vessel_enrichment',
    label: 'Vessel Enrichment',
    // OPTIONAL, not DEGRADED: enrichment adds context to a candidate and changes no score.
    // Marking it DEGRADED would drag `overall` down for something that costs the conclusion
    // nothing.
    state: gfw ? 'AVAILABLE' : 'OPTIONAL',
    reason: gfw
      ? 'Global Fishing Watch token configured; candidate vessels are enriched with public identity and activity context.'
      : 'No Global Fishing Watch token. Global vessel enrichment unavailable.',
    consequence: gfw
      ? 'Candidates carry GFW identity and activity context alongside the AIS-derived evidence. ' +
        'Enrichment is context only — it does not enter the attribution score.'
      : 'Candidates are ranked on AIS-derived evidence alone. Identity beyond the MMSI and its ' +
        'MID-derived flag is not shown. No score or ranking changes.',
    providers: [{ name: 'Global Fishing Watch', configured: gfw, role: 'ENRICHMENT' as const }],
  };
}

function detectionCapability(): Capability {
  return {
    key: 'oil_detection',
    label: 'Oil Detection',
    state: 'AVAILABLE',
    reason: 'The classical dark-spot detector (darkspot-v1) runs on every ingested scene.',
    consequence:
      'Detection is a candidate generator, not a classifier. Measured on a held-out real ' +
      'split it overlaps every true slick but also fires on look-alike scenes, so every ' +
      'detection carries an explicit look-alike risk and requires analyst review before it ' +
      'can drive an origin estimate.',
    providers: [{ name: 'darkspot-v1 (in-service)', configured: true, role: 'PRIMARY' as const }],
  };
}

function attributionCapability(oceanState: CapabilityState, aisState: CapabilityState): Capability {
  if (aisState === 'UNAVAILABLE') {
    return {
      key: 'attribution',
      label: 'Attribution',
      state: 'UNAVAILABLE',
      reason: 'Attribution needs AIS positions to correlate against, and none are available.',
      consequence:
        'No candidate list is produced. This is a statement about AIS coverage, not a ' +
        'finding that no vessel was responsible.',
      providers: [{ name: 'VARUNA 12-feature scorer', configured: true, role: 'PRIMARY' as const }],
    };
  }

  const degraded = oceanState === 'DEGRADED';
  return {
    key: 'attribution',
    label: 'Attribution',
    state: degraded ? 'DEGRADED' : 'AVAILABLE',
    reason: degraded
      ? 'Scoring runs, but against an origin zone derived by proximity rather than by drift.'
      : 'Scoring runs against a drift-derived origin zone and a bounded release window.',
    consequence: degraded
      ? 'Every candidate is capped at MODERATE, and temporal alignment is withheld as ' +
        'NOT_APPLICABLE because a WIDE release window does not separate vessels. The output ' +
        'remains a ranked investigative lead, never a verdict.'
      : 'Candidates are ranked on up to twelve measured features with bootstrap confidence ' +
        'intervals. Scores are UNCALIBRATED and comparable within one report only. The output ' +
        'is a ranked investigative lead with evidence and uncertainty, never a verdict.',
    providers: [{ name: 'VARUNA 12-feature scorer', configured: true, role: 'PRIMARY' as const }],
  };
}

const ORDER: Record<CapabilityState, number> = {
  UNAVAILABLE: 0,
  DEGRADED: 1,
  // OPTIONAL never drags the overall state down: it is a capability whose absence costs the
  // conclusion nothing, and treating it as a fault would train people to ignore the panel.
  OPTIONAL: 3,
  AVAILABLE: 2,
};

export async function buildCapabilityReport(): Promise<CapabilityReport> {
  const ocean = oceanCurrentCapability();
  const [ais, wind] = await Promise.all([aisCapability(), windCapability()]);

  const capabilities: Capability[] = [
    satelliteCapability(),
    detectionCapability(),
    ocean,
    wind,
    ais,
    enrichmentCapability(),
    attributionCapability(ocean.state, ais.state),
  ];

  const overall = capabilities.reduce<CapabilityState>((worst, c) => {
    return ORDER[c.state] < ORDER[worst] ? c.state : worst;
  }, 'AVAILABLE');

  return {
    generatedAt: new Date().toISOString(),
    overall,
    capabilities,
    note:
      'Configuration and recorded provider health, not a live network probe. A DEGRADED ' +
      'capability still runs — the consequence field states what it costs the conclusion.',
  };
}
