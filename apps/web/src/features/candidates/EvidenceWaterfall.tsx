import { MethodologyNote } from '../../components/MethodologyNote.tsx';

/**
 * Evidence waterfall — 04_UIUX §4.7.2.
 *
 * Three rules, each of which exists to stop a specific way of misleading a reader:
 *
 *  1. The RAW MEASURED VALUE sits beside every contribution. "0.94" is not evidence;
 *     "15° apart → 0.94" is. A reader must be able to disagree with the normalisation
 *     without re-deriving the measurement.
 *  2. NOT MEASURED and NOT APPLICABLE rows are RENDERED, hatched, not hidden. Hiding them
 *     would make a candidate scored on six features look identically well-evidenced as one
 *     scored on twelve.
 *  3. The renormalisation note is permanent, not a tooltip. The score's denominator is the
 *     measured weight, and a reader who does not know that will misread every number here.
 */
export interface FeatureContribution {
  key: string;
  rawValue: number | null;
  rawUnit: string;
  normalised: number | null;
  weight: number;
  contribution: number | null;
  status: 'MEASURED' | 'MISSING' | 'NOT_APPLICABLE';
  evidenceRefs?: Array<{ kind: string; id: string; at?: string }>;
}

interface Props {
  features: FeatureContribution[];
  measuredCount: number;
  score: number;
  scoreCI?: [number, number];
  onFeatureClick?: (key: string) => void;
}

export const FEATURE_LABELS: Record<string, string> = {
  spatial_proximity: 'Spatial proximity',
  temporal_alignment: 'Temporal alignment',
  track_intersection: 'Track intersection',
  heading_alignment: 'Heading alignment',
  ais_dark_period: 'AIS dark period',
  speed_consistency: 'Speed consistency',
  vessel_type_prior: 'Vessel type prior',
  origin_density_at_track: 'Origin density at track',
  draught_change: 'Draught change',
  slick_axis_continuity: 'Slick axis continuity',
  manoeuvre_anomaly: 'Manoeuvre anomaly',
  prior_incident_history: 'Prior incident history',
};

export function EvidenceWaterfall({
  features,
  measuredCount,
  score,
  scoreCI,
  onFeatureClick,
}: Props) {
  // Sorted by absolute contribution so the reader sees what actually drove the score, but
  // unmeasured rows stay in the list rather than sinking out of sight.
  const measured = features
    .filter((f) => f.status === 'MEASURED')
    .sort((a, b) => Math.abs(b.contribution ?? 0) - Math.abs(a.contribution ?? 0));
  const unmeasured = features.filter((f) => f.status !== 'MEASURED');

  const measuredWeight = measured.reduce((s, f) => s + f.weight, 0);
  const maxContribution = Math.max(0.001, ...measured.map((f) => f.contribution ?? 0));

  return (
    <div className="waterfall">
      <header className="wf-head">
        <span className="wf-score mono">
          {score.toFixed(1)}
          {scoreCI ? (
            <span className="wf-ci">
              {' '}
              [{scoreCI[0].toFixed(0)}–{scoreCI[1].toFixed(0)}]
            </span>
          ) : null}
        </span>
        <span className="muted">
          {measuredCount} of 12 features measured
          <MethodologyNote id="review.immutability" />
        </span>
      </header>

      <ol className="wf-rows">
        {measured.map((f) => (
          <li key={f.key} className="wf-row">
            <button
              className="wf-label"
              onClick={() => onFeatureClick?.(f.key)}
              title="Show the source records behind this feature"
            >
              {FEATURE_LABELS[f.key] ?? f.key}
            </button>
            {/* The raw measurement, always. */}
            <span className="wf-raw mono">
              {f.rawValue!.toFixed(2)} {f.rawUnit}
            </span>
            <span className="wf-bar" aria-hidden="true">
              <span
                className="wf-fill"
                style={{ width: `${((f.contribution ?? 0) / maxContribution) * 100}%` }}
              />
            </span>
            <span className="wf-contribution mono">
              {f.normalised!.toFixed(2)} × {f.weight} = {f.contribution!.toFixed(3)}
            </span>
          </li>
        ))}

        {unmeasured.map((f) => (
          <li key={f.key} className="wf-row wf-unmeasured">
            <span className="wf-label">{FEATURE_LABELS[f.key] ?? f.key}</span>
            <span className="wf-raw">
              <span className={`token ${f.status === 'MISSING' ? 'token-warn' : ''}`}>
                {f.status === 'MISSING' ? 'NOT MEASURED' : 'NOT APPLICABLE'}
              </span>
            </span>
            <span className="wf-bar wf-hatched" aria-hidden="true" />
            <span className="wf-contribution muted mono">weight {f.weight} excluded</span>
          </li>
        ))}
      </ol>

      {/* Permanent, not a tooltip: without this the numbers above are misread. */}
      <p className="wf-note">
        The score is the sum of measured contributions divided by the measured weight (
        <span className="mono">{measuredWeight.toFixed(2)}</span> of 1.00), not by 1.00. Features
        that could not be measured, or that do not apply, are excluded from both sides — a candidate
        is never penalised for a gap in our data.
      </p>
    </div>
  );
}
