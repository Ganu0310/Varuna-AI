# CHANGELOG

All notable changes to the VARUNA project will be documented in this file.

## [v1.1.0] - 2026-08-31

### Added
- **Automated Review Engine (Auto-Review Feature):**
  - Added `AUTO_CONFIRMED` and `AUTO_REJECTED` review statuses to `@varuna/shared` constants and Zod schemas (`SpillDetection`).
  - Implemented `evaluateAutoReview()` threshold engine in `apps/api/src/modules/detections/autoReview.ts` implementing Option A (Zero-Wait Hybrid Pipeline Policy).
  - High-confidence slicks ($\text{confidence} \ge 0.75$, $\text{lookAlikeRisk} < 0.20$, $\text{areaKm2} \ge 0.10$) transition to `AUTO_CONFIRMED` and auto-enqueue background drift & AIS correlation jobs.
  - High-risk look-alikes transition to `AUTO_REJECTED`. Borderline slicks remain `UNREVIEWED` for manual analyst triage.
- **14-Feature Attribution Model & Candidate Vessel Ranking:**
  - Added `vessel_type_risk` (Gross Tonnage / Ship Class weighting) and `ais_dark_period_anomaly` (flagging AIS transponder silence > 30 mins in release window) to `ATTRIBUTION_FEATURES`.
  - Updated `scoreCandidate()` in `apps/api/src/modules/attribution/features.ts` and `EvidenceWaterfall.tsx` to process and render all 14 evidence features.
- **Backward Drift Modeling & Origin Surface:**
  - 5,000 particle Gaussian dispersion integration with KDE cumulative density contours (50% and 90%) and release window bounding via prior clear satellite scene overpasses.

- **VARUNA Prototype Technical Architecture & Algorithm Guide:**
  - Added comprehensive documentation detailing every function, algorithm, decision mechanism, mathematical equation, and data flow in [`doc/docs/PROJECT_PROTOTYPE_EXPLANATION.md`](file:///e:/SIH/doc/docs/PROJECT_PROTOTYPE_EXPLANATION.md) and [`doc/docs/PROJECT_PROTOTYPE_EXPLANATION.pdf`](file:///e:/SIH/doc/docs/PROJECT_PROTOTYPE_EXPLANATION.pdf).


### Architectural Rationale
- Zero-wait background execution allows analysts to arrive at pre-computed vessel attribution dossiers without waiting, while preserving safety gates and manual override capabilities on borderline detections.
- Vessel risk weighting and dark-period anomaly detection prevent adversarial vessels that disable AIS or carry large oil volume from evading attribution ranking.
- Detailed end-to-end algorithmic documentation ensures complete transparency and explainability for hackathon evaluations, code audits, and operational training.

