import { execFile } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { WebSocket, WebSocketServer } from 'ws';
import {
  ALL_HARNESS_IDS,
  type HarnessId,
  type UnifiedProject,
  type UnifiedStreamEvent,
} from '@crosscode/shared';
import { ProjectScanner, type ProjectScanOptions } from '../scanner/project-scanner.js';
import { updateActiveTask } from '../workspace/agent-workspace.js';
import { ProviderSwitchboard } from '../providers/provider-switchboard.js';

/**
 * REST + WebSocket gateway for the local daemon ("守护服务网关").
 *
 * - Device pairing: `POST /pair` validates a 6-digit dynamic PIN and returns a
 *   long-lived HS256 JWT; every other route requires `Authorization: Bearer`.
 * - REST: project scan, harness/provider switching (persisted under
 *   `<project>/.agent/runtime/`), skills toggles (injectable JSON store) and
 *   git diff inspect / discard (checkout --) / accept (stage into index).
 * - WebSocket `/ws/session`: downstream JSON frames carrying
 *   `UnifiedStreamEvent`s (text deltas, tool calls, normalized errors,
 *   screen frames) plus approval cards; upstream actions `approve`/`reject`
 *   (routed through the injectable {@link PendingApprovalRegistry}),
 *   `send_prompt` and `switch_provider`. The gateway never owns harness
 *   instances — an injectable {@link SessionManager} supplies sessions.
 *
 * The Fastify instance is created without listening: tests use
 * `fastify.inject()` or bind `app.server` to an ephemeral port themselves.
 */

const GATEWAY_JWT_ISSUER = 'crosscode-gateway';
const DEFAULT_JWT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const WS_CLOSE_UNAUTHORIZED = 4001;
const WS_CLOSE_NO_SESSION = 4002;

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Pending approvals
// ---------------------------------------------------------------------------

export interface PendingApprovalRecord {
  approvalId: string;
  sessionId: string;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: string;
}

export interface PendingApprovalRegistry {
  /** Registers a pending approval; `onResolution` fires exactly once. */
  register(record: PendingApprovalRecord, onResolution: (approved: boolean) => void): void;
  /** Resolves a pending approval; returns false when the id is unknown. */
  resolve(approvalId: string, approved: boolean): boolean;
  isPending(approvalId: string): boolean;
  listPending(): PendingApprovalRecord[];
}

export class InMemoryPendingApprovalRegistry implements PendingApprovalRegistry {
  private readonly pending = new Map<
    string,
    { record: PendingApprovalRecord; onResolution: (approved: boolean) => void }
  >();

  register(record: PendingApprovalRecord, onResolution: (approved: boolean) => void): void {
    this.pending.set(record.approvalId, { record, onResolution });
  }

  resolve(approvalId: string, approved: boolean): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    this.pending.delete(approvalId);
    entry.onResolution(approved);
    return true;
  }

  isPending(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  listPending(): PendingApprovalRecord[] {
    return Array.from(this.pending.values()).map((entry) => ({ ...entry.record }));
  }
}

// ---------------------------------------------------------------------------
// Pluggable session abstraction
// ---------------------------------------------------------------------------

/** Upstream client actions the gateway forwards to the session. */
export type SessionClientAction =
  | { type: 'send_prompt'; prompt: string }
  | { type: 'switch_provider'; providerId: string };

export interface GatewayConnectionContext {
  sessionId: string;
  projectId?: string;
  projectPath?: string;
}

/**
 * Structural view of one agent session. The gateway only relies on this
 * interface — real implementations wrap harness adapters, tests inject fakes.
 */
export interface GatewaySession {
  readonly sessionId: string;
  /** Stream of UnifiedStreamEvents produced by the underlying harness. */
  subscribe(listener: (event: UnifiedStreamEvent) => void): () => void;
  /** Called when a pending approval raised on this session is resolved. */
  handleApproval(approvalId: string, approved: boolean): void;
  /** Client actions other than approve/reject (those stay in the gateway). */
  handleAction(action: SessionClientAction): void | Promise<void>;
  /** Optional cleanup hook fired when the websocket disconnects. */
  dispose?(): void;
}

export interface SessionManager {
  getSession(context: GatewayConnectionContext): GatewaySession | null | Promise<GatewaySession | null>;
}

// ---------------------------------------------------------------------------
// Wire frames
// ---------------------------------------------------------------------------

