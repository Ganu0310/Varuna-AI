import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/** X-Request-Id in, echoed out (06_BACKEND §6.2, 02_TRD §2.9). */
export function requestId() {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    req.id = incoming && incoming.length <= 200 ? incoming : randomUUID();
    res.setHeader('X-Request-Id', String(req.id));
    next();
  };
}

/**
 * `req.id` is typed by pino-http as `ReqId` (string | number | object). We always set a
 * string, but this accessor keeps call sites honest without casts.
 */
export function reqId(req: Request): string {
  return String(req.id ?? '');
}
