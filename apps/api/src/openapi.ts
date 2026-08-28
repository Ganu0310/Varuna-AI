import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { ProblemDetails } from '@varuna/shared';
import { LoginBody, PublicUser, RegisterBody } from './modules/auth/schema.js';
import { CatalogueSearchQuery } from './modules/catalogue/schema.js';
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
