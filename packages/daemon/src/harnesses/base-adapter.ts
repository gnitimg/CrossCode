import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  normalizeHarnessError,
  type HarnessId,
  type NormalizedAgentError,
  type UnifiedStreamEvent,
} from '@crosscode/shared';
import {
  appendNormalizedErrorLog,
  ensureAgentWorkspace,
  readAgentWorkspaceContext,
  updateActiveTask,
  type AgentWorkspaceContext,
} from '../workspace/agent-workspace.js';

/**
 * Minimal structural description of a spawned child process. Real
 * `child_process.ChildProcess` instances satisfy it, and tests can build
 * lightweight EventEmitter-based fakes.
 */
export interface HarnessChildProcess extends EventEmitter {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  stdin: EventEmitter | null;
  exitCode: number | null;
  kill(signal?: string): boolean;
}

export type SpawnFunction = (
  command: string,
  args: readonly string[],
  options?: { cwd?: string },
) => HarnessChildProcess;

/**
 * Default spawn implementation.
 *
 * On Windows, harness CLIs (claude / opencode / codex / ...) are typically
 * installed as `.cmd`/`.bat` shims, and since the CVE-2024-27980 fix Node
 * refuses to spawn `.cmd`/`.bat` files unless an explicit shell is enabled.
 * Therefore the default function sets `shell: true` on win32. Caveat: in
 * shell mode cmd.exe joins the command line without automatic quoting, so
 * callers that need strict quoting/escaping of prompt text should inject
 * their own SpawnFunction (the injected interface is unchanged).
 */
export const defaultSpawnFunction: SpawnFunction = (command, args, options) => {
  const useShell = process.platform === 'win32';
  return nodeSpawn(command, args, {
    cwd: options?.cwd,
    windowsHide: true,
    shell: useShell,
  }) as unknown as HarnessChildProcess;
};

export interface HarnessAdapterOptions {
  /** Project root: used both as spawn cwd and as the `.agent` workspace root. */
  projectPath: string;
  /** Optional provider id attached to normalized errors. */
  providerId?: string;
  /** Injectable spawn function (defaults to child_process.spawn). */
  spawn?: SpawnFunction;
}

export interface ExternalCliOptions {
  model?: string;
  mcpConfigPath?: string;
  permissionMode?: string;
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007]*\u0007|\u001B[@-Z\\-_]/g;
const CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const TIMESTAMP_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?\s+/;
// Log-level chatter that carries no agent content. WARN/ERROR lines are
// intentionally NOT dropped: they are user-facing signals and are forwarded
// as text_delta content instead of being silently discarded.
const CLI_NOISE_LINE_PATTERN = /^(?:INFO|DEBUG|TRACE|VERBOSE)\b[\s:]/;
const SPINNER_LINE_PATTERN = /^[\u2800-\u28FF]/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, '');
}

/**
 * Cleans one interactive CLI output line: strips ANSI escape sequences and
 * control characters, drops low-value log-level chatter (INFO/DEBUG/...),
 * spinner frames and empty lines. WARN/ERROR lines are kept as content.
 * Returns null when the line carries no user-facing content.
 */
export function cleanCliNoiseLine(rawLine: string): string | null {
  let line = stripAnsi(rawLine);
  line = line.replace(CONTROL_CHARS_PATTERN, '');
  line = line.replace(TIMESTAMP_PREFIX_PATTERN, '');
  line = line.trim();
  if (line.length === 0) return null;
  if (CLI_NOISE_LINE_PATTERN.test(line)) return null;
  if (SPINNER_LINE_PATTERN.test(line)) return null;
  return line;
}

export function tryParseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const record = asRecord(item);
        if (record && record.type === 'text' && typeof record.text === 'string') return record.text;
        return '';
      })
      .filter((text) => text.length > 0)
      .join('\n');
  }
  return '';
}

