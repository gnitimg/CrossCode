/**
 * External browser bridge.
 *
 * Two ways to drive a user-owned browser:
 *
 * 1. Companion browser extension over WebSocket
 *    - Endpoint path: `/ws/chrome-extension`, attachable to an external
 *      `http.Server` (or self-hosted via `listen()`).
 *    - Protocol (JSON text frames):
 *      - extension → server: `{ type: 'register', tabs: [{ id, title, url, active }] }`
 *      - server   → extension: `{ type: 'action', requestId, tabId, action: { kind, payload } }`
 *      - extension → server: `{ type: 'result', requestId, ok, payload? }`
 *    - Latest registered connection wins (single-user local tool).
 *
 * 2. Chrome DevTools Protocol (`--remote-debugging-port=9222`)
 *    - `listTabs`  → GET `<cdp>/json/list`
 *    - `activateTab` → GET `<cdp>/json/activate/<tabId>`
 *    - `execAction` → generic CDP command passthrough over the page's
 *      `webSocketDebuggerUrl` (`action.kind` = CDP method, `action.payload` = params).
 *
 * Both transports sit behind the injectable `ExternalBrowserConnector`
 * interface. When an extension is connected it is preferred; otherwise the
 * configured CDP connector is used. Every HTTP/socket edge is injectable so
 * tests stay fully offline.
 */

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ExternalTabInfo {
  id: string;
  title?: string;
  url?: string;
  active?: boolean;
}

export interface ExternalBrowserAction {
  /** Semantic action for the extension (e.g. `activate`, `click`, `scroll`, `evaluate`) or a CDP method name when routed via CDP. */
  kind: string;
  payload?: Record<string, unknown>;
}

export interface ExternalBrowserConnector {
  listTabs(): Promise<ExternalTabInfo[]>;
  activateTab(tabId: string): Promise<unknown>;
  execAction(tabId: string, action: ExternalBrowserAction): Promise<unknown>;
}

export class ExternalBrowserBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalBrowserBridgeError';
  }
}

// ---------------------------------------------------------------------------
// WebSocket bridge (extension transport)
// ---------------------------------------------------------------------------

export const CHROME_EXTENSION_WS_PATH = '/ws/chrome-extension';

interface PendingAction {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ExtensionBridgeOptions {
  /** Upgrade path handled by this bridge. Default `/ws/chrome-extension`. */
  wsPath?: string;
  /** How long to wait for an extension action result. Default 10s. */
  actionTimeoutMs?: number;
}

/**
 * WebSocket server for companion browser extensions. Implements the
 * registration store plus request/response action dispatch. Attachable to any
 * `http.Server` via `attachToServer(server)` (handles only its own path on
 * `upgrade`; other paths are untouched/destroyed), or self-hosted with
 * `listen(port)`.
 */
export class ExtensionWebSocketBridge {
  private readonly wsPath: string;
  private readonly actionTimeoutMs: number;
  private readonly wss: WebSocketServer;
  private extensionSocket: WebSocket | null = null;
  private registeredTabs: ExternalTabInfo[] = [];
  private readonly pendingActions = new Map<string, PendingAction>();
  /** http.Server created by self-hosted `listen()` (kept alive until `close()`). */
  private selfHostedServer: http.Server | null = null;

  constructor(options: ExtensionBridgeOptions = {}) {
    this.wsPath = options.wsPath ?? CHROME_EXTENSION_WS_PATH;
    this.actionTimeoutMs = options.actionTimeoutMs ?? 10_000;
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on('connection', (socket) => this.handleConnection(socket));
  }

  get path(): string {
    return this.wsPath;
  }

  get isExtensionConnected(): boolean {
    return this.extensionSocket !== null && this.extensionSocket.readyState === WebSocket.OPEN;
  }

