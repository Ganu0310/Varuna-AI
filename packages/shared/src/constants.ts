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

/**
 * Why a rejected detection is rejected — 07_AIML §7.2.12, 06_BACKEND §6.4.5.
 *
 * A rejection already requires a reason in prose. Prose is unusable in aggregate: it cannot
 * answer "which look-alike class does this detector fall for most?", and it cannot become a
 * labelled negative. The measured false-positive rate on the held-out split is 68% on
 * look-alike scenes with a mean look-alike risk of 0.26 — wrong AND unwarned — and the one
 * thing that fixes that is labelled negatives of each physical class. Every rejection an
 * analyst makes is one, if we record which class it was.
 *
 * `kind` separates the two questions a rejection can answer:
 *
 *   LOOK_ALIKE   the analyst judged the pixels are not oil — a statement about the imagery
 *   OPERATIONAL  the rejection is about the workflow, not the pixels — it says nothing at
 *                all about what the detector saw, and must never be trained on
 *
 * `sarClass` is the class these pixels should have carried, and is the single rule for
 * whether a rejection is usable as a training label: **usable iff `sarClass !== null`.**
 * A sensor artefact is genuinely not oil, but it is not a valid sample of any physical
 * class either, so it is a LOOK_ALIKE with no `sarClass` — recorded, and not trained on.
 */
