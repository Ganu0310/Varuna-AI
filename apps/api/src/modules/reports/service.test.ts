import { describe, it, expect } from 'vitest';
import { MANDATORY_REPORT_SECTIONS } from '@varuna/shared';
import { assertMandatorySections, enforceMandatorySections, ALL_SECTIONS } from './service.js';
import { toCsv, toGeoJson, toManifest } from './exports.js';
import { HttpError } from '../../errors.js';
import type { ReportData } from './service.js';

/**
 * The guarantee under test: **a dossier cannot be produced without UNCERTAINTY and
 * PROVENANCE.** A report that names a vessel while omitting what the analysis could not
 * establish, and where its numbers came from, is not a shorter report — it is a misleading
 * one, and it is precisely the document someone would want when the caveats are inconvenient.
 */
describe('mandatory report sections', () => {
  it('the mandatory set is UNCERTAINTY and PROVENANCE', () => {
    expect([...MANDATORY_REPORT_SECTIONS].sort()).toEqual(['PROVENANCE', 'UNCERTAINTY']);
  });

  it('rejects a request that omits either', () => {
    for (const omitted of MANDATORY_REPORT_SECTIONS) {
      const sections = ALL_SECTIONS.filter((s) => s !== omitted);
      let thrown: unknown;
      try {
        assertMandatorySections([...sections]);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(HttpError);
      expect((thrown as HttpError).status).toBe(422);
      expect((thrown as HttpError).detail).toMatch(/misrepresents/);
    }
  });

  it('accepts a minimal request that includes both', () => {
    expect(() => assertMandatorySections(['UNCERTAINTY', 'PROVENANCE'])).not.toThrow();
  });

  it('enforce() ADDS the mandatory sections rather than trusting the caller', () => {
    const out = enforceMandatorySections(['SUMMARY']);
    expect(out).toContain('UNCERTAINTY');
    expect(out).toContain('PROVENANCE');
    expect(out).toContain('SUMMARY');
  });

  it('enforce() de-duplicates and preserves the canonical order', () => {
    const out = enforceMandatorySections(['PROVENANCE', 'SUMMARY', 'PROVENANCE', 'UNCERTAINTY']);
    expect(new Set(out).size).toBe(out.length);
    expect(out.indexOf('SUMMARY')).toBeLessThan(out.indexOf('UNCERTAINTY'));
  });
});

// ── exports ───────────────────────────────────────────────────────────

const DATA: ReportData = {
  investigation: {
    _id: 'inv1',
    name: 'Guam 2025-09-21',
    windowStart: new Date('2025-09-21T00:00:00Z'),
    windowEnd: new Date('2025-09-22T00:00:00Z'),
    aoiAreaKm2: 1438,
    aoi: {
      type: 'Polygon',
      coordinates: [
        [
          [144.55, 13.3],
          [144.95, 13.3],
          [144.95, 13.6],
          [144.55, 13.6],
          [144.55, 13.3],
        ],
      ],
    },
  },
  scenes: [{ productId: 'S1C_IW_GRDH_1SDV_20250921T200737_rtc' }],
  detections: [
    {
      _id: 'det1',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [144.66, 13.44],
            [144.68, 13.44],
            [144.68, 13.46],
            [144.66, 13.44],
          ],
        ],
      },
      areaKm2: 1.198,
      confidence: { overall: 0.61, lookAlikeCompetition: 0.24 },
      morphology: { elongationRatio: 1.977 },
      reviewStatus: 'UNREVIEWED',
      model: { artefactSha256: 'ed1867ad' },
      provenance: { provider: 'VARUNA', datasetId: 'classical-darkspot@1.0.0' },
    },
  ],
  origin: {
    _id: 'o1',
    method: 'FOOTPRINT_PROXIMITY',
    status: 'DEGRADED',
    degradationReason: 'No keyless ocean-current model covers this date.',
    originField: {
      support90: {
        type: 'Polygon',
        coordinates: [
          [
            [144.6, 13.4],
            [144.7, 13.4],
            [144.7, 13.5],
            [144.6, 13.4],
          ],
        ],
      },
    },
  },
  aisCoverage: {
    source: 'MARINE_CADASTRE',
    recordCount: 9711,
    distinctVessels: 28,
    firstAt: '2025-09-21T08:00:05Z',
    lastAt: '2025-09-22T07:59:52Z',
    bbox: [144.4, 13.2, 145.1, 13.8],
    medianIntervalSec: 71,
    requestedWindow: { from: '2025-09-21T00:00:00Z', to: '2025-09-22T00:00:00Z' },
    temporalCompleteness: 1,
    qualityFlagCounts: {},
    assessment: '9,711 positions from 28 vessels.',
  },
  candidates: [
    {
      rank: 1,
      mmsi: 368278840,
      score: 91.8,
      scoreCI: [64, 77],
      tier: 'MODERATE',
      measuredFeatureCount: 8,
      calibrated: false,
      weightProfileId: 'DEFAULT_V1',
      features: [
        {
          key: 'spatial_proximity',
          status: 'MEASURED',
          rawValue: 0,
          rawUnit: 'km',
          normalised: 1,
          weight: 0.18,
          contribution: 0.18,
        },
        {
          key: 'draught_change',
          status: 'MISSING',
          rawValue: null,
          rawUnit: 'metres',
          normalised: null,
          weight: 0.05,
          contribution: null,
        },
      ],
    },
  ],
  uncertainty: { statements: [], overall: 'A ranking of investigative leads.' },
  plainSummary: {
    headline: 'Satellite images show what looks like an oil spill.',
    howThisWasFound: 'How this finding was made.',
    whatWasSeen: 'What was seen.',
    whereAndWhen: 'Where and when.',
    possibleOrigin: 'Possible origin.',
    vesselsIntro: 'One ship was close enough to be worth checking.',
    vessels: [{ mmsi: 368278840, rank: 1, assessment: 'This is worth investigating further.' }],
    whatWeDontKnow: ['This report is a starting point, not a finished investigation.'],
    bottomLine: 'In short: this is a list of leads, not a determination of responsibility.',
  },
  provenanceAppendix: { records: [], lineageNote: 'note' },
  manifest: {
    pipelineVersion: 'varuna-1.0.0',
    detectorSha: 'ed1867ad',
    weightProfileId: 'DEFAULT_V1',
    sceneProductIds: ['S1C_IW_GRDH_1SDV_20250921T200737_rtc'],
    aisSource: 'MARINE_CADASTRE',
    originMethod: 'FOOTPRINT_PROXIMITY',
    generatedAt: '2026-08-28T00:00:00Z',
    note: 'manifest',
  },
  sections: [...ALL_SECTIONS],
  generatedAt: '2026-08-28T00:00:00Z',
};