  /** Handle `upgrade` for our path on an external http.Server. */
  attachToServer(server: http.Server): void {
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      if (url.pathname !== this.wsPath) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, request);
      });
    });
  }

  /** Self-host convenience: standalone http server bound to `port` (0 = ephemeral). */
  async listen(port = 0): Promise<number> {
    const server = http.createServer((_req, res) => {
      res.writeHead(404).end();
    });
    this.attachToServer(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    // Keep the http server referenced so the bridge stays reachable until close().
    this.selfHostedServer = server;
    return (server.address() as { port: number }).port;
  }

  async close(): Promise<void> {
    for (const pending of this.pendingActions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ExternalBrowserBridgeError('Bridge is closing'));
    }
    this.pendingActions.clear();
    if (this.extensionSocket) {
      this.extensionSocket.close();
      this.extensionSocket = null;
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    if (this.selfHostedServer) {
      const server = this.selfHostedServer;
      this.selfHostedServer = null;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /** Currently registered tab list (what the extension last pushed). */
  getTabs(): ExternalTabInfo[] {
    return this.registeredTabs.map((tab) => ({ ...tab }));
  }

  private handleConnection(socket: WebSocket): void {
    // Latest connection wins; drop the previous extension link and its stale
    // tab registrations (the new extension has not registered anything yet).
    if (this.extensionSocket && this.extensionSocket !== socket) {
      this.extensionSocket.close();
      this.registeredTabs = [];
    }
    this.extensionSocket = socket;
    socket.on('message', (data) => {
      this.handleMessage(socket, data.toString());
    });
    socket.on('close', () => {
      if (this.extensionSocket === socket) {
        this.extensionSocket = null;
        this.registeredTabs = [];
      }
    });
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }
    const record = message as { type?: string } & Record<string, unknown>;
    if (record.type === 'register' && Array.isArray(record.tabs)) {
      this.registeredTabs = (record.tabs as ExternalTabInfo[]).map((tab) => ({
        id: String(tab.id),
        title: tab.title === undefined ? undefined : String(tab.title),
        url: tab.url === undefined ? undefined : String(tab.url),
        active: tab.active === undefined ? undefined : Boolean(tab.active),
      }));
      return;
    }
    if (record.type === 'result' && typeof record.requestId === 'string') {
      const pending = this.pendingActions.get(record.requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pendingActions.delete(record.requestId);
      if (record.ok) {
        pending.resolve(record.payload);
      } else {
        pending.reject(
          new ExternalBrowserBridgeError(
            `Extension action failed: ${String(record.error ?? 'unknown error')}`,
          ),
        );
      }
      return;
    }
    // Unknown message types are ignored (forward compatibility).
    void socket;
  }

  /** Send an action to the connected extension and await its result. */
  sendAction(tabId: string, action: ExternalBrowserAction): Promise<unknown> {
    const socket = this.extensionSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(
        new ExternalBrowserBridgeError('No browser extension is connected to the bridge'),
      );
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(requestId);
        reject(
          new ExternalBrowserBridgeError(
            `Extension action timed out after ${this.actionTimeoutMs}ms (tab ${tabId}, action ${action.kind})`,
          ),
        );
      }, this.actionTimeoutMs);
      this.pendingActions.set(requestId, { resolve, reject, timer });
      socket.send(
        JSON.stringify({ type: 'action', requestId, tabId, action }),
        (error?: Error | null) => {
          if (error) {
            clearTimeout(timer);
            this.pendingActions.delete(requestId);
            reject(new ExternalBrowserBridgeError(`Failed to send action: ${error.message}`));
          }
        },
      );
    });
  }
}

/** Connector implementation that routes every call through the WebSocket extension. */
export class ExtensionBridgeConnector implements ExternalBrowserConnector {
  constructor(private readonly bridge: ExtensionWebSocketBridge) {}

  async listTabs(): Promise<ExternalTabInfo[]> {
    return this.bridge.getTabs();
  }

  async activateTab(tabId: string): Promise<unknown> {
    return this.bridge.sendAction(tabId, { kind: 'activate' });
  }

  async execAction(tabId: string, action: ExternalBrowserAction): Promise<unknown> {
    return this.bridge.sendAction(tabId, action);
  }
}

// ---------------------------------------------------------------------------
// Chrome CDP connector (--remote-debugging-port=9222)
// ---------------------------------------------------------------------------

/** Minimal injectable HTTP GET client (no fetch/DOM types needed). */
export interface CdpHttpClient {
  get(url: string): Promise<{ status: number; body: string }>;
}

/** Injectable factory for debugger WebSocket sockets (used by `execAction`). */
export interface CdpSocketFactory {
  connect(url: string): Promise<CdpSocket>;
}

export interface CdpSocket {
  send(payload: string): void;
  /** Resolves with the next JSON message (object) received on the socket. */
  nextMessage(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface CdpConnectorOptions {
  /** CDP base URL. Default `http://127.0.0.1:9222`. */
  cdpBaseUrl?: string;
  /** HTTP client for `/json/*` endpoints. Default: node:http GET. */
  httpClient?: CdpHttpClient;
  /** Socket factory for CDP command passthrough. Default: lazy `ws` client. */
  socketFactory?: CdpSocketFactory;
  /** Timeout for CDP command responses. Default 10s. */
  commandTimeoutMs?: number;
}

function createNodeHttpCdpClient(): CdpHttpClient {
  return {
    get(url: string): Promise<{ status: number; body: string }> {
      return new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        });
        request.on('error', reject);
      });
    },
  };
}

