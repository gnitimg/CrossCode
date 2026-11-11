import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { NormalizedAgentError } from '@crosscode/shared';
import {
  BuiltinBrowser,
  BuiltinBrowserError,
  CdpBrowserConnector,
  ComputerUseWin32,
  ExternalBrowserBridge,
  ExternalBrowserBridgeError,
  SkillVirtualizer,
  buildApprovalRequiredError,
  createUnifiedMcpServer,
  createWsCdpSocketFactory,
  defaultMcpServerEntry,
  registerIntoAppConfigs,
  BUILTIN_BROWSER_TOOL_NAMES,
  COMPUTER_USE_TOOL_NAMES,
  EXTERNAL_BROWSER_TOOL_NAMES,
  SKILLS_TOOL_NAMES,
  type AccessibilityNodeSnapshot,
  type BrowserDriverFactory,
  type BrowserPageDriver,
  type CdpHttpClient,
  type CdpSocket,
  type CdpSocketFactory,
  type ConsoleLogEntry,
  type PowerShellExecutor,
  type PowerShellResult,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Shared temp fixture lifecycle (every test stays inside its own temp dir)
// ---------------------------------------------------------------------------

let tempRoot: string;
let ssotRoot: string;
let registryOutputPath: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crosscode-mcp-hub-task5-'));
  ssotRoot = path.join(tempRoot, 'ssot', 'skills');
  registryOutputPath = path.join(tempRoot, '.agent', 'runtime', 'skills-registry.json');
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nSkill body.\n`,
    'utf8',
  );
}

function makeSkillsVirtualizer(): SkillVirtualizer {
  return new SkillVirtualizer({ ssotRoot, apps: [], registryOutputPath });
}

async function waitFor<T>(
  probe: () => T | undefined | null | false,
  timeoutMs = 3000,
  stepMs = 10,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('waitFor: condition not met within timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

// ---------------------------------------------------------------------------
// Fakes: builtin browser drivers
// ---------------------------------------------------------------------------

function makePageTree(): AccessibilityNodeSnapshot {
  return {
    role: 'page',
    name: 'Test Page',
    selector: 'role=page',
    children: [
      { role: 'heading', name: 'Welcome', selector: 'role=heading|name=Welcome' },
      { role: 'textbox', name: 'Email', selector: 'role=textbox|name=Email' },
      { role: 'button', name: 'Sign in', selector: 'role=button|name=Sign in' },
    ],
  };
}

class FakePageDriver implements BrowserPageDriver {
  readonly clickCalls: string[] = [];
  readonly fillCalls: Array<{ selector: string; text: string }> = [];
  readonly navCalls: string[] = [];
  closed = false;
  consoleEntries: ConsoleLogEntry[] = [];
  currentUrl = 'about:blank';

  constructor(private readonly tree: AccessibilityNodeSnapshot) {}

  async navigate(url: string): Promise<string> {
    this.navCalls.push(url);
    this.currentUrl = url;
    return url;
  }

  getUrl(): string {
    return this.currentUrl;
  }

  async getTitle(): Promise<string> {
    return `Test Page ${this.currentUrl}`;
  }

  async getAccessibilityTree(): Promise<AccessibilityNodeSnapshot> {
    return this.tree;
  }

  async click(selector: string): Promise<void> {
    this.clickCalls.push(selector);
  }

  async fill(selector: string, text: string): Promise<void> {
    this.fillCalls.push({ selector, text });
  }

  async screenshotPng(): Promise<Uint8Array> {
    return Uint8Array.from([1, 2, 3, 4]);
  }

  listConsoleEntries(): ConsoleLogEntry[] {
    return this.consoleEntries;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeBrowserFactory implements BrowserDriverFactory {
  readonly launched: FakePageDriver[] = [];

  constructor(private readonly tree: AccessibilityNodeSnapshot) {}

  async launchPage(): Promise<BrowserPageDriver> {
    const driver = new FakePageDriver(this.tree);
    this.launched.push(driver);
    return driver;
  }
}

// ---------------------------------------------------------------------------
// Fakes: PowerShell executor
// ---------------------------------------------------------------------------

interface QueuedResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

class FakePowerShellExecutor implements PowerShellExecutor {
  readonly scripts: string[] = [];
  private readonly pending: QueuedResponse[] = [];

  queue(response: Partial<QueuedResponse>): void {
    this.pending.push({ exitCode: 0, stdout: '', stderr: '', ...response });
  }

  queueMarked(marker: string, payload: Record<string, unknown>): void {
    this.queue({ stdout: `${marker}${JSON.stringify(payload)}\n` });
  }

  queueLines(lines: string[]): void {
    this.queue({ stdout: `${lines.join('\n')}\n` });
  }

  failNext(stderr = 'boom'): void {
    this.queue({ exitCode: 1, stderr });
  }

  async exec(script: string): Promise<PowerShellResult> {
    this.scripts.push(script);
    const next = this.pending.shift();
    return next ?? { exitCode: 0, stdout: '', stderr: '' };
  }
}

// ---------------------------------------------------------------------------
// 1. Unified MCP server — tool catalog + protocol roundtrip
// ---------------------------------------------------------------------------

describe('Task 5: unified MCP server', () => {
  interface Fixture {
    factory: FakeBrowserFactory;
    executor: FakePowerShellExecutor;
    computerUse: ComputerUseWin32;
    bridge: ExternalBrowserBridge;
    server: ReturnType<typeof createUnifiedMcpServer>;
  }

  function buildFixture(): Fixture {
    const factory = new FakeBrowserFactory(makePageTree());
    const builtinBrowser = new BuiltinBrowser({ driverFactory: factory, maxInstances: 2 });
    const executor = new FakePowerShellExecutor();
    const computerUse = new ComputerUseWin32({ executor });
    const bridge = new ExternalBrowserBridge();
    const server = createUnifiedMcpServer({
      builtinBrowser,
      externalBridge: bridge,
      computerUse,
      skills: makeSkillsVirtualizer(),
    });
    return { factory, executor, computerUse, bridge, server };
  }

  it('registers the full tool catalog: 6 builtin browser + 3 external browser + 5 computer use + 2 skills', () => {
    const { server } = buildFixture();
    const names = server.listTools().map((tool) => tool.name);
    expect(names).toHaveLength(16);
    expect(names).toEqual([
      ...BUILTIN_BROWSER_TOOL_NAMES,
      ...EXTERNAL_BROWSER_TOOL_NAMES,
      ...COMPUTER_USE_TOOL_NAMES,
      ...SKILLS_TOOL_NAMES,
    ]);
    expect(names.slice(0, 6)).toEqual([
      'browser_builtin_open',
      'browser_builtin_snapshot',
      'browser_builtin_click',
      'browser_builtin_fill',
      'browser_builtin_screenshot',
      'browser_builtin_console',
    ]);
    expect(names.slice(6, 9)).toEqual([
      'browser_external_list_tabs',
      'browser_external_activate_tab',
      'browser_external_exec_action',
    ]);
    expect(names.slice(9, 14)).toEqual([
      'computer_screenshot',
      'computer_mouse_action',
      'computer_keyboard_action',
      'computer_window_list',
      'computer_window_focus',
    ]);
    expect(names.slice(14)).toEqual(['skills_list', 'skills_prompt_injection_block']);
    // Every tool declares a JSON-schema input contract
    for (const tool of server.listTools()) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.description.length).toBeGreaterThan(10);
    }
    expect(server.getTool('skills_list')).toBeDefined();
    expect(server.getTool('nope')).toBeUndefined();
  });

  it('serves listTools and callTool over the real MCP protocol (in-memory transport)', async () => {
    await writeSkill(path.join(ssotRoot, 'deploy-aws'), 'deploy-aws', 'Deploy services to AWS ECS.');
    const { server, factory } = buildFixture();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'vitest-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toHaveLength(16);

    // builtin snapshot through the protocol
    const openResult = await client.callTool({
      name: 'browser_builtin_open',
      arguments: { url: 'https://example.test/home' },
    });
    expect(openResult.isError).toBeUndefined();
    expect(JSON.stringify(openResult.structuredContent)).toContain('https://example.test/home');

    const snapshot = await client.callTool({ name: 'browser_builtin_snapshot', arguments: {} });
    const snapshotText = (snapshot.content as Array<{ type: string; text?: string }>)[0].text ?? '';
    expect(snapshotText).toContain('@e1');
    expect(snapshotText).toContain('@e4 [button] "Sign in"');

    const click = await client.callTool({
      name: 'browser_builtin_click',
      arguments: { ref: '@e4' },
    });
    expect(click.isError).toBeUndefined();
    expect(factory.launched[factory.launched.length - 1].clickCalls).toContain('role=button|name=Sign in');

    const fill = await client.callTool({
      name: 'browser_builtin_fill',
      arguments: { ref: '@e3', text: 'user@example.test' },
    });
    expect(fill.isError).toBeUndefined();

    const screenshot = await client.callTool({ name: 'browser_builtin_screenshot', arguments: {} });
    const blocks = screenshot.content as Array<{ type: string; data?: string; mimeType?: string }>;
    expect(blocks.some((block) => block.type === 'image' && block.data === 'AQIDBA==' && block.mimeType === 'image/png')).toBe(true);

    const skills = await client.callTool({ name: 'skills_list', arguments: {} });
    const skillsText = (skills.content as Array<{ type: string; text?: string }>)[0].text ?? '';
    expect(skillsText).toContain('deploy-aws');
    expect(skillsText).toContain('Deploy services to AWS ECS.');

    const block = await client.callTool({ name: 'skills_prompt_injection_block', arguments: {} });
    const blockText = (block.content as Array<{ type: string; text?: string }>)[0].text ?? '';
    expect(blockText).toContain('crosscode:skills-injection BEGIN');
    expect(blockText).toContain('crosscode:skills-injection END');

    // Safety gate surfaces CC-TOOL-4002 through the protocol too
    const approval = await client.callTool({
      name: 'computer_mouse_action',
      arguments: { action: 'left_click' },
    });
    const approvalPayload = (approval.structuredContent ?? {}) as Record<string, unknown>;
    expect(approvalPayload.status).toBe('approval_required');
    expect(approvalPayload.code).toBe('CC-TOOL-4002');
    expect(approvalPayload.recoveryAction).toBe('AWAIT_APPROVAL');
    expect(typeof approvalPayload.approvalId).toBe('string');

    await Promise.all([client.close(), server.underlyingServer.close()]);
  });

  it('maps handler failures to isError results and unknown tools to MethodNotFound', async () => {
    const { server } = buildFixture();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'vitest-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // No page open yet -> builtin snapshot fails -> isError content, not a protocol error
    const failed = await client.callTool({ name: 'browser_builtin_snapshot', arguments: {} });
    expect(failed.isError).toBe(true);
    const text = (failed.content as Array<{ type: string; text?: string }>)[0].text ?? '';
    expect(text).toContain('browser_builtin_open');
    // Builtin-browser errors carry the CC-TOOL-4001 normalized error envelope
    const errorEnvelope = (failed.structuredContent ?? {}) as {
      error?: NormalizedAgentError;
    };
    expect(errorEnvelope.error?.code).toBe('CC-TOOL-4001');
    expect(errorEnvelope.error?.category).toBe('TOOL');
    expect(errorEnvelope.error?.recoveryAction).toBe('RESTART_PROCESS');

    await expect(
      client.callTool({ name: 'does_not_exist', arguments: {} }),
    ).rejects.toThrow(/Unknown tool/);

    await Promise.all([client.close(), server.underlyingServer.close()]);
  });

  it('supports a fully injected toolset override plus extraTools', async () => {
    const { server: defaultServer } = buildFixture();
    const custom: Parameters<typeof createUnifiedMcpServer>[0] = {
      tools: [
        {
          name: 'echo',
          description: 'Echoes its text argument back.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          handler: async (args) => ({
            content: [{ type: 'text', text: `echo: ${String(args.text)}` }],
          }),
        },
      ],
      extraTools: [
        {
          name: 'ping',
          description: 'Always answers pong.',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
        },
      ],
    };
    const customServer = createUnifiedMcpServer(custom);
    expect(customServer.listTools().map((tool) => tool.name)).toEqual(['echo', 'ping']);
    // the default fixture server still exposes the standard catalog
    expect(defaultServer.listTools()).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// 2. Builtin browser — refs, dispatch, pool
// ---------------------------------------------------------------------------

describe('Task 5: builtin browser (fake drivers, no Chromium)', () => {
  it('assigns @eN refs depth-first in snapshot() and renders the role/name tree', async () => {
    const factory = new FakeBrowserFactory(makePageTree());
    const browser = new BuiltinBrowser({ driverFactory: factory });
    const open = await browser.open('https://example.test/home');
    expect(open.url).toBe('https://example.test/home');
    expect(open.title).toBe('Test Page https://example.test/home');
    expect(open.poolSize).toBe(1);
    expect(factory.launched).toHaveLength(1); // lazy launch happened exactly here

    const snapshot = await browser.snapshot();
    const lines = snapshot.text.split('\n');
    expect(lines[0]).toBe('page "Test Page https://example.test/home" (https://example.test/home)');
    expect(lines[1]).toBe('  - @e1 [page] "Test Page"');
    expect(lines[2]).toBe('    - @e2 [heading] "Welcome"');
    expect(lines[3]).toBe('    - @e3 [textbox] "Email"');
    expect(lines[4]).toBe('    - @e4 [button] "Sign in"');
    expect(snapshot.refCount).toBe(4);
  });

  it('routes click/fill by ref to the matching node selector', async () => {
    const factory = new FakeBrowserFactory(makePageTree());
    const browser = new BuiltinBrowser({ driverFactory: factory });
    await browser.open('https://example.test/form');
    await browser.snapshot();

    const clicked = await browser.click('@e4');
    expect(clicked).toEqual({ clickedRef: '@e4', role: 'button', name: 'Sign in' });
    expect(factory.launched[0].clickCalls).toEqual(['role=button|name=Sign in']);

    const filled = await browser.fill('@e3', 'user@example.test');
    expect(filled).toEqual({ filledRef: '@e3', role: 'textbox', text: 'user@example.test' });
    expect(factory.launched[0].fillCalls).toEqual([
      { selector: 'role=textbox|name=Email', text: 'user@example.test' },
    ]);
  });

  it('rejects malformed and stale refs with clear errors', async () => {
    const factory = new FakeBrowserFactory(makePageTree());
    const browser = new BuiltinBrowser({ driverFactory: factory });
    await browser.open('https://example.test/x');
    await browser.snapshot();

    await expect(browser.click('@e99')).rejects.toThrow(BuiltinBrowserError);
    await expect(browser.click('e1')).rejects.toThrow(/Invalid element ref/);
    await expect(browser.fill('@e99', 'x')).rejects.toThrow(/Unknown element ref/);
  });

  it('returns base64 PNG screenshots and the console/pageerror buffer', async () => {
    const factory = new FakeBrowserFactory(makePageTree());
    const browser = new BuiltinBrowser({ driverFactory: factory });
    await browser.open('https://example.test/log');
    const activeDriver = factory.launched[0];
    activeDriver.consoleEntries = [
      { level: 'warn', text: 'deprecated API', timestamp: '2026-01-01T00:00:00.000Z' },
      { level: 'pageerror', text: 'Uncaught TypeError: x is not a function', timestamp: '2026-01-01T00:00:01.000Z' },
    ];

    const shot = await browser.screenshot();
    expect(shot).toEqual({ base64: 'AQIDBA==', mimeType: 'image/png' });

    const entries = browser.console();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ level: 'warn', text: 'deprecated API' });
    expect(entries[1].level).toBe('pageerror');
  });

  it('enforces the pool cap by closing the oldest page and keeps the newest active', async () => {
    const factory = new FakeBrowserFactory(makePageTree());
    const browser = new BuiltinBrowser({ driverFactory: factory, maxInstances: 2 });
    await browser.open('https://example.test/a');
    await browser.open('https://example.test/b');
    const third = await browser.open('https://example.test/c');

    expect(browser.poolSize).toBe(2);
    expect(third.poolSize).toBe(2);
    expect(factory.launched[0].closed).toBe(true);
    expect(factory.launched[1].closed).toBe(false);
    expect(factory.launched[2].closed).toBe(false);

    const snapshot = await browser.snapshot();
    expect(snapshot.url).toBe('https://example.test/c');
  });

  it('fails with a clear error when tools run before any open()', async () => {
    const factory = new FakeBrowserFactory(makePageTree());
    const browser = new BuiltinBrowser({ driverFactory: factory });
    await expect(browser.snapshot()).rejects.toThrow(/browser_builtin_open/);
    expect(factory.launched).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. External browser bridge — real local ws service + fake extension/CDP
// ---------------------------------------------------------------------------

describe('Task 5: external browser bridge (real local ws, fake extension + CDP)', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) {
        await close().catch(() => undefined);
      }
    }
  });

  function trackWebSocket(socket: WebSocket): void {
    closers.push(async () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    });
  }

  async function listenOnEphemeralPort(server: http.Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    closers.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return port;
  }

  function fakeCdpHttp(): { client: CdpHttpClient; calls: string[] } {
    const calls: string[] = [];
    const client: CdpHttpClient = {
      async get(url: string) {
        calls.push(url);
        if (url.endsWith('/json/list')) {
          return {
            status: 200,
            body: JSON.stringify([
              {
                id: 'T1',
                title: 'Doc',
                url: 'https://example.test/doc',
                type: 'page',
                webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/T1',
              },
            ]),
          };
        }
        if (url.includes('/json/activate/')) {
          return { status: 200, body: '{"result":"Target activated"}' };
        }
        return { status: 404, body: '' };
      },
    };
    return { client, calls };
  }

  it('completes the extension loop: register tabs, activate, exec action with result roundtrip', async () => {
    const bridge = new ExternalBrowserBridge();
    closers.push(() => bridge.close());
    const httpServer = http.createServer();
    bridge.attachToServer(httpServer);
    expect(bridge.wsPath).toBe('/ws/chrome-extension');
    const port = await listenOnEphemeralPort(httpServer);

    const extension = new WebSocket(`ws://127.0.0.1:${port}/ws/chrome-extension`);
    trackWebSocket(extension);
    await new Promise<void>((resolve, reject) => {
      extension.once('open', () => resolve());
      extension.once('error', reject);
    });

    const receivedActions: Array<Record<string, unknown>> = [];
    extension.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.type === 'action') {
        receivedActions.push(message);
        extension.send(
          JSON.stringify({
            type: 'result',
            requestId: message.requestId,
            ok: true,
            payload: { echoed: message.action },
          }),
        );
      }
    });

    expect(bridge.isExtensionConnected).toBe(true);
    extension.send(
      JSON.stringify({
        type: 'register',
        tabs: [
          { id: '1', title: 'Docs', url: 'https://x.test/docs', active: true },
          { id: '2', title: 'Mail', url: 'https://x.test/mail' },
        ],
      }),
    );
    await waitFor(() => bridge.extensionBridge.getTabs().length === 2);

    const tabs = await bridge.listTabs();
    expect(tabs.transport).toBe('extension');
    expect(tabs.tabs).toEqual([
      { id: '1', title: 'Docs', url: 'https://x.test/docs', active: true },
      { id: '2', title: 'Mail', url: 'https://x.test/mail', active: undefined },
    ]);

    const activated = await bridge.activateTab('2');
    expect(activated.transport).toBe('extension');
    expect(activated.tabId).toBe('2');
    await waitFor(() => receivedActions.some((action) => action.tabId === '2'));
    expect(receivedActions.find((action) => action.tabId === '2')?.action).toEqual({ kind: 'activate' });

    const executed = await bridge.execAction('1', { kind: 'click', payload: { ref: '@e3' } });
    expect(executed.transport).toBe('extension');
    expect(executed.result).toEqual({ echoed: { kind: 'click', payload: { ref: '@e3' } } });
    await waitFor(() => receivedActions.some((action) => action.tabId === '1'));
    const lastAction = receivedActions[receivedActions.length - 1];
    expect(lastAction.tabId).toBe('1');
    expect(lastAction.action).toEqual({ kind: 'click', payload: { ref: '@e3' } });
    expect(typeof lastAction.requestId).toBe('string');
  });

  it('propagates extension failures and timeouts as bridge errors', async () => {
    const bridge = new ExternalBrowserBridge({ extension: { actionTimeoutMs: 250 } });
    closers.push(() => bridge.close());
    const httpServer = http.createServer();
    bridge.attachToServer(httpServer);
    const port = await listenOnEphemeralPort(httpServer);

    // First extension answers with ok:false
    const failing = new WebSocket(`ws://127.0.0.1:${port}/ws/chrome-extension`);
    trackWebSocket(failing);
    await new Promise<void>((resolve, reject) => {
      failing.once('open', () => resolve());
      failing.once('error', reject);
    });
    failing.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.type === 'action') {
        failing.send(
          JSON.stringify({ type: 'result', requestId: message.requestId, ok: false, error: 'tab closed' }),
        );
      }
    });
    failing.send(JSON.stringify({ type: 'register', tabs: [{ id: '9' }] }));
    await waitFor(() => bridge.extensionBridge.getTabs().length === 1);
    await expect(bridge.execAction('9', { kind: 'click' })).rejects.toThrow(/tab closed/);

    // Latest connection wins: the new socket takes over but never answers -> timeout
    const silent = new WebSocket(`ws://127.0.0.1:${port}/ws/chrome-extension`);
    trackWebSocket(silent);
    await new Promise<void>((resolve, reject) => {
      silent.once('open', () => resolve());
      silent.once('error', reject);
    });
    await waitFor(() => bridge.extensionBridge.getTabs().length === 0);
    await expect(bridge.activateTab('9')).rejects.toThrow(/timed out/i);
  });

  it('destroys upgrade attempts on foreign paths', async () => {
    const bridge = new ExternalBrowserBridge();
    closers.push(() => bridge.close());
    const httpServer = http.createServer();
    bridge.attachToServer(httpServer);
    const port = await listenOnEphemeralPort(httpServer);

    const outsider = new WebSocket(`ws://127.0.0.1:${port}/ws/other-path`);
    trackWebSocket(outsider);
    const outcome = await new Promise<string>((resolve) => {
      outsider.once('error', () => resolve('error'));
      outsider.once('close', () => resolve('close'));
    });
    expect(['error', 'close']).toContain(outcome);
    expect(bridge.isExtensionConnected).toBe(false);
  });

  it('CdpBrowserConnector: injectable HTTP lists/activates tabs and passthrough exec via injectable socket', async () => {
    const { client: httpClient, calls } = fakeCdpHttp();
    const sentCommands: string[] = [];
    const socketFactory: CdpSocketFactory = {
      async connect(url: string): Promise<CdpSocket> {
        expect(url).toBe('ws://127.0.0.1:9222/devtools/page/T1');
        return {
          send(payload: string): void {
            sentCommands.push(payload);
          },
          async nextMessage(): Promise<Record<string, unknown>> {
            return { id: 1, result: { value: 42 } };
          },
          async close(): Promise<void> {},
        };
      },
    };
    const cdp = new CdpBrowserConnector({
      cdpBaseUrl: 'http://127.0.0.1:9222',
      httpClient,
      socketFactory,
    });

    const tabs = await cdp.listTabs();
    expect(tabs).toEqual([{ id: 'T1', title: 'Doc', url: 'https://example.test/doc', active: true }]);
    expect(calls[0]).toBe('http://127.0.0.1:9222/json/list');

    await cdp.activateTab('T1');
    expect(calls[1]).toBe('http://127.0.0.1:9222/json/activate/T1');

    const result = await cdp.execAction('T1', {
      kind: 'Runtime.evaluate',
      payload: { expression: '6*7' },
    });
    expect(result).toEqual({ value: 42 });
    expect(JSON.parse(sentCommands[0])).toEqual({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: '6*7' },
    });
    // execAction locates the tab and the debugger URL from ONE /json/list call:
    // listTabs(1) + execAction(1) — no duplicate request.
    expect(calls.filter((url) => url.endsWith('/json/list'))).toHaveLength(2);
  });

  it('CdpBrowserConnector wraps malformed /json/list payloads with a bridge error', async () => {
    const httpClient: CdpHttpClient = {
      async get() {
        return { status: 200, body: 'not-json at all' };
      },
    };
    const cdp = new CdpBrowserConnector({ httpClient });
    await expect(cdp.listTabs()).rejects.toThrow(ExternalBrowserBridgeError);
    await expect(cdp.listTabs()).rejects.toThrow(/invalid JSON/);
  });

  it('default CDP socket factory survives socket errors after open (no uncaught exception)', async () => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const port = (wss.address() as AddressInfo).port;
    closers.push(async () => {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });

    const serverSocketPromise = new Promise<WebSocket>((resolve) => {
      wss.once('connection', (serverSocket) => resolve(serverSocket));
    });
    const factory = createWsCdpSocketFactory();
    const socket = await factory.connect(`ws://127.0.0.1:${port}`);
    const serverSocket = await serverSocketPromise;

    // A pending nextMessage waiter plus a post-open socket error must not crash
    // the process (vitest fails the run on uncaught exceptions).
    const pending = socket.nextMessage();
    // Trigger a deterministic protocol violation on the wire: a frame with RSV
    // bits set (no extension was negotiated) -> client emits 'error'.
    const rawSocket = (
      serverSocket as unknown as { _socket: { write: (chunk: Buffer) => void } }
    )._socket;
    rawSocket.write(Buffer.from([0xc0, 0x00]));

    await expect(pending).rejects.toThrow();
    // The socket object is still usable after the error (nextMessage fails fast)
    await expect(socket.nextMessage()).rejects.toThrow();
    await socket.close();
  });

  it('falls back to CDP when no extension is connected, and errors when nothing is available', async () => {
    const { client: httpClient } = fakeCdpHttp();
    const bridge = new ExternalBrowserBridge({ cdp: { httpClient } });
    closers.push(() => bridge.close());

    const listed = await bridge.listTabs();
    expect(listed.transport).toBe('cdp');
    expect(listed.tabs[0].id).toBe('T1');

    const activated = await bridge.activateTab('T1');
    expect(activated.transport).toBe('cdp');
    expect(activated.action).toEqual({ kind: 'activate' });

    const bare = new ExternalBrowserBridge();
    closers.push(() => bare.close());
    await expect(bare.listTabs()).rejects.toThrow(ExternalBrowserBridgeError);
    await expect(bare.listTabs()).rejects.toThrow(/No external browser available/);
  });

  it('CdpBrowserConnector surfaces HTTP failures as bridge errors', async () => {
    const httpClient: CdpHttpClient = {
      async get() {
        return { status: 500, body: 'no debugger' };
      },
    };
    const cdp = new CdpBrowserConnector({ httpClient });
    await expect(cdp.listTabs()).rejects.toThrow(/HTTP 500/);
  });
});

