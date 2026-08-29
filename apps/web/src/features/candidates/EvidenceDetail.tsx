import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { FEATURE_LABELS } from './EvidenceWaterfall.tsx';

/**
 * One evidence feature, opened out — 06_BACKEND §6.4.8.
 *
 * The waterfall shows what each feature contributed. This answers the next question: what was
 * actually measured, in what unit, and from which observations. Those are different questions,
 * and the second is the one that decides whether a contribution is believable.
 *
 * A feature that could NOT be measured is the more important case. It shows its reason and
 * stays visible, because an analyst needs to know that a slot in the model was empty rather
 * than scoring zero — a missing feature and a feature measured as zero support opposite
 * conclusions, and only one of them is evidence.
 */

interface EvidenceResponse {
  feature: {
    key: string;
    rawValue: number | null;
    rawUnit: string | null;
    normalised: number | null;
    weight: number;
    contribution: number | null;
    status: 'MEASURED' | 'MISSING' | 'NOT_APPLICABLE';
    reason?: string | null;
    evidenceRefs?: Array<{ kind: string; id: string; at?: string }>;
  };
  definition: { unit: string | null; defaultWeight: number; family: string };
  mmsi: number;
  measurable: boolean;
}

export function EvidenceDetail({
  candidateId,
  featureKey,
}: {
  candidateId: string;
  featureKey: string;
}) {
  const q = useQuery({
    queryKey: ['evidence', candidateId, featureKey],
    queryFn: () => api.get<EvidenceResponse>(`/candidates/${candidateId}/evidence/${featureKey}`),
    enabled: Boolean(candidateId && featureKey),
  });

  if (q.isLoading) return <p className="muted">Loading evidence…</p>;
  if (q.isError || !q.data) return <p className="field-error">Could not load this feature.</p>;

  const { feature: f, definition, mmsi } = q.data;
  const measured = f.status === 'MEASURED';

  return (
    <div className="evidence-detail">
      <h4>
        {FEATURE_LABELS[f.key] ?? f.key}{' '}
        <span className={`token ${measured ? 'status-ok' : 'status-warn'}`}>{f.status}</span>
      </h4>

      <dl className="kv">
        <dt>Vessel</dt>
        <dd className="mono">{mmsi}</dd>

        <dt>Measured value</dt>
        <dd className="mono">
          {/* An em dash, never 0. Rendering an unmeasured feature as zero would make an
              absence of evidence look like evidence of absence. */}
          {f.rawValue == null ? '—' : `${f.rawValue} ${f.rawUnit ?? definition.unit ?? ''}`}
        </dd>

        <dt>Normalised</dt>
        <dd className="mono">{f.normalised == null ? '—' : f.normalised.toFixed(3)}</dd>

        <dt>Weight</dt>
        <dd className="mono">
          {f.weight.toFixed(2)}
          {Math.abs(f.weight - definition.defaultWeight) > 1e-9 ? (
            <span className="muted"> (default {definition.defaultWeight.toFixed(2)})</span>
          ) : null}
        </dd>

        <dt>Contribution</dt>
        <dd className="mono">{f.contribution == null ? '—' : f.contribution.toFixed(3)}</dd>

        <dt>Family</dt>
        <dd>{definition.family}</dd>
      </dl>

      {!measured ? (
        <p className="field-hint">
          {f.reason ??
            (f.status === 'NOT_APPLICABLE'
              ? 'This feature does not apply to this detection, so it is excluded from the ' +
                'score rather than counted as zero.'
              : 'This feature could not be measured from the available data. Its weight is ' +
                'excluded from the renormalisation, so it neither helps nor harms the score.')}
        </p>
      ) : null}

      {f.evidenceRefs && f.evidenceRefs.length > 0 ? (
        <>
          <h5>Underlying observations</h5>
          <ul className="evidence-refs mono">
            {f.evidenceRefs.map((r, i) => (
              <li key={`${r.kind}-${r.id}-${i}`}>
                {r.kind} {r.id.slice(-8)}
                {r.at ? <span className="muted"> · {r.at}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="field-hint">
          No individual observation references are recorded for this feature. It was derived from
          the track as a whole rather than from particular fixes.
        </p>
      )}
    </div>
  );
}