interface CdpJsonMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** Default `ws`-client socket factory for CDP command passthrough. */
export function createWsCdpSocketFactory(): CdpSocketFactory {
  return {
    async connect(url: string): Promise<CdpSocket> {
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      const queue: Array<Promise<Record<string, unknown>>> = [];
      const waiters: Array<{
        resolve: (value: Record<string, unknown>) => void;
        reject: (reason: Error) => void;
      }> = [];
      socket.on('message', (data: unknown) => {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(String(data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (waiters.length > 0) {
          waiters.shift()!.resolve(parsed);
        } else {
          queue.push(Promise.resolve(parsed));
        }
      });
      socket.on('close', () => {
        while (waiters.length > 0) {
          waiters.shift()!.reject(new ExternalBrowserBridgeError('CDP socket closed'));
        }
      });
      return {
        send(payload: string): void {
          socket.send(payload);
        },
        async nextMessage(): Promise<Record<string, unknown>> {
          if (queue.length > 0) {
            return queue.shift()!;
          }
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
        async close(): Promise<void> {
          await new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) {
              resolve();
              return;
            }
            socket.once('close', () => resolve());
            socket.close();
          });
        },
      };
    },
  };
}

/**
 * Chrome DevTools Protocol connector for a browser started with
 * `--remote-debugging-port`. HTTP client and socket factory are injectable so
 * tests never touch a real browser.
 */
export class CdpBrowserConnector implements ExternalBrowserConnector {
  private readonly baseUrl: string;
  private readonly httpClient: CdpHttpClient;
  private readonly socketFactory: CdpSocketFactory;
  private readonly commandTimeoutMs: number;

  constructor(options: CdpConnectorOptions = {}) {
    this.baseUrl = (options.cdpBaseUrl ?? 'http://127.0.0.1:9222').replace(/\/+$/, '');
    this.httpClient = options.httpClient ?? createNodeHttpCdpClient();
    this.socketFactory = options.socketFactory ?? createWsCdpSocketFactory();
    this.commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
  }

  get cdpEndpoint(): string {
    return this.baseUrl;
  }

