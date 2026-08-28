import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';

const app = createApp();

describe('varuna-api skeleton', () => {
  it('GET /health returns ok with a request id echoed', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('echoes an inbound X-Request-Id', async () => {
    const res = await request(app).get('/health').set('X-Request-Id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('unknown routes return RFC 9457 problem+json', async () => {
    const res = await request(app).get('/no-such-route');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ status: 404, title: 'Not found' });
    expect(res.body.requestId).toBeTruthy();
  });

  it('GET /api/v1 identifies the API', async () => {
    const res = await request(app).get('/api/v1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'varuna-api', version: 'v1' });
  });
});
