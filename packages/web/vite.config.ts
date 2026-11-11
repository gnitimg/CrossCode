/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { loadEnv } from 'vite';

/**
 * CrossCode workbench dev/build configuration.
 *
 * - Dev server listens on 5273 and proxies `/api` (REST, prefix stripped) and
 *   `/ws` (WebSocket upgrade) to the local daemon gateway.
 * - The daemon target defaults to http://127.0.0.1:4610 and can be overridden
 *   via `CROSSCODE_DAEMON_URL` (process env) or `VITE_DAEMON_URL` (.env files).
 * - `VITE_DEMO=1` forces the offline demo mode handled by the app bootstrap.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const daemonHttp =
    process.env.CROSSCODE_DAEMON_URL || env.CROSSCODE_DAEMON_URL || env.VITE_DAEMON_URL || 'http://127.0.0.1:4610';

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5273,
      proxy: {
        '/api': {
          target: daemonHttp,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
        '/ws': {
          target: daemonHttp,
          ws: true,
          changeOrigin: true,
        },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['tests/setup.ts'],
      include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'],
    },
  };
});
