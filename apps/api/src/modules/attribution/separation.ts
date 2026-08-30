import type { CandidateInput, ScoringContext } from './features.js';
import { scoreCandidate } from './features.js';
import {
  gaussian,
  mulberry32,
  perturbFixes,
  perturbationPlan,
  scaleAboutCentroid,
  trackLineFrom,
} from './bootstrap.js';

/**
 * Is the top candidate actually ahead of the second — 07_AIML §7.5.3.
 *
 * A ranked list invites the reader to act on its order. Nothing in this system told them
 * whether the order was real. Each candidate already carries a bootstrap interval, but two
 * intervals cannot answer this question, for a reason that matters:
 *
 * **`bootstrapCi` resamples each candidate independently.** It draws that candidate's own
 * origin-zone jitter from that candidate's own seed. That is correct for a marginal interval
 * on one vessel — but there is only ONE origin zone, and its uncertainty is common-mode:
 * when the release zone is drawn further north, it moves further north for every vessel at
 * once. Comparing two independently-drawn intervals treats a shared cause as two separate
 * accidents, and answers a question nobody asked.
 *
 * So this resamples the whole field TOGETHER. One origin-zone draw per iteration, applied to
 * every candidate in that iteration, and then the resulting *rank order* is recorded. What
 * comes out is the number a reader actually needs:
 *
 *     in N draws of the evidence, how often does this vessel still come first?
 *
 * Positional error stays independent per vessel, and deliberately so — an AIS reporting gap
 * on one ship tells you nothing about the gap on another. The shared term is the physics;
 * the independent term is the measurement. Conflating them either way would be wrong.
 *
 * Nothing here re-measures anything. It re-asks the existing scoring function under drawn
 * inputs, so a separation result can never disagree with the score it describes.
 */

/**
 * How often the leader must win a paired draw before the gap is called real.
 *
 * A convention, not a measurement — the same status as the twelve feature weights, and
 * labelled as such wherever it is reported. It is set at 0.9 to match the one-sided reading
 * of the 5th/95th interval already used for scores, so a reader does not have to hold two
 * different notions of "confident" in their head while reading one dossier.
 */
export const DISTINGUISHABLE_WIN_SHARE = 0.9;

/** Ranking beyond the front of the field is not decision-relevant, and costs N x iterations. */
export const SEPARATION_FIELD_SIZE = 10;

export interface RankSeparation {
  iterations: number;
  /** How many candidates were resampled — the front of the field, not all of them. */
  consideredCount: number;
  /** P(this vessel ranks first), across paired draws. Ordered by share, descending. */
  topRankShare: Array<{ mmsi: number; share: number }>;
  leader: {
    mmsi: number;
    runnerUpMmsi: number;
    /** P(leader outscores the runner-up) in the SAME draw. The decision-relevant number. */
    winShare: number;
    /** Mean score gap across draws. A large win share on a 0.4-point margin is still thin. */
    meanMargin: number;
    distinguishable: boolean;
  } | null;
  verdict: string;
  note: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function rankSeparation(
  candidates: CandidateInput[],
  ctx: ScoringContext,
  iterations = 300,
  seed = 7,
): RankSeparation {
  const empty = (verdict: string): RankSeparation => ({
    iterations: 0,
    consideredCount: candidates.length,
    topRankShare: [],
    leader: null,
    verdict,
    note: 'No paired resampling was run.',
  });

  if (candidates.length === 0) return empty('No candidates to separate.');

  // The nominal order, from the unperturbed scores — the one the analyst is looking at.
  const point = candidates
    .map((c) => ({ mmsi: c.mmsi, score: scoreCandidate(c, ctx).score }))
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 1) {
    return empty(
      'Only one candidate was ranked, so there is no second place to be distinguishable ' +
        'from. That is a statement about the AIS coverage, not about the strength of the ' +
        'evidence against this vessel.',
    );
  }

  const field = point
    .slice(0, SEPARATION_FIELD_SIZE)
    .map((p) => candidates.find((c) => c.mmsi === p.mmsi)!);

  const leaderMmsi = point[0]!.mmsi;
  const runnerUpMmsi = point[1]!.mmsi;

  const rand = mulberry32(seed);
  const plans = field.map(perturbationPlan);

