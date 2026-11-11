import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ALL_HARNESS_IDS,
  normalizeHarnessError,
  type AgentMode,
  type HarnessId,
  type UnifiedStreamEvent,
} from '@crosscode/shared';
import { appendNormalizedErrorLog } from '../workspace/agent-workspace.js';
import {
  BaseHarnessAdapter,
  HarnessEventBus,
  type SpawnFunction,
} from '../harnesses/base-adapter.js';
import {
  CrossCodeNativeHarness,
  type LLMClient,
} from '../harnesses/crosscode-native-harness.js';
import { OpenCodeAdapter } from '../harnesses/opencode-adapter.js';
import { ClaudeCodeAdapter } from '../harnesses/claude-code-adapter.js';
import { CodexAdapter } from '../harnesses/codex-adapter.js';
import { QoderAdapter } from '../harnesses/qoder-adapter.js';
import { ZCodeAdapter } from '../harnesses/zcode-adapter.js';
import { DeepSeekAdapter } from '../harnesses/deepseek-adapter.js';
import type {
  GatewayConnectionContext,
  GatewaySession,
  PendingApprovalRecord,
  SessionClientAction,
  SessionManager,
} from './http-ws-gateway.js';

/**
 * Structural contract matching `@crosscode/mcp-hub`'s `PendingApproval` so
 * `@crosscode/daemon` can bridge `ComputerUseWin32` approvals without a
 * circular package dependency.
 */
export interface ComputerUsePendingApprovalLike {
  approvalId: string;
  toolName: string;
  reason: string;
  originalAction: Record<string, unknown>;
  createdAt: string;
}

export interface ComputerUseApprovalDecisionLike {
  approvalId: string;
  approved: boolean;
  executed: boolean;
  result?: unknown;
  reason?: string;
}

export interface ComputerUseApprovalBridgeTarget {
  approve(approvalId: string): Promise<ComputerUseApprovalDecisionLike>;
  reject(approvalId: string, reason?: string): ComputerUseApprovalDecisionLike;
  listPendingApprovals(): ComputerUsePendingApprovalLike[];
  onApprovalRequest?(listener: (approval: ComputerUsePendingApprovalLike) => void): () => void;
}

export interface DaemonSessionManagerOptions {
  /** Fallback project path when the WebSocket connection does not specify `?projectPath=`. */
  defaultProjectPath?: string;
  /** Initial agent mode for `CrossCodeNativeHarness` (default `'build'`). */
  mode?: AgentMode;
  /** Injectable LLM client or factory for `CrossCodeNativeHarness`. */
  llmClient?: LLMClient | ((projectPath: string) => LLMClient);
  /**
   * Whether `CrossCodeNativeHarness` blocks on tools with `requiresApproval: true`
   * until a remote `approve`/`reject` frame arrives. Default `true`.
   */
  enforceApprovalGate?: boolean;
  /** Maximum ReAct steps per prompt for `CrossCodeNativeHarness`. */
  maxSteps?: number;
  /** Optional injectable process spawner for the 6 external CLI harness adapters. */
  spawn?: SpawnFunction;
  /** Optional override for the external harness adapter map. */
  externalAdapters?:
    | Partial<Record<HarnessId, BaseHarnessAdapter>>
    | ((projectPath: string) => Partial<Record<HarnessId, BaseHarnessAdapter>>);
  /** Optional `ComputerUseWin32` instance whose `CC-TOOL-4002` approvals are bridged to WebSocket sessions. */
  computerUse?: ComputerUseApprovalBridgeTarget;
  /** Runtime directory resolver for reading persisted `harness-state.json` / `provider-state.json`. */
  runtimeDir?: (projectPath: string) => string;
  /** Abort in-flight harness runs when the WebSocket client disconnects (default `false`). */
  abortOnDisconnect?: boolean;
}

export function createDefaultExternalAdapters(
  projectPath: string,
  spawn?: SpawnFunction,
): Partial<Record<HarnessId, BaseHarnessAdapter>> {
  return {
    opencode: new OpenCodeAdapter({ projectPath, spawn }),
    'claude-code': new ClaudeCodeAdapter({ projectPath, spawn }),
    codex: new CodexAdapter({ projectPath, spawn }),
    qoder: new QoderAdapter({ projectPath, spawn }),
    zcode: new ZCodeAdapter({ projectPath, spawn }),
    'deepseek-harness': new DeepSeekAdapter({ projectPath, spawn }),
  };
}

