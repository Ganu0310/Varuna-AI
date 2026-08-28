import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';

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
};

export function SocketProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const base = import.meta.env.VITE_API_URL ?? '';
    const s = io(`${base}/investigations`, {
      path: '/ws',
      withCredentials: true,
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 10_000,
    });

    s.on('connect', () => {
      setConnected(true);
      setStale(false);
    });
    s.on('disconnect', () => {
      setConnected(false);
      setStale(true);
    });
    s.on('connect_error', () => setStale(true));

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
      s.removeAllListeners();
      s.close();
    };
  }, [qc]);

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