  async listTabs(): Promise<ExternalTabInfo[]> {
    const response = await this.httpClient.get(`${this.baseUrl}/json/list`);
    if (response.status !== 200) {
      throw new ExternalBrowserBridgeError(
        `CDP /json/list returned HTTP ${response.status} (is Chrome running with --remote-debugging-port?)`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch (error) {
      throw new ExternalBrowserBridgeError(
        `CDP /json/list returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new ExternalBrowserBridgeError('CDP /json/list response is not an array');
    }
    return (parsed as Array<Record<string, unknown>>).map((target) => ({
      id: String(target.id),
      title: target.title === undefined ? undefined : String(target.title),
      url: target.url === undefined ? undefined : String(target.url),
      active: target.type !== undefined ? String(target.type) === 'page' : undefined,
    }));
  }

  async activateTab(tabId: string): Promise<unknown> {
    const response = await this.httpClient.get(`${this.baseUrl}/json/activate/${encodeURIComponent(tabId)}`);
    if (response.status !== 200) {
      throw new ExternalBrowserBridgeError(
        `CDP /json/activate/${tabId} returned HTTP ${response.status}`,
      );
    }
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      return { activated: true };
    }
  }

  /**
   * Execute a CDP command on the page target: `action.kind` is the CDP method
   * (e.g. `Page.navigate`, `Runtime.evaluate`), `action.payload` the params.
   */
  async execAction(tabId: string, action: ExternalBrowserAction): Promise<unknown> {
    const tabs = await this.listTabs();
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (!tab) {
      throw new ExternalBrowserBridgeError(`CDP tab ${tabId} not found (query /json/list)`);
    }
    const webSocketDebuggerUrl = await this.resolveDebuggerUrl(tabId);
    const socket = await this.socketFactory.connect(webSocketDebuggerUrl);
    const id = 1;
    try {
      socket.send(
        JSON.stringify({
          id,
          method: action.kind,
          params: action.payload ?? {},
        }),
      );
      const deadline = Date.now() + this.commandTimeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new ExternalBrowserBridgeError(
            `CDP command ${action.kind} timed out after ${this.commandTimeoutMs}ms`,
          );
        }
        const message = (await this.nextMessageWithTimeout(socket, remaining)) as CdpJsonMessage;
        if (message.id === id) {
          if (message.error !== undefined) {
            throw new ExternalBrowserBridgeError(
              `CDP command ${action.kind} failed: ${JSON.stringify(message.error)}`,
            );
          }
          return message.result ?? null;
        }
        // Responses for other ids/events are skipped.
      }
    } finally {
      await socket.close().catch(() => undefined);
    }
  }

  private nextMessageWithTimeout(socket: CdpSocket, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ExternalBrowserBridgeError(`CDP command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      socket
        .nextMessage()
        .then((message) => {
          clearTimeout(timer);
          resolve(message);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  private async resolveDebuggerUrl(tabId: string): Promise<string> {
    const response = await this.httpClient.get(`${this.baseUrl}/json/list`);
    if (response.status !== 200) {
      throw new ExternalBrowserBridgeError(`CDP /json/list returned HTTP ${response.status}`);
    }
    const targets = JSON.parse(response.body) as Array<Record<string, unknown>>;
    const target = targets.find((candidate) => String(candidate.id) === tabId);
    const url = target?.webSocketDebuggerUrl;
    if (typeof url !== 'string' || url.length === 0) {
      throw new ExternalBrowserBridgeError(`CDP target ${tabId} has no webSocketDebuggerUrl`);
    }
    return url;
  }
}

// ---------------------------------------------------------------------------
// Facade: extension-first, CDP fallback
// ---------------------------------------------------------------------------

export type ExternalBrowserTransport = 'extension' | 'cdp';

export interface ExternalBrowserBridgeOptions {
  /** WebSocket bridge options (path/timeout). */
  extension?: ExtensionBridgeOptions;
  /** CDP connector options; when omitted, CDP fallback is disabled. */
  cdp?: CdpConnectorOptions;
}

export interface ExternalBridgeListTabsResult {
  transport: ExternalBrowserTransport;
  tabs: ExternalTabInfo[];
}

export interface ExternalBridgeActionResult {
  transport: ExternalBrowserTransport;
  tabId: string;
  action: ExternalBrowserAction;
  result: unknown;
}

/**
 * Facade implementing the `browser_external_*` tool API: prefers a connected
 * companion extension, falls back to the configured CDP endpoint.
 */
export class ExternalBrowserBridge {
  readonly extensionBridge: ExtensionWebSocketBridge;
  readonly extensionConnector: ExtensionBridgeConnector;
  readonly cdpConnector: CdpBrowserConnector | null;

  constructor(options: ExternalBrowserBridgeOptions = {}) {
    this.extensionBridge = new ExtensionWebSocketBridge(options.extension);
    this.extensionConnector = new ExtensionBridgeConnector(this.extensionBridge);
    this.cdpConnector = options.cdp ? new CdpBrowserConnector(options.cdp) : null;
  }

  /** Attach the extension WebSocket endpoint to an external http.Server. */
  attachToServer(server: http.Server): void {
    this.extensionBridge.attachToServer(server);
  }

  /** Self-host the extension WebSocket endpoint (ephemeral port by default). */
  async listen(port = 0): Promise<number> {
    return this.extensionBridge.listen(port);
  }

  get wsPath(): string {
    return this.extensionBridge.path;
  }

  get isExtensionConnected(): boolean {
    return this.extensionBridge.isExtensionConnected;
  }

  private getActiveConnector(): { transport: ExternalBrowserTransport; connector: ExternalBrowserConnector } | null {
    if (this.extensionBridge.isExtensionConnected) {
      return { transport: 'extension', connector: this.extensionConnector };
    }
    if (this.cdpConnector) {
      return { transport: 'cdp', connector: this.cdpConnector };
    }
    return null;
  }

  async listTabs(): Promise<ExternalBridgeListTabsResult> {
    const active = this.getActiveConnector();
    if (!active) {
      throw new ExternalBrowserBridgeError(
        'No external browser available: no extension connected and no CDP endpoint configured',
      );
    }
    return { transport: active.transport, tabs: await active.connector.listTabs() };
  }

  async activateTab(tabId: string): Promise<ExternalBridgeActionResult> {
    const active = this.getActiveConnector();
    if (!active) {
      throw new ExternalBrowserBridgeError(
        'No external browser available: no extension connected and no CDP endpoint configured',
      );
    }
    const result = await active.connector.activateTab(tabId);
    return { transport: active.transport, tabId, action: { kind: 'activate' }, result };
  }

  async execAction(
    tabId: string,
    action: ExternalBrowserAction,
  ): Promise<ExternalBridgeActionResult> {
    const active = this.getActiveConnector();
    if (!active) {
      throw new ExternalBrowserBridgeError(
        'No external browser available: no extension connected and no CDP endpoint configured',
      );
    }
    const result = await active.connector.execAction(tabId, action);
    return { transport: active.transport, tabId, action, result };
  }

  async close(): Promise<void> {
    await this.extensionBridge.close();
  }
}