export class DaemonGatewaySession implements GatewaySession {
  public readonly sessionId: string;
  public readonly projectPath: string;
  public readonly nativeHarness: CrossCodeNativeHarness;
  public readonly externalAdapters: Partial<Record<HarnessId, BaseHarnessAdapter>>;

  private readonly bus = new HarnessEventBus();
  private readonly runtimeDirResolver: (projectPath: string) => string;
  private readonly abortOnDisconnect: boolean;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly computerUsePending = new Map<string, ComputerUsePendingApprovalLike>();

  private computerUse?: ComputerUseApprovalBridgeTarget;
  private activeHarnessId: HarnessId = 'crosscode-native';
  private activeProviderId?: string;
  private activeRunPromise: Promise<void> | null = null;

  constructor(options: {
    sessionId: string;
    projectPath: string;
    mode?: AgentMode;
    llmClient?: LLMClient;
    enforceApprovalGate?: boolean;
    maxSteps?: number;
    externalAdapters: Partial<Record<HarnessId, BaseHarnessAdapter>>;
    computerUse?: ComputerUseApprovalBridgeTarget;
    runtimeDir: (projectPath: string) => string;
    abortOnDisconnect?: boolean;
  }) {
    this.sessionId = options.sessionId;
    this.projectPath = path.resolve(options.projectPath);
    this.externalAdapters = options.externalAdapters;
    this.computerUse = options.computerUse;
    this.runtimeDirResolver = options.runtimeDir;
    this.abortOnDisconnect = options.abortOnDisconnect ?? false;

    this.nativeHarness = new CrossCodeNativeHarness({
      projectPath: this.projectPath,
      mode: options.mode ?? 'build',
      llmClient: options.llmClient,
      externalAdapters: this.externalAdapters,
      maxSteps: options.maxSteps,
      enforceApprovalGate: options.enforceApprovalGate ?? true,
    });

    this.unsubscribers.push(
      this.nativeHarness.subscribe((event) => {
        this.forwardEvent(event);
      }),
    );

    for (const adapter of Object.values(this.externalAdapters)) {
      if (!adapter) continue;
      this.unsubscribers.push(
        adapter.subscribe((event) => {
          // When crosscode-native is in orchestrate mode it already forwards
          // external adapter events; only forward directly when an external
          // adapter is the active top-level harness.
          if (this.activeHarnessId !== 'crosscode-native') {
            this.forwardEvent(event);
          }
        }),
      );
    }
  }

  private forwardEvent(event: UnifiedStreamEvent): void {
    this.bus.emit({
      ...event,
      sessionId: this.sessionId,
    });
  }

  setComputerUse(computerUse: ComputerUseApprovalBridgeTarget | undefined): void {
    this.computerUse = computerUse;
  }

  getActiveHarnessId(): HarnessId {
    return this.activeHarnessId;
  }

  setActiveHarnessId(harnessId: HarnessId): void {
    this.activeHarnessId = harnessId;
  }

  getActiveProviderId(): string | undefined {
    return this.activeProviderId;
  }

  /**
   * Surfaces a `ComputerUseWin32` `CC-TOOL-4002` pending approval onto this
   * session's stream so connected WebSocket clients receive both the
   * `normalized_error` event and the interactive `approval_request` card.
   */
  notifyComputerUseApproval(approval: ComputerUsePendingApprovalLike): void {
    this.computerUsePending.set(approval.approvalId, approval);
    this.bus.emit({
      type: 'tool_call_start',
      sessionId: this.sessionId,
      callId: approval.approvalId,
      toolName: approval.toolName,
      args: {
        ...approval.originalAction,
        approvalId: approval.approvalId,
        reason: approval.reason,
      },
      requiresApproval: true,
    });
    const error = normalizeHarnessError(
      this.activeHarnessId,
      `Tool approval required (${approval.toolName}): ${approval.reason}`,
      this.activeProviderId,
    );
    this.bus.emit({
      type: 'normalized_error',
      sessionId: this.sessionId,
      error,
    });
  }

