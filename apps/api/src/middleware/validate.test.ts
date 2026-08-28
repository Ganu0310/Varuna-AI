import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { validate, validatedQuery } from './validate.js';
import { errorHandler } from './errorHandler.js';
import { requestId } from './requestId.js';

const Body = z.object({ name: z.string().min(1), count: z.number().int() }).strict();
const Query = z.object({ limit: z.coerce.number().int().min(1).max(10).default(5) }).strict();

function app() {
  const a = express();
  a.use(requestId());
  a.use(express.json());
  a.post('/b', validate({ body: Body }), (req, res) => res.json({ received: req.body }));
  a.get('/q', validate({ query: Query }), (req, res) =>
    res.json({ received: validatedQuery(req) }),
  );
  a.use(errorHandler);
  return a;
}

describe('validate middleware', () => {
  it('accepts a valid body and passes the PARSED value downstream', async () => {
    const res = await request(app()).post('/b').send({ name: 'x', count: 3 });
    expect(res.status).toBe(200);
    expect(res.body.received).toEqual({ name: 'x', count: 3 });
  });

  it('rejects unknown keys (.strict) rather than silently dropping them', async () => {
    const res = await request(app()).post('/b').send({ name: 'x', count: 3, sneaky: true });
    expect(res.status).toBe(400);
    expect(res.body.title).toBe('Request validation failed');
  });

  it('returns RFC 9457 problem+json with a per-field path', async () => {
    const res = await request(app()).post('/b').send({ name: '', count: 'nope' });
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const paths = (res.body.errors as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('name');
    expect(paths).toContain('count');
    expect(res.body.requestId).toBeTruthy();
  });

  it('coerces and defaults query values', async () => {
    expect((await request(app()).get('/q')).body.received).toEqual({ limit: 5 });
    expect((await request(app()).get('/q?limit=7')).body.received).toEqual({ limit: 7 });
  });

  it('rejects an out-of-range query value', async () => {
    const res = await request(app()).get('/q?limit=99');
    expect(res.status).toBe(400);
  });
});
