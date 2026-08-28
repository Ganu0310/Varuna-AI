import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

/** X-Request-Id in, echoed out (06_BACKEND §6.2, 02_TRD §2.9). */
export function requestId() {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    req.id = incoming && incoming.length <= 200 ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}