  subscribe(listener: (event: UnifiedStreamEvent) => void): () => void {
    return this.bus.subscribe(listener);
  }

  async handleApproval(
    approvalId: string,
    approved: boolean,
    record?: PendingApprovalRecord,
  ): Promise<void> {
    const candidateCallIds = [record?.callId, approvalId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );

    for (const callId of candidateCallIds) {
      if (this.nativeHarness.resolveToolApproval(callId, approved)) {
        return;
      }
    }

    if (this.computerUse) {
      const pendingList = this.computerUse.listPendingApprovals();
      const targetId = candidateCallIds.find(
        (id) =>
          this.computerUsePending.has(id) ||
          pendingList.some((item) => item.approvalId === id),
      );
      if (targetId) {
        const pendingMeta =
          this.computerUsePending.get(targetId) ??
          pendingList.find((item) => item.approvalId === targetId);
        this.computerUsePending.delete(targetId);
        const toolName = record?.toolName ?? pendingMeta?.toolName ?? 'computer_use';
        if (approved) {
          const decision = await this.computerUse.approve(targetId);
          this.bus.emit({
            type: 'tool_call_result',
            sessionId: this.sessionId,
            callId: record?.callId ?? targetId,
            toolName,
            output: JSON.stringify(decision.result ?? decision),
            isError: false,
          });
        } else {
          const decision = this.computerUse.reject(targetId, 'permission denied by user');
          const output = `Tool execution rejected by user (CC-TOOL-4002: ${
            decision.reason ?? 'permission denied by user'
          }).`;
          this.bus.emit({
            type: 'tool_call_result',
            sessionId: this.sessionId,
            callId: record?.callId ?? targetId,
            toolName,
            output,
            isError: true,
          });
          const normalized = normalizeHarnessError(
            this.activeHarnessId,
            `tool ${toolName} failed: ${output}`,
            this.activeProviderId,
          );
          await appendNormalizedErrorLog(this.projectPath, normalized).catch(() => undefined);
        }
      }
    }
  }

  async handleAction(action: SessionClientAction): Promise<void> {
    if (action.type === 'switch_provider') {
      this.activeProviderId = action.providerId;
      return;
    }
    if (action.type === 'send_prompt') {
      const persistedHarness = await this.readPersistedHarnessId();
      if (persistedHarness) {
        this.activeHarnessId = persistedHarness;
      }
      if (this.activeHarnessId === 'crosscode-native') {
        if (this.nativeHarness.isRunning()) {
          throw new Error('CrossCodeNativeHarness session is already running');
        }
        const run = this.nativeHarness.start(action.prompt);
        this.activeRunPromise = run.finally(() => {
          if (this.activeRunPromise === run) {
            this.activeRunPromise = null;
          }
        });
        return;
      }
      const adapter = this.externalAdapters[this.activeHarnessId];
      if (!adapter) {
        throw new Error(`No adapter configured for harness '${this.activeHarnessId}'`);
      }
      if (adapter.isRunning()) {
        throw new Error(`Harness '${this.activeHarnessId}' is already running`);
      }
      const run = adapter.start(action.prompt);
      this.activeRunPromise = run.finally(() => {
        if (this.activeRunPromise === run) {
          this.activeRunPromise = null;
        }
      });
    }
  }

  async waitForIdle(): Promise<void> {
    if (this.activeRunPromise) {
      await this.activeRunPromise;
    }
  }

  private async readPersistedHarnessId(): Promise<HarnessId | null> {
    const statePath = path.join(this.runtimeDirResolver(this.projectPath), 'harness-state.json');
    try {
      const raw = await fs.readFile(statePath, 'utf8');
      const parsed = JSON.parse(raw) as { harnessId?: unknown };
      if (
        typeof parsed?.harnessId === 'string' &&
        ALL_HARNESS_IDS.includes(parsed.harnessId as HarnessId)
      ) {
        return parsed.harnessId as HarnessId;
      }
    } catch {
      // missing or unreadable state file -> keep current harness
    }
    return null;
  }

  dispose(): void {
    if (this.abortOnDisconnect) {
      this.nativeHarness.abort();
      for (const adapter of Object.values(this.externalAdapters)) {
        adapter?.stop();
      }
    }
    while (this.unsubscribers.length > 0) {
      const unsub = this.unsubscribers.pop();
      unsub?.();
    }
  }
}