  const topCounts = new Map<number, number>();
  let leaderWins = 0;
  let marginSum = 0;

  for (let iter = 0; iter < iterations; iter++) {
    /*
     * ONE draw of the origin zone, for the entire field. This single line is the whole
     * point of the function: drawing it inside the per-candidate loop instead would give
     * each vessel its own private release zone, which is not a thing that exists.
     */
    const jitter = 1 + gaussian(rand) * 0.08;
    const drawnCtx = { ...ctx, originZone: scaleAboutCentroid(ctx.originZone, jitter) };

    const drawn = field.map((c, i) => {
      const fixes = perturbFixes(c, plans[i]!, rand);
      return {
        mmsi: c.mmsi,
        score: scoreCandidate({ ...c, fixes, trackLine: trackLineFrom(fixes) }, drawnCtx).score,
      };
    });

    // Ties break on MMSI so the count is reproducible; a tie is not a win either way, and
    // the margin it contributes is zero, which is the honest reading of one.
    const sorted = [...drawn].sort((a, b) => b.score - a.score || a.mmsi - b.mmsi);
    const winner = sorted[0]!.mmsi;
    topCounts.set(winner, (topCounts.get(winner) ?? 0) + 1);

    const a = drawn.find((d) => d.mmsi === leaderMmsi)!;
    const b = drawn.find((d) => d.mmsi === runnerUpMmsi)!;
    if (a.score > b.score) leaderWins += 1;
    marginSum += a.score - b.score;
  }

  const topRankShare = [...topCounts.entries()]
    .map(([mmsi, n]) => ({ mmsi, share: round3(n / iterations) }))
    .sort((x, y) => y.share - x.share);

  const winShare = round3(leaderWins / iterations);
  const meanMargin = round1(marginSum / iterations);
  const distinguishable = winShare >= DISTINGUISHABLE_WIN_SHARE;

  return {
    iterations,
    consideredCount: field.length,
    topRankShare,
    leader: { mmsi: leaderMmsi, runnerUpMmsi, winShare, meanMargin, distinguishable },
    verdict: verdictFor(leaderMmsi, runnerUpMmsi, winShare, meanMargin, distinguishable),
    note:
      `Paired resampling: ${iterations} draws over the ${field.length} highest-scoring ` +
      'candidates. Each draw perturbs the origin zone ONCE for the whole field, because ' +
      'there is one release zone and its uncertainty moves every vessel together; ' +
      'interpolated positions are perturbed per vessel, because a reporting gap on one ship ' +
      'says nothing about another. Real AIS fixes are never perturbed.',
  };
}

function verdictFor(
  leader: number,
  runnerUp: number,
  winShare: number,
  meanMargin: number,
  distinguishable: boolean,
): string {
  const pct = Math.round(winShare * 100);

  if (!distinguishable) {
    return (
      `MMSI ${leader} and MMSI ${runnerUp} are NOT separable on this evidence. Re-drawing ` +
      `the uncertain inputs puts ${leader} ahead in only ${pct}% of ${''}draws (mean margin ` +
      `${meanMargin} points), against a ${Math.round(DISTINGUISHABLE_WIN_SHARE * 100)}% ` +
      'convention. The order of the top two is an artefact of where the estimates happened ' +
      'to land, and must not be read as one vessel being the stronger lead. Both belong in ' +
      'any follow-up, or neither does.'
    );
  }

  // A high win share on a tiny margin is the case worth calling out separately: the leader
  // wins consistently and by almost nothing, which reads as decisive and is not.
  if (meanMargin < 2) {
    return (
      `MMSI ${leader} leads MMSI ${runnerUp} in ${pct}% of draws, but by a mean of only ` +
      `${meanMargin} points. The order is stable; the gap is not large. Treat this as a ` +
      'consistent ordering between two closely-matched candidates rather than as one ' +
      'standing clearly apart.'
    );
  }

  return (
    `MMSI ${leader} outscores MMSI ${runnerUp} in ${pct}% of draws, by a mean of ` +
    `${meanMargin} points. The top of the ranking is stable under the uncertainty in the ` +
    'origin zone and the interpolated positions. This is a statement about the ORDER being ' +
    'reproducible, not about the vessel being responsible.'
  );
}