describe('GeoJSON export', () => {
  it('carries provenance inline on every detection feature', () => {
    const gj = toGeoJson(DATA) as { features: Array<{ properties: Record<string, unknown> }> };
    const det = gj.features.find((f) => f.properties.kind === 'DETECTION')!;
    // If this file is separated from the report, the feature must still name its source.
    expect(det.properties.provenance).toBeTruthy();
  });

  it('carries the degradation reason with the origin geometry', () => {
    const gj = toGeoJson(DATA) as { features: Array<{ properties: Record<string, unknown> }> };
    const origin = gj.features.find((f) => f.properties.kind === 'ORIGIN_SUPPORT_90')!;
    // A proximity buffer must never be mistaken for a drift-derived zone in QGIS.
    expect(origin.properties.status).toBe('DEGRADED');
    expect(String(origin.properties.degradationReason)).toMatch(/no keyless ocean-current/i);
  });

  it('includes the AOI and the run manifest', () => {
    const gj = toGeoJson(DATA) as {
      features: Array<{ properties: Record<string, unknown> }>;
      properties: Record<string, unknown>;
    };
    expect(gj.features.some((f) => f.properties.kind === 'AOI')).toBe(true);
    expect(gj.properties.manifest).toBeTruthy();
  });
});

describe('CSV export', () => {
  it('uses long format with a status column, so MISSING is not a blank cell', () => {
    const csv = toCsv(DATA);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('feature_status');
    // A blank cell is indistinguishable from a zero; the status column is what prevents that.
    const missingRow = lines.find((l) => l.includes('draught_change'))!;
    expect(missingRow).toContain('MISSING');
  });

  it('emits one row per feature, not one per candidate', () => {
    const lines = toCsv(DATA).trim().split('\n');
    expect(lines.length).toBe(1 + 2); // header + two features
  });

  it('escapes values containing commas or quotes', () => {
    const withComma = {
      ...DATA,
      candidates: [
        {
          ...(DATA.candidates[0] as Record<string, unknown>),
          weightProfileId: 'CUSTOM, v2',
        },
      ],
    } as ReportData;
    expect(toCsv(withComma)).toContain('"CUSTOM, v2"');
  });
});

describe('run manifest', () => {
  it('pins what is needed to reproduce the run', () => {
    const m = toManifest(DATA) as Record<string, unknown>;
    expect(m.sceneProductIds).toEqual(['S1C_IW_GRDH_1SDV_20250921T200737_rtc']);
    expect(m.detectorSha).toBe('ed1867ad');
    expect(m.weightProfileId).toBe('DEFAULT_V1');
    expect(m.originMethod).toBe('FOOTPRINT_PROXIMITY');
  });

  it('keeps the uncertainty statement with the manifest, so they never travel apart', () => {
    const m = toManifest(DATA) as Record<string, unknown>;
    expect(m.uncertainty).toBeTruthy();
    expect(m.provenanceAppendix).toBeTruthy();
  });
});
