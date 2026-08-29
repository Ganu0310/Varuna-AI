import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client.ts';
import { FEATURE_LABELS } from './EvidenceWaterfall.tsx';

/**
 * Weight sensitivity — 06_BACKEND §6.4.8, 12 F-16.
 *
 * The twelve weights are expert-elicited priors, not measurements. An analyst who cannot see
 * how much the ranking depends on them is being asked to trust a number whose provenance is
 * "someone chose 0.18". This panel lets them find out: change the priors, see whether the
 * order survives.
 *
 * Two things this is careful about.
 *
 * FIRST — reweighting is NOT a preview. The server rewrites every candidate's score and rank
 * and stamps `weightProfileId`, so the report will afterwards be a report produced under
 * custom weights. That is correct behaviour (a ranking must be identifiable as non-default)
 * but it means the button is an edit, not a what-if, and it says so.
 *
 * SECOND — weights must sum to 1.00. The server refuses otherwise with a 422, because scores
 * renormalised over a total that is not 1 are not comparable between candidates. Rather than
 * let someone discover that on submit, the sum is shown live and normalising is one click.
 */

interface WeightProfile {
  profileId: string;
  weights: Record<string, number>;
  description: string;
}

interface Props {
  investigationId: string;
  detectionId: string | null;
}

export function SensitivityPanel({ investigationId, detectionId }: Props) {
  const qc = useQueryClient();
  const [weights, setWeights] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const profiles = useQuery({
    queryKey: ['weight-profiles'],
    queryFn: () => api.get<{ items: WeightProfile[] }>('/weight-profiles'),
    staleTime: Infinity,
  });

  const defaultProfile = profiles.data?.items.find((p) => p.profileId === 'DEFAULT_V1');

  useEffect(() => {
    if (defaultProfile && !weights) setWeights({ ...defaultProfile.weights });
  }, [defaultProfile, weights]);

  const total = useMemo(() => Object.values(weights ?? {}).reduce((s, w) => s + w, 0), [weights]);
  const normalised = Math.abs(total - 1) <= 0.001;
  const changed = useMemo(
    () =>
      defaultProfile && weights
        ? Object.keys(weights).some(
            (k) => Math.abs(weights[k]! - (defaultProfile.weights[k] ?? 0)) > 1e-9,
          )
        : false,
    [weights, defaultProfile],
  );

  const apply = useMutation({
    mutationFn: () =>
      api.post(`/investigations/${investigationId}/candidates/reweight`, {
        detectionId,
        profileId: 'CUSTOM',
        weights,
      }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['candidates', investigationId] });
    },
    onError: (e) =>
      setError(
        e instanceof ApiError ? (e.problem?.detail ?? e.problem?.title ?? e.message) : String(e),
      ),
  });

  if (!weights || !defaultProfile) return <p className="muted">Loading weight profile…</p>;

  return (
    <div className="sensitivity">
      <p className="muted">
        The twelve weights are expert-elicited priors, not measurements. Move them to see how much
        the ranking actually depends on them — if the top candidate survives a large change, that is
        worth knowing; if it does not, that is worth knowing more.
      </p>

      <div className="sens-rows">
        {Object.keys(defaultProfile.weights).map((key) => {
          const v = weights[key] ?? 0;
          const base = defaultProfile.weights[key] ?? 0;
          const delta = v - base;
          return (
            <div key={key} className="sens-row">
              <label htmlFor={`w-${key}`}>{FEATURE_LABELS[key] ?? key}</label>
              <input
                id={`w-${key}`}
                type="range"
                min={0}
                max={0.5}
                step={0.01}
                value={v}
                onChange={(e) => setWeights({ ...weights, [key]: Number(e.target.value) })}
              />
              <span className="mono sens-value">
                {v.toFixed(2)}
                {Math.abs(delta) > 1e-9 ? (
                  <span className={delta > 0 ? 'sens-up' : 'sens-down'}>
                    {delta > 0 ? ' ▲' : ' ▼'}
                    {Math.abs(delta).toFixed(2)}
                  </span>
                ) : null}
              </span>
            </div>
          );
        })}
      </div>

      <div className={`sens-total ${normalised ? '' : 'sens-total-bad'}`}>
        <span className="mono">Σ {total.toFixed(3)}</span>
        {normalised ? (
          <span className="muted"> — normalised</span>
        ) : (
          <>
            <span className="field-error">
              {' '}
              — must sum to 1.000, or scores stop being comparable between candidates.
            </span>
            <button
              className="btn-ghost"
              onClick={() => {
                // Scale rather than clamp: preserves the analyst's intended RATIOS, which is
                // what they were actually expressing by moving the sliders.
                if (total <= 0) return;
                const scaled = Object.fromEntries(
                  Object.entries(weights).map(([k, w]) => [
                    k,
                    Math.round((w / total) * 1000) / 1000,
                  ]),
                );
                setWeights(scaled);
              }}
            >
              Normalise
            </button>
          </>
        )}
      </div>

      <div className="form-error" role="alert">
        {error ?? ''}
      </div>

      <div className="sens-actions">
        <button
          disabled={!normalised || !detectionId || apply.isPending || !changed}
          onClick={() => apply.mutate()}
        >
          {apply.isPending ? 'Re-ranking…' : 'Apply weights and re-rank'}
        </button>
        <button
          className="btn-ghost"
          disabled={!changed}
          onClick={() => setWeights({ ...defaultProfile.weights })}
        >
          Reset to defaults
        </button>
      </div>

      <p className="field-hint">
        {detectionId
          ? 'This rewrites the stored scores and ranks — it is not a preview. The report will ' +
            'record the ranking as produced under a CUSTOM weight profile, so a reader can ' +
            'tell it was not the default.'
          : 'Correlate a detection first — there are no candidates to re-rank.'}
      </p>
    </div>
  );
}
