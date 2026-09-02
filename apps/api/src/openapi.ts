import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ProblemDetails, REJECTION_CATEGORY_IDS, SAR_CLASSES } from '@varuna/shared';
import { LoginBody, PublicUser, RegisterBody } from './modules/auth/schema.js';
import { CatalogueSearchQuery } from './modules/catalogue/schema.js';
import { ReviewBody } from './modules/detections/schema.js';
import { TrainingLabelQuery } from './modules/admin/schema.js';
import { DiscoverDetectionsQuery, TriggerSweepBody } from './modules/discover/schema.js';
import {
  AddMemberBody,
  CreateInvestigationBody,
  ListInvestigationsQuery,
  UpdateInvestigationBody,
} from './modules/investigations/schema.js';

/**
 * OpenAPI 3.1 generated FROM the Zod schemas, so the spec cannot drift from the
 * implementation (02_TRD §2.2.2, 06_BACKEND §6.4). CI diffs the emitted document.
 */
extendZodWithOpenApi(z);

const problem = {
  description: 'RFC 9457 problem+json',
  content: { 'application/problem+json': { schema: ProblemDetails } },
};

function buildRegistry(): OpenAPIRegistry {
  const r = new OpenAPIRegistry();

  r.registerPath({
    method: 'post',
    path: '/api/v1/auth/register',
    tags: ['auth'],
    summary: 'Create an account and start a session',
    request: { body: { content: { 'application/json': { schema: RegisterBody } } } },
    responses: {
      201: {
        description: 'Created; access and refresh cookies set',
        content: { 'application/json': { schema: z.object({ user: PublicUser }) } },
      },
      409: problem,
      429: problem,
    },
  });

  r.registerPath({
    method: 'post',
    path: '/api/v1/auth/login',
    tags: ['auth'],
    request: { body: { content: { 'application/json': { schema: LoginBody } } } },
    responses: {
      200: {
        description: 'Signed in; cookies set',
        content: { 'application/json': { schema: z.object({ user: PublicUser }) } },
      },
      401: problem,
      429: problem,
    },
  });

  r.registerPath({
    method: 'post',
    path: '/api/v1/auth/refresh',
    tags: ['auth'],
    summary: 'Rotate the refresh token. Reuse of a spent token revokes the whole family.',
    responses: {
      200: {
        description: 'Rotated',
        content: { 'application/json': { schema: z.object({ user: PublicUser }) } },
      },
      401: problem,
    },
  });

  r.registerPath({
    method: 'post',
    path: '/api/v1/auth/logout',
    tags: ['auth'],
    responses: { 204: { description: 'Session ended' } },
  });

  r.registerPath({
    method: 'get',
    path: '/api/v1/auth/me',
    tags: ['auth'],
    responses: {
      200: {
        description: 'Current user',
        content: {
          'application/json': {
            schema: z.object({ user: PublicUser, permissions: z.object({ role: z.string() }) }),
          },
        },
      },
      401: problem,
    },
  });

  r.registerPath({
    method: 'get',
    path: '/api/v1/investigations',
    tags: ['investigations'],
    request: { query: ListInvestigationsQuery },
    responses: {
      200: {
        description: 'Cursor-paginated list',
        content: {
          'application/json': {
            schema: z.object({ items: z.array(z.unknown()), nextCursor: z.string().nullable() }),
          },
        },
      },
      401: problem,
      403: problem,
    },
  });

  r.registerPath({
    method: 'post',
    path: '/api/v1/investigations',
    tags: ['investigations'],
    summary:
      'Create an investigation. AOI is capped at 50,000 km² (geodesic) and the window at 30 days.',
    request: { body: { content: { 'application/json': { schema: CreateInvestigationBody } } } },
    responses: {
      201: { description: 'Created', content: { 'application/json': { schema: z.unknown() } } },
      422: problem,
      401: problem,
    },
  });

  r.registerPath({
    method: 'get',
    path: '/api/v1/investigations/{id}',
    tags: ['investigations'],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Investigation',
        content: { 'application/json': { schema: z.unknown() } },
      },
      404: problem,
    },
  });

  r.registerPath({
    method: 'get',
    path: '/api/v1/investigations/{id}/summary',
    tags: ['investigations'],
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Pipeline stage roll-up',
        content: { 'application/json': { schema: z.unknown() } },
      },
      404: problem,
    },
  });

  r.registerPath({
    method: 'patch',
    path: '/api/v1/investigations/{id}',
    tags: ['investigations'],
    summary: 'Update. Changing the AOI or window invalidates downstream results and says so.',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: UpdateInvestigationBody } } },
    },
    responses: {
      200: { description: 'Updated', content: { 'application/json': { schema: z.unknown() } } },
      404: problem,
      422: problem,
    },
  });

  r.registerPath({
    method: 'delete',
    path: '/api/v1/investigations/{id}',
    tags: ['investigations'],
    request: { params: z.object({ id: z.string() }) },
    responses: { 204: { description: 'Soft-deleted' }, 404: problem },
  });

  r.registerPath({
    method: 'post',
    path: '/api/v1/investigations/{id}/members',
    tags: ['investigations'],
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: AddMemberBody } } },
    },
    responses: {
      200: {
        description: 'Members updated',
        content: { 'application/json': { schema: z.unknown() } },
      },
      404: problem,
    },
  });

  r.registerPath({
    method: 'get',
    path: '/api/v1/catalogue/search',
    tags: ['catalogue'],
    summary:
      'Live satellite catalogue search. Queries every configured provider in parallel and ' +
      'returns a normalised, de-duplicated list plus a per-provider status. Nothing is ' +
      'persisted. A provider returning zero results is reported as NO_RESULTS (a real ' +
      'answer about coverage), not as a failure.',
    request: { query: CatalogueSearchQuery },
    responses: {
      200: {
        description: 'Normalised results with per-provider status',
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(z.unknown()),
              providerStatus: z.array(
                z.object({
                  provider: z.string(),
                  status: z.enum([
                    'OK',
                    'NO_RESULTS',
                    'CIRCUIT_OPEN',
                    'QUOTA_EXHAUSTED',
                    'NOT_CONFIGURED',
                    'TIMEOUT',
                    'ERROR',
                  ]),
                  count: z.number(),
                  latencyMs: z.number().nullable(),
                  reason: z.string().optional(),
                  retryAt: z.string().optional(),
                }),
              ),
            }),
          },
        },
      },
      400: problem,
      429: problem,
      503: {
        description:
          'Every provider in the chain failed. The body carries attempted[] and a ' +
          'consequence string; no results are returned rather than results from an ' +
          'unverified source.',
        content: { 'application/problem+json': { schema: ProblemDetails } },
      },
    },
  });

  r.registerPath({
    method: 'get',
    path: '/api/v1/catalogue/providers',
    tags: ['catalogue'],
    summary: 'Provider health: circuit state, quota consumed, p95 latency, last success.',
    responses: {
      200: {
        description: 'Provider health',
        content: { 'application/json': { schema: z.object({ items: z.array(z.unknown()) }) } },
      },
      401: problem,
    },
  });

  /**
   * The two operator-upload routes are documented together because they are one interaction:
   * `inspect` says what a file claims about itself, `upload` accepts it on those terms.
   */
  r.registerPath({
    method: 'post',
    path: '/api/v1/investigations/{id}/scenes/inspect',
    tags: ['scenes'],
    summary:
      'Read a GeoTIFF header and report what the file says about itself — coordinate system, ' +
      'size, pixel spacing, a preview footprint, and every acquisition time it states, each ' +
      'with its source and how far it can be trusted. Nothing is stored or queued. Send the ' +
      'whole file or only its leading bytes; a mission product identifier in `originalName` ' +
      'is read too.',
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'multipart/form-data': {
            schema: z.object({
              scene: z.string().openapi({ type: 'string', format: 'binary' }),
              originalName: z.string().optional(),
              totalBytes: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'What the file states, plus how its extent sits against the AOI',
        content: {
          'application/json': {
            schema: z.object({
              acceptable: z.boolean(),
              rejectionReason: z.string().nullable(),
              partial: z.boolean(),
              metadata: z.unknown(),
              aoi: z.unknown().nullable(),
              note: z.string(),
            }),
          },
        },
      },
      400: problem,
      403: problem,
      404: problem,
    },
  });

  /**
   * Discover — browsing what the scheduled sweep already found, and asking it to look now.
   * See `apps/api/src/modules/discover/service.ts` for why these reads deliberately cross
   * investigation boundaries.
   */
  r.registerPath({
    method: 'get',
    path: '/api/v1/discover/overpasses',
    tags: ['discover'],
    summary:
      'Every satellite acquisition the sweep saw over the watch regions in a period — ' +
      'readable or not. An overpass that produced no detection is still evidence the sky was ' +
      'watched, and `ingestibleReason` carries the reason the provider itself gave for why ' +
      'a product cannot be analysed (raw GRD needing SNAP correction, typically). ' +
      'Pre-computed by the ' +
      'sweep; this never queries a provider.',
    request: { query: DiscoverDetectionsQuery },
    responses: {
      200: {
        description: 'Acquisitions in the period, newest first',
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(
                z.object({
                  _id: z.string(),
                  regionId: z.string(),
                  productId: z.string(),
                  provider: z.string(),
                  collection: z.string(),
                  acquiredAt: z.string(),
                  platform: z.string().nullable(),
                  footprint: z.unknown().nullable(),
                  ingestible: z.boolean(),
                  ingestibleReason: z.string().nullable(),
                }),
              ),
            }),
          },
        },
      },
      400: problem,
      403: problem,
    },
  });

  r.registerPath({
    method: 'post',
    path: '/api/v1/discover/sweep',
    tags: ['discover'],
    summary:
      'Run a sweep now for one watch region, or all of them. A manual sweep re-searches a ' +
      'wide window rather than the incremental gap a scheduled tick uses, because someone ' +
      'pressing this is asking what is out there, not what changed since last night. The job ' +
      'key is stable per scope, so a second press while one is running is reported as ' +
      '`deduplicated` instead of starting a second sweep.',
    request: {
      body: { content: { 'application/json': { schema: TriggerSweepBody } } },
    },
    responses: {
      202: {
        description: 'Sweep queued',
        content: {
          'application/json': {
            schema: z.object({
              jobId: z.string(),
              deduplicated: z.boolean(),
              regionId: z.string().nullable(),
            }),
          },
        },
      },
      200: { description: 'A sweep with this scope is already running; the same job is returned' },
      403: problem,
      404: problem,
      429: problem,
    },
  });

  r.registerPath({
    method: 'post',
    path: '/api/v1/scenes/inspect',
    tags: ['scenes'],
    summary:
      'The same header read, before any investigation exists. Used by the new-investigation ' +
      'form to derive an area of interest and a time window from the scene itself. Nothing ' +
      'is stored or queued, and the response omits the AOI comparison because there is no ' +
      'AOI yet.',
    request: {
      body: {
        content: {
          'multipart/form-data': {
            schema: z.object({
              scene: z.string().openapi({ type: 'string', format: 'binary' }),
              originalName: z.string().optional(),
              totalBytes: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'What the file states about itself',
        content: {
          'application/json': {
            schema: z.object({
              acceptable: z.boolean(),
              rejectionReason: z.string().nullable(),
              partial: z.boolean(),
              metadata: z.unknown(),
              note: z.string(),
            }),
          },
        },
      },
      400: problem,
      403: problem,
      413: problem,
    },
  });

  r.registerPath({
    method: 'post',
    path: '/api/v1/investigations/{id}/scenes/upload',
    tags: ['scenes'],
    summary:
      'Accept an operator-supplied SAR GeoTIFF. Refused unless it is genuinely georeferenced. ' +
      '`acquiredAt` may be omitted when the file states it unambiguously (a mission product ' +
      'identifier, or a metadata key meaning acquisition rather than production); a weak ' +
      'signal such as TIFFTAG_DATETIME is never adopted, and the 400 lists what was found. ' +
      'The resulting scene is recorded as OPERATOR_SUPPLIED everywhere it appears.',
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'multipart/form-data': {
            schema: z.object({
              scene: z.string().openapi({ type: 'string', format: 'binary' }),
              acquiredAt: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: { description: 'These exact bytes were already held; no duplicate work queued' },
      202: {
        description: 'Stored and queued for ingest and detection',
        content: {
          'application/json': {
            schema: z.object({
              jobId: z.string(),
              productId: z.string(),
              checksum: z.string(),
              acquiredAt: z.string(),
              acquiredAtSource: z.string().nullable(),
              extracted: z.unknown(),
              provenanceNotice: z.string(),
            }),
          },
        },
      },
      400: problem,
      403: problem,
      422: problem,
    },
  });

  r.registerPath({
    method: 'get',
    path: '/api/v1/detections/rejection-categories',
    tags: ['detections'],
    summary:
      'The rejection taxonomy a REJECT review must name. A category is usable as a labelled ' +
      'negative for the detector iff it names a sarClass; OPERATIONAL categories describe ' +
      'the workflow rather than the imagery and are deliberately excluded from training.',
    responses: {
      200: {
        description: 'Every category, with its kind, training class and description',
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(
                z.object({
                  id: z.string(),
                  label: z.string(),
                  kind: z.enum(['LOOK_ALIKE', 'OPERATIONAL']),
                  sarClass: z.enum(SAR_CLASSES).nullable(),
                  description: z.string(),
                }),
              ),
              note: z.string(),
            }),
          },
        },
      },
      401: problem,
    },
  });

  r.registerPath({
    method: 'post',
    path: '/api/v1/detections/{id}/review',
    tags: ['detections'],
    summary:
      'CONFIRM / REJECT / EDIT / REOPEN. The model output is immutable — an EDIT appends a ' +
      'version carrying the pre-edit geometry rather than overwriting it. REJECT requires ' +
      'BOTH a note (so the decision is reviewable) and a rejectionCategory (so it counts ' +
      'across cases and can become a labelled negative).',
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: ReviewBody } } },
    },
    responses: {
      200: {
        description:
          'Reviewed. `trainingClass` is the SAR class this rejection contributes as a ' +
          'labelled negative, or null when it contributes none.',
        content: {
          'application/json': {
            schema: z.object({
              detectionId: z.string(),
              reviewStatus: z.string(),
              version: z.number().int(),
              areaKm2: z.number(),
              geometryChanged: z.boolean(),
              rejectionCategory: z.enum(REJECTION_CATEGORY_IDS).optional(),
              trainingClass: z.enum(SAR_CLASSES).nullable().optional(),
            }),
          },
        },
      },
      404: problem,
      422: {
        description:
          'A REJECT without a note or without a category, or an EDIT without a geometry.',
        content: { 'application/problem+json': { schema: ProblemDetails } },
      },
    },
  });

  /**
   * Discover — browse a small, named list of watch regions a scheduled sweep already ran
   * detection over, and start an investigation from what it found. The read routes
   * deliberately cross the ordinary investigation-membership boundary (see the module
   * header in modules/discover/service.ts); documented here so that is visible in the
   * public contract rather than only in source comments.
   */
  r.registerPath({
    method: 'get',
    path: '/api/v1/discover/regions',
    tags: ['discover'],
    summary: 'The fixed list of watch regions the sweep covers, each with its real AOI.',
    responses: {
      200: {
        description: 'The watch regions',
        content: { 'application/json': { schema: z.object({ items: z.array(z.unknown()) }) } },
      },
    },
  });

  r.registerPath({
    method: 'get',
    path: '/api/v1/discover/detections',
    tags: ['discover'],
    summary:
      'Detections lying INSIDE a watch region whose scene was acquired within [from, to] ' +
      '(at most 90 days apart), optionally narrowed to one region. Selected by geography, not ' +
      'by which pipeline ingested the scene, and always filtered to investigations the caller ' +
      'may read. Nothing here triggers new provider work. outsidePeriod counts visible ' +
      'findings in the same regions that fall outside the window, so an empty list can say ' +
      'whether the period is the reason.',
    request: {
      query: z.object({
        from: z.string().datetime(),
        to: z.string().datetime(),
        regionId: z.string().optional(),
      }),
    },
    responses: {
      200: {
        description: 'Detections in the window, and a count of those outside it',
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(z.unknown()),
              outsidePeriod: z.object({
                count: z.number(),
                earliest: z.string().nullable(),
                latest: z.string().nullable(),
              }),
            }),
          },
        },
      },
      400: problem,
    },
  });

  r.registerPath({
    method: 'post',
    path: '/api/v1/discover/detections/{id}/adopt',
    tags: ['discover'],
    summary:
      'Move a Discover-found scene — and every detection on it, not only the one clicked — ' +
      'onto a real investigation. Creates a new investigation by default (the primary "start ' +
      'investigating" action); pass investigationId to adopt into an existing one instead.',
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          'application/json': { schema: z.object({ investigationId: z.string().optional() }) },
        },
      },
    },
    responses: {
      200: {
        description: 'Adopted into an existing investigation',
        content: {
          'application/json': {
            schema: z.object({
              investigationId: z.string(),
              created: z.boolean(),
              adoptedDetectionCount: z.number().int(),
            }),
          },
        },
      },
      201: { description: 'Adopted into a newly-created investigation' },
      400: problem,
      404: problem,
      409: {
        description: 'This scene is already attached to the target investigation.',
        content: { 'application/problem+json': { schema: ProblemDetails } },
      },
    },
  });

  r.registerPath({
    method: 'get',
    path: '/api/v1/admin/training-labels',
    tags: ['admin'],
    summary:
      'The labelled set analyst review has produced, across every investigation. Admin-only ' +
      'because a training set is only a set once it spans cases, and no membership does. ' +
      'Assembled from real review actions; nothing is generated and nothing is trained ' +
      'automatically.',
    request: { query: TrainingLabelQuery },
    responses: {
      200: {
        description:
          'Usable labels, the rejections that are NOT usable with the reason for each, and ' +
          'a summary carrying the per-class shortfall against the working target.',
        content: {
          'application/json': {
            schema: z.object({
              items: z.array(z.unknown()),
              unusable: z.array(
                z.object({
                  detectionId: z.string(),
                  reviewStatus: z.string(),
                  rejectionCategory: z.string().nullable(),
                  reason: z.string(),
                }),
              ),
              summary: z.object({
                reviewedDetections: z.number().int(),
                usable: z.number().int(),
                byClass: z.record(z.string(), z.number().int()),
                byCategory: z.record(z.string(), z.number().int()),
                unusable: z.object({
                  count: z.number().int(),
                  byReason: z.record(z.string(), z.number().int()),
                }),
                shortfall: z.array(
                  z.object({
                    sarClass: z.string(),
                    held: z.number().int(),
                    needed: z.number().int(),
                  }),
                ),
                readyToRetrain: z.boolean(),
                assessment: z.string(),
              }),
              note: z.string(),
            }),
          },
        },
      },
      401: problem,
      403: problem,
    },
  });

  r.registerPath({
    method: 'get',
    path: '/api/v1/jobs',
    tags: ['jobs'],
    responses: {
      200: { description: 'Jobs', content: { 'application/json': { schema: z.unknown() } } },
      401: problem,
    },
  });

  for (const action of ['cancel', 'retry'] as const) {
    r.registerPath({
      method: 'post',
      path: `/api/v1/jobs/{id}/${action}`,
      tags: ['jobs'],
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: {
          description: 'Acknowledged',
          content: { 'application/json': { schema: z.unknown() } },
        },
        404: problem,
      },
    });
  }

  return r;
}

// Explicit return type: the generator's own type lives inside a pnpm-hashed path that
// TypeScript cannot name portably.
export function openApiDocument(): Record<string, unknown> {
  const generator = new OpenApiGeneratorV31(buildRegistry().definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'VARUNA API',
      version: '1.0.0',
      description:
        'Vessel Attribution through Remote-sensing & Unified Navigational Analytics (SIH26143). ' +
        'Errors are RFC 9457 application/problem+json. Auth is via httpOnly cookies.',
    },
    servers: [{ url: '/' }],
  }) as unknown as Record<string, unknown>;
}
