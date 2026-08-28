import type { Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';
import { ACCESS_COOKIE } from '../middleware/authenticate.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { canAccessInvestigation } from '../middleware/rbac.js';
import { ROLE_RANK, type Role } from '@varuna/shared';

/**
 * Socket.IO — 03_ARCHITECTURE §3.8, 06_BACKEND §6.7.
 *
 * Namespaces: /jobs, /investigations, /ais.
 * The handshake verifies the JWT from the httpOnly cookie; room joins additionally check
 * investigation membership. The browser NEVER connects to an upstream data provider —
 * that would leak the API key (03_ARCHITECTURE §3.8).
 */
let io: IOServer | null = null;

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((part) => {
      const idx = part.indexOf('=');
      const k = part.slice(0, idx).trim();
      const v = decodeURIComponent(part.slice(idx + 1).trim());
      return [k, v];
    }),
  );
}

interface SocketUser {
  id: string;
  email: string;
  role: Role;
}

export function initRealtime(server: HttpServer): IOServer {
  io = new IOServer(server, {
    path: '/ws',
    cors: { origin: env.PUBLIC_APP_URL, credentials: true },
    serveClient: false,
  });

  const authenticateSocket = async (socket: Socket, next: (err?: Error) => void) => {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const claims = await verifyAccessToken(cookies[ACCESS_COOKIE] ?? '');
    if (!claims) return next(new Error('unauthorised'));
    (socket.data as { user: SocketUser }).user = {
      id: claims.sub,
      email: claims.email,
      role: claims.role,
    };
    next();
  };

  const jobs = io.of('/jobs');
  const investigations = io.of('/investigations');
  const ais = io.of('/ais');

  for (const ns of [jobs, investigations, ais]) ns.use(authenticateSocket);

  jobs.on('connection', (socket) => {
    socket.on('join', (jobId: unknown) => {
      if (typeof jobId === 'string' && jobId.length <= 200) void socket.join(`job:${jobId}`);
    });
  });

  investigations.on('connection', (socket) => {
    const user = (socket.data as { user: SocketUser }).user;
    socket.on('join', async (investigationId: unknown) => {
      if (typeof investigationId !== 'string') return;
      if (!(await canAccessInvestigation(user, investigationId))) {
        socket.emit('error', { code: 'FORBIDDEN', investigationId });
        return;
      }
      await socket.join(`inv:${investigationId}`);
      socket.emit('joined', { investigationId });
    });
  });

  ais.on('connection', (socket) => {
    const user = (socket.data as { user: SocketUser }).user;
    // Live AIS is analyst-and-above (03_ARCHITECTURE §3.8).
    if (ROLE_RANK[user.role] < ROLE_RANK.analyst) {
      socket.disconnect(true);
      return;
    }
    socket.on('subscribe', (aoiHash: unknown) => {
      if (typeof aoiHash === 'string' && aoiHash.length <= 128) void socket.join(`ais:${aoiHash}`);
    });
  });

  logger.info({ path: '/ws' }, 'socket.io initialised');
  return io;
}

export function getIo(): IOServer | null {
  return io;
}

/** Fan a job-progress event out to both the job room and the investigation room. */
export function emitJobProgress(payload: {
  jobId: string;
  investigationId?: string;
  pct: number;
  stage: string;
  message?: string;
}): void {
  if (!io) return;
  io.of('/jobs').to(`job:${payload.jobId}`).emit('job:progress', payload);
  if (payload.investigationId) {
    io.of('/investigations').to(`inv:${payload.investigationId}`).emit('job:progress', payload);
  }
}

export function emitJobTerminal(
  event: 'job:completed' | 'job:failed',
  payload: { jobId: string; kind: string; investigationId?: string; reason?: string },
): void {
  if (!io) return;
  io.of('/jobs').to(`job:${payload.jobId}`).emit(event, payload);
  if (payload.investigationId) {
    io.of('/investigations').to(`inv:${payload.investigationId}`).emit(event, payload);
  }
}

export async function closeRealtime(): Promise<void> {
  if (io) {
    await io.close();
    io = null;
  }
}
