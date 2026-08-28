import {
  Router,
  type CookieOptions,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { env } from '../../env.js';
import { validate } from '../../middleware/validate.js';
import { reqId } from '../../middleware/requestId.js';
import { authLimiter } from '../../middleware/rateLimits.js';
import { rbac } from '../../middleware/rbac.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../middleware/authenticate.js';
import { UnauthorizedError } from '../../errors.js';
import { audit } from '../audit/service.js';
import { LoginBody, RegisterBody } from './schema.js';
import * as authService from './service.js';
import { ACCESS_TTL_SECONDS } from './tokens.js';

/**
 * Auth routes — 06_BACKEND §6.4.1.
 * Tokens travel ONLY in httpOnly cookies; they are never in a response body, so client
 * JavaScript (and therefore XSS) cannot read them (02_TRD SEC-2).
 */
export const authRouter: Router = Router();

function cookieBase(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    domain: env.COOKIE_DOMAIN === 'localhost' ? undefined : env.COOKIE_DOMAIN,
    path: '/',
  };
}

function setSessionCookies(res: Response, tokens: authService.SessionTokens): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...cookieBase(),
    maxAge: ACCESS_TTL_SECONDS * 1000,
  });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...cookieBase(),
    expires: tokens.refreshExpiresAt,
    // The refresh cookie is only ever sent to the refresh/logout endpoints.
    path: '/api/v1/auth',
  });
}

function clearSessionCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase() });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase(), path: '/api/v1/auth' });
}

const meta = (req: Request) => ({ userAgent: req.get('user-agent'), ip: req.ip });

authRouter.post(
  '/register',
  authLimiter,
  validate({ body: RegisterBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user, tokens } = await authService.register(req.body, meta(req));
      setSessionCookies(res, tokens);
      await audit({
        actorId: user._id,
        action: 'AUTH_REGISTER',
        entityType: 'User',
        entityId: user._id,
        after: { email: user.email, role: user.role },
        requestId: reqId(req),
      });
      res.status(201).json({ user });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  '/login',
  authLimiter,
  validate({ body: LoginBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { user, tokens } = await authService.login(req.body, meta(req));
      setSessionCookies(res, tokens);
      await audit({
        actorId: user._id,
        action: 'AUTH_LOGIN',
        entityType: 'User',
        entityId: user._id,
        requestId: reqId(req),
      });
      res.json({ user });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  '/refresh',
  authLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
      if (!presented) throw new UnauthorizedError('No refresh token');
      const { user, tokens } = await authService.refresh(presented, meta(req));
      setSessionCookies(res, tokens);
      res.json({ user });
    } catch (err) {
      clearSessionCookies(res);
      next(err);
    }
  },
);

authRouter.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    await authService.logout(presented);
    if (req.user) {
      await audit({
        actorId: req.user.id,
        action: 'AUTH_LOGOUT',
        entityType: 'User',
        entityId: req.user.id,
        requestId: reqId(req),
      });
    }
    clearSessionCookies(res);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

authRouter.get('/me', rbac('viewer'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await authService.getPublicUser(req.user!.id);
    if (!user) throw new UnauthorizedError('Account no longer exists');
    res.json({ user, permissions: { role: user.role } });
  } catch (err) {
    next(err);
  }
});
