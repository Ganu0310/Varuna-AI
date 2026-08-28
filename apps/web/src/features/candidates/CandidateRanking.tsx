import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client.ts';
import { useSelectionStore } from '../../state/stores.ts';
import { EvidenceWaterfall, type FeatureContribution } from './EvidenceWaterfall.tsx';

/**
 * Candidate ranking — 05_FRONTEND §5.5.7.
 *
 * The screen is built around one constraint: it must not read as an accusation. Every tier
 * carries its meaning in text as well as colour, the disclaimer is permanent rather than a
 * footnote, and an `INSUFFICIENT_EVIDENCE` top result replaces the ranking entirely with an
 * explanation instead of showing a leaderboard with a caveat.
 */
interface Candidate {
  _id: string;
  mmsi: number;
  score: number;
  scoreCI: [number, number];
  tier: 'STRONG' | 'MODERATE' | 'WEAK' | 'INSUFFICIENT_EVIDENCE';
  rank: number;
  measuredFeatureCount: number;
  features: FeatureContribution[];
  calibrated: boolean;
  weightProfileId: string;
  excluded: { reason: string; at: string } | null;
}

interface Response {
  items: Candidate[];
  summary: {
    total: number;
    insufficientEvidence: number;
    excluded: number;
    topTier: string | null;
  };
  disclaimer: string;
}

const TIER_TEXT: Record<string, string> = {
  STRONG: 'Strong evidential association',
  MODERATE: 'Moderate evidential association',
  WEAK: 'Weak evidential association',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence',
};

export function CandidateRanking({ investigationId }: { investigationId: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const select = useSelectionStore((s) => s.select);
  const hover = useSelectionStore((s) => s.hover);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['candidates', investigationId],
    queryFn: () => api.get<Response>(`/investigations/${investigationId}/candidates`),
    staleTime: 15_000,
  });

  if (isLoading) return <p className="muted">Loading candidates…</p>;
  if (isError) return <p className="field-error">Could not load candidates.</p>;

  const items = (data?.items ?? []).filter((c) => !c.excluded);
  const summary = data?.summary;

  if (items.length === 0) {
    return (
      <div className="empty-state">
        <h3>No candidates</h3>
        <p>
          No vessels have been correlated against a detection yet. Run correlation once an origin
          estimate exists.
        </p>
      </div>
    );
  }

  const top = items[0]!;

  return (
    <div className="stack-sm">
      {/* Permanent, in-flow. Not a tooltip and not small print. */}
      <p className="disclaimer">{data?.disclaimer}</p>

      {!top.calibrated ? (
        <p className="field-hint">
          Scores are UNCALIBRATED weighted evidence, not probabilities: too few validated incidents
          exist to fit a calibration. A score of 70 does not mean a 70% chance.
        </p>
      ) : null}

      {top.tier === 'INSUFFICIENT_EVIDENCE' ? (
        // The ranking is replaced, not annotated. Showing a leaderboard with a caveat invites
        // the reader to act on the order anyway (12 F-14).
        <div className="panel-error" role="alert">
          <strong>Insufficient evidence to rank candidates</strong>
          <p>
            The best-supported vessel was measurable on only {top.measuredFeatureCount} of 12
            evidence features — below the six-feature minimum. A score computed from that few
            features is not a strong case regardless of its value, so no ranking is presented.
          </p>
          <p className="consequence">
            This usually means AIS coverage is sparse, or the origin estimate is too weak to
            discriminate. Both are stated in the AIS coverage panel and the origin panel.
          </p>
        </div>
      ) : (
        <table className="data-table candidate-table">
          <thead>
            <tr>
              <th className="num">#</th>
              <th>MMSI</th>
              <th className="num">Score</th>
              <th>Assessment</th>
              <th className="num">Features</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr
                key={c._id}
                className={openId === c._id ? 'row-open' : ''}
                onMouseEnter={() => hover({ kind: 'vessel', mmsi: c.mmsi })}
                onMouseLeave={() => hover({ kind: 'none' })}
              >
                <td className="num mono">{c.rank}</td>
                <td className="mono">{c.mmsi}</td>
                <td className="num mono">
                  {c.score.toFixed(1)}
                  {/* Uncertainty travels with the number, always. */}
                  <span className="muted">
                    {' '}
                    [{c.scoreCI[0].toFixed(0)}–{c.scoreCI[1].toFixed(0)}]
                  </span>
                </td>
                <td>
                  {/* Four channels: position, label text, interval, and colour last. */}
                  <span className={`token tier-${c.tier.toLowerCase()}`}>{TIER_TEXT[c.tier]}</span>
                </td>
                <td className="num mono">{c.measuredFeatureCount}/12</td>
                <td>
                  <button
                    className="btn-ghost"
                    onClick={() => {
                      const next = openId === c._id ? null : c._id;
                      setOpenId(next);
                      if (next) {
                        select({ kind: 'candidate', id: c._id, mmsi: c.mmsi });
                      }
                    }}
                  >
                    {openId === c._id ? 'Hide evidence' : 'Evidence'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {openId ? (
        <section className="card">
          {(() => {
            const c = items.find((x) => x._id === openId)!;
            return (
              <>
                <h3>
                  Evidence for MMSI <span className="mono">{c.mmsi}</span>
                </h3>
                {c.tier === 'STRONG' ? (
                  <p className="disclaimer">
                    A strong evidential association is not a determination of responsibility. It
                    indicates that the available evidence is consistent with this vessel and
                    warrants investigation.
                  </p>
                ) : null}
                <EvidenceWaterfall
                  features={c.features}
                  measuredCount={c.measuredFeatureCount}
                  score={c.score}
                  scoreCI={c.scoreCI}
                />
                {c.weightProfileId !== 'DEFAULT_V1' ? (
                  <p className="field-hint">
                    Ranked under weight profile <span className="mono">{c.weightProfileId}</span>,
                    not the defaults. This is recorded in the report.
                  </p>
                ) : null}
              </>
            );
          })()}
        </section>
      ) : null}

      {summary && summary.excluded > 0 ? (
        // Excluded candidates are hidden from the ranking but stay counted, so a reader can
        // see that a decision was made rather than that a vessel never existed.
        <p className="field-hint">
          {summary.excluded} candidate(s) excluded by an analyst and not shown. Exclusions require a
          stated reason and are recorded in the audit log.
        </p>
      ) : null}
    </div>
  );
}
