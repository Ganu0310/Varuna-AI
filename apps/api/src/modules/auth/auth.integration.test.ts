import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../../app.js';
import { connectMongo, disconnectMongo } from '../../db/connection.js';
import { UserModel, RefreshTokenModel } from './model.js';

/**
 * Auth against a REAL MongoDB — 06_BACKEND §6.4.1 / §6.9, 02_TRD SEC-1/SEC-2.
 * These prove the security properties end to end: hashing, cookie flags, rotation, and
 * the reuse-detection revocation.
 */
const app = createApp();

const CREDS = {
  email: 'analyst@varuna.test',
  password: 'correct-horse-battery',
  name: 'Test Analyst',
};

function cookieValue(setCookie: string[] | undefined, name: string): string | undefined {
  const hit = (setCookie ?? []).find((c) => c.startsWith(`${name}=`));
  return hit?.split(';')[0]?.split('=')[1];
}

function cookieAttrs(setCookie: string[] | undefined, name: string): string {
  return (setCookie ?? []).find((c) => c.startsWith(`${name}=`)) ?? '';
}

describe('auth flow (real MongoDB)', () => {
  beforeAll(async () => {
    await connectMongo();
  });

  beforeEach(async () => {
    await UserModel.deleteMany({ email: CREDS.email });
    await RefreshTokenModel.deleteMany({});
  });

  afterAll(async () => {
    await UserModel.deleteMany({ email: CREDS.email });
    await RefreshTokenModel.deleteMany({});
    await disconnectMongo();
  });

  it('registers, stores an argon2id hash (never the password), and sets httpOnly cookies', async () => {
    const res = await request(app).post('/api/v1/auth/register').send(CREDS);
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(CREDS.email);
    // The default role is analyst — a user cannot self-assign privilege (01_PRD FR-9.2).
    expect(res.body.user.role).toBe('analyst');
    // No token is ever in the body.
    expect(JSON.stringify(res.body)).not.toContain(CREDS.password);
    expect(res.body.accessToken).toBeUndefined();

    const stored = await UserModel.findOne({ email: CREDS.email }).select('+passwordHash');
    expect(stored!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored!.passwordHash).toContain('m=19456'); // 02_TRD SEC-1
    expect(stored!.passwordHash).toContain('t=2');
    expect(stored!.passwordHash).not.toContain(CREDS.password);

    const attrs = cookieAttrs(res.headers['set-cookie'] as unknown as string[], 'varuna_access');
    expect(attrs).toMatch(/HttpOnly/i);
    expect(attrs).toMatch(/SameSite=Strict/i);
  });

  it('rejects a duplicate email with 409', async () => {
    await request(app).post('/api/v1/auth/register').send(CREDS);
    const res = await request(app).post('/api/v1/auth/register').send(CREDS);
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('rejects a weak password before it reaches the database', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ ...CREDS, password: 'short' });
    expect(res.status).toBe(400);
    expect(await UserModel.countDocuments({ email: CREDS.email })).toBe(0);
  });

  it('logs in with the right password and refuses the wrong one — with an identical message', async () => {
    await request(app).post('/api/v1/auth/register').send(CREDS);

    const good = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: CREDS.email, password: CREDS.password });
    expect(good.status).toBe(200);

    const bad = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: CREDS.email, password: 'wrong-password-entirely' });
    expect(bad.status).toBe(401);

    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@varuna.test', password: 'wrong-password-entirely' });
    expect(unknown.status).toBe(401);
    // Identical wording: the endpoint must not reveal which emails are registered.
    expect(unknown.body.detail).toBe(bad.body.detail);
  });

  it('/me requires authentication and returns the current user', async () => {
    const agent = request.agent(app);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);

    await agent.post('/api/v1/auth/register').send(CREDS);
    const me = await agent.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(CREDS.email);
    expect(me.body.permissions.role).toBe('analyst');
  });

  it('rotates the refresh token — the old value stops working', async () => {
    const reg = await request(app).post('/api/v1/auth/register').send(CREDS);
    const first = cookieValue(reg.headers['set-cookie'] as unknown as string[], 'varuna_refresh')!;

    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`varuna_refresh=${first}`]);
    expect(rotated.status).toBe(200);
    const second = cookieValue(
      rotated.headers['set-cookie'] as unknown as string[],
      'varuna_refresh',
    )!;
    expect(second).not.toBe(first);
  });

  it('THEFT SIGNAL: reusing a spent refresh token revokes the whole family', async () => {
    const reg = await request(app).post('/api/v1/auth/register').send(CREDS);
    const first = cookieValue(reg.headers['set-cookie'] as unknown as string[], 'varuna_refresh')!;

    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`varuna_refresh=${first}`]);
    const second = cookieValue(
      rotated.headers['set-cookie'] as unknown as string[],
      'varuna_refresh',
    )!;

    // Replay the already-spent token — this is what an attacker with a stolen copy does.
    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`varuna_refresh=${first}`]);
    expect(replay.status).toBe(401);
    expect(replay.body.detail).toMatch(/reuse/i);

    // The legitimate holder's newer token is now dead too — the family was revoked.
    const afterRevoke = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`varuna_refresh=${second}`]);
    expect(afterRevoke.status).toBe(401);

    const revoked = await RefreshTokenModel.find({ revokedReason: 'REUSE_DETECTED' });
    expect(revoked.length).toBeGreaterThanOrEqual(2);
  });

  it('logout revokes the family and clears cookies', async () => {
    const reg = await request(app).post('/api/v1/auth/register').send(CREDS);
    const token = cookieValue(reg.headers['set-cookie'] as unknown as string[], 'varuna_refresh')!;

    const out = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', [`varuna_refresh=${token}`]);
    expect(out.status).toBe(204);

    const after = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', [`varuna_refresh=${token}`]);
    expect(after.status).toBe(401);
  });

  it('writes an audit entry for register and login', async () => {
    await request(app).post('/api/v1/auth/register').send(CREDS);
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: CREDS.email, password: CREDS.password });

    const actions = await mongoose.connection
      .db!.collection('audit_log')
      .find({ entityType: 'User' })
      .map((d) => d.action as string)
      .toArray();
    expect(actions).toContain('AUTH_REGISTER');
    expect(actions).toContain('AUTH_LOGIN');
  });
});
