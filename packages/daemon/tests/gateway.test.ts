import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import type { UnifiedStreamEvent } from '@crosscode/shared';
import {
  createGateway,
  HarnessEventBus,
  InMemoryPendingApprovalRegistry,
  ProviderSwitchboard,
  type GatewayDownstreamFrame,
  type GatewayHandle,
  type GatewaySession,
  type SessionClientAction,
} from '../src/index.js';

const execFileAsync = promisify(execFile);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'crosscode-gw-'));
}

async function makeProject(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name, version: '0.0.0' }, null, 2)}\n`,
    'utf8',
  );
  return dir;
}

/** Creates a real git repository with one committed file (a.txt = "one"). */
async function makeGitProject(root: string, name: string): Promise<string> {
  const dir = await makeProject(root, name);
  const git = (args: string[]): Promise<{ stdout: string; stderr: string }> =>
    execFileAsync('git', args, { cwd: dir });
  await git(['init', '-b', 'main']);
  await git(['config', 'core.autocrlf', 'false']);
  await git(['config', 'user.name', 'crosscode-test']);
  await git(['config', 'user.email', 'test@crosscode.local']);
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\n', 'utf8');
  await git(['add', '.']);
  await git(['commit', '-m', 'init']);
  return dir;
}

const SCAN_OPTIONS = { maxWorkspaceDepth: 1 };

/** Creates a gateway whose /projects scan is confined to the temp root. */
function makeGatewayForRoot(root: string, extra: Record<string, unknown> = {}): GatewayHandle {
  return createGateway({
    jwtSecret: 'test-secret-do-not-use',
    pin: '123456',
    scanOptions: { workspaceRoots: [root], appConfigDirs: {}, ...SCAN_OPTIONS },
    ...extra,
  });
}

async function pair(gateway: GatewayHandle, pin: string): Promise<{ statusCode: number; token: string | null; json: Record<string, unknown> }> {
  const res = await gateway.app.inject({ method: 'POST', url: '/pair', payload: { pin } });
  const json = res.json() as Record<string, unknown>;
  return { statusCode: res.statusCode, token: typeof json.token === 'string' ? json.token : null, json };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function authorizedJson(
  gateway: GatewayHandle,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  token: string,
  payload?: unknown,
): Promise<{ statusCode: number; json: Record<string, unknown> | unknown[] }> {
  const res = await gateway.app.inject({ method, url, headers: authHeaders(token), payload });
  const text = res.body;
  let json: Record<string, unknown> | unknown[] = {};
  try {
    json = JSON.parse(text) as Record<string, unknown> | unknown[];
  } catch {
    json = {};
  }
  return { statusCode: res.statusCode, json };
}

/** Finds the project id for a temp directory via the gateway scan. */
async function projectIdFor(gateway: GatewayHandle, token: string, projectDir: string): Promise<string> {
  const { statusCode, json } = await authorizedJson(gateway, 'GET', '/projects', token);
  expect(statusCode).toBe(200);
  const projects = json as Array<{ id: string; path: string }>;
  const match = projects.find((p) => path.resolve(p.path).toLowerCase() === path.resolve(projectDir).toLowerCase());
  if (!match) {
    throw new Error(`project not found for ${projectDir}; scanned ${projects.length} projects`);
  }
  return match.id;
}

class FakeSession implements GatewaySession {
  sessionId: string;
  private readonly bus = new HarnessEventBus();
  readonly actions: SessionClientAction[] = [];
  readonly approvals: Array<{ approvalId: string; approved: boolean }> = [];

  constructor(sessionId = 'sess-fake') {
    this.sessionId = sessionId;
  }

  emit(event: UnifiedStreamEvent): void {
    this.bus.emit(event);
  }

  subscribe(listener: (event: UnifiedStreamEvent) => void): () => void {
    return this.bus.subscribe(listener);
  }

  handleApproval(approvalId: string, approved: boolean): void {
    this.approvals.push({ approvalId, approved });
  }

  handleAction(action: SessionClientAction): void {
    this.actions.push(action);
  }
}

class SpyingRegistry extends InMemoryPendingApprovalRegistry {
  readonly resolvedCalls: Array<{ approvalId: string; approved: boolean }> = [];

  resolve(approvalId: string, approved: boolean): boolean {
    this.resolvedCalls.push({ approvalId, approved });
    return super.resolve(approvalId, approved);
  }
}

interface StartedGateway {
  gateway: GatewayHandle;
  /** Sessions created by the (default shared) session factory, in order. */
  sessions: FakeSession[];
  registry: SpyingRegistry;
  wsUrl: string;
}

interface StartGatewayOptions {
  /** Custom session factory (one call per ws connection). */
  sessionFactory?: () => FakeSession | null;
  /** When set, /projects scanning is confined to this temp root. */
  scanRoot?: string;
}

async function startGateway(opts: StartGatewayOptions = {}): Promise<StartedGateway> {
  const sessions: FakeSession[] = [];
  if (!opts.sessionFactory) {
    // Shared session: created eagerly so tests can grab sessions[0] before
    // the first ws connection attaches to it.
    sessions.push(new FakeSession());
  }
  const defaultFactory = (): FakeSession => sessions[0];
  const factory = opts.sessionFactory ?? defaultFactory;
  const registry = new SpyingRegistry();
  const gateway = createGateway({
    jwtSecret: 'ws-test-secret',
    pin: '123456',
    sessionManager: { getSession: async () => factory() },
    pendingApprovals: registry,
    ...(opts.scanRoot
      ? { scanOptions: { workspaceRoots: [opts.scanRoot], appConfigDirs: {}, maxWorkspaceDepth: 1 } }
      : { scanProjects: async () => [] }),
  });
  await gateway.app.listen({ port: 0, host: '127.0.0.1' });
  const address = gateway.app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (!port) throw new Error('gateway did not bind to an ephemeral port');
  return { gateway, sessions, registry, wsUrl: `ws://127.0.0.1:${port}/ws/session` };
}