export interface DaemonSessionManager extends SessionManager {
  getSession(context: GatewayConnectionContext): Promise<DaemonGatewaySession>;
  getActiveSessions(): DaemonGatewaySession[];
  /**
   * Attaches a `ComputerUseWin32` instance so any `CC-TOOL-4002` safety-gate
   * approval is automatically broadcast to active WebSocket sessions and
   * resolved when the operator sends `approve` or `reject`.
   */
  attachComputerUse(computerUse: ComputerUseApprovalBridgeTarget): () => void;
  /** Manually forwards a `ComputerUseWin32` pending approval to active session(s). */
  notifyComputerUseApproval(approval: ComputerUsePendingApprovalLike, sessionId?: string): void;
}

/**
 * Composition root wiring `CrossCodeNativeHarness` (with blocking tool
 * approval gate enabled by default), the 6 external CLI harness adapters, and
 * optional `ComputerUseWin32` desktop safety-gate approvals into `createGateway`.
 */
export function createDaemonSessionManager(
  options: DaemonSessionManagerOptions = {},
): DaemonSessionManager {
  const defaultProjectPath = options.defaultProjectPath ?? path.join(os.tmpdir(), 'crosscode-default-project');
  const runtimeDir =
    options.runtimeDir ??
    ((projectPath: string) => path.join(path.resolve(projectPath), '.agent', 'runtime'));

  const sessions = new Map<string, DaemonGatewaySession>();
  let currentComputerUse = options.computerUse;
  let detachComputerUseListener: (() => void) | null = null;

  const notifyComputerUseApproval = (
    approval: ComputerUsePendingApprovalLike,
    targetSessionId?: string,
  ): void => {
    if (targetSessionId) {
      const target = sessions.get(targetSessionId);
      target?.notifyComputerUseApproval(approval);
      return;
    }
    // Broadcast to the most recently attached active session (or all active sessions).
    const activeList = [...sessions.values()];
    const latest = activeList[activeList.length - 1];
    if (latest) {
      latest.notifyComputerUseApproval(approval);
    }
  };

  const attachComputerUse = (computerUse: ComputerUseApprovalBridgeTarget): (() => void) => {
    detachComputerUseListener?.();
    currentComputerUse = computerUse;
    for (const session of sessions.values()) {
      session.setComputerUse(computerUse);
    }
    if (typeof computerUse.onApprovalRequest === 'function') {
      detachComputerUseListener = computerUse.onApprovalRequest((approval) => {
        notifyComputerUseApproval(approval);
      });
    } else {
      detachComputerUseListener = null;
    }
    return () => {
      detachComputerUseListener?.();
      detachComputerUseListener = null;
    };
  };

  if (options.computerUse) {
    attachComputerUse(options.computerUse);
  }

  return {
    async getSession(context: GatewayConnectionContext): Promise<DaemonGatewaySession> {
      const projectPath = context.projectPath
        ? path.resolve(context.projectPath)
        : path.resolve(defaultProjectPath);
      await fs.mkdir(projectPath, { recursive: true });

      const llmClient =
        typeof options.llmClient === 'function'
          ? options.llmClient(projectPath)
          : options.llmClient;

      const externalAdapters =
        typeof options.externalAdapters === 'function'
          ? options.externalAdapters(projectPath)
          : options.externalAdapters ?? createDefaultExternalAdapters(projectPath, options.spawn);

      const session = new DaemonGatewaySession({
        sessionId: context.sessionId,
        projectPath,
        mode: options.mode,
        llmClient,
        enforceApprovalGate: options.enforceApprovalGate ?? true,
        maxSteps: options.maxSteps,
        externalAdapters,
        computerUse: currentComputerUse,
        runtimeDir,
        abortOnDisconnect: options.abortOnDisconnect,
      });

      const origDispose = session.dispose.bind(session);
      session.dispose = () => {
        sessions.delete(session.sessionId);
        origDispose();
      };

      sessions.set(session.sessionId, session);
      return session;
    },

    getActiveSessions(): DaemonGatewaySession[] {
      return [...sessions.values()];
    },

    attachComputerUse,
    notifyComputerUseApproval,
  };
}