export const REJECTION_CATEGORIES = [
  {
    id: 'LOW_WIND',
    label: 'Low-wind or wind-shadow zone',
    kind: 'LOOK_ALIKE',
    sarClass: 'sea_surface',
    description:
      'Glassy water returns low backscatter for the same reason oil does. The commonest ' +
      'false positive in the literature and the one a wind field would have caught.',
  },
  {
    id: 'BIOGENIC_FILM',
    label: 'Biogenic film or algal slick',
    kind: 'LOOK_ALIKE',
    sarClass: 'look_alike',
    description: 'A natural surfactant damps capillary waves exactly as mineral oil does.',
  },
  {
    id: 'RAIN_CELL',
    label: 'Rain cell',
    kind: 'LOOK_ALIKE',
    sarClass: 'look_alike',
    description: 'Rain damping produces a dark patch, usually with a softer edge than a slick.',
  },
  {
    id: 'SHIP_WAKE',
    label: 'Ship wake or turbulent trail',
    kind: 'LOOK_ALIKE',
    sarClass: 'look_alike',
    description: 'A wake is linear and vessel-attached; a discharge trail is not the same thing.',
  },
  {
    id: 'INTERNAL_WAVE',
    label: 'Internal wave or current shear',
    kind: 'LOOK_ALIKE',
    sarClass: 'look_alike',
    description: 'Oceanographic surface signature — often banded, and repeats across the scene.',
  },
  {
    id: 'SEA_ICE',
    label: 'Sea ice',
    kind: 'LOOK_ALIKE',
    sarClass: 'look_alike',
    description: 'Ice and its leads produce dark features with slick-like outlines.',
  },
  {
    id: 'LAND_OR_STRUCTURE',
    label: 'Land, tidal flat or fixed structure',
    kind: 'LOOK_ALIKE',
    sarClass: 'land',
    description:
      'Dark land — wet asphalt, runways, tidal flats, aquaculture — that the coastline mask ' +
      'did not remove. Each one is a hole in the mask and worth knowing about as such.',
  },
  {
    id: 'SENSOR_ARTEFACT',
    label: 'Sensor or processing artefact',
    kind: 'LOOK_ALIKE',
    sarClass: null,
    description:
      'Azimuth ambiguity, scalloping, thermal-noise banding, radiometric artefact. Not oil, ' +
      'and not a valid sample of any physical class either — recorded, never trained on.',
  },
  {
    id: 'LOOK_ALIKE_UNCLASSIFIED',
    label: 'Not oil — class not determined',
    kind: 'LOOK_ALIKE',
    sarClass: 'look_alike',
    description:
      'The analyst is confident it is not oil but will not name the mechanism. Honest, and ' +
      'still a usable negative.',
  },
  {
    id: 'INSUFFICIENT_IMAGE_QUALITY',
    label: 'Cannot be judged from this scene',
    kind: 'OPERATIONAL',
    sarClass: null,
    description:
      'Noise, far-range incidence angle or partial coverage make the call unsafe. This is an ' +
      'absence of evidence, not evidence of absence, so it is not a negative.',
  },
  {
    id: 'DUPLICATE',
    label: 'Duplicate of another detection',
    kind: 'OPERATIONAL',
    sarClass: null,
    description: 'The same feature is already recorded. Says nothing about the pixels.',
  },
  {
    id: 'SUPERSEDED',
    label: 'Superseded by a better acquisition',
    kind: 'OPERATIONAL',
    sarClass: null,
    description: 'A later or cleaner scene covers the same feature and is being used instead.',
  },
  {
    id: 'OUT_OF_SCOPE',
    label: 'Outside this investigation',
    kind: 'OPERATIONAL',
    sarClass: null,
    description: 'A real feature, but outside the AOI, window or remit of this case.',
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  kind: 'LOOK_ALIKE' | 'OPERATIONAL';
  sarClass: SarClass | null;
  description: string;
}>;

export type RejectionCategory = (typeof REJECTION_CATEGORIES)[number]['id'];
export const REJECTION_CATEGORY_IDS = REJECTION_CATEGORIES.map((c) => c.id) as [
  RejectionCategory,
  ...RejectionCategory[],
];

/** A rejection is usable as a labelled negative iff it names a physical class. */
export function trainingClassFor(id: RejectionCategory): SarClass | null {
  return REJECTION_CATEGORIES.find((c) => c.id === id)?.sarClass ?? null;
}

// ── Detection triage (07_AIML §9, 08_APP_FLOW §8.2) ──────────────────
/*
 * Triage ORDERS THE REVIEW QUEUE. It never adjudicates one.
 *
 * There is no AUTO_CONFIRMED and no AUTO_REJECTED, and that omission is the whole design.
 * On the 66-scene held-out split the shipped detector fired on 68.2% of look-alike scenes,
 * and on those false positives its own look-alike warning channel averaged 0.259 — barely
 * above what it assigns a true slick. `tuning.py` then swept the look-alike risk gate across
 * 0.2-1.0 on 384 development scenes: the best configuration removed 8.5 points of false
 * positives in development and transferred as EXACTLY ZERO improvement on the held-out split.
 * Across every configuration swept, mean risk on false positives stayed in the 0.15-0.29
 * band. The conclusion recorded in 07_AIML §9 is that the look-alike problem is "not
 * reachable by thresholds, area gates, shape gates or risk gates on a classical detector".
 *
 * A status set by a threshold would therefore be a coin flip wearing a label, on a system
 * whose output can be used to accuse a vessel operator. Worse, it would poison the fix: the
 * remedy the evidence points at is labelled negatives from human rejections, and
 * `labels.ts` only counts a detection a human actually looked at. Auto-adjudication would
 * both feed the detector its own output and shrink the supply of real labels.
 *
 * So triage answers a different, answerable question — WHERE IS AN ANALYST'S ATTENTION WORTH
 * MOST? — out of three physical measurements that do not depend on the broken classifier.
 */
export const TRIAGE_WEIGHTS = {
  /** How much this would matter if real. Area is an operational fact, not a judgement. */
  significance: 0.45,
  /** How adjudicable it is: contrast against local sea background, in dB. */
  interpretability: 0.35,
  /** How answerable it is: a linear slick can be matched to a track; a blob cannot. */
  attributability: 0.2,
} as const;

/** Saturation points for the three components. Beyond these, more does not mean more urgent. */
export const TRIAGE_SCALES = {
  /** km². Below the floor a detection is barely above the detector's own minimum area. */
  areaFloorKm2: 0.05,
  areaSaturationKm2: 10,
  /** dB below local background. 07_AIML §7.2.11: ~10 dB is unambiguous separation. */
  contrastSaturationDb: 10,
  /** Elongation ratio. Mirrors the confidence model's shape term, which saturates at 4. */
  elongationSaturation: 4,
} as const;

export const TRIAGE_PRIORITY_THRESHOLDS = { HIGH: 0.6, MEDIUM: 0.35 } as const;
export const TRIAGE_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type TriagePriority = (typeof TRIAGE_PRIORITIES)[number];

/**
 * Speculative precompute — the actual latency win.
 *
 * Back-tracking and correlation are enqueued at ingest so the dossier is already built when
 * the analyst opens the case. The detection stays UNREVIEWED throughout: computing an origin
 * is not the same act as accepting a detection, and only the second one needs a human.
 *
 * The cap exists because a drift run is a 5,000-particle ensemble behind an external OPeNDAP
 * fetch. Spending that on every dark patch in a busy scene would delay the detections an
 * analyst is most likely to open, which is the opposite of the point.
 */
export const TRIAGE_PRECOMPUTE = {
  /** Below this score, wait for a human to ask. */
  minScore: 0.15,
  /** Highest-scoring N detections per scene. */
  maxPerScene: 5,
} as const;

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
  { key: 'ais_dark_period', unit: 'minutes', defaultWeight: 0.08, family: 'behavioural' },
  { key: 'vessel_type_risk', unit: '0-1', defaultWeight: 0.08, family: 'behavioural' },
  { key: 'ais_dark_period_anomaly', unit: '0-1', defaultWeight: 0.08, family: 'behavioural' },
  { key: 'speed_consistency', unit: '0-1', defaultWeight: 0.06, family: 'kinematic' },
  { key: 'vessel_type_prior', unit: '0-1', defaultWeight: 0.04, family: 'behavioural' },
  { key: 'origin_density_at_track', unit: 'normalised', defaultWeight: 0.04, family: 'spatial' },
  { key: 'draught_change', unit: 'metres', defaultWeight: 0.02, family: 'behavioural' },
  { key: 'slick_axis_continuity', unit: '0-1', defaultWeight: 0.015, family: 'kinematic' },
  { key: 'manoeuvre_anomaly', unit: '0-1', defaultWeight: 0.01, family: 'kinematic' },
  { key: 'prior_incident_history', unit: 'count', defaultWeight: 0.005, family: 'behavioural' },
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
  // Concurrency 1: a sweep tick fans out into many INGEST enqueues itself (one per scene per
  // watch region), so the tick job's own body is cheap orchestration — running two ticks at
  // once would only double-enqueue the same work, never finish it faster (06_BACKEND §6.4.10).
  sweep: { retries: 1, backoffBaseMs: 60_000, concurrency: 1 },
} as const;
export type QueueName = keyof typeof JOB_QUEUES;

export const JOB_KINDS = [
  'INGEST',
  'DETECTION',
  'DRIFT',
  'AIS_IMPORT',
  'SCORING',
  'REPORT',
  'SWEEP_TICK',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

// ── Report (06_BACKEND §6.4.9, 12 F-32) ────────────────────────────
export const MANDATORY_REPORT_SECTIONS = ['UNCERTAINTY', 'PROVENANCE'] as const;

// ── RBAC (01_PRD FR-9.2) ──────────────────────────────────────────
export const ROLES = ['viewer', 'analyst', 'lead', 'admin'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_RANK: Record<Role, number> = { viewer: 0, analyst: 1, lead: 2, admin: 3 };
