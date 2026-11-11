import type { HarnessId, UnifiedProject } from '@crosscode/shared';

/**
 * REST client for the daemon gateway (`http-ws-gateway.ts`).
 *
 * - When no daemon URL is configured the client talks same-origin under the
 *   `/api` prefix, which the Vite dev server proxies to the daemon (the `/api`
 *   prefix is stripped). Otherwise it calls the daemon origin directly.
 * - Every call (except pairing) carries `Authorization: Bearer <jwt>`.
 * - Successful call latency is reported through `onLatency` for the live
 *   latency readout in the top switchboard bar.
 */

export interface ProviderCatalogEntry {
  id: string;
  label: string;
  protocol: 'anthropic' | 'openai' | 'gemini' | 'custom';
  baseUrl: string;
  models: string[];
  isCustom?: boolean;
}

export interface PairResult {
  token: string;
  tokenType: string;
  expiresIn: number;
  issuedAt: string;
}

export interface SkillsState {
  skills: Record<string, boolean>;
  updatedAt: string;
}

export interface GatewayDiffChange {
  status: string;
  file: string;
  staged: boolean;
}

export interface GatewayDiffResponse {
  projectId: string;
  projectPath: string;
  isGitRepo: boolean;
  branch?: string;
  changes: GatewayDiffChange[];
  diff: string;
}

export class DaemonApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'DaemonApiError';
  }
}

export interface DaemonApiClientOptions {
  /** Direct daemon origin; empty string = same-origin /api proxy. */
  daemonUrl?: string;
  tokenProvider?: () => string | null;
  onLatency?: (ms: number) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class DaemonApiClient {
  private readonly daemonUrl: string;
  private readonly tokenProvider: () => string | null;
  private readonly onLatency?: (ms: number) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DaemonApiClientOptions = {}) {
    this.daemonUrl = ((options.daemonUrl ?? import.meta.env.VITE_DAEMON_URL ?? '') as string).replace(/\/+$/, '');
    this.tokenProvider = options.tokenProvider ?? (() => null);
    this.onLatency = options.onLatency;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 4000;
  }

  private restUrl(path: string): string {
    return this.daemonUrl ? `${this.daemonUrl}${path}` : `/api${path}`;
  }

  /** WebSocket session endpoint, optionally scoped to a project path. */
  wsSessionUrl(projectPath?: string): string {
    const params = new URLSearchParams();
    if (projectPath) params.set('projectPath', projectPath);
    const query = params.toString();
    if (this.daemonUrl) {
      return `${this.daemonUrl.replace(/^http/, 'ws')}/ws/session${query ? `?${query}` : ''}`;
    }
    const protocol = globalThis.location?.protocol === 'https:' ? 'wss' : 'ws';
    const host = globalThis.location?.host ?? 'localhost:5273';
    return `${protocol}://${host}/ws/session${query ? `?${query}` : ''}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { auth?: boolean },
  ): Promise<T> {
    const auth = options?.auth ?? true;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) {
      const token = this.tokenProvider();
      if (token) headers.authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await this.fetchImpl(this.restUrl(path), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        let message = detail;
        try {
          const parsed = JSON.parse(detail) as { error?: string };
          message = parsed.error ?? detail;
        } catch {
          // keep raw text
        }
        throw new DaemonApiError(response.status, message || `${method} ${path} failed (${response.status})`, detail);
      }
      this.onLatency?.(Date.now() - startedAt);
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof DaemonApiError) throw error;
      if (controller.signal.aborted) {
        throw new DaemonApiError(0, `请求超时（${this.timeoutMs}ms）: ${method} ${path}`);
      }
      throw new DaemonApiError(0, error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }

  // --- gateway routes ------------------------------------------------------

  pair(pin: string): Promise<PairResult> {
    return this.request<PairResult>('POST', '/pair', { pin }, { auth: false });
  }

  listProjects(): Promise<UnifiedProject[]> {
    return this.request<UnifiedProject[]>('GET', '/projects');
  }

  listProviders(): Promise<ProviderCatalogEntry[]> {
    return this.request<ProviderCatalogEntry[]>('GET', '/providers');
  }

  switchHarness(projectId: string, harnessId: HarnessId): Promise<{ ok: boolean }> {
    return this.request('POST', `/projects/${encodeURIComponent(projectId)}/harness`, { harnessId });
  }

  switchProvider(projectId: string, providerId: string, modelId?: string): Promise<{ ok: boolean }> {
    return this.request('POST', `/projects/${encodeURIComponent(projectId)}/provider`, {
      providerId,
      ...(modelId ? { modelId } : {}),
    });
  }

  getDiff(projectId: string): Promise<GatewayDiffResponse> {
    return this.request('GET', `/projects/${encodeURIComponent(projectId)}/diff`);
  }

  acceptDiff(projectId: string, files?: string[]): Promise<{ ok: boolean; accepted: string[] }> {
    return this.request('POST', `/projects/${encodeURIComponent(projectId)}/diff/accept`, files ? { files } : {});
  }

  discardDiff(projectId: string, files?: string[]): Promise<{ ok: boolean; discarded: string[] }> {
    return this.request('POST', `/projects/${encodeURIComponent(projectId)}/diff/discard`, files ? { files } : {});
  }

  getSkills(): Promise<SkillsState> {
    return this.request<SkillsState>('GET', '/skills');
  }

  putSkill(skillId: string, enabled: boolean): Promise<SkillsState> {
    return this.request('PUT', '/skills', { skillId, enabled });
  }
}