class WsFrameCollector {
  readonly frames: GatewayDownstreamFrame[] = [];

  constructor(ws: WebSocket) {
    ws.on('message', (data: unknown) => {
      try {
        this.frames.push(JSON.parse(String(data)) as GatewayDownstreamFrame);
      } catch {
        // ignore non-JSON frames
      }
    });
  }

  async waitFor(match: (frame: GatewayDownstreamFrame) => boolean, timeoutMs = 5000): Promise<GatewayDownstreamFrame> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.frames.find(match);
      if (found) return found;
      await sleep(20);
    }
    throw new Error(`timeout waiting for frame; received: ${JSON.stringify(this.frames)}`);
  }
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err: Error) => reject(err));
    ws.once('close', (code: number) => reject(new Error(`closed before open (code ${code})`)));
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for socket close')), timeoutMs);
    ws.once('close', (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
    ws.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

const cleanupRoots: string[] = [];
const cleanupGateways: GatewayHandle[] = [];

async function trackRoot(): Promise<string> {
  const root = await makeTempRoot();
  cleanupRoots.push(root);
  return root;
}

function trackGateway(gateway: GatewayHandle): GatewayHandle {
  cleanupGateways.push(gateway);
  return gateway;
}

afterEach(async () => {
  while (cleanupGateways.length > 0) {
    const gateway = cleanupGateways.pop()!;
    try {
      await gateway.close();
    } catch {
      // ignore double-close
    }
  }
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop()!;
    await fs.rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pairing & auth
// ---------------------------------------------------------------------------

describe('gateway pairing and auth', () => {
  it('rejects a wrong PIN with 403', async () => {
    const root = await trackRoot();
    const gateway = trackGateway(makeGatewayForRoot(root));
    const result = await pair(gateway, '000000');
    expect(result.statusCode).toBe(403);
    expect(result.token).toBeNull();
  });

  it('rejects a malformed PIN with 400', async () => {
    const root = await trackRoot();
    const gateway = trackGateway(makeGatewayForRoot(root));
    const result = await pair(gateway, '12ab');
    expect(result.statusCode).toBe(400);
  });

  it('issues a JWT for the correct PIN that grants access to /projects', async () => {
    const root = await trackRoot();
    const gateway = trackGateway(makeGatewayForRoot(root));
    const result = await pair(gateway, '123456');
    expect(result.statusCode).toBe(200);
    expect(typeof result.token).toBe('string');

    const denied = await gateway.app.inject({ method: 'GET', url: '/projects' });
    expect(denied.statusCode).toBe(401);

    const badToken = await gateway.app.inject({
      method: 'GET',
      url: '/projects',
      headers: authHeaders('not.a.jwt'),
    });
    expect(badToken.statusCode).toBe(401);

    const ok = await authorizedJson(gateway, 'GET', '/projects', result.token!);
    expect(ok.statusCode).toBe(200);
    expect(Array.isArray(ok.json)).toBe(true);
  });

  it('supports PIN rotation via setPin', async () => {
    const root = await trackRoot();
    const gateway = trackGateway(makeGatewayForRoot(root));
    gateway.setPin('654321');

    const oldPin = await pair(gateway, '123456');
    expect(oldPin.statusCode).toBe(403);

    const newPin = await pair(gateway, '654321');
    expect(newPin.statusCode).toBe(200);
    expect(newPin.token).not.toBeNull();
  });

  it('locks /pair after consecutive failures and recovers when the lockout expires', async () => {
    const root = await trackRoot();
    let nowMs = 1_700_000_000_000;
    const gateway = trackGateway(
      makeGatewayForRoot(root, {
        pairRateLimit: { maxFailures: 2, lockoutSeconds: 60, now: () => nowMs },
      }),
    );

    // Two consecutive failures exhaust the budget (403 each).
    expect((await pair(gateway, '000001')).statusCode).toBe(403);
    expect((await pair(gateway, '000002')).statusCode).toBe(403);

    // Even the correct PIN is rejected with 429 while locked.
    const locked = await pair(gateway, '123456');
    expect(locked.statusCode).toBe(429);
    expect((locked.json as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);

    // Still locked within the window.
    nowMs += 30_000;
    expect((await pair(gateway, '123456')).statusCode).toBe(429);

    // After the lockout expires the correct PIN pairs again.
    nowMs += 61_000;
    const recovered = await pair(gateway, '123456');
    expect(recovered.statusCode).toBe(200);
    expect(recovered.token).not.toBeNull();

    // A success clears the counters (no lockout after isolated failures).
    expect((await pair(gateway, '000003')).statusCode).toBe(403);
    expect((await pair(gateway, '123456')).statusCode).toBe(200);
  });

  it('rejects a non-6-digit pin passed via createGateway options', () => {
    expect(() => createGateway({ jwtSecret: 's', pin: '12ab' })).toThrow(/6 digits/);
    expect(() => createGateway({ jwtSecret: 's', pin: '12345' })).toThrow(/6 digits/);
    expect(() => createGateway({ jwtSecret: 's', pin: '123456' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ProviderSwitchboard
// ---------------------------------------------------------------------------

describe('ProviderSwitchboard', () => {
  it('lists the built-in provider catalog', () => {
    const switchboard = new ProviderSwitchboard({ credentials: {} });
    const ids = switchboard.listProviders().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['anthropic', 'openai', 'deepseek', 'gemini', 'openrouter', 'ollama']));
  });

  it('resolveEnv merges overrides with global < harness < project priority', () => {
    const switchboard = new ProviderSwitchboard({ credentials: { OPENAI_API_KEY: 'sk-injected' } });
    const env = switchboard.resolveEnv({
      providerId: 'openai',
      overrides: {
        global: { OPENAI_API_KEY: 'g', OPENAI_BASE_URL: 'https://global.example.com/v1' },
        harness: { OPENAI_API_KEY: 'h' },
        project: { OPENAI_API_KEY: 'p' },
      },
    });
    expect(env.OPENAI_API_KEY).toBe('p');
    expect(env.OPENAI_BASE_URL).toBe('https://global.example.com/v1');

    const env2 = switchboard.resolveEnv({
      providerId: 'openai',
      overrides: { global: { OPENAI_API_KEY: 'g' }, harness: { OPENAI_API_KEY: 'h' } },
    });
    expect(env2.OPENAI_API_KEY).toBe('h');
    expect(env2.CROSSCODE_PROVIDER_ID).toBe('openai');
  });

  it('injects DeepSeek credentials with OpenAI-compatible aliases', () => {
    const switchboard = new ProviderSwitchboard({ credentials: { DEEPSEEK_API_KEY: 'sk-fake-deepseek' } });
    const env = switchboard.resolveEnv({ providerId: 'deepseek' });
    expect(env.DEEPSEEK_API_KEY).toBe('sk-fake-deepseek');
    expect(env.OPENAI_API_KEY).toBe('sk-fake-deepseek');
    expect(env.DEEPSEEK_BASE_URL).toBe('https://api.deepseek.com');
    expect(env.OPENAI_BASE_URL).toBe('https://api.deepseek.com');
  });

  it('persists the active provider and reads it back', async () => {
    const root = await trackRoot();
    const projectDir = await makeProject(root, 'sb-proj');
    const runtimeDir = path.join(root, 'runtime-store');
    const switchboard = new ProviderSwitchboard({
      credentials: {},
      runtimeDir: () => runtimeDir,
    });

    expect(switchboard.getActiveProviderId(projectDir)).toBe('deepseek');

    await switchboard.switchProvider(projectDir, 'anthropic');
    const stateFile = path.join(runtimeDir, 'provider-state.json');
    const state = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { providerId: string };
    expect(state.providerId).toBe('anthropic');
    expect(switchboard.getActiveProviderId(projectDir)).toBe('anthropic');
    expect(switchboard.getActiveProvider(projectDir).id).toBe('anthropic');

    await expect(switchboard.switchProvider(projectDir, 'nope')).rejects.toThrow(/Unknown provider/);
  });

  it('registers custom OpenAI-compatible providers at runtime', async () => {
    const root = await trackRoot();
    const projectDir = await makeProject(root, 'custom-proj');
    const runtimeDir = path.join(root, 'runtime-store');
    const switchboard = new ProviderSwitchboard({
      credentials: { MY_RELAY_KEY: 'sk-fake-relay' },
      runtimeDir: () => runtimeDir,
    });

    const custom = switchboard.registerCustomProvider({
      label: 'My Relay',
      baseUrl: 'https://relay.example.com/v1',
      models: ['relay-large'],
      apiKeyEnvName: 'MY_RELAY_KEY',
    });
    expect(custom.id).toBe('custom-my-relay');
    expect(switchboard.listProviders().some((p) => p.id === 'custom-my-relay')).toBe(true);

    const env = switchboard.resolveEnv({ providerId: 'custom-my-relay' });
    expect(env.MY_RELAY_KEY).toBe('sk-fake-relay');
    expect(env.OPENAI_API_KEY).toBe('sk-fake-relay');
    expect(env.OPENAI_BASE_URL).toBe('https://relay.example.com/v1');

    await switchboard.switchProvider(projectDir, 'custom-my-relay');
    expect(switchboard.getActiveProviderId(projectDir)).toBe('custom-my-relay');

    expect(() =>
      switchboard.registerCustomProvider({ id: 'custom-my-relay', label: 'Dup', baseUrl: 'https://x' }),
    ).toThrow(/already registered/);
  });
});

// ---------------------------------------------------------------------------
// Harness / provider switching routes
// ---------------------------------------------------------------------------

describe('harness and provider switching routes', () => {
  it('persists harness switch state and syncs the .agent manifest', async () => {
    const root = await trackRoot();
    const projectDir = await makeProject(root, 'harness-proj');
    const gateway = trackGateway(makeGatewayForRoot(root));
    const { token } = await pair(gateway, '123456');
    const id = await projectIdFor(gateway, token!, projectDir);

    const invalid = await authorizedJson(gateway, 'POST', `/projects/${id}/harness`, token!, {
      harnessId: 'not-a-harness',
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await authorizedJson(gateway, 'POST', '/projects/does-not-exist/harness', token!, {
      harnessId: 'codex',
    });
    expect(missing.statusCode).toBe(404);

    const ok = await authorizedJson(gateway, 'POST', `/projects/${id}/harness`, token!, {
      harnessId: 'codex',
    });
    expect(ok.statusCode).toBe(200);

    const statePath = (ok.json as { statePath: string }).statePath;
    const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as { harnessId: string };
    expect(state.harnessId).toBe('codex');

    const manifest = JSON.parse(
      await fs.readFile(path.join(projectDir, '.agent', 'manifest.json'), 'utf8'),
    ) as { activeHarness: string };
    expect(manifest.activeHarness).toBe('codex');
  });

  it('persists provider switch state through the switchboard', async () => {
    const root = await trackRoot();
    const projectDir = await makeProject(root, 'provider-proj');
    const gateway = trackGateway(makeGatewayForRoot(root));
    const { token } = await pair(gateway, '123456');
    const id = await projectIdFor(gateway, token!, projectDir);

    const bad = await authorizedJson(gateway, 'POST', `/projects/${id}/provider`, token!, {
      providerId: 'nope',
    });
    expect(bad.statusCode).toBe(400);

    const ok = await authorizedJson(gateway, 'POST', `/projects/${id}/provider`, token!, {
      providerId: 'anthropic',
    });
    expect(ok.statusCode).toBe(200);
    expect((ok.json as { activeProviderId: string }).activeProviderId).toBe('anthropic');

    const state = JSON.parse(
      await fs.readFile(path.join(projectDir, '.agent', 'runtime', 'provider-state.json'), 'utf8'),
    ) as { providerId: string };
    expect(state.providerId).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// Git diff routes
// ---------------------------------------------------------------------------

describe('git diff routes', () => {
  it('lists working-tree changes and the diff patch', async () => {
    const root = await trackRoot();
    const projectDir = await makeGitProject(root, 'diff-proj');
    await fs.writeFile(path.join(projectDir, 'a.txt'), 'two\n', 'utf8');
    await fs.writeFile(path.join(projectDir, 'new.txt'), 'brand new\n', 'utf8');

    const gateway = trackGateway(makeGatewayForRoot(root));
    const { token } = await pair(gateway, '123456');
    const id = await projectIdFor(gateway, token!, projectDir);

    const { statusCode, json } = await authorizedJson(gateway, 'GET', `/projects/${id}/diff`, token!);
    expect(statusCode).toBe(200);
    const body = json as {
      isGitRepo: boolean;
      branch: string;
      changes: Array<{ status: string; file: string; staged: boolean }>;
      diff: string;
    };
    expect(body.isGitRepo).toBe(true);
    expect(body.branch).toBe('main');
    const aChange = body.changes.find((c) => c.file === 'a.txt');
    expect(aChange?.status).toBe(' M');
    expect(aChange?.staged).toBe(false);
    expect(body.changes.some((c) => c.file === 'new.txt' && c.status === '??')).toBe(true);
    expect(body.diff).toContain('two');
  });

  it('discard restores working-tree files via git checkout', async () => {
    const root = await trackRoot();
    const projectDir = await makeGitProject(root, 'discard-proj');
    await fs.writeFile(path.join(projectDir, 'a.txt'), 'two\n', 'utf8');
    await fs.writeFile(path.join(projectDir, 'new.txt'), 'brand new\n', 'utf8');

    const gateway = trackGateway(makeGatewayForRoot(root));
    const { token } = await pair(gateway, '123456');
    const id = await projectIdFor(gateway, token!, projectDir);

    const traversal = await authorizedJson(gateway, 'POST', `/projects/${id}/diff/discard`, token!, {
      files: ['../outside.txt'],
    });
    expect(traversal.statusCode).toBe(400);

    const res = await authorizedJson(gateway, 'POST', `/projects/${id}/diff/discard`, token!, {
      files: ['a.txt'],
    });
    expect(res.statusCode).toBe(200);

    expect((await fs.readFile(path.join(projectDir, 'a.txt'), 'utf8')).trim()).toBe('one');
    // Untracked files are untouched by discard.
    await fs.access(path.join(projectDir, 'new.txt'));
  });

  it('accept stages changes into the git index (git add)', async () => {
    const root = await trackRoot();
    const projectDir = await makeGitProject(root, 'accept-proj');
    await fs.writeFile(path.join(projectDir, 'a.txt'), 'two\n', 'utf8');
    await fs.writeFile(path.join(projectDir, 'new.txt'), 'brand new\n', 'utf8');

    const gateway = trackGateway(makeGatewayForRoot(root));
    const { token } = await pair(gateway, '123456');
    const id = await projectIdFor(gateway, token!, projectDir);

    const res = await authorizedJson(gateway, 'POST', `/projects/${id}/diff/accept`, token!, {
      files: ['a.txt', 'new.txt'],
    });
    expect(res.statusCode).toBe(200);

    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: projectDir });
    const lines = stdout.split(/\r?\n/).filter((line) => line.length > 0);
    expect(lines).toContain('M  a.txt'); // staged modification
    expect(lines).toContain('A  new.txt'); // staged addition
  });

  it('reports non-ASCII filenames raw (core.quotepath=off) and discards/accepts them correctly', async () => {
    const root = await trackRoot();
    const projectDir = await makeGitProject(root, 'cjk-proj');
    await fs.writeFile(path.join(projectDir, '中文文档.txt'), 'v1\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: projectDir });
    await execFileAsync('git', ['commit', '-m', 'add cjk file'], { cwd: projectDir });
    await fs.writeFile(path.join(projectDir, '中文文档.txt'), 'v2\n', 'utf8');

    const gateway = trackGateway(makeGatewayForRoot(root));
    const { token } = await pair(gateway, '123456');
    const id = await projectIdFor(gateway, token!, projectDir);

    // The change list carries the raw UTF-8 filename, not an octal escape.
    const listed = await authorizedJson(gateway, 'GET', `/projects/${id}/diff`, token!);
    expect(listed.statusCode).toBe(200);
    const changes = (listed.json as { changes: Array<{ status: string; file: string }> }).changes;
    const cjk = changes.find((c) => c.file === '中文文档.txt');
    expect(cjk?.status).toBe(' M');

    // Discard restores the committed content via the non-ASCII pathspec.
    const discarded = await authorizedJson(gateway, 'POST', `/projects/${id}/diff/discard`, token!, {
      files: ['中文文档.txt'],
    });
    expect(discarded.statusCode).toBe(200);
    expect((await fs.readFile(path.join(projectDir, '中文文档.txt'), 'utf8')).trim()).toBe('v1');

    // Accept stages the change again via the non-ASCII pathspec.
    await fs.writeFile(path.join(projectDir, '中文文档.txt'), 'v2\n', 'utf8');
    const accepted = await authorizedJson(gateway, 'POST', `/projects/${id}/diff/accept`, token!, {
      files: ['中文文档.txt'],
    });
    expect(accepted.statusCode).toBe(200);
    const { stdout } = await execFileAsync(
      'git',
      ['-c', 'core.quotepath=off', 'status', '--porcelain'],
      { cwd: projectDir },
    );
    expect(stdout.split(/\r?\n/)).toContain('M  中文文档.txt');
  });
});

// ---------------------------------------------------------------------------
// Skills toggles
// ---------------------------------------------------------------------------

describe('skills toggles', () => {
  it('writes and reads skill toggle state from the injected JSON store', async () => {
    const root = await trackRoot();
    const storePath = path.join(root, 'skills-state.json');
    const gateway = trackGateway(
      makeGatewayForRoot(root, { skillsStorePath: storePath }),
    );
    const { token } = await pair(gateway, '123456');

    const initial = await authorizedJson(gateway, 'GET', '/skills', token!);
    expect(initial.statusCode).toBe(200);
    expect((initial.json as { skills: Record<string, boolean> }).skills).toEqual({});

    const put1 = await authorizedJson(gateway, 'PUT', '/skills', token!, {
      skillId: 'web-search',
      enabled: true,
    });
    expect(put1.statusCode).toBe(200);

    const put2 = await authorizedJson(gateway, 'PUT', '/skills', token!, {
      skills: { 'pdf-export': false },
    });
    expect(put2.statusCode).toBe(200);

    const state = await authorizedJson(gateway, 'GET', '/skills', token!);
    const skills = (state.json as { skills: Record<string, boolean> }).skills;
    expect(skills['web-search']).toBe(true);
    expect(skills['pdf-export']).toBe(false);

    const persisted = JSON.parse(await fs.readFile(storePath, 'utf8')) as { skills: Record<string, boolean> };
    expect(persisted.skills['web-search']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WebSocket session stream
// ---------------------------------------------------------------------------

describe('websocket /ws/session', () => {
  it('requires authentication and closes sockets that skip it', async () => {
    const { gateway, wsUrl } = await startGateway();
    trackGateway(gateway);

    const ws = new WebSocket(wsUrl);
    const collector = new WsFrameCollector(ws);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: 'send_prompt', prompt: 'nope' }));

    const code = await waitForClose(ws);
    expect(code).toBe(4001);
    const errorFrame = await collector.waitFor((f) => f.type === 'error');
    expect((errorFrame as { message: string }).message).toContain('authentication required');
  });

  it('closes connections carrying an invalid query token', async () => {
    const { gateway, wsUrl } = await startGateway();
    trackGateway(gateway);

    const ws = new WebSocket(`${wsUrl}?token=garbage.token.here`);
    const code = await waitForClose(ws);
    expect(code).toBe(4001);
  });

  it('authenticates via first message, forwards session events and completes the approval flow', async () => {
    const { gateway, sessions, registry, wsUrl } = await startGateway();
    const session = sessions[0];
    trackGateway(gateway);

    const { token } = await pair(gateway, '123456');
    const ws = new WebSocket(wsUrl);
    const collector = new WsFrameCollector(ws);
    await waitOpen(ws);

    // First-message auth (no ?token= query parameter).
    ws.send(JSON.stringify({ type: 'auth', token }));
    await collector.waitFor((f) => f.type === 'auth_ok');
    await collector.waitFor((f) => f.type === 'session_attached');

    // Downstream: text deltas are forwarded as UnifiedStreamEvent frames.
    session.emit({
      type: 'text_delta',
      sessionId: 'sess-fake',
      harness: 'crosscode-native',
      text: 'hello gateway',
    });
    const delta = await collector.waitFor((f) => f.type === 'text_delta');
    expect((delta as { text: string }).text).toBe('hello gateway');

    // Downstream: tool call requiring approval produces an approval card.
    session.emit({
      type: 'tool_call_start',
      sessionId: 'sess-fake',
      callId: 'call-1',
      toolName: 'edit_file',
      args: { file: 'a.txt' },
      requiresApproval: true,
    });
    await collector.waitFor((f) => f.type === 'tool_call_start');
    const card = (await collector.waitFor((f) => f.type === 'approval_request')) as {
      approvalId: string;
      callId: string;
      toolName: string;
    };
    expect(card.callId).toBe('call-1');
    expect(card.toolName).toBe('edit_file');
    expect(registry.isPending(card.approvalId)).toBe(true);

    // Upstream: approve resolves through the registry and reaches the session.
    ws.send(JSON.stringify({ type: 'approve', approvalId: card.approvalId }));
    await collector.waitFor((f) => f.type === 'approval_resolved');
    expect(registry.resolvedCalls).toEqual([{ approvalId: card.approvalId, approved: true }]);
    expect(session.approvals).toEqual([{ approvalId: card.approvalId, approved: true }]);
    expect(registry.isPending(card.approvalId)).toBe(false);

    // Upstream: send_prompt reaches the session.
    ws.send(JSON.stringify({ type: 'send_prompt', prompt: 'continue working' }));
    await sleep(100);
    expect(session.actions).toContainEqual({ type: 'send_prompt', prompt: 'continue working' });
  });

  it('authenticates via query token, forwards screen frames and persists provider switches', async () => {
    const root = await trackRoot();
    const projectDir = await makeProject(root, 'ws-provider-proj');
    const { gateway, sessions, wsUrl } = await startGateway({ scanRoot: root });
    const session = sessions[0];
    trackGateway(gateway);

    const { token } = await pair(gateway, '123456');
    const ws = new WebSocket(
      `${wsUrl}?token=${encodeURIComponent(token!)}&projectPath=${encodeURIComponent(projectDir)}`,
    );
    const collector = new WsFrameCollector(ws);
    await waitOpen(ws);
    await collector.waitFor((f) => f.type === 'session_attached');

    // Downstream: screen frames (base64 blocks) are forwarded.
    session.emit({
      type: 'screen_frame',
      sessionId: 'sess-fake',
      source: 'builtin-browser',
      imageBase64: 'aGVsbG8=',
      timestamp: new Date().toISOString(),
    });
    const frame = (await collector.waitFor((f) => f.type === 'screen_frame')) as {
      imageBase64: string;
      source: string;
    };
    expect(frame.imageBase64).toBe('aGVsbG8=');
    expect(frame.source).toBe('builtin-browser');

    // Upstream: switch_provider persists through the switchboard and reaches
    // the session.
    ws.send(JSON.stringify({ type: 'switch_provider', providerId: 'openai' }));
    await collector.waitFor((f) => f.type === 'provider_switched');
    const state = JSON.parse(
      await fs.readFile(path.join(projectDir, '.agent', 'runtime', 'provider-state.json'), 'utf8'),
    ) as { providerId: string };
    expect(state.providerId).toBe('openai');
    expect(session.actions).toContainEqual({ type: 'switch_provider', providerId: 'openai' });

    // Downstream: reject flow.
    session.emit({
      type: 'tool_call_start',
      sessionId: 'sess-fake',
      callId: 'call-2',
      toolName: 'run_command',
      args: { cmd: 'rm -rf /' },
      requiresApproval: true,
    });
    const card = (await collector.waitFor((f) => f.type === 'approval_request')) as { approvalId: string };
    ws.send(JSON.stringify({ type: 'reject', approvalId: card.approvalId }));
    await collector.waitFor((f) => f.type === 'approval_resolved');
    expect(session.approvals).toContainEqual({ approvalId: card.approvalId, approved: false });
  });

  it('refuses switch_provider for a projectPath that is not a scanned project', async () => {
    const root = await trackRoot();
    // projectDir exists on disk but is NOT inside any scanned workspace root.
    const projectDir = await makeProject(root, 'unscanned-proj');
    const { gateway, wsUrl } = await startGateway();
    trackGateway(gateway);

    const { token } = await pair(gateway, '123456');
    const ws = new WebSocket(
      `${wsUrl}?token=${encodeURIComponent(token!)}&projectPath=${encodeURIComponent(projectDir)}`,
    );
    const collector = new WsFrameCollector(ws);
    await waitOpen(ws);
    await collector.waitFor((f) => f.type === 'session_attached');

    ws.send(JSON.stringify({ type: 'switch_provider', providerId: 'openai' }));
    const error = (await collector.waitFor((f) => f.type === 'error')) as { message: string };
    expect(error.message).toContain('not a scanned project');

    // Nothing was persisted on disk.
    await expect(
      fs.access(path.join(projectDir, '.agent', 'runtime', 'provider-state.json')),
    ).rejects.toThrow();
  });

  it('answers switch_provider with an error frame when neither projectPath nor session exists', async () => {
    const { gateway, wsUrl } = await startGateway({
      sessionFactory: () => null, // every connection stays session-less
    });
    trackGateway(gateway);

    const { token } = await pair(gateway, '123456');
    const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token!)}`);
    const collector = new WsFrameCollector(ws);
    await waitOpen(ws);

    // attachSession reports the missing session but keeps the socket open.
    const noSession = (await collector.waitFor((f) => f.type === 'error')) as { message: string };
    expect(noSession.message).toContain('no session available');

    ws.send(JSON.stringify({ type: 'switch_provider', providerId: 'openai' }));
    const error = (await collector.waitFor((f) => f.type === 'error' && f !== noSession)) as {
      message: string;
    };
    expect(error.message).toContain('switch_provider requires');

    // approve/reject are equally refused without a session.
    ws.send(JSON.stringify({ type: 'approve', approvalId: 'apr_missing' }));
    const approveError = (await collector.waitFor((f) => f.type === 'error' && f !== noSession && f !== error)) as {
      message: string;
    };
    expect(approveError.message).toContain('no session attached');
  });

  it('refuses approve/reject for approvals belonging to another session', async () => {
    let counter = 0;
    const { gateway, sessions, wsUrl } = await startGateway({
      sessionFactory: () => {
        counter += 1;
        const session = new FakeSession(`sess-${counter}`);
        sessions.push(session);
        return session;
      },
    });
    trackGateway(gateway);

    const { token } = await pair(gateway, '123456');
    const socketA = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token!)}`);
    const collectorA = new WsFrameCollector(socketA);
    await waitOpen(socketA);
    await collectorA.waitFor((f) => f.type === 'session_attached');

    const socketB = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token!)}`);
    const collectorB = new WsFrameCollector(socketB);
    await waitOpen(socketB);
    await collectorB.waitFor((f) => f.type === 'session_attached');

    // Session A (connection A) raises an approval.
    const sessionA = sessions[0];
    const sessionB = sessions[1];
    sessionA.emit({
      type: 'tool_call_start',
      sessionId: sessionA.sessionId,
      callId: 'call-a',
      toolName: 'edit_file',
      args: {},
      requiresApproval: true,
    });
    const card = (await collectorA.waitFor((f) => f.type === 'approval_request')) as {
      approvalId: string;
      sessionId: string;
    };
    expect(card.sessionId).toBe(sessionA.sessionId);

    // Connection B (session B) tries to approve A's approval → refused.
    socketB.send(JSON.stringify({ type: 'approve', approvalId: card.approvalId }));
    const error = (await collectorB.waitFor((f) => f.type === 'error')) as { message: string };
    expect(error.message).toContain('does not belong to session');
    expect(sessionA.approvals).toEqual([]);
    expect(sessionB.approvals).toEqual([]);

    // Connection A can still approve its own approval.
    socketA.send(JSON.stringify({ type: 'approve', approvalId: card.approvalId }));
    await collectorA.waitFor((f) => f.type === 'approval_resolved');
    expect(sessionA.approvals).toEqual([{ approvalId: card.approvalId, approved: true }]);
  });

  it('reports an error frame instead of crashing when the session approval callback throws', async () => {
    const { gateway, sessions, wsUrl } = await startGateway();
    trackGateway(gateway);
    const session = sessions[0];
    session.handleApproval = () => {
      throw new Error('approval callback exploded');
    };

    const { token } = await pair(gateway, '123456');
    const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token!)}`);
    const collector = new WsFrameCollector(ws);
    await waitOpen(ws);
    await collector.waitFor((f) => f.type === 'session_attached');

    session.emit({
      type: 'tool_call_start',
      sessionId: session.sessionId,
      callId: 'call-boom',
      toolName: 'edit_file',
      args: {},
      requiresApproval: true,
    });
    const card = (await collector.waitFor((f) => f.type === 'approval_request')) as {
      approvalId: string;
    };
    ws.send(JSON.stringify({ type: 'approve', approvalId: card.approvalId }));

    // The failure surfaces as an error frame (no unhandled rejection).
    const error = (await collector.waitFor((f) => f.type === 'error')) as { message: string };
    expect(error.message).toContain('approval callback exploded');
    ws.close();
  });
});
