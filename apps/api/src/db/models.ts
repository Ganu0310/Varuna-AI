/**
 * Model registry. Importing this file registers every Mongoose model exactly once.
 * `ais_positions` is a time-series collection created in bootstrap.ts, not a model here.
 */
export { ProvenanceRecordModel } from '../modules/provenance/model.js';
export { AuditLogModel } from '../modules/audit/model.js';
export { InvestigationModel } from '../modules/investigations/model.js';
export { JobModel } from '../modules/jobs/model.js';
export { SatelliteSceneModel } from '../modules/scenes/model.js';
export { SpillDetectionModel } from '../modules/detections/model.js';
export { VesselModel, VesselTrackModel } from '../modules/ais/model.js';
export { OriginEstimateModel } from '../modules/origin/model.js';
export { CandidateVesselModel } from '../modules/candidates/model.js';
