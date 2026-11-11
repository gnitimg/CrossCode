import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionSocket, dispatchGatewayFrame } from '../src/api/ws-client';
import { resetWorkbenchStore, useWorkbenchStore } from '../src/store/workbench';

/** Scripted WebSocket double: records sent frames, replays gateway frames. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  url: string;
  sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const factory = (url: string): FakeWebSocket => new FakeWebSocket(url);

beforeEach(() => {
  resetWorkbenchStore();
  FakeWebSocket.instances = [];
});

afterEach(() => {
  vi.useRealTimers();
  useWorkbenchStore.getState().setTransport(null);
});

describe('ws-client downstream parsing into the store', () => {
  it('sends the auth frame on open and folds stream events into the timeline', () => {
    const socket = new SessionSocket({ url: 'ws://daemon/ws/session?projectPath=F%3A%5Ccs', token: 'jwt-test', factory });
    socket.connect();

    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeDefined();
    expect(ws!.url).toContain('/ws/session');
    ws!.open();
    expect(JSON.parse(ws!.sent[0] ?? '{}')).toEqual({ type: 'auth', token: 'jwt-test' });
    expect(useWorkbenchStore.getState().wsStatus).toBe('authenticating');

    ws!.emit({ type: 'auth_ok' });
    expect(useWorkbenchStore.getState().wsStatus).toBe('live');

    ws!.emit({ type: 'session_attached', sessionId: 'sess-1' });
    expect(useWorkbenchStore.getState().sessionId).toBe('sess-1');

    // Two consecutive text deltas merge into one message item.
    ws!.emit({ type: 'text_delta', sessionId: 'sess-1', harness: 'crosscode-native', text: '你好' });
    ws!.emit({ type: 'text_delta', sessionId: 'sess-1', harness: 'crosscode-native', text: '，世界' });
    ws!.emit({ type: 'thinking_delta', sessionId: 'sess-1', harness: 'crosscode-native', text: '先想想…' });

    const timeline = useWorkbenchStore.getState().timeline;
    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ kind: 'message', text: '你好，世界' });
    expect(timeline[1]).toMatchObject({ kind: 'thinking', text: '先想想…' });
    // Token usage accumulates from deltas.
    expect(useWorkbenchStore.getState().tokenUsage.completion).toBeGreaterThan(0);

    // Tool call lifecycle.
    ws!.emit({
      type: 'tool_call_start',
      sessionId: 'sess-1',
      callId: 'c1',
      toolName: 'browser_navigate',
      args: { url: 'https://example.com' },
      requiresApproval: true,
    });
    ws!.emit({ type: 'tool_call_result', sessionId: 'sess-1', callId: 'c1', toolName: 'browser_navigate', output: 'ok', isError: false });

    // Approval card raised by the gateway.
    ws!.emit({
      type: 'approval_request',
      approvalId: 'apr_1',
      sessionId: 'sess-1',
      callId: 'c1',
      toolName: 'browser_navigate',
      args: { url: 'https://example.com' },
      createdAt: new Date().toISOString(),
    });

    // Normalized error → banner state.
    ws!.emit({
      type: 'normalized_error',
      sessionId: 'sess-1',
      error: {
        code: 'CC-QUOTA-2002',
        category: 'QUOTA',
        harness: 'deepseek-harness',
        rawMessage: '429 insufficient_quota',
        userTitle: 'DeepSeek 额度已耗尽',
        recoveryAction: 'SWITCH_PROVIDER',
        timestamp: new Date().toISOString(),
      },
    });

    // Screen frame → inspector.
    ws!.emit({
      type: 'screen_frame',
      sessionId: 'sess-1',
      source: 'builtin-browser',
      imageBase64: 'aGk=',
      width: 800,
      height: 600,
      timestamp: new Date().toISOString(),
    });

    const state = useWorkbenchStore.getState();
    const toolItems = state.timeline.filter((item) => item.kind === 'tool');
    expect(toolItems).toHaveLength(1);
    expect(toolItems[0]).toMatchObject({ callId: 'c1', status: 'ok', output: 'ok' });
    expect(state.approvals).toHaveLength(1);
    expect(state.approvals[0]).toMatchObject({ approvalId: 'apr_1', callId: 'c1' });
    expect(state.errors[0]?.code).toBe('CC-QUOTA-2002');
    expect(state.screenFrames).toHaveLength(1);
    expect(state.screenFrames[0]?.mime).toBe('image/png');

    // file_change appends a stat-bar item.
    ws!.emit({ type: 'file_change', sessionId: 'sess-1', filePath: 'src/a.ts', additions: 5, deletions: 1, diffPatch: '' });
    expect(useWorkbenchStore.getState().timeline.at(-1)).toMatchObject({ kind: 'file', additions: 5, deletions: 1 });
  });

  it('updates the active project on provider_switched and ignores unknown frames', () => {
    useWorkbenchStore.getState().setProjects([
      {
        id: 'p1',
        name: 'demo',
        path: 'F:\\demo',
        discoveredFrom: ['crosscode-native'],
        activeHarness: 'crosscode-native',
        activeProviderId: 'deepseek',
        activeModelId: 'deepseek-chat',
        hasAgentDir: true,
        lastActiveAt: new Date().toISOString(),
      },
    ]);
    useWorkbenchStore.getState().setActiveProject('p1');

    dispatchGatewayFrame({ type: 'provider_switched', providerId: 'openai' });
    expect(useWorkbenchStore.getState().projects[0]?.activeProviderId).toBe('openai');

    expect(() => dispatchGatewayFrame({ type: 'totally_unknown_frame' })).not.toThrow();
    expect(() => dispatchGatewayFrame(null)).not.toThrow();
    expect(() => dispatchGatewayFrame('not-an-object')).not.toThrow();
  });
});

describe('ws-client upstream actions', () => {
  it('sends approve / reject / send_prompt / switch_provider frames', () => {
    const socket = new SessionSocket({ url: 'ws://daemon/ws/session', token: 'jwt', factory });
    socket.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.open();

    socket.respondApproval('apr_9', true);
    socket.respondApproval('apr_9', false);
    socket.sendPrompt('运行测试');
    socket.switchProvider('openai');

    const frames = ws.sent.slice(1).map((raw) => JSON.parse(raw) as Record<string, unknown>);
    expect(frames[0]).toEqual({ type: 'approve', approvalId: 'apr_9' });
    expect(frames[1]).toEqual({ type: 'reject', approvalId: 'apr_9' });
    expect(frames[2]).toEqual({ type: 'send_prompt', prompt: '运行测试' });
    expect(frames[3]).toEqual({ type: 'switch_provider', providerId: 'openai' });

    socket.close();
  });
});

describe('ws-client resilience', () => {
  it('reconnects with backoff and resets attempts after auth_ok', () => {
    vi.useFakeTimers();
    const socket = new SessionSocket({ url: 'ws://daemon/ws/session', token: 'jwt', factory });
    socket.connect();

    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.onclose?.({ code: 1006 });

    expect(useWorkbenchStore.getState().wsStatus).toBe('reconnecting');
    expect(useWorkbenchStore.getState().reconnectAttempt).toBe(1);

    vi.advanceTimersByTime(1600);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const second = FakeWebSocket.instances[1]!;
    second.open();
    second.emit({ type: 'auth_ok' });
    expect(useWorkbenchStore.getState().wsStatus).toBe('live');

    socket.close();
  });

  it('falls back to demo mode after exhausting reconnect attempts', () => {
    vi.useFakeTimers();
    const fallback = vi.fn();
    const socket = new SessionSocket({ url: 'ws://daemon/ws/session', token: 'jwt', factory, maxAttempts: 1, onDemoFallback: fallback });
    socket.connect();

    FakeWebSocket.instances[0]!.onclose?.({ code: 1006 });
    vi.advanceTimersByTime(2000);
    FakeWebSocket.instances[1]!.onclose?.({ code: 1006 });

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(useWorkbenchStore.getState().wsStatus).toBe('failed');
    expect(useWorkbenchStore.getState().transport).toBeNull();
    socket.close();
  });

  it('routes close code 4001 to the pairing gate instead of reconnecting', () => {
    vi.useFakeTimers();
    const socket = new SessionSocket({ url: 'ws://daemon/ws/session', token: 'bad', factory });
    socket.connect();

    FakeWebSocket.instances[0]!.onclose?.({ code: 4001 });

    expect(useWorkbenchStore.getState().mode).toBe('offline');
    expect(useWorkbenchStore.getState().jwt).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    socket.close();
  });
});