export type GatewayDownstreamFrame =
  | UnifiedStreamEvent
  | ({ type: 'approval_request' } & PendingApprovalRecord)
  | { type: 'approval_resolved'; approvalId: string; approved: boolean }
  | { type: 'session_attached'; sessionId: string }
  | { type: 'provider_switched'; providerId: string }
  | { type: 'auth_ok' }
  | { type: 'error'; message: string };

export type GatewayUpstreamFrame =
  | { type: 'auth'; token: string }
  | { type: 'approve'; approvalId: string }
  | { type: 'reject'; approvalId: string }
  | { type: 'send_prompt'; prompt: string }
  | { type: 'switch_provider'; providerId: string };

// ---------------------------------------------------------------------------
// Gateway options & handle
// ---------------------------------------------------------------------------

export interface GatewayOptions {
  /** HS256 secret used to sign and verify pairing JWTs. */
  jwtSecret: string;
  /** Token lifetime in seconds (default 30 days). */
  jwtTtlSeconds?: number;
  /** Initial pairing PIN; a random 6-digit code is generated when omitted. */
  pin?: string;
  /** Dynamic PIN source consulted on every /pair call (overrides `pin`). */
  getPin?: () => string;
  /** Scan options handed to {@link ProjectScanner.scanAll}. */
  scanOptions?: ProjectScanOptions;
  /** Injectable scan function (tests point it at a temp workspace). */
  scanProjects?: (options: ProjectScanOptions | undefined) => Promise<UnifiedProject[]>;
  /** Provider switchboard (a default one is created when omitted). */
  switchboard?: ProviderSwitchboard;
  /** Runtime dir resolver for harness/provider state (default `.agent/runtime`). */
  runtimeDir?: (projectPath: string) => string;
  /** JSON file backing the skills toggles. */
  skillsStorePath?: string;
  /** Pluggable session source for /ws/session. */
  sessionManager?: SessionManager;
  /** Pending approval registry (in-memory default). */
  pendingApprovals?: PendingApprovalRegistry;
}

export interface GatewayHandle {
  app: FastifyInstance;
  switchboard: ProviderSwitchboard;
  pendingApprovals: PendingApprovalRegistry;
  wsServer: WebSocketServer;
  /** Rotates the current pairing PIN. */
  setPin(pin: string): void;
  /** Returns the currently valid pairing PIN. */
  getPin(): string;
  /** Closes all websocket clients, the ws server and the Fastify instance. */
  close(): Promise<void>;
}

export interface SkillsToggleState {
  skills: Record<string, boolean>;
  updatedAt: string;
}

interface GitChange {
  /** Two-character porcelain status, e.g. `M `, ` M`, `??`, `A `. */
  status: string;
  index: string;
  workingTree: string;
  file: string;
  /** True when the change is already in the index (staged). */
  staged: boolean;
}

interface GitDiffSummary {
  isGitRepo: boolean;
  branch?: string;
  changes: GitChange[];
  diff: string;
}

// ---------------------------------------------------------------------------
// Git helpers (all git invocations use execFile with argument arrays — no
// shell interpolation — and file arguments are validated to stay inside the
// project directory).
// ---------------------------------------------------------------------------

async function runGit(cwd: string, args: readonly string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message ?? 'git command failed',
    };
  }
}

function stripGitQuotes(file: string): string {
  if (file.length >= 2 && file.startsWith('"') && file.endsWith('"')) {
    return file.slice(1, -1);
  }
  return file;
}

function parsePorcelain(output: string): GitChange[] {
  const changes: GitChange[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.length < 4) continue;
    const status = rawLine.slice(0, 2);
    let file = rawLine.slice(3);
    // Rename entries look like "R  old -> new"; report the new path.
    if (file.includes(' -> ')) {
      file = file.slice(file.lastIndexOf(' -> ') + 4);
    }
    file = stripGitQuotes(file);
    changes.push({
      status,
      index: status[0],
      workingTree: status[1],
      file,
      staged: status[0] !== ' ' && status[0] !== '?',
    });
  }
  return changes;
}

