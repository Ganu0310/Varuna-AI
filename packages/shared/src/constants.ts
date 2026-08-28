/**
 * Cross-service constants. One source of truth for thresholds, enums and chains that the
 * specs pin. Referenced from the API, the worker, and (mirrored) the Python ML service.
 */

// ── Investigation bounds (01_PRD A1, 06_BACKEND §6.4.2) ────────────────
export const MAX_AOI_KM2 = 50_000;
export const MAX_WINDOW_DAYS = 30;

// ── SAR segmentation classes (07_AIML §7.2.1) ─────────────────────────
export const SAR_CLASSES = ['sea_surface', 'oil_spill', 'look_alike', 'ship', 'land'] as const;
export type SarClass = (typeof SAR_CLASSES)[number];
export const SAR_CLASS_INDEX: Record<SarClass, number> = {
  sea_surface: 0,
  oil_spill: 1,
  look_alike: 2,
  ship: 3,
  land: 4,
};

// ── Detection thresholds (02_TRD §2.8.2, 07_AIML §7.2.10) ─────────────
export const DETECTION_MIN_AREA_KM2 = 0.05;
export const DETECTION_MIN_MEAN_OIL_PROB = 0.6;
export const SEGMENTATION_TILE_SIZE = 256;
export const SEGMENTATION_STRIDE = 192;

// ── Drift defaults (02_TRD §2.8.3, 07_AIML §7.3) ─────────────────────
export const DRIFT_DEFAULTS = {
  particleCount: 5_000,
  timeStepMinutes: 15,
  horizonHours: 24,
  maxHorizonHours: 72,
  windDriftCoefficientRange: [0.02, 0.04] as [number, number],
  ekmanDeflectionRangeDeg: [0, 20] as [number, number],
  horizontalDiffusivity: 10, // m^2/s
};

// ── Attribution scoring (02_TRD §2.8.5, 07_AIML §7.5 / §7.6) ─────────
export const MIN_MEASURED_FEATURES = 6;
export const MIN_CALIBRATION_SAMPLES = 30;

export const TIER_THRESHOLDS = { STRONG: 70, MODERATE: 50, WEAK: 30 } as const;
export const TIERS = ['STRONG', 'MODERATE', 'WEAK', 'INSUFFICIENT_EVIDENCE'] as const;
export type Tier = (typeof TIERS)[number];

/** The twelve evidence features with their default (expert-elicited) weights — 07_AIML §7.6. */
export const ATTRIBUTION_FEATURES = [
  { key: 'spatial_proximity', unit: 'km', defaultWeight: 0.18, family: 'spatial' },
  { key: 'temporal_alignment', unit: 'fraction', defaultWeight: 0.16, family: 'temporal' },
  { key: 'track_intersection', unit: 'km', defaultWeight: 0.13, family: 'spatial' },
  { key: 'heading_alignment', unit: 'degrees', defaultWeight: 0.1, family: 'kinematic' },
  { key: 'ais_dark_period', unit: 'minutes', defaultWeight: 0.1, family: 'behavioural' },
  { key: 'speed_consistency', unit: '0-1', defaultWeight: 0.08, family: 'kinematic' },
  { key: 'vessel_type_prior', unit: '0-1', defaultWeight: 0.07, family: 'behavioural' },
  { key: 'origin_density_at_track', unit: 'normalised', defaultWeight: 0.07, family: 'spatial' },
  { key: 'draught_change', unit: 'metres', defaultWeight: 0.05, family: 'behavioural' },
  { key: 'slick_axis_continuity', unit: '0-1', defaultWeight: 0.03, family: 'kinematic' },
  { key: 'manoeuvre_anomaly', unit: '0-1', defaultWeight: 0.02, family: 'kinematic' },
  { key: 'prior_incident_history', unit: 'count', defaultWeight: 0.01, family: 'behavioural' },
] as const;
export type AttributionFeatureKey = (typeof ATTRIBUTION_FEATURES)[number]['key'];
export const DEFAULT_WEIGHT_PROFILE_ID = 'DEFAULT_V1';

// ── AIS (02_TRD §2.4.4, 10_DATASETS §10.4.6) ─────────────────────────
export const AIS_QUALITY_FLAGS = [
  'AIS_GAP',
  'POSITION_JUMP',
  'MMSI_INVALID',
  'MMSI_DUPLICATE',
  'STATIC_MISMATCH',
  'LOW_SAMPLING',
] as const;
export type AisQualityFlag = (typeof AIS_QUALITY_FLAGS)[number];

/** Sentinel values that MUST be mapped to null, never stored as numbers (10_DATASETS §10.4.6). */
export const AIS_SENTINELS = { sog: 102.3, cog: 360.0, heading: 511 } as const;

export const AIS_SOURCES = [
  'MARINE_CADASTRE',
  'DMA_DK',
  'KYSTVERKET_NO',
  'GFW',
  'AISSTREAM',
  'USER_UPLOAD',
] as const;
export type AisSource = (typeof AIS_SOURCES)[number];

// Track reconstruction defaults (06_BACKEND §6.6.2 / §6.6.3)
export const TRACK_RECONSTRUCTION = {
  maxGapMinutes: 20,
  maxImpliedSpeedKn: 45,
  minPoints: 3,
  lowSamplingSec: 600,
};

// ── Provider fallback chains (06_BACKEND §6.5.1) ─────────────────────
export const PROVIDER_CHAINS = {
  SATELLITE_CATALOGUE: ['CDSE', 'PLANETARY_COMPUTER', 'ASF'],
  SATELLITE_DOWNLOAD: ['PLANETARY_COMPUTER', 'CDSE', 'ASF'],
  OCEAN_CURRENTS: ['CMEMS', 'HYCOM'],
  WIND: ['ERA5', 'GFS'],
  AIS_HISTORICAL: ['LOCAL_ARCHIVE', 'MARINE_CADASTRE', 'DMA_DK', 'KYSTVERKET', 'GFW'],
  AIS_LIVE: ['AISSTREAM'],
} as const;

// ── Job queues (03_ARCHITECTURE §3.6) ───────────────────────────────
export const JOB_QUEUES = {
  ingest: { retries: 3, backoffBaseMs: 30_000, concurrency: 8 },
  inference: { retries: 2, backoffBaseMs: 60_000, concurrency: 2 },
  drift: { retries: 3, backoffBaseMs: 20_000, concurrency: 4 },
  'ais-import': { retries: 3, backoffBaseMs: 30_000, concurrency: 8 },
  scoring: { retries: 3, backoffBaseMs: 5_000, concurrency: 8 },
  report: { retries: 2, backoffBaseMs: 15_000, concurrency: 2 },
} as const;
export type QueueName = keyof typeof JOB_QUEUES;

export const JOB_KINDS = [
  'INGEST',
  'DETECTION',
  'DRIFT',
  'AIS_IMPORT',
  'SCORING',
  'REPORT',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

// ── Report (06_BACKEND §6.4.9, 12 F-32) ────────────────────────────
export const MANDATORY_REPORT_SECTIONS = ['UNCERTAINTY', 'PROVENANCE'] as const;

// ── RBAC (01_PRD FR-9.2) ──────────────────────────────────────────
export const ROLES = ['viewer', 'analyst', 'lead', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = { viewer: 0, analyst: 1, lead: 2, admin: 3 };
