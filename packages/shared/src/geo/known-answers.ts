import knownAnswers from '../../geo-known-answers.json' with { type: 'json' };

/**
 * The cross-stack geodesy known-answer contract. Both the Node (geographiclib-geodesic)
 * and Python (pyproj.Geod) implementations must reproduce every value here within 0.1% —
 * enforced as a CI gate (02_TRD §2.6.4 / §2.15, IMPLEMENTATION_PLAN §14.10).
 */
export interface GeodesicInverseCase {
  name: string;
  from: [number, number]; // [lon, lat]
  to: [number, number];
  expectedMetres: number;
  tolMetres: number;
  note?: string;
}

export interface PolygonAreaCase {
  name: string;
  ringLonLat: [number, number][];
  expectedSquareMetres: number;
  tolSquareMetres: number;
  note?: string;
}

export const GEO_KNOWN_ANSWERS: {
  geodesicInverse: GeodesicInverseCase[];
  polygonAreaGeodesic: PolygonAreaCase[];
} = {
  geodesicInverse: knownAnswers.geodesicInverse as GeodesicInverseCase[],
  polygonAreaGeodesic: knownAnswers.polygonAreaGeodesic as PolygonAreaCase[],
};