// ---------------------------------------------------------------------------
// 4. Computer use (win32) — fake executor + safety gate
// ---------------------------------------------------------------------------

describe('Task 5: computer use win32 (fake PowerShell executor, safety gate)', () => {
  it('computer_screenshot: emits a CopyFromScreen script and parses the marked JSON reply', async () => {
    const executor = new FakePowerShellExecutor();
    executor.queueMarked('__CC_SCREEN_JSON__', {
      width: 1920,
      height: 1080,
      scaledWidth: 1280,
      scaledHeight: 720,
      base64: 'AAAB',
    });
    const cu = new ComputerUseWin32({ executor, maxScreenshotEdge: 1280 });
    const shot = await cu.screenshot();

    expect(shot).toEqual({
      mimeType: 'image/png',
      imageBase64: 'AAAB',
      width: 1920,
      height: 1080,
      scaledWidth: 1280,
      scaledHeight: 720,
    });
    const script = executor.scripts[0];
    expect(script).toContain('Add-Type -AssemblyName System.Drawing');
    expect(script).toContain('CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)');
    expect(script).toContain('[System.Drawing.Imaging.ImageFormat]::Png');
    expect(script).toContain('$maxEdge = 1280');
    expect(script).toContain('__CC_SCREEN_JSON__');
  });

  it('computer_screenshot: executor failures propagate with stderr', async () => {
    const executor = new FakePowerShellExecutor();
    executor.failNext('Add-Type exploded');
    const cu = new ComputerUseWin32({ executor });
    await expect(cu.screenshot()).rejects.toThrow(/Add-Type exploded/);
  });

  it('computer_mouse_action: builds SetCursorPos/mouse_event scripts for explicit coordinates', async () => {
    const executor = new FakePowerShellExecutor();
    executor.queueMarked('__CC_MOUSE_OK__', { performed: 'left_click' });
    const cu = new ComputerUseWin32({ executor });

    const result = await cu.mouseAction({ action: 'left_click', x: 100, y: 200 });
    expect(result).toEqual({ performed: 'left_click', x: 100, y: 200 });

    const script = executor.scripts[0];
    expect(script).toContain('SetCursorPos(100, 200)');
    expect(script).toContain('mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)'); // LEFTDOWN
    expect(script).toContain('mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)'); // LEFTUP
    expect(script).toContain('Add-Type -TypeDefinition @"');
    expect(script).toContain('user32.dll');
  });

  it('computer_mouse_action: right click, double click, drag and move hit the right flags', async () => {
    const executor = new FakePowerShellExecutor();
    executor.queueMarked('__CC_MOUSE_OK__', { performed: 'right_click' });
    executor.queueMarked('__CC_MOUSE_OK__', { performed: 'double_click' });
    executor.queueMarked('__CC_MOUSE_OK__', { performed: 'drag' });
    executor.queueMarked('__CC_MOUSE_OK__', { performed: 'move' });
    const cu = new ComputerUseWin32({ executor });

    await cu.mouseAction({ action: 'right_click', x: 1, y: 2 });
    let script = executor.scripts[0];
    expect(script).toContain('mouse_event(0x8, 0, 0, 0, [UIntPtr]::Zero)');
    expect(script).toContain('mouse_event(0x10, 0, 0, 0, [UIntPtr]::Zero)');

    await cu.mouseAction({ action: 'double_click', x: 3, y: 4 });
    script = executor.scripts[1];
    expect(script.match(/mouse_event\(0x2, 0, 0, 0, \[UIntPtr\]::Zero\)/g)).toHaveLength(2);

    await cu.mouseAction({ action: 'drag', x: 5, y: 6, x2: 50, y2: 60 });
    script = executor.scripts[2];
    expect(script).toContain('SetCursorPos(5, 6)');
    expect(script).toContain('SetCursorPos(50, 60)');
    expect(script.indexOf('mouse_event(0x2')).toBeLessThan(script.indexOf('SetCursorPos(50, 60)'));
    expect(script.indexOf('mouse_event(0x4')).toBeGreaterThan(script.indexOf('SetCursorPos(50, 60)'));

    await cu.mouseAction({ action: 'move', x: 7, y: 8 });
    script = executor.scripts[3];
    expect(script).toContain('SetCursorPos(7, 8)');
    expect(script).not.toContain('::mouse_event(');

    await expect(cu.mouseAction({ action: 'move' })).rejects.toThrow(/move requires x and y/);

    // A drag without an end point is a full-screen gesture: held by the default policy
    const dragHeld = await cu.mouseAction({ action: 'drag', x: 1, y: 2 });
    expect('status' in dragHeld && dragHeld.status === 'approval_required').toBe(true);

    // With the full-screen gate disabled, the missing-endpoint validation throws instead
    const cuOpen = new ComputerUseWin32({
      executor,
      safetyPolicy: { blockFullScreenClicks: false },
    });
    await expect(cuOpen.mouseAction({ action: 'drag', x: 1, y: 2 })).rejects.toThrow(/drag requires/);
  });

  it('SafetyPolicy: full-screen click (no coordinates) is held for approval and never executed', async () => {
    const executor = new FakePowerShellExecutor();
    executor.queueMarked('__CC_MOUSE_OK__', { performed: 'left_click' });
    const cu = new ComputerUseWin32({ executor });

    const approval = await cu.mouseAction({ action: 'left_click' });
    expect('approvalId' in approval).toBe(true);
    const held = approval as Extract<typeof approval, { status: 'approval_required' }>;
    expect(held.status).toBe('approval_required');
    expect(held.code).toBe('CC-TOOL-4002');
    expect(held.category).toBe('TOOL');
    expect(held.recoveryAction).toBe('AWAIT_APPROVAL');
    expect(held.toolName).toBe('computer_mouse_action');
    expect(held.originalAction).toEqual({ action: 'left_click' });
    expect(held.reason).toMatch(/Full-screen mouse gesture/);
    expect(held.error.code).toBe('CC-TOOL-4002');
    expect(held.error.recoveryAction).toBe('AWAIT_APPROVAL');
    expect(held.error.userTitle).toBe('高危工具操作等待远程人工审批');
    // nothing executed while pending
    expect(executor.scripts).toHaveLength(0);
    expect(cu.listPendingApprovals()).toHaveLength(1);

    // approve -> original action runs
    const decision = await cu.approve(held.approvalId);
    expect(decision.approved).toBe(true);
    expect(decision.executed).toBe(true);
    expect(executor.scripts).toHaveLength(1);
    expect(executor.scripts[0]).toContain('mouse_event(0x2');
    expect(cu.listPendingApprovals()).toHaveLength(0);
  });

  it('SafetyPolicy: rejecting a pending action never runs it', async () => {
    const executor = new FakePowerShellExecutor();
    const cu = new ComputerUseWin32({ executor });
    const approval = await cu.mouseAction({ action: 'double_click' });
    const held = approval as Extract<typeof approval, { status: 'approval_required' }>;

    const decision = cu.reject(held.approvalId, 'not now');
    expect(decision).toMatchObject({ approvalId: held.approvalId, approved: false, executed: false });
    expect(executor.scripts).toHaveLength(0);
    expect(cu.listPendingApprovals()).toHaveLength(0);
    await expect(cu.approve(held.approvalId)).rejects.toThrow(/Unknown approval id/);
  });

  it('SafetyPolicy: disabled blockFullScreenClicks lets coordinate-free clicks through', async () => {
    const executor = new FakePowerShellExecutor();
    executor.queueMarked('__CC_MOUSE_OK__', { performed: 'left_click' });
    const cu = new ComputerUseWin32({
      executor,
      safetyPolicy: { blockFullScreenClicks: false },
    });
    const result = await cu.mouseAction({ action: 'left_click' });
    expect('status' in result).toBe(false);
    expect(executor.scripts).toHaveLength(1);
    expect(executor.scripts[0]).not.toContain('::SetCursorPos(');
  });

  it('computer_keyboard_action: type escapes SendKeys metacharacters and PS quotes', async () => {
    const executor = new FakePowerShellExecutor();
    executor.queueMarked('__CC_TYPE_OK__', { performed: 'type' });
    const cu = new ComputerUseWin32({ executor });

    const result = await cu.keyboardAction({ action: 'type', text: "a^b it's (ok) [v1]" });
    expect(result).toEqual({ performed: 'type', text: "a^b it's (ok) [v1]" });
    const script = executor.scripts[0];
    expect(script).toContain('Add-Type -AssemblyName System.Windows.Forms');
    expect(script).toContain(
      "[System.Windows.Forms.SendKeys]::SendWait('a{^}b it''s {(}ok{)} {[}v1{]}')",
    );
  });

  it('computer_keyboard_action: allowed hotkeys emit keybd_event sequences with resolved VK codes', async () => {
    const executor = new FakePowerShellExecutor();
    executor.queueMarked('__CC_HOTKEY_OK__', { performed: 'hotkey' });
    const cu = new ComputerUseWin32({ executor });

    const result = await cu.keyboardAction({ action: 'hotkey', keys: 'Ctrl+C' });
    expect(result).toEqual({ performed: 'hotkey', keys: 'Ctrl+C' });
    const script = executor.scripts[0];
    expect(script).toContain('keybd_event(0x11, 0, 0, [UIntPtr]::Zero)'); // VK_CONTROL down
    expect(script).toContain('keybd_event(0x43, 0, 0, [UIntPtr]::Zero)'); // C down
    expect(script).toContain('keybd_event(0x43, 0, 2, [UIntPtr]::Zero)'); // C up (KEYEVENTF_KEYUP)
    expect(script).toContain('keybd_event(0x11, 0, 2, [UIntPtr]::Zero)');
    expect(script).toContain('user32.dll');

    await expect(cu.keyboardAction({ action: 'hotkey', keys: 'Ctrl+NotAKey' })).rejects.toThrow(
      /Unknown key token/,
    );
  });

  it('SafetyPolicy: Alt+Tab and Win-key combos are held for approval (approvable)', async () => {
    const executor = new FakePowerShellExecutor();
    executor.queueMarked('__CC_HOTKEY_OK__', { performed: 'hotkey' });
    executor.queueMarked('__CC_HOTKEY_OK__', { performed: 'hotkey' });
    const cu = new ComputerUseWin32({ executor });

    const altTab = await cu.keyboardAction({ action: 'hotkey', keys: 'Alt+Tab' });
    const heldAltTab = altTab as Extract<typeof altTab, { status: 'approval_required' }>;
    expect(heldAltTab.status).toBe('approval_required');
    expect(heldAltTab.reason).toMatch(/Alt\+Tab|denied combo/i);
    expect(executor.scripts).toHaveLength(0);

    const winD = await cu.keyboardAction({ action: 'hotkey', keys: 'Win+D' });
    const heldWinD = winD as Extract<typeof winD, { status: 'approval_required' }>;
    expect(heldWinD.status).toBe('approval_required');
    expect(heldWinD.reason).toMatch(/Win\/Meta key/);

    // approving the Alt+Tab action then really runs the keybd_event script
    const decision = await cu.approve(heldAltTab.approvalId);
    expect(decision.executed).toBe(true);
    expect(executor.scripts[0]).toContain('keybd_event(0x12, 0, 0, [UIntPtr]::Zero)'); // VK_MENU (Alt)
    expect(executor.scripts[0]).toContain('keybd_event(0x9, 0, 0, [UIntPtr]::Zero)'); // VK_TAB
    await cu.reject(heldWinD.approvalId);
    expect(executor.scripts).toHaveLength(1);
  });

  it('SafetyPolicy: denied combos are configurable and Ctrl+C stays allowed by default', async () => {
    const executor = new FakePowerShellExecutor();
    executor.queueMarked('__CC_HOTKEY_OK__', { performed: 'hotkey' });
    executor.queueMarked('__CC_HOTKEY_OK__', { performed: 'hotkey' });
    const cu = new ComputerUseWin32({
      executor,
      safetyPolicy: { deniedCombos: ['ctrl+c'], denyWinKey: false },
    });

    // Ctrl+C now denied by configuration (order-insensitive match)
    const denied = await cu.keyboardAction({ action: 'hotkey', keys: 'CTRL+c' });
    expect('status' in denied && denied.status === 'approval_required').toBe(true);

    // Win+D allowed because denyWinKey disabled and not on the list
    const result = await cu.keyboardAction({ action: 'hotkey', keys: 'Win+D' });
    expect('status' in result).toBe(false);
    expect(executor.scripts[0]).toContain('keybd_event(0x5b, 0, 0, [UIntPtr]::Zero)');
  });

  it('computer_window_list: parses EnumWindows marker lines', async () => {
    const executor = new FakePowerShellExecutor();
    executor.queueLines([
      'noise line without marker',
      '__CC_WINDOW__123__SEP__Visual Studio Code',
      '__CC_WINDOW__456__SEP__Terminal',
    ]);
    const cu = new ComputerUseWin32({ executor });

    const result = await cu.windowList();
    expect(result.windows).toEqual([
      { hwnd: 123, title: 'Visual Studio Code' },
      { hwnd: 456, title: 'Terminal' },
    ]);
    const script = executor.scripts[0];
    expect(script).toContain('EnumWindows');
    expect(script).toContain('GetWindowText');
    expect(script).toContain('IsWindowVisible');
    expect(script).toContain('__CC_WINDOW__');
  });

  it('computer_window_focus: sensitive titles are held for approval; others run SetForegroundWindow', async () => {
    const executor = new FakePowerShellExecutor();
    executor.queueMarked('__CC_FOCUS__', { focused: true, hwnd: 777, title: 'Bank Portal' });
    // hwnd-only requests now read the window title back before the policy runs
    executor.queue({
      stdout: `__CC_TITLE__${Buffer.from('Code Editor', 'utf8').toString('base64')}\n`,
    });
    executor.queueMarked('__CC_FOCUS__', { focused: true, hwnd: 42 });
    const cu = new ComputerUseWin32({
      executor,
      safetyPolicy: { sensitiveWindowTitles: ['bank', /passwor/i] },
    });

    const blocked = await cu.windowFocus({ title: 'My Bank Portal' });
    const held = blocked as Extract<typeof blocked, { status: 'approval_required' }>;
    expect(held.status).toBe('approval_required');
    expect(held.toolName).toBe('computer_window_focus');
    expect(held.reason).toMatch(/sensitive title/i);
    expect(executor.scripts).toHaveLength(0);

    // approve -> the focus script finally runs
    const decision = await cu.approve(held.approvalId);
    expect(decision.executed).toBe(true);
    expect(executor.scripts[0]).toContain('SetForegroundWindow($target)');
    expect(executor.scripts[0]).toContain("FindWindow($null, 'My Bank Portal')");
    expect(executor.scripts[0]).toContain('ShowWindow($target, 9)');

    // regex-based sensitive rule
    const blockedRegex = await cu.windowFocus({ title: 'Enter your password' });
    expect('status' in blockedRegex && blockedRegex.status === 'approval_required').toBe(true);

    // benign hwnd: title readback first (non-sensitive), then the focus script
    const ok = await cu.windowFocus({ hwnd: 42 });
    expect(ok).toEqual({ focused: true, hwnd: 42 });
    expect(executor.scripts[1]).toContain('GetTitle($target)');
    expect(executor.scripts[1]).toContain('__CC_TITLE__');
    expect(executor.scripts[2]).toContain('[IntPtr]::new(42)');
    expect(executor.scripts[2]).not.toContain('FindWindow($null');

    await expect(cu.windowFocus({})).rejects.toThrow(/hwnd or title/);
  });

  it('SafetyPolicy: focusing by hwnd reads the title back so sensitive rules cannot be bypassed', async () => {
    const executor = new FakePowerShellExecutor();
    // The readback travels base64-encoded (like the real flow) and carries a
    // sensitive Chinese title: decoded via UTF-8 on the Node side.
    executor.queue({
      stdout: `__CC_TITLE__${Buffer.from('记事本 - 银行门户', 'utf8').toString('base64')}\n`,
    });
    executor.queueMarked('__CC_FOCUS__', { focused: true, hwnd: 777 });
    const cu = new ComputerUseWin32({
      executor,
      safetyPolicy: { sensitiveWindowTitles: ['银行'] },
    });

    const blocked = await cu.windowFocus({ hwnd: 777 });
    const held = blocked as Extract<typeof blocked, { status: 'approval_required' }>;
    expect(held.status).toBe('approval_required');
    expect(held.code).toBe('CC-TOOL-4002');
    expect(held.recoveryAction).toBe('AWAIT_APPROVAL');
    expect(held.reason).toMatch(/sensitive title/i);
    expect(held.originalAction).toMatchObject({ hwnd: 777, resolvedTitle: '记事本 - 银行门户' });
    // only the passive title readback ran while the action is pending
    expect(executor.scripts).toHaveLength(1);
    expect(executor.scripts[0]).toContain('GetTitle($target)');
    expect(cu.listPendingApprovals()).toHaveLength(1);

    // approve -> the focus script finally runs
    const decision = await cu.approve(held.approvalId);
    expect(decision.executed).toBe(true);
    expect(executor.scripts[1]).toContain('SetForegroundWindow($target)');
    expect(executor.scripts[1]).toContain('[IntPtr]::new(777)');
    expect(cu.listPendingApprovals()).toHaveLength(0);
  });

  it('windowFocus by hwnd skips the title readback when no sensitive rules are configured', async () => {
    const executor = new FakePowerShellExecutor();
    executor.queueMarked('__CC_FOCUS__', { focused: true, hwnd: 5 });
    const cu = new ComputerUseWin32({ executor });

    const ok = await cu.windowFocus({ hwnd: 5 });
    expect(ok).toEqual({ focused: true, hwnd: 5 });
    expect(executor.scripts).toHaveLength(1);
    expect(executor.scripts[0]).not.toContain('[CCWindowEnum]::GetTitle');
  });

  it('every generated PowerShell script sets a UTF-8 console output encoding header', async () => {
    const executor = new FakePowerShellExecutor();
    executor.queueMarked('__CC_SCREEN_JSON__', {
      width: 100,
      height: 50,
      scaledWidth: 100,
      scaledHeight: 50,
      base64: 'AAAB',
    });
    executor.queueMarked('__CC_MOUSE_OK__', { performed: 'left_click' });
    executor.queueMarked('__CC_TYPE_OK__', { performed: 'type' });
    executor.queueMarked('__CC_HOTKEY_OK__', { performed: 'hotkey' });
    executor.queueLines(['__CC_WINDOW__1__SEP__记事本 - 无标题']);
    executor.queue({
      stdout: `__CC_TITLE__${Buffer.from('记事本', 'utf8').toString('base64')}\n`,
    });
    executor.queueMarked('__CC_FOCUS__', { focused: true, hwnd: 1 });
    const cu = new ComputerUseWin32({
      executor,
      safetyPolicy: { sensitiveWindowTitles: ['zzz-not-present'] },
    });

    await cu.screenshot();
    await cu.mouseAction({ action: 'left_click', x: 1, y: 2 });
    await cu.keyboardAction({ action: 'type', text: 'hi' });
    await cu.keyboardAction({ action: 'hotkey', keys: 'Ctrl+C' });
    const list = await cu.windowList();
    // Non-ASCII titles survive the marked-line channel untouched.
    expect(list.windows[0].title).toBe('记事本 - 无标题');
    await cu.windowFocus({ hwnd: 1 });

    // 7 scripts: screenshot, mouse, type, hotkey, list, title readback, focus
    expect(executor.scripts).toHaveLength(7);
    for (const script of executor.scripts) {
      expect(script).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8');
      expect(script).toContain("$ErrorActionPreference = 'Stop'");
    }
    // The hwnd readback script transports the title base64-encoded.
    expect(executor.scripts[5]).toContain('ToBase64String');
    expect(executor.scripts[5]).toContain('GetTitle($target)');
  });

  it('pending approvals expire after their TTL and enforce a capacity cap', async () => {
    const executor = new FakePowerShellExecutor();
    const cu = new ComputerUseWin32({
      executor,
      pendingApprovalTtlMs: 40,
      maxPendingApprovals: 2,
    });

    const first = await cu.mouseAction({ action: 'left_click' });
    const second = await cu.mouseAction({ action: 'left_click' });
    const third = await cu.mouseAction({ action: 'left_click' });
    const heldFirst = first as Extract<typeof first, { status: 'approval_required' }>;
    const heldSecond = second as Extract<typeof second, { status: 'approval_required' }>;
    const heldThird = third as Extract<typeof third, { status: 'approval_required' }>;

    // capacity 2: the oldest pending item (first) was evicted
    expect(cu.listPendingApprovals()).toHaveLength(2);
    await expect(cu.approve(heldFirst.approvalId)).rejects.toThrow(/Unknown approval id/);

    // TTL 40ms: everything still pending expires — approve and reject both see it gone
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cu.listPendingApprovals()).toHaveLength(0);
    await expect(cu.approve(heldSecond.approvalId)).rejects.toThrow(/Unknown approval id/);
    expect(() => cu.reject(heldThird.approvalId)).toThrow(/Unknown approval id/);
    expect(executor.scripts).toHaveLength(0); // nothing ever executed
  });

  it('buildApprovalRequiredError produces a CC-TOOL-4002 NormalizedAgentError payload', () => {
    const error: NormalizedAgentError = buildApprovalRequiredError('Tool approval required (x)');
    expect(error.code).toBe('CC-TOOL-4002');
    expect(error.category).toBe('TOOL');
    expect(error.recoveryAction).toBe('AWAIT_APPROVAL');
    expect(error.harness).toBe('crosscode-native');
    expect(error.timestamp).toBeTruthy();
  });

  it('default executor is created automatically when none is injected', () => {
    const cu = new ComputerUseWin32();
    expect(cu.listPendingApprovals()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. registerIntoAppConfigs — idempotent mcpServers merge
// ---------------------------------------------------------------------------

describe('Task 5: registerIntoAppConfigs (temp JSON files)', () => {
  const ENTRY = { command: 'node', args: ['C:/crosscode/mcp-hub/dist/index.js', '--mcp-stdio'] };

  it('creates the entry in a missing file, then reports unchanged on re-registration', async () => {
    const configPath = path.join(tempRoot, 'apps', 'claude', 'mcp-config.json');

    const first = await registerIntoAppConfigs([{ path: configPath }], { serverEntry: ENTRY });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ path: configPath, serverName: 'crosscode', status: 'created' });
    expect(first[0].previousEntry).toBeUndefined();

    const written = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(written.mcpServers).toEqual({ crosscode: ENTRY });

    const second = await registerIntoAppConfigs([{ path: configPath }], { serverEntry: ENTRY });
    expect(second[0].status).toBe('unchanged');
    expect(second[0].previousEntry).toEqual(ENTRY);
    const reread = await fs.readFile(configPath, 'utf8');
    expect(JSON.parse(reread)).toEqual(written);
  });

  it('preserves unrelated mcpServers entries and top-level keys when creating/updating', async () => {
    const configPath = path.join(tempRoot, 'zcode-config.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({ foo: 'bar', mcpServers: { otherServer: { command: 'uvx', args: ['x'] } } }),
      'utf8',
    );

    const results = await registerIntoAppConfigs([{ path: configPath }], { serverEntry: ENTRY });
    expect(results[0].status).toBe('created');

    const updated = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      foo?: string;
      mcpServers: Record<string, unknown>;
    };
    expect(updated.foo).toBe('bar');
    expect(updated.mcpServers.otherServer).toEqual({ command: 'uvx', args: ['x'] });
    expect(updated.mcpServers.crosscode).toEqual(ENTRY);

    // Update the entry in place: same serverName, different payload, others untouched
    const newEntry = { ...ENTRY, env: { CC_DEBUG: '1' } };
    const second = await registerIntoAppConfigs([{ path: configPath }], { serverEntry: newEntry });
    expect(second[0].status).toBe('updated');
    expect(second[0].previousEntry).toEqual(ENTRY);

    const final = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      foo?: string;
      mcpServers: Record<string, unknown>;
    };
    expect(final.foo).toBe('bar');
    expect(final.mcpServers.otherServer).toEqual({ command: 'uvx', args: ['x'] });
    expect(final.mcpServers.crosscode).toEqual(newEntry);
  });

  it('supports per-target serverName/serverEntry overrides', async () => {
    const configPath = path.join(tempRoot, 'qoder.json');
    const entry = { command: 'crosscode-mcp.exe', args: ['--serve'] };
    const results = await registerIntoAppConfigs([
      { path: configPath, serverName: 'crosscode-unified', serverEntry: entry },
    ]);
    expect(results[0]).toMatchObject({
      path: configPath,
      serverName: 'crosscode-unified',
      status: 'created',
    });
    const written = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers['crosscode-unified']).toEqual(entry);
    expect(written.mcpServers.crosscode).toBeUndefined();
  });

  it('defaultMcpServerEntry points at this package index.js with --mcp-stdio', () => {
    const entry = defaultMcpServerEntry();
    expect(entry.command).toBe('node');
    expect(entry.args?.[0]).toMatch(/index\.js$/);
    expect(entry.args).toContain('--mcp-stdio');
  });

  it('rejects config files that are not JSON objects', async () => {
    const configPath = path.join(tempRoot, 'broken.json');
    await fs.writeFile(configPath, '[1, 2, 3]', 'utf8');
    await expect(registerIntoAppConfigs([{ path: configPath }], { serverEntry: ENTRY })).rejects.toThrow(
      /JSON object/,
    );
  });
});
