import { describe, it, expect } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import { ROLES, type Role } from '@varuna/shared';
import { rbac } from './rbac.js';
import { errorHandler } from './errorHandler.js';
import { requestId } from './requestId.js';

/**
 * RBAC matrix — every guarded role level × every caller role, plus anonymous
 * (02_TRD SEC-3, 06_BACKEND §6.11). Deny by default is the property under test.
 */
function appGuardedBy(minimum: Role, as?: Role) {
  const app = express();
  app.use(requestId());
  app.use((req, _res, next) => {
    if (as) req.user = { id: '000000000000000000000001', email: 'a@b.co', role: as };
    next();
  });
  app.get('/guarded', rbac(minimum), (_req: Request, res: Response) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

const RANK: Record<Role, number> = { viewer: 0, analyst: 1, lead: 2, admin: 3 };

describe('rbac matrix', () => {
  for (const minimum of ROLES) {
    it(`anonymous is denied 401 on a route requiring "${minimum}"`, async () => {
      const res = await request(appGuardedBy(minimum)).get('/guarded');
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
    });

    for (const caller of ROLES) {
      const shouldPass = RANK[caller] >= RANK[minimum];
      it(`${caller} ${shouldPass ? 'passes' : 'is denied 403 on'} a route requiring "${minimum}"`, async () => {
        const res = await request(appGuardedBy(minimum, caller)).get('/guarded');
        if (shouldPass) {
          expect(res.status).toBe(200);
          expect(res.body).toEqual({ ok: true });
        } else {
          expect(res.status).toBe(403);
          expect(res.body.title).toBe('Forbidden');
        }
      });
    }
  }

  it('admin passes every level', async () => {
    for (const minimum of ROLES) {
      const res = await request(appGuardedBy(minimum, 'admin')).get('/guarded');
      expect(res.status).toBe(200);
    }
  });

  it('viewer passes only the viewer level', async () => {
    const passed: Role[] = [];
    for (const minimum of ROLES) {
      const res = await request(appGuardedBy(minimum, 'viewer')).get('/guarded');
      if (res.status === 200) passed.push(minimum);
    }
    expect(passed).toEqual(['viewer']);
  });
});