export function genCallId(): string {
  return `call_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Small typed pub/sub wrapper for UnifiedStreamEvent streams. */
export class HarnessEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  subscribe(listener: (event: UnifiedStreamEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }

  emit(event: UnifiedStreamEvent): void {
    this.emitter.emit('event', event);
  }
}

/**
 * Base class for external harness adapters.
 *
 * Owns the session lifecycle (start/stop/abort), line-splitting of stdout,
 * stderr accumulation, error normalization, and `.agent` workspace
 * integration (active-task tracking + error log persistence). Subclasses
 * provide the CLI shape (command + args) and the stdout line parsing that
 * turns harness-specific output into UnifiedStreamEvents.
 */
export abstract class BaseHarnessAdapter {
  public readonly harnessId: HarnessId;

  protected readonly spawnFn: SpawnFunction;
  protected readonly projectPath: string;
  protected readonly providerId: string | undefined;
  protected workspaceContext: AgentWorkspaceContext | null = null;

  private readonly bus = new HarnessEventBus();
  private sessionIdValue: string | null = null;
  private currentProc: HarnessChildProcess | null = null;
  private running = false;
  private finished = true;
  private abortRequested = false;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private exitPromise: Promise<void> = Promise.resolve();
  private resolveExit: (() => void) | null = null;

  constructor(harnessId: HarnessId, options: HarnessAdapterOptions) {
    this.harnessId = harnessId;
    this.projectPath = path.resolve(options.projectPath);
    this.providerId = options.providerId;
    this.spawnFn = options.spawn ?? defaultSpawnFunction;
  }

  // ---------------------------------------------------------------------------
  // Public session API
  // ---------------------------------------------------------------------------

  subscribe(listener: (event: UnifiedStreamEvent) => void): () => void {
    return this.bus.subscribe(listener);
  }

  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  isRunning(): boolean {
    return this.running;
  }

  getWorkspaceContext(): AgentWorkspaceContext | null {
    return this.workspaceContext;
  }

  waitForExit(): Promise<void> {
    return this.exitPromise;
  }

  /**
   * Starts a session: prepares the `.agent` workspace, relays any in-progress
   * task context into the prompt, spawns the harness CLI and streams its
   * output as UnifiedStreamEvents. Resolves when the process exits and the
   * workspace has been updated.
   */
  async start(prompt: string): Promise<void> {
    if (this.running) {
      throw new Error(`Harness '${this.harnessId}' session is already running`);
    }
    this.running = true;
    this.finished = false;
    this.abortRequested = false;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.sessionIdValue = randomUUID();
    this.onSessionStart();

    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    let proc: HarnessChildProcess;
    try {
      await ensureAgentWorkspace(this.projectPath, { activeHarness: this.harnessId });
      this.workspaceContext = await readAgentWorkspaceContext(this.projectPath);
      const finalPrompt = this.buildRelayPrompt(prompt);
      await this.markTaskStarted(prompt);

      proc = this.spawnFn(this.getCommand(), this.buildCliArgs(finalPrompt), {
        cwd: this.projectPath,
      });
    } catch (err) {
      // Startup failures (workspace prep errors, synchronous spawn errors)
      // must not leave the adapter stuck in a running state: reset the
      // session flags and route the failure through the standard
      // error-normalization path instead of throwing past the caller.
      await this.handleStartupFailure(err);
      return;
    }
    this.currentProc = proc;

    proc.stdout?.on('data', (chunk: unknown) => this.ingestStdout(chunk));
    proc.stderr?.on('data', (chunk: unknown) => {
      this.stderrBuffer += typeof chunk === 'string' ? chunk : String(chunk);
    });
    proc.on('exit', (code: number | null) => {
      void this.handleExit(code);
    });
    proc.on('error', (err: Error) => {
      void this.handleSpawnError(err);
    });

    await this.exitPromise;
  }

  /** Kills the underlying process if one is running (no error event). */
  stop(): void {
    const proc = this.currentProc;
    if (!proc) return;
    try {
      proc.kill('SIGTERM');
    } catch {
      // already dead
    }
  }

  /** Aborts the session: kills the process and records a normalized error. */
  abort(): void {
    this.abortRequested = true;
    this.stop();
  }

  // ---------------------------------------------------------------------------
  // Subclass contract
  // ---------------------------------------------------------------------------

  protected abstract getCommand(): string;

  public abstract buildCliArgs(prompt: string): string[];

  /** Parses one cleaned stdout line into zero or more UnifiedStreamEvents. */
  protected abstract handleStdoutLine(line: string): void;

  /** Hook for subclasses to reset per-session state. */
  protected onSessionStart(): void {
    // default: nothing
  }

  // ---------------------------------------------------------------------------
  // Emit helpers (available to subclasses and the native harness)
  // ---------------------------------------------------------------------------

  protected emitEvent(event: UnifiedStreamEvent): void {
    this.bus.emit(event);
  }

  protected getBus(): HarnessEventBus {
    return this.bus;
  }

  protected emitTextDelta(text: string): void {
    if (!text) return;
    this.emitEvent({
      type: 'text_delta',
      sessionId: this.requireSessionId(),
      harness: this.harnessId,
      text,
    });
  }

  protected emitThinkingDelta(text: string): void {
    if (!text) return;
    this.emitEvent({
      type: 'thinking_delta',
      sessionId: this.requireSessionId(),
      harness: this.harnessId,
      text,
    });
  }

  protected emitToolCallStart(
    callId: string,
    toolName: string,
    args: Record<string, unknown> = {},
    requiresApproval = false,
  ): void {
    this.emitEvent({
      type: 'tool_call_start',
      sessionId: this.requireSessionId(),
      callId,
      toolName,
      args,
      requiresApproval,
    });
  }

  protected emitToolCallResult(
    callId: string,
    toolName: string,
    output: string,
    isError = false,
  ): void {
    this.emitEvent({
      type: 'tool_call_result',
      sessionId: this.requireSessionId(),
      callId,
      toolName,
      output,
      isError,
    });
  }

  protected emitNormalizedError(error: NormalizedAgentError): void {
    this.emitEvent({
      type: 'normalized_error',
      sessionId: this.requireSessionId(),
      error,
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private requireSessionId(): string {
    if (!this.sessionIdValue) {
      throw new Error(`Harness '${this.harnessId}' has no active session`);
    }
    return this.sessionIdValue;
  }

  private ingestStdout(chunk: unknown): void {
    this.stdoutBuffer += typeof chunk === 'string' ? chunk : String(chunk);
    let newlineIndex = this.stdoutBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const rawLine = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.trim().length > 0) {
        this.handleStdoutLine(line);
      }
      newlineIndex = this.stdoutBuffer.indexOf('\n');
    }
  }

  /**
   * Appends the persisted in-progress task context (from `.agent/context/
   * active-task.json`) to the prompt so a harness can pick up work left
   * behind by another harness.
   */
  private buildRelayPrompt(prompt: string): string {
    const task = this.workspaceContext?.activeTask;
    if (!task || task.status !== 'in_progress') return prompt;
    if (task.completedSteps.length === 0 && task.nextSteps.length === 0) return prompt;
    const relay = [
      '',
      '[CrossCode Context Relay] This project has an in-progress task recorded in the shared .agent workspace.',
      `Task: ${task.taskId} — ${task.title}`,
      `Last harness: ${task.currentHarness}`,
      `Completed steps: ${task.completedSteps.length > 0 ? task.completedSteps.join('; ') : '(none recorded)'}`,
      `Remaining steps: ${task.nextSteps.length > 0 ? task.nextSteps.join('; ') : '(none recorded)'}`,
      'Continue from the remaining steps and keep the same task id.',
    ];
    return `${prompt}\n${relay.join('\n')}`;
  }

  private async markTaskStarted(prompt: string): Promise<void> {
    const existing = this.workspaceContext?.activeTask;
    const freshTask = !existing || existing.status === 'idle' || existing.taskId === 'TASK-INIT';
    try {
      await updateActiveTask(this.projectPath, {
        ...(freshTask
          ? { taskId: `TASK-${randomUUID().replace(/-/g, '').slice(0, 8)}`, title: prompt.slice(0, 120) }
          : {}),
        status: 'in_progress',
        currentHarness: this.harnessId,
        currentStep: `Executing via ${this.harnessId} CLI`,
      });
    } catch {
      // workspace persistence is best-effort
    }
  }

  private async handleExit(code: number | null): Promise<void> {
    if (this.finished) return;
    this.finished = true;

    // Flush a trailing line without newline as final output.
    const remainder = this.stdoutBuffer.trim();
    this.stdoutBuffer = '';
    if (remainder.length > 0) {
      this.handleStdoutLine(remainder);
    }

    const stderrText = this.stderrBuffer.trim();
    this.stderrBuffer = '';

    let error: NormalizedAgentError | null = null;
    if (this.abortRequested) {
      error = normalizeHarnessError(
        this.harnessId,
        'Agent session aborted by user request',
        this.providerId,
      );
    } else if (code !== null && code !== 0) {
      error = normalizeHarnessError(
        this.harnessId,
        stderrText.length > 0 ? stderrText : `process exited with code ${code}`,
        this.providerId,
      );
    }

    if (error) {
      this.emitNormalizedError(error);
      await this.persistError(error);
    } else {
      await this.markTaskCompleted();
    }

    this.currentProc = null;
    this.running = false;
    this.resolveExit?.();
    this.resolveExit = null;
  }

  /**
   * Shared failure path for startup errors: emits a normalized_error event,
   * persists it to the `.agent` workspace, and resets session state so the
   * adapter can start a new session afterwards.
   */
  private async handleStartupFailure(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const error = normalizeHarnessError(this.harnessId, message, this.providerId);
    this.emitNormalizedError(error);
    await this.persistError(error);
    this.currentProc = null;
    this.running = false;
    this.finished = true;
    this.resolveExit?.();
    this.resolveExit = null;
  }

  private async handleSpawnError(err: Error): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const error = normalizeHarnessError(
      this.harnessId,
      `Failed to spawn '${this.getCommand()}': ${err.message}`,
      this.providerId,
    );
    this.emitNormalizedError(error);
    await this.persistError(error);
    this.currentProc = null;
    this.running = false;
    this.resolveExit?.();
    this.resolveExit = null;
  }

  private async persistError(error: NormalizedAgentError): Promise<void> {
    try {
      await appendNormalizedErrorLog(this.projectPath, error);
      await updateActiveTask(this.projectPath, {
        status: 'in_progress',
        currentStep: `Interrupted by ${error.code} (${error.recoveryAction})`,
      });
    } catch {
      // workspace persistence is best-effort
    }
  }

  private async markTaskCompleted(): Promise<void> {
    try {
      await updateActiveTask(this.projectPath, {
        status: 'completed',
        currentStep: `Completed via ${this.harnessId}`,
      });
    } catch {
      // workspace persistence is best-effort
    }
  }
}
