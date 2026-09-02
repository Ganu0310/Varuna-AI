/**
 * Automated Review Engine — Option A Zero-Wait Hybrid Pipeline Policy.
 *
 * Evaluates candidate detections post-segmentation against high-confidence thresholds.
 * - AUTO_CONFIRMED: confidence >= 0.75, lookAlikeRisk < 0.20, areaKm2 >= 0.10.
 * - AUTO_REJECTED: lookAlikeRisk >= 0.60 or (confidence < 0.35 && lookAlikeRisk >= 0.40).
 * - UNREVIEWED: Borderline / ambiguous cases reserved for analyst manual triage.
 */

export interface AutoReviewInput {
  overallConfidence: number;
  lookAlikeRisk: number;
  windSuitability?: number;
  areaKm2: number;
}

export interface AutoReviewAssessment {
  status: 'AUTO_CONFIRMED' | 'AUTO_REJECTED' | 'UNREVIEWED';
  reasons: string[];
  autoTriggerPipeline: boolean;
}

export function evaluateAutoReview(input: AutoReviewInput): AutoReviewAssessment {
  const { overallConfidence, lookAlikeRisk, areaKm2 } = input;
  const reasons: string[] = [];

  // Check Auto-Confirm Thresholds
  if (overallConfidence >= 0.75 && lookAlikeRisk < 0.2 && areaKm2 >= 0.1) {
    reasons.push(
      `High overall confidence (${overallConfidence.toFixed(2)} >= 0.75), low look-alike risk ` +
        `(${lookAlikeRisk.toFixed(2)} < 0.20), and area ${areaKm2.toFixed(2)} km² >= 0.10 km².`,
    );
    return {
      status: 'AUTO_CONFIRMED',
      reasons,
      autoTriggerPipeline: true,
    };
  }

  // Check Auto-Reject Thresholds
  if (lookAlikeRisk >= 0.6 || (overallConfidence < 0.35 && lookAlikeRisk >= 0.4)) {
    reasons.push(
      `High look-alike risk (${lookAlikeRisk.toFixed(2)}) or low overall confidence ` +
        `(${overallConfidence.toFixed(2)}) indicating high risk of non-slick surface feature.`,
    );
    return {
      status: 'AUTO_REJECTED',
      reasons,
      autoTriggerPipeline: false,
    };
  }

  // Fallback to manual queue
  reasons.push(
    `Ambiguous confidence (${overallConfidence.toFixed(2)}) or look-alike risk ` +
      `(${lookAlikeRisk.toFixed(2)}) placed in UNREVIEWED queue for analyst manual review.`,
  );
  return {
    status: 'UNREVIEWED',
    reasons,
    autoTriggerPipeline: false,
  };
}
