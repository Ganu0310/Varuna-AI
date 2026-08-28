import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The client never holds a third-party data-provider credential (02_TRD TR-7). The dev
// server proxies /api and /ws to the Node API; only VITE_-prefixed vars reach the bundle,
// and the only ones permitted are VITE_API_URL and VITE_SENTRY_DSN (11_API_KEYS §11.9.1).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true },
      '/tiles': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
