/**
 * Named areas of interest, so an AOI can be chosen instead of typed.
 *
 * Every entry is a REAL location derived from data this project actually holds, not a
 * hand-picked list of plausible-looking seas. The bounds come from two sources:
 *
 *  - the staged demo incident (a real Sentinel-1 acquisition with a real AIS slice), and
 *  - the geographic clusters of the 150 CONFIRMED-OIL scenes in the Trujillo-Acatitla
 *    evaluation dataset (CC-BY-4.0), computed from the imagery's own bounds.
 *
 * So "there was a slick here" is a statement the dataset supports, not a guess.
 *
 * `aisCoverage` is the field that saves the most wasted effort. The free bulk AIS archive
 * (NOAA Marine Cadastre) covers US waters ONLY. Choosing a Mediterranean or Red Sea box will
 * find imagery and detections perfectly well, and then produce no candidate vessels at all —
 * not because nothing was there, but because we cannot see who was. Stating that at the
 * moment of choosing is the difference between a known limit and a confusing dead end.
 */

export interface AoiPreset {
  id: string;
  label: string;
  region: string;
  /** west, south, east, north */
  bbox: [number, number, number, number];
  aisCoverage: 'STAGED' | 'OBTAINABLE' | 'NONE';
  note: string;
}

export const AOI_PRESETS: AoiPreset[] = [
  {
    id: 'guam-apra',
    label: 'Guam — Apra Harbour',
    region: 'Western Pacific',
    bbox: [144.55, 13.3, 144.95, 13.6],
    aisCoverage: 'STAGED',
    note:
      'The staged demo incident. A real Sentinel-1C RTC acquisition (2025-09-21) is already ' +
      'ingested and 9.4M real AIS positions are loaded locally. The only area where the full ' +
      'chain runs end to end with nothing left to download.',
  },
  {
    id: 'gulf-of-mexico',
    label: 'Gulf of Mexico — Mississippi Delta',
    region: 'US waters',
    bbox: [-90.6, 28.6, -88.9, 29.05],
    aisCoverage: 'OBTAINABLE',
    note:
      '11 confirmed-oil scenes sit in this box in the evaluation dataset, and it is US ' +
      'waters — so Marine Cadastre AIS is downloadable for it. The best candidate for a ' +
      'second full end-to-end incident, once that AIS slice is imported.',
  },
  {
    id: 'baniyas-syria',
    label: 'Baniyas, Syria',
    region: 'Eastern Mediterranean',
    bbox: [34.6, 35.1, 35.1, 35.8],
    aisCoverage: 'NONE',
    note:
      '12 confirmed-oil scenes, including the 2021 Baniyas refinery discharges. Imagery and ' +
      'detection work here; attribution will not, because no free AIS archive covers it.',
  },
  {
    id: 'iskenderun',
    label: 'İskenderun Bay',
    region: 'Eastern Mediterranean',
    bbox: [35.0, 35.3, 35.8, 36.2],
    aisCoverage: 'NONE',
    note: 'The densest oil cluster in the dataset — 21 confirmed-oil scenes. No free AIS.',
  },
  {
    id: 'red-sea-north',
    label: 'Red Sea — Saudi coast (north)',
    region: 'Red Sea',
    bbox: [37.8, 19.5, 39.0, 21.1],
    aisCoverage: 'NONE',
    note: '17 confirmed-oil scenes along a major tanker route. No free AIS.',
  },
  {
    id: 'persian-gulf',
    label: 'Persian Gulf — Abu Dhabi',
    region: 'Persian Gulf',
    bbox: [54.2, 25.2, 55.0, 26.0],
    aisCoverage: 'NONE',
    note: '14 confirmed-oil scenes in one of the busiest tanker regions on earth. No free AIS.',
  },
  {
    id: 'ligurian',
    label: 'Ligurian Sea — Corsica',
    region: 'Western Mediterranean',
    bbox: [9.0, 43.2, 9.5, 43.6],
    aisCoverage: 'NONE',
    note: '11 confirmed-oil scenes. No free AIS.',
  },
  {
    id: 'makassar',
    label: 'Makassar Strait',
    region: 'Indonesia',
    bbox: [116.3, -4.2, 116.8, -3.2],
    aisCoverage: 'NONE',
    note: '10 confirmed-oil scenes. No free AIS.',
  },
];

export function bboxText(p: AoiPreset): string {
  return p.bbox.join(',');
}

export const AIS_COVERAGE_LABEL: Record<AoiPreset['aisCoverage'], string> = {
  STAGED: 'AIS loaded locally — full chain runs',
  OBTAINABLE: 'AIS downloadable (US waters) — not yet imported',
  NONE: 'No free AIS archive covers this area — attribution will find no candidates',
};