async function collectDiff(projectPath: string): Promise<GitDiffSummary> {
  const repoCheck = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
  if (!repoCheck.ok || repoCheck.stdout.trim() !== 'true') {
    return { isGitRepo: false, changes: [], diff: '' };
  }
  const branchRes = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const statusRes = await runGit(projectPath, ['status', '--porcelain']);
  const diffRes = await runGit(projectPath, ['--no-pager', 'diff']);
  return {
    isGitRepo: true,
    ...(branchRes.ok ? { branch: branchRes.stdout.trim() } : {}),
    changes: parsePorcelain(statusRes.ok ? statusRes.stdout : ''),
    diff: diffRes.ok ? diffRes.stdout : '',
  };
}

/**
 * Guards `git checkout --` / `git add` targets: relative paths only, no `..`
 * segments, and the resolved path must stay inside the project directory.
 */
function isSafeRelativeFile(projectPath: string, file: unknown): file is string {
  if (typeof file !== 'string') return false;
  const normalized = file.trim().replace(/\\/g, '/');
  if (normalized.length === 0 || normalized.includes('\0')) return false;
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return false;
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) return false;
  const root = path.resolve(projectPath);
  const resolved = path.resolve(root, ...segments);
  return resolved === root || resolved.startsWith(root + path.sep);
}

// ---------------------------------------------------------------------------
// Gateway factory
// ---------------------------------------------------------------------------

