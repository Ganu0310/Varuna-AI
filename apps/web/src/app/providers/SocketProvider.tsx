import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { useMeCached } from '../../api/hooks.ts';

/**
 * Socket.IO provider — 05_FRONTEND §5.8.
 *
 * Job completion drives `invalidateQueries`, so the UI updates without polling. A dropped
 * connection sets `stale`, which panels surface so the user knows the view may be behind
 * (08_APP_FLOW §8.7) rather than silently showing old data.
 */
interface SocketState {
  socket: Socket | null;
  connected: boolean;
  stale: boolean;
  joinInvestigation: (id: string) => void;
}

const SocketContext = createContext<SocketState>({
  socket: null,
  connected: false,
  stale: false,
  joinInvestigation: () => {},
});

const KIND_TO_QUERY_KEYS: Record<string, string[][]> = {
  INGEST: [['scenes']],
  DETECTION: [['detections']],
  DRIFT: [['origin']],
  AIS_IMPORT: [['tracks']],
  SCORING: [['candidates']],
  REPORT: [['reports']],
  // A sweep changes what Discover has to show, so a finished one refreshes the page rather
  // than leaving yesterday's results up until someone reloads.
  SWEEP_TICK: [['discover-detections'], ['discover-overpasses'], ['discover-regions']],
};

export function SocketProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useMeCached();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [stale, setStale] = useState(false);

  // Keyed on WHO is signed in, not merely that someone is: a logout followed by a different
  // login must not keep a socket that was authorised for the previous analyst.
  const userId = me?.user._id;

  useEffect(() => {
    /*
      No session, no socket.

      This provider wraps the whole router, public routes included, so it used to open a
      connection on the landing and login pages — where the handshake CANNOT succeed, because
      it reads the same access cookie the REST calls do. The rejection is not quiet either:
      the server drops the engine.io session the moment the namespace middleware refuses it,
      and the long-poll already in flight for that session id comes back as a 400 on /ws.

      Waiting for /auth/me costs nothing — the cache already holds it by the time any
      authenticated route renders — and removes the one failure this provider was guaranteed
      to produce on every visit.
    */
    if (!userId) {
      setSocket(null);
      setConnected(false);
      setStale(false);
      return;
    }

    const base = import.meta.env.VITE_API_URL ?? '';
    const s = io(`${base}/investigations`, {
      path: '/ws',
      withCredentials: true,
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 10_000,
    });

    let retry: ReturnType<typeof setTimeout> | undefined;

    s.on('connect', () => {
      setConnected(true);
      setStale(false);
    });
    s.on('disconnect', () => {
      setConnected(false);
      setStale(true);
    });
    s.on('connect_error', () => {
      setConnected(false);
      setStale(true);
      // socket.io reconnects after a TRANSPORT failure, never after a handshake the server's
      // middleware rejected — that one is terminal unless someone calls connect() again.
      // An expired access cookie lands here, and apiFetch rotates it within the minute, so a
      // slow retry of our own is the difference between the view recovering and it sitting
      // stale until the analyst reloads. `active` means the manager is already retrying.
      if (s.active) return;
      clearTimeout(retry);
      retry = setTimeout(() => s.connect(), 5_000);
    });

    s.on('job:progress', () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    });

    s.on('job:completed', ({ kind }: { kind: string }) => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      for (const key of KIND_TO_QUERY_KEYS[kind] ?? []) {
        void qc.invalidateQueries({ queryKey: key });
      }
    });

    s.on('job:failed', () => {
      void qc.invalidateQueries({ queryKey: ['jobs'] });
    });

    setSocket(s);
    return () => {
      clearTimeout(retry);
      s.removeAllListeners();
      s.close();
    };
  }, [qc, userId]);

  const value = useMemo<SocketState>(
    () => ({
      socket,
      connected,
      stale,
      joinInvestigation: (id: string) => socket?.emit('join', id),
    }),
    [socket, connected, stale],
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketState {
  return useContext(SocketContext);
}
