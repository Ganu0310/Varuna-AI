# Gap register — plan vs. build

Audited 29 Aug 2026 at `07ce01c`. Every task line in `IMPLEMENTATION_PLAN.md`
(155 across 14 phases) read against the working tree; ~90 specific capabilities
probed directly in source rather than inferred from the plan's checkboxes.

**28 mismatches.** They are not all the same kind, and the distinction is the point
— only the first kind is a hole.

| | Count | Meaning |
|---|---|---|
| **Absent** | 18 | Specified, not built, no substitute |
| **Deviates** | 7 | Built another way; the capability exists |
| **Deliberate** | 3 | Skipped on purpose, reason recorded in the code |

Phases **3, 6 and 7** match the plan in full.

Gates at time of audit: typecheck 4/4, lint clean, 101 web tests, 156 API tests,
8 E2E, real-data policy passing.

---

## Phase 0 — Foundations

- **Absent — Husky pre-commit hook.** `gitleaks` runs in CI, so a leaked secret is
  caught, but only once it is already in a pushed commit and therefore in the
  history. The hook is what stops it reaching the repository at all.

## Phase 1 — Data-plane spine

- **Deviates — Pydantic mirror generated from Zod, with a CI drift check.** The
  Pydantic models exist but are hand-written per router. Nothing detects the two
  definitions drifting apart, so a field renamed in `packages/shared` fails at
  runtime on the ML boundary instead of in CI.

## Phase 2 — Platform

- **Absent — investigation comments.** `/members` and `/audit` ship; `/comments`
  has no model, route or UI. Analyst-to-analyst annotation is not possible.
- **Absent — OpenAPI diff check in CI.** The spec is generated and served. Nothing
  fails the build when a route changes shape, which is the whole reason to publish
  a spec.

## Phase 3 — Providers + catalogue

Matches.

## Phase 4 — ML service, SAR preprocessing, ingest

- **Absent — `POST /scenes/upload`.** Scenes can only enter by product ID from a
  catalogue. An analyst holding a GeoTIFF — from a national agency, or an
  acquisition the public catalogues do not carry — has no way in.
- **Absent — coastline land mask.** Detection runs on the whole scene. Land returns
  bright, dark and textured regions a dark-spot detector has no reason to reject,
  so a coastal scene can produce a slick that is a car park.
- **Deviates — Testcontainers.** Seven integration tests run, against a developer's
  live MongoDB rather than a container. They pass, but only on a machine set up by
  hand — CI cannot run them.

## Phase 5 — M1 segmentation

- **Absent — U-Net++, DeepLabV3+, SegFormer-B2.** One architecture was built and
  evaluated, not four. The plan's instruction to *pick the shipped model by
  evaluation rather than assertion* was followed and the U-Net lost: better oil IoU
  (0.637 vs 0.564) but worse on look-alikes (81.8% vs 68.2% false positives),
  because look-alike scenes carry no positive pixels and so teach no rejection. The
  classical detector ships. Three architectures remain untried.
- **Deviates — `OilSegLoss` = 0.5·Dice + 0.5·Focal.** Training uses BCE + soft Dice.
  Both address class imbalance; focal additionally down-weights easy negatives,
  which is exactly the look-alike problem above — so this is a plausible lead, not
  merely a deviation.

## Phase 6 — Detections

Matches.

## Phase 7 — Environmental data + M2 drift

Matches.

## Phase 8 — AIS

- **Absent — packed binary track format and its decoder worker.** `?format=binary`
  and `aisDecoder.worker.ts` do not exist; tracks go over the wire as JSON and are
  parsed on the main thread. A 60 s read-path cache currently holds the endpoint
  inside its budget, which is why this has not bitten yet.
- **Absent — Kystverket and Global Fishing Watch clients.** An API token slot and a
  quota entry exist for GFW; no client calls either service. Real AIS coverage is
  Marine Cadastre (US) and DMA (Denmark) only — which is why the guide states the
  US-waters limitation outright.

## Phase 9 — M3 attribution

