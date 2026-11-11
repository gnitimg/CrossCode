/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to `1` to force the offline demo mode. */
  readonly VITE_DEMO?: string;
  /** Direct daemon origin (e.g. http://127.0.0.1:4610); empty = same-origin /api proxy. */
  readonly VITE_DAEMON_URL?: string;
}