export function createGateway(options: GatewayOptions): GatewayHandle {
  if (!options.jwtSecret || typeof options.jwtSecret !== 'string') {
    throw new Error('createGateway requires a jwtSecret');
  }

  const secretKey = new TextEncoder().encode(options.jwtSecret);
  const ttlSeconds = options.jwtTtlSeconds ?? DEFAULT_JWT_TTL_SECONDS;
  const runtimeDirResolver =
    options.runtimeDir ?? ((projectPath: string) => path.join(path.resolve(projectPath), '.agent', 'runtime'));
  const skillsStorePath =
    options.skillsStorePath ?? path.join(os.homedir(), '.crosscode', 'gateway', 'skills-state.json');

  const switchboard =
    options.switchboard ?? new ProviderSwitchboard({ runtimeDir: runtimeDirResolver });
  const pendingApprovals = options.pendingApprovals ?? new InMemoryPendingApprovalRegistry();
  const scanProjects = options.scanProjects ?? (async () => ProjectScanner.scanAll(options.scanOptions ?? {}));

  let currentPin = options.pin ?? String(randomInt(100000, 1000000));
  const getPin = (): string => (options.getPin ? options.getPin() : currentPin);
  const setPin = (pin: string): void => {
    if (!/^\d{6}$/.test(pin)) {
      throw new Error('pin must be exactly 6 digits');
    }
    currentPin = pin;
  };

  async function verifyToken(token: string): Promise<boolean> {
    try {
      await jwtVerify(token, secretKey, { issuer: GATEWAY_JWT_ISSUER });
      return true;
    } catch {
      return false;
    }
  }

  const requireAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | undefined> => {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'missing bearer token' });
    }
    const token = header.slice('Bearer '.length).trim();
    if (!(await verifyToken(token))) {
      return reply.code(401).send({ error: 'invalid or expired token' });
    }
    return undefined;
  };

  async function resolveProject(id: string): Promise<UnifiedProject | null> {
    const projects = await scanProjects(options.scanOptions);
    return projects.find((project) => project.id === id) ?? null;
  }

  // --- Skills toggle store -------------------------------------------------

  async function readSkillsState(): Promise<SkillsToggleState> {
    try {
      const raw = await fs.readFile(skillsStorePath, 'utf8');
      const parsed = JSON.parse(raw) as SkillsToggleState;
      if (parsed && typeof parsed.skills === 'object' && parsed.skills !== null) {
        return { skills: { ...parsed.skills }, updatedAt: parsed.updatedAt ?? new Date().toISOString() };
      }
    } catch {
      // missing or malformed store → default empty state
    }
    return { skills: {}, updatedAt: new Date().toISOString() };
  }

  async function writeSkillsState(state: SkillsToggleState): Promise<void> {
    await fs.mkdir(path.dirname(skillsStorePath), { recursive: true });
    await fs.writeFile(skillsStorePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  const app = fastify({ logger: false });

  // --- Pairing -------------------------------------------------------------

  app.post('/pair', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const pin = typeof body.pin === 'string' ? body.pin : '';
    if (!/^\d{6}$/.test(pin)) {
      return reply.code(400).send({ error: 'pin must be a 6-digit code' });
    }
    const expected = getPin();
    if (!expected || pin !== expected) {
      return reply.code(403).send({ error: 'invalid pairing pin' });
    }
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ scope: 'crosscode-gateway' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(issuedAt)
      .setIssuer(GATEWAY_JWT_ISSUER)
      .setExpirationTime(issuedAt + ttlSeconds)
      .sign(secretKey);
    return {
      token,
      tokenType: 'Bearer',
      expiresIn: ttlSeconds,
      issuedAt: new Date(issuedAt * 1000).toISOString(),
    };
  });

  // --- REST routes (all require a Bearer token) ----------------------------

  app.get('/projects', { preHandler: [requireAuth] }, async () => {
    return scanProjects(options.scanOptions);
  });

  app.get('/providers', { preHandler: [requireAuth] }, async () => {
    return switchboard.listProviders();
  });

  app.post('/projects/:id/harness', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const harnessId = typeof body.harnessId === 'string' ? body.harnessId : '';
    if (!ALL_HARNESS_IDS.includes(harnessId as HarnessId)) {
      return reply.code(400).send({
        error: `harnessId must be one of: ${ALL_HARNESS_IDS.join(', ')}`,
      });
    }
    const harness = harnessId as HarnessId;
    const project = await resolveProject(id);
    if (!project) {
      return reply.code(404).send({ error: `unknown project '${id}'` });
    }

    // Persist the harness switch under the project's `.agent/runtime/` so the
    // daemon (and any harness relaunched later) picks it up across restarts.
    const dir = runtimeDirResolver(project.path);
    await fs.mkdir(dir, { recursive: true });
    const updatedAt = new Date().toISOString();
    const statePath = path.join(dir, 'harness-state.json');
    await fs.writeFile(statePath, `${JSON.stringify({ harnessId: harness, updatedAt }, null, 2)}\n`, 'utf8');

    // Keep the shared .agent manifest + active-task state in sync.
    try {
      await updateActiveTask(project.path, {
        currentHarness: harness,
        currentStep: `Harness switched to ${harness} via gateway`,
      });
    } catch {
      // best-effort: runtime state file above is the source of truth
    }

    return { ok: true, projectId: id, projectPath: project.path, harnessId, statePath, updatedAt };
  });

  app.post('/projects/:id/provider', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const providerId = typeof body.providerId === 'string' ? body.providerId : '';
    if (!providerId) {
      return reply.code(400).send({ error: 'providerId is required' });
    }
    const project = await resolveProject(id);
    if (!project) {
      return reply.code(404).send({ error: `unknown project '${id}'` });
    }
    const modelId = typeof body.modelId === 'string' ? body.modelId : undefined;
    try {
      await switchboard.switchProvider(project.path, providerId, { modelId });
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
    return {
      ok: true,
      projectId: id,
      projectPath: project.path,
      providerId,
      activeProviderId: switchboard.getActiveProviderId(project.path),
    };
  });

  app.get('/projects/:id/diff', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = await resolveProject(id);
    if (!project) {
      return reply.code(404).send({ error: `unknown project '${id}'` });
    }
    const summary = await collectDiff(project.path);
    return { projectId: id, projectPath: project.path, ...summary };
  });

  app.post('/projects/:id/diff/discard', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const project = await resolveProject(id);
    if (!project) {
      return reply.code(404).send({ error: `unknown project '${id}'` });
    }

    const summary = await collectDiff(project.path);
    const files = Array.isArray(body.files)
      ? body.files.map((file) => file)
      : // Default: every tracked file with working-tree changes (untracked
        // files have no HEAD version to restore, so they are excluded).
        summary.changes
          .filter((change) => change.status !== '??' && change.workingTree !== ' ')
          .map((change) => change.file);

    const invalid = files.filter((file) => !isSafeRelativeFile(project.path, file));
    if (invalid.length > 0) {
      return reply.code(400).send({ error: 'files must be relative paths inside the project', invalid });
    }
    if (files.length === 0) {
      return reply.code(400).send({ error: 'no working-tree changes to discard' });
    }

    // Discard semantics: `git checkout -- <files>` throws away the working
    // tree changes and restores the files from the index/HEAD. This is
    // destructive and never touches the index.
    const result = await runGit(project.path, ['checkout', '--', ...files]);
    if (!result.ok) {
      return reply.code(400).send({ error: result.stderr.trim() || 'git checkout failed' });
    }
    return { ok: true, projectId: id, discarded: files };
  });

  app.post('/projects/:id/diff/accept', { preHandler: [requireAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const project = await resolveProject(id);
    if (!project) {
      return reply.code(404).send({ error: `unknown project '${id}'` });
    }

    const summary = await collectDiff(project.path);
    const files = Array.isArray(body.files)
      ? body.files.map((file) => file)
      : summary.changes.map((change) => change.file);

    const invalid = files.filter((file) => !isSafeRelativeFile(project.path, file));
    if (invalid.length > 0) {
      return reply.code(400).send({ error: 'files must be relative paths inside the project', invalid });
    }
    if (files.length === 0) {
      return reply.code(400).send({ error: 'no changes to accept' });
    }

    // Accept semantics: stage the listed changes into git's index (`git add`),
    // merging them into the pending commit set. Nothing is committed here and
    // no working-tree content is modified.
    const result = await runGit(project.path, ['add', '--', ...files]);
    if (!result.ok) {
      return reply.code(400).send({ error: result.stderr.trim() || 'git add failed' });
    }
    return { ok: true, projectId: id, accepted: files };
  });

  // --- Skills toggles ------------------------------------------------------

  app.get('/skills', { preHandler: [requireAuth] }, async () => {
    return readSkillsState();
  });

  app.put('/skills', { preHandler: [requireAuth] }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const current = await readSkillsState();
    const skills: Record<string, boolean> = { ...current.skills };

    if (body.skillId !== undefined) {
      if (typeof body.skillId !== 'string' || body.skillId.length === 0) {
        return reply.code(400).send({ error: 'skillId must be a non-empty string' });
      }
      if (typeof body.enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled must be a boolean' });
      }
      skills[body.skillId] = body.enabled;
    }

    if (body.skills !== undefined) {
      if (!body.skills || typeof body.skills !== 'object' || Array.isArray(body.skills)) {
        return reply.code(400).send({ error: 'skills must be an object of boolean toggles' });
      }
      for (const [skillId, enabled] of Object.entries(body.skills as Record<string, unknown>)) {
        if (typeof enabled !== 'boolean') {
          return reply.code(400).send({ error: 'skills values must be booleans' });
        }
        skills[skillId] = enabled;
      }
    }

    const next: SkillsToggleState = { skills, updatedAt: new Date().toISOString() };
    await writeSkillsState(next);
    return next;
  });

  // --- WebSocket session channel -------------------------------------------

  const wsServer = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  app.server.on('upgrade', (request, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      pathname = '/';
    }
    if (pathname !== '/ws/session') {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit('connection', ws, request);
    });
  });

  wsServer.on('connection', (ws: WebSocket, request: import('node:http').IncomingMessage) => {
    sockets.add(ws);

    let authenticated = false;
    let session: GatewaySession | null = null;
    let unsubscribe: (() => void) | null = null;

    const url = new URL(request.url ?? '/', 'http://localhost');
    const connectionProjectPath = url.searchParams.get('projectPath') ?? undefined;

    const send = (frame: GatewayDownstreamFrame): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(frame));
      }
    };

    const attachSession = async (): Promise<void> => {
      if (!options.sessionManager) {
        send({ type: 'error', message: 'no session manager configured' });
        ws.close(WS_CLOSE_NO_SESSION, 'no session manager');
        return;
      }
      const context: GatewayConnectionContext = {
        sessionId: randomUUID(),
        projectId: url.searchParams.get('projectId') ?? undefined,
        projectPath: connectionProjectPath,
      };
      let resolved: GatewaySession | null = null;
      try {
        resolved = await options.sessionManager.getSession(context);
      } catch (error) {
        send({ type: 'error', message: (error as Error).message });
        ws.close(WS_CLOSE_NO_SESSION, 'session manager error');
        return;
      }
      if (!resolved) {
        send({ type: 'error', message: 'no session available for this connection' });
        ws.close(WS_CLOSE_NO_SESSION, 'no session');
        return;
      }

      session = resolved;
      const activeSession = resolved;

      unsubscribe = activeSession.subscribe((event) => {
        // Forward the raw UnifiedStreamEvent first (text_delta, tool_call_*,
        // normalized_error, screen_frame, ...), then raise an approval card
        // for tool calls that require user approval.
        send(event);
        if (event.type === 'tool_call_start' && event.requiresApproval) {
          const record: PendingApprovalRecord = {
            approvalId: `apr_${randomUUID()}`,
            sessionId: event.sessionId,
            callId: event.callId,
            toolName: event.toolName,
            args: event.args,
            createdAt: new Date().toISOString(),
          };
          pendingApprovals.register(record, (approved) => {
            activeSession.handleApproval(record.approvalId, approved);
          });
          send({ type: 'approval_request', ...record });
        }
      });

      send({ type: 'session_attached', sessionId: activeSession.sessionId });
    };

    const authenticate = async (token: unknown): Promise<boolean> => {
      if (typeof token !== 'string' || token.length === 0) return false;
      if (!(await verifyToken(token))) return false;
      authenticated = true;
      send({ type: 'auth_ok' });
      await attachSession();
      return true;
    };

    const handleClientMessage = async (raw: string): Promise<void> => {
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        send({ type: 'error', message: 'invalid JSON frame' });
        return;
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        send({ type: 'error', message: 'frame must be a JSON object' });
        return;
      }
      const frame = message as Record<string, unknown>;

      // Connection auth: the first message must carry the token when the
      // client did not authenticate via the `?token=` query parameter.
      if (!authenticated) {
        if (frame.type === 'auth') {
          const ok = await authenticate(frame.token);
          if (!ok) {
            send({ type: 'error', message: 'invalid or expired token' });
            ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
          }
          return;
        }
        send({ type: 'error', message: 'authentication required' });
        ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }

      switch (frame.type) {
        case 'approve':
        case 'reject': {
          const approvalId = typeof frame.approvalId === 'string' ? frame.approvalId : '';
          if (!approvalId) {
            send({ type: 'error', message: 'approvalId is required' });
            return;
          }
          const approved = frame.type === 'approve';
          // The registry owns resolution: it invokes the callback captured at
          // registration time, which forwards the decision to the session.
          if (!pendingApprovals.resolve(approvalId, approved)) {
            send({ type: 'error', message: `unknown pending approval '${approvalId}'` });
            return;
          }
          send({ type: 'approval_resolved', approvalId, approved });
          return;
        }
        case 'send_prompt': {
          if (!session) {
            send({ type: 'error', message: 'no session attached' });
            return;
          }
          try {
            await session.handleAction({ type: 'send_prompt', prompt: String(frame.prompt ?? '') });
          } catch (error) {
            send({ type: 'error', message: (error as Error).message });
          }
          return;
        }
        case 'switch_provider': {
          const providerId = typeof frame.providerId === 'string' ? frame.providerId : '';
          if (!providerId) {
            send({ type: 'error', message: 'providerId is required' });
            return;
          }
          if (connectionProjectPath) {
            try {
              await switchboard.switchProvider(connectionProjectPath, providerId);
            } catch (error) {
              send({ type: 'error', message: (error as Error).message });
              return;
            }
          }
          if (session) {
            try {
              await session.handleAction({ type: 'switch_provider', providerId });
            } catch (error) {
              send({ type: 'error', message: (error as Error).message });
              return;
            }
          }
          send({ type: 'provider_switched', providerId });
          return;
        }
        default:
          send({ type: 'error', message: `unsupported message type '${String(frame.type)}'` });
      }
    };

    ws.on('message', (data: unknown) => {
      void handleClientMessage(typeof data === 'string' ? data : String(data));
    });

    ws.on('close', () => {
      sockets.delete(ws);
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      try {
        session?.dispose?.();
      } catch {
        // dispose is best-effort
      }
      session = null;
    });

    ws.on('error', () => {
      // Socket-level errors are handled by the close event.
    });

    // Token via query parameter authenticates immediately on connect.
    const queryToken = url.searchParams.get('token');
    if (queryToken !== null) {
      void authenticate(queryToken).then((ok) => {
        if (!ok) {
          ws.close(WS_CLOSE_UNAUTHORIZED, 'unauthorized');
        }
      });
    }
  });

  async function close(): Promise<void> {
    for (const ws of sockets) {
      try {
        ws.close(1012, 'gateway shutting down');
      } catch {
        // already closed
      }
    }
    await new Promise<void>((resolve) => {
      wsServer.close(() => resolve());
    });
    await app.close();
  }

  return {
    app,
    switchboard,
    pendingApprovals,
    wsServer,
    setPin,
    getPin,
    close,
  };
}