- **Deviates — scoring lives in the API, not the ML service.** All twelve features,
  the measured-weight denominator and the bootstrap CI are implemented in
  TypeScript under `modules/attribution/`. There is no `POST /score`. The behaviour
  matches the specification; the deployment boundary does not.
- **Deliberate — isotonic calibrator.** Not fitted, because fitting one needs 30
  labelled incidents and we have none. Scores are returned through the identity
  mapping and labelled `UNCALIBRATED` — the honest option, and the one the policy
  requires.

## Phase 10 — Workspace UI shell

- **Absent — landing page.** `/` redirects straight to `/investigations`. The
  specified globe, scrollytelling and live public-incident waterfall are the front
  door a judge meets first, and there is currently no front door.
- **Absent — CI performance budgets.** No gate on bundle size, LCP, CLS or INP.
  Separately, the specified 220 kB workspace budget was measured to be unreachable
  — MapLibre alone is 284.63 kB — so the budget itself needs revising before it can
  be enforced.
- **Absent — `design/primitives` and `motion.ts`.** No shared Button, Input,
  NumericField or CoordinateField; no motion presets. Controls are styled per
  feature against the tokens, so they are consistent today by discipline rather
  than by construction.
- **Absent — `tokens-sync-check` in CI.** `tokens.css` and `tokens.ts` are both
  present and both maintained by hand. deck.gl and Three cannot read CSS variables,
  so the typed mirror is what they use — and nothing asserts the two agree.
- **Deviates — generated API types.** The client is hand-written rather than
  generated from the OpenAPI spec. Combined with the missing spec diff check,
  nothing connects a server route change to the frontend types that describe it.
- **Deviates — `ProvenanceChip` and `JobConsole`.** Both behaviours are present,
  written inline in the panels that need them rather than extracted. Cosmetic
  today; a source of divergence as soon as a third caller appears.

## Phase 11 — 3D surfaces

- **Deviates — globe built on MapLibre, not react-three-fiber.** All three surfaces
  exist — globe, slick relief, space–time prism — but the globe uses MapLibre's
  native globe projection instead of an R3F sphere with a custom day/night Fresnel
  shader. Three.js is not a dependency at all. The surface works; it is less
  striking, and the atmosphere shell is not there.
- **Absent — static frame on `visibilitychange`.** A backgrounded tab keeps
  rendering. The two-context budget is respected and E2E-tested, so this is battery
  and heat rather than a correctness risk.

## Phase 12 — Reporting & exports

- **Absent — server-side PDF rendering.** The dossier route, the mandatory-section
  enforcement and the GeoJSON and CSV exports all work. The Playwright DOM-to-PDF
  step does not exist, so the one artefact an investigator actually files — a
  signed, paginated PDF — cannot be produced.

## Phase 13 — Demo staging, integration, hardening

- **Absent — `GET /api/v1/public/demo-incident`.** The read-only public
  reconstruction the landing page was to be built around. Blocked behind the same
  missing landing page, and blocking any unauthenticated demo link.
- **Absent — full-chain integration test.** The chain has been run end to end by
  hand and by the E2E suite against a live stack. Nothing runs
  `ingest → detect → backtrack → correlate → score → report` in one automated
  test, so a break between two stages is only caught in the browser.

## Not attached to one phase

- **Deliberate — `inference` queue processor.** Left unregistered on purpose, with
  the reason written at `apps/worker/src/index.ts:67`: detection currently runs
  inside the ingest job, and a separate inference queue belongs with a learned
  segmentation model that has not been adopted.
- **Deliberate — CMEMS and CDS credentials.** Not held, so drift runs without
  currents or winds and self-labels `DEGRADED`. The degradation path is implemented
  and correct; it is the accounts that are missing, and only registration unblocks
  it.

---

## The three that would change what the system can claim

**The land mask.** Without it a coastal scene can report a slick that is a car
park, and no amount of downstream rigour survives a false detection at the top of
the chain.

**The PDF.** Everything the dossier does — mandatory uncertainty, mandatory
provenance, methodology notes — exists to produce a document someone can file. It
currently cannot leave the browser as one.

**The full-chain test.** Seven stages verified individually and never together in
CI. Every integration break so far has been found by a person clicking.
