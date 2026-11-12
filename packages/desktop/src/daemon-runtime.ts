import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createDaemonSessionManager, createGateway, type GatewayHandle } from '@crosscode/daemon';

/**
 * Daemon runtime for the desktop shell.
 *
 * Boots the same gateway the CLI/daemon exposes, plus:
 * - static hosting of the built workbench (single origin for REST + WS),
 * - a persisted JWT secret and pairing PIN so restarts keep existing sessions,
 * - automatic self-pairing: the shell mints its own token and hands it to the
 *   renderer via `?token=`, so the desktop app never shows the PIN gate.
 */

export interface ApprovalNotification {
  approvalId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface DaemonRuntimeOptions {
  /** Absolute path to the built workbench (`packages/web/dist`). */
  webDistDir: string;
  /** Directories scanned for projects. Defaults to the user's home. */
  workspaceRoots?: string[];
  /** Preferred listening port (falls back to the next free port). */
  port?: number;
  /** Directory for persisted daemon config (Electron `userData`). */
  configDir: string;
  onApprovalRequest?: (approval: ApprovalNotification) => void;
}

export interface DaemonRuntime {
  /** Workbench URL with an embedded pairing token. */
  url: string;
  /** Plain URL without credentials (for "open in browser"). */
  baseUrl: string;
  port: number;
  /** Gateway JWT the shell minted for itself (also embedded in `url`). */
  token: string;
  gateway: GatewayHandle;
  close(): Promise<void>;
}

interface DesktopConfig {
  /** Persisted so already-paired remote devices keep their JWTs across restarts. */
  jwtSecret: string;
}

const DEFAULT_PORT = 4610;
const MAX_PORT_ATTEMPTS = 12;

async function loadConfig(configDir: string): Promise<DesktopConfig> {
  const file = path.join(configDir, 'daemon.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<DesktopConfig>;
    if (typeof parsed.jwtSecret === 'string' && parsed.jwtSecret.length >= 32) {
      return { jwtSecret: parsed.jwtSecret };
    }
  } catch {
    // missing or unreadable config → create a fresh one below
  }
  const config: DesktopConfig = {
    jwtSecret: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'),
  };
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 }).catch(() => undefined);
  return config;
}

/** Exchanges the local PIN for a gateway JWT (the shell authenticates to itself). */
async function mintToken(baseUrl: string, pin: string): Promise<string> {
  const response = await fetch(`${baseUrl}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin }),
  });
  if (!response.ok) {
    throw new Error(`self-pairing failed (${response.status})`);
  }
  const payload = (await response.json()) as { token?: unknown };
  if (typeof payload.token !== 'string' || payload.token.length === 0) {
    throw new Error('self-pairing returned no token');
  }
  return payload.token;
}

export async function startDaemonRuntime(options: DaemonRuntimeOptions): Promise<DaemonRuntime> {
  const config = await loadConfig(options.configDir);
  const preferredPort = options.port ?? Number(process.env.CROSSCODE_PORT ?? DEFAULT_PORT);
  const workspaceRoots =
    options.workspaceRoots && options.workspaceRoots.length > 0 ? options.workspaceRoots : undefined;

  const sessionManager = createDaemonSessionManager({
    ...(workspaceRoots ? { defaultProjectPath: workspaceRoots[0] } : {}),
  });

  let gateway: GatewayHandle | null = null;
  let port = preferredPort;

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    const candidate = preferredPort + attempt;
    const handle = createGateway({
      jwtSecret: config.jwtSecret,
      staticDir: options.webDistDir,
      sessionManager,
      ...(workspaceRoots
        ? { scanOptions: { workspaceRoots } }
        : {}),
      onApprovalRequest: (record) => {
        options.onApprovalRequest?.({
          approvalId: record.approvalId,
          toolName: record.toolName,
          args: record.args,
        });
      },
    });
    try {
      await handle.app.listen({ port: candidate, host: '127.0.0.1' });
      gateway = handle;
      port = candidate;
      break;
    } catch (error) {
      await handle.close().catch(() => undefined);
      const code = (error as { code?: string }).code;
      if (code !== 'EADDRINUSE') throw error;
    }
  }

  if (!gateway) {
    throw new Error(`no free port in range ${preferredPort}-${preferredPort + MAX_PORT_ATTEMPTS - 1}`);
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  let token: string;
  try {
    token = await mintToken(baseUrl, gateway.getPin());
  } catch {
    // A stale lockout can block self-pairing; rotating clears it.
    gateway.rotatePin();
    token = await mintToken(baseUrl, gateway.getPin());
  }

  return {
    url: `${baseUrl}/?desktop=1&token=${encodeURIComponent(token)}`,
    baseUrl,
    port,
    token,
    gateway,
    async close() {
      await gateway?.close();
    },
  };
}
