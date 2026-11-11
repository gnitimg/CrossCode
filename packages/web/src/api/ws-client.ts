import type { UnifiedStreamEvent } from '@crosscode/shared';
import { useWorkbenchStore } from '../store/workbench';
import type { ApprovalCard } from '../store/model';

/**
 * WebSocket session client for the daemon gateway (`/ws/session`).
 *
 * Downstream: `UnifiedStreamEvent`s + approval_request/approval_resolved +
 * session_attached/provider_switched/auth_ok/error frames — parsed and folded
 * into the workbench store via {@link dispatchGatewayFrame}.
 * Upstream: `auth` / `approve` / `reject` / `send_prompt` / `switch_provider`.
 *
 * The socket authenticates with an `auth` frame after open, reconnects with
 * exponential backoff, and can fall back into offline demo mode after repeated
 * failures (see `onDemoFallback`). The WebSocket implementation is injectable
 * so tests run against a fake without any real network I/O.
 */

export type GatewayUpstreamFrame =
  | { type: 'auth'; token: string }
  | { type: 'approve'; approvalId: string }
  | { type: 'reject'; approvalId: string }
  | { type: 'send_prompt'; prompt: string }
  | { type: 'switch_provider'; providerId: string };

export interface SessionTransport {
  sendPrompt(prompt: string): void;
  switchProvider(providerId: string): void;
  respondApproval(approvalId: string, approved: boolean): void;
  /** Optional hot restart used by the RESTART_PROCESS self-heal action. */
  restart?(): void;
}

/** Minimal structural WebSocket surface (real WebSocket and fakes both fit). */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: (() => void) | null;
}

export type WsFactory = (url: string) => WsLike;

const defaultWsFactory: WsFactory = (url) => new WebSocket(url) as unknown as WsLike;

const WS_CLOSE_UNAUTHORIZED = 4001;

const STREAM_EVENT_TYPES: ReadonlySet<string> = new Set<UnifiedStreamEvent['type']>([
  'thinking_delta',
  'text_delta',
  'tool_call_start',
  'tool_call_result',
  'file_change',
  'normalized_error',
  'harness_switched',
  'screen_frame',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Pure downstream-frame dispatcher: folds one gateway frame into the store.
 * Unknown frame types are ignored (forward compatibility).
 */
export function dispatchGatewayFrame(frame: unknown): void {
  if (!isPlainObject(frame)) return;
  const store = useWorkbenchStore.getState();

  switch (frame.type) {
    case 'auth_ok':
      store.setWsStatus('live');
      return;
    case 'session_attached':
      store.setSession(typeof frame.sessionId === 'string' ? frame.sessionId : null);
      return;
    case 'approval_request': {
      const card: ApprovalCard = {
        approvalId: typeof frame.approvalId === 'string' ? frame.approvalId : '',
        sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : '',
        callId: typeof frame.callId === 'string' ? frame.callId : '',
        toolName: typeof frame.toolName === 'string' ? frame.toolName : '',
        args: isPlainObject(frame.args) ? frame.args : {},
        createdAt: typeof frame.createdAt === 'string' ? frame.createdAt : new Date().toISOString(),
      };
      store.addApproval(card);
      return;
    }
    case 'approval_resolved':
      store.removeApproval(typeof frame.approvalId === 'string' ? frame.approvalId : '');
      return;
    case 'provider_switched': {
      const providerId = typeof frame.providerId === 'string' ? frame.providerId : '';
      if (!providerId) return;
      store.setProjects(
        store.projects.map((project) =>
          project.id === store.activeProjectId ? { ...project, activeProviderId: providerId } : project,
        ),
      );
      store.addSystemNote(`Provider 已切换 → ${providerId}`);
      return;
    }
    case 'error':
      store.addSystemNote(`网关错误：${typeof frame.message === 'string' ? frame.message : 'unknown'}`);
      return;
    default:
      break;
  }

  if (typeof frame.type === 'string' && STREAM_EVENT_TYPES.has(frame.type)) {
    store.applyStreamEvent(frame as UnifiedStreamEvent);
  }
}

export interface SessionSocketOptions {
  url: string;
  token: string | null;
  factory?: WsFactory;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxAttempts?: number;
  /** Called after reconnect attempts are exhausted (defaults to demo mode). */
  onDemoFallback?: (reason: string) => void;
}

export class SessionSocket implements SessionTransport {
  private ws: WsLike | null = null;
  private attempts = 0;
  private manualClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: SessionSocketOptions) {}

  connect(): void {
    this.manualClose = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    useWorkbenchStore.getState().setWsStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');

    const ws = (this.options.factory ?? defaultWsFactory)(this.options.url);
    this.ws = ws;
    ws.onopen = () => {
      useWorkbenchStore.getState().setWsStatus('authenticating');
      this.sendFrame({ type: 'auth', token: this.options.token ?? '' });
    };
    ws.onmessage = (event) => this.handleRaw(event.data);
    ws.onclose = (event) => this.handleClose(event?.code);
    ws.onerror = () => {
      // socket-level errors are followed by a close event
    };
  }

  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    useWorkbenchStore.getState().setWsStatus('closed');
  }

  /** Hot restart (RESTART_PROCESS self-heal): reset backoff and reconnect. */
  restart(): void {
    this.attempts = 0;
    const ws = this.ws;
    this.ws = null;
    this.manualClose = true;
    ws?.close();
    this.connect();
  }

  sendPrompt(prompt: string): void {
    this.sendFrame({ type: 'send_prompt', prompt });
  }

  switchProvider(providerId: string): void {
    this.sendFrame({ type: 'switch_provider', providerId });
  }

  respondApproval(approvalId: string, approved: boolean): void {
    this.sendFrame({ type: approved ? 'approve' : 'reject', approvalId });
  }

  private sendFrame(frame: GatewayUpstreamFrame): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(frame));
      return;
    }
    useWorkbenchStore.getState().addSystemNote('WebSocket 未就绪，指令已丢弃');
  }

  private handleRaw(data: unknown): void {
    let frame: unknown;
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data));
    } catch {
      return;
    }
    if (isPlainObject(frame) && frame.type === 'auth_ok') {
      this.attempts = 0;
    }
    dispatchGatewayFrame(frame);
  }

  private handleClose(code?: number): void {
    this.ws = null;
    const store = useWorkbenchStore.getState();

    if (this.manualClose) {
      store.setWsStatus('closed');
      return;
    }
    if (code === WS_CLOSE_UNAUTHORIZED) {
      // Pairing token rejected: surface the PIN pairing gate again.
      store.setWsStatus('failed');
      store.setTransport(null);
      store.clearJwt();
      store.setMode('offline');
      return;
    }

    this.attempts += 1;
    const maxAttempts = this.options.maxAttempts ?? 10;
    if (this.attempts > maxAttempts) {
      store.setWsStatus('failed');
      store.setTransport(null);
      const fallback =
        this.options.onDemoFallback ?? ((reason: string) => useWorkbenchStore.getState().enterDemoMode(reason));
      fallback('WebSocket 多次重连失败，已进入离线演示模式');
      return;
    }

    store.setWsStatus('reconnecting');
    store.setReconnectAttempt(this.attempts);
    const base = this.options.reconnectBaseMs ?? 1200;
    const max = this.options.reconnectMaxMs ?? 15000;
    const delay = Math.min(max, base * 2 ** (this.attempts - 1)) + Math.random() * 250;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}
