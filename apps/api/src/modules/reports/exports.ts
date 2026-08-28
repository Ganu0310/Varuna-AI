import type { ReportData } from './service.js';

/**
 * Machine-readable exports — 06_BACKEND §6.4.9, 01_PRD NFR-19.
 *
 * These exist so a finding can be checked by someone who does not trust our UI. The GeoJSON
 * opens in QGIS, the CSV in a spreadsheet, and the manifest pins every input precisely
 * enough to re-run the analysis. Each carries its provenance inline rather than in a
 * separate file, because an exported feature that gets separated from its source record is
 * exactly the artefact this project exists to avoid.
 */

export function toGeoJson(data: ReportData): Record<string, unknown> {
  const features: Record<string, unknown>[] = [];

  const inv = data.investigation as { _id: unknown; name: string; aoi: unknown };
  features.push({
    type: 'Feature',
    geometry: inv.aoi,
    properties: {
      kind: 'AOI',
      investigationId: String(inv._id),
      name: inv.name,
      provenance: { provider: 'Analyst', datasetId: 'investigation-aoi' },
    },
  });

  for (const d of data.detections) {
    const det = d as {
      _id: unknown;
      geometry: unknown;
      areaKm2: number;
      confidence: Record<string, number>;
      morphology: Record<string, number>;
      reviewStatus: string;
      provenance: Record<string, unknown>;
    };
    features.push({
      type: 'Feature',
      geometry: det.geometry,
      properties: {
        kind: 'DETECTION',
        id: String(det._id),
        areaKm2: det.areaKm2,
        confidence: det.confidence?.overall,
        lookAlikeRisk: det.confidence?.lookAlikeCompetition,
        elongationRatio: det.morphology?.elongationRatio,
        reviewStatus: det.reviewStatus,
        // Inline, so the feature stays traceable if this file is separated from the report.
        provenance: det.provenance,
      },
    });
  }

  if (data.origin) {
    const o = data.origin as {
      _id: unknown;
      method: string;
      status: string;
      degradationReason: string | null;
      originField?: { support90?: unknown; support50?: unknown };
    };
    for (const [key, geom] of [
      ['ORIGIN_SUPPORT_90', o.originField?.support90],
      ['ORIGIN_SUPPORT_50', o.originField?.support50],
    ] as const) {
      if (!geom) continue;
      features.push({
        type: 'Feature',
        geometry: geom,
        properties: {
          kind: key,
          method: o.method,
          status: o.status,
          // The degradation reason travels with the geometry: a proximity buffer must never
          // be mistaken for a drift-derived origin zone in QGIS.
          degradationReason: o.degradationReason,
        },
      });
    }
  }

  return {
    type: 'FeatureCollection',
    features,
    properties: {
      generatedAt: data.generatedAt,
      manifest: data.manifest,
      note: data.uncertainty.overall,
    },
  };
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Candidates plus their per-feature contributions, one row per feature.
 *
 * Long format rather than wide, because a MISSING feature needs a status column: a blank
 * cell in a wide table is indistinguishable from a zero, which is the confusion the whole
 * scoring model is built to avoid.
 */
export function toCsv(data: ReportData): string {
  const header = [
    'rank',
    'mmsi',
    'score',
    'score_ci_low',
    'score_ci_high',
    'tier',
    'measured_features',
    'calibrated',
    'weight_profile',
    'feature_key',
    'feature_status',
    'raw_value',
    'raw_unit',
    'normalised',
    'weight',
    'contribution',
  ];
  const rows: string[] = [header.join(',')];

  for (const c of data.candidates) {
    const cand = c as {
      rank: number;
      mmsi: number;
      score: number;
      scoreCI: number[];
      tier: string;
      measuredFeatureCount: number;
      calibrated: boolean;
      weightProfileId: string;
      features: Array<Record<string, unknown>>;
    };
    for (const f of cand.features ?? []) {
      rows.push(
        [
          cand.rank,
          cand.mmsi,
          cand.score,
          cand.scoreCI?.[0],
          cand.scoreCI?.[1],
          cand.tier,
          cand.measuredFeatureCount,
          cand.calibrated,
          cand.weightProfileId,
          f.key,
          f.status,
          f.rawValue,
          f.rawUnit,
          f.normalised,
          f.weight,
          f.contribution,
        ]
          .map(csvEscape)
          .join(','),
      );
    }
  }

  return rows.join('\n') + '\n';
}

/** The run manifest, plus the uncertainty statement so the two never travel apart. */
export function toManifest(data: ReportData): Record<string, unknown> {
  return {
    ...data.manifest,
    investigation: {
      id: String((data.investigation as { _id: unknown })._id),
      name: (data.investigation as { name: string }).name,
      windowStart: (data.investigation as { windowStart: Date }).windowStart,
      windowEnd: (data.investigation as { windowEnd: Date }).windowEnd,
      aoiAreaKm2: (data.investigation as { aoiAreaKm2: number }).aoiAreaKm2,
    },
    counts: {
      scenes: data.scenes.length,
      detections: data.detections.length,
      candidates: data.candidates.length,
      provenanceRecords: data.provenance.records.length,
    },
    aisCoverage: data.aisCoverage
      ? {
          source: data.aisCoverage.source,
          recordCount: data.aisCoverage.recordCount,
          distinctVessels: data.aisCoverage.distinctVessels,
          medianIntervalSec: data.aisCoverage.medianIntervalSec,
        }
      : null,
    uncertainty: data.uncertainty,
    provenance: data.provenance,
  };
}
