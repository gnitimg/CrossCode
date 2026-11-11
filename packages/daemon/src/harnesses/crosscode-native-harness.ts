import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  normalizeHarnessError,
  type ActiveTaskState,
  type AgentMode,
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
import {
  HarnessEventBus,
  asRecord,
  genCallId,
  readString,
  BaseHarnessAdapter,
} from './base-adapter.js';

// ---------------------------------------------------------------------------
// LLM client contracts
// ---------------------------------------------------------------------------

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** For role 'tool': the id of the tool call this message answers. */
  toolCallId?: string;
  /** For role 'tool': the tool that produced this result. */
  toolName?: string;
  /** For role 'assistant': tool calls requested by the model. */
  toolCalls?: LLMToolCall[];
}

export interface LLMToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMResponse {
  text?: string;
  thinking?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMClient {
  complete(messages: LLMMessage[], tools: LLMToolDefinition[]): Promise<LLMResponse>;
}

/** Minimal structural HTTP result so tests can inject fetch fakes without DOM types. */
export interface LLMHttpResult {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<LLMHttpResult>;

export interface OpenAICompatibleClientOptions {
  baseURL: string;
  apiKey?: string;
  model: string;
  fetchFn?: FetchLike;
  temperature?: number;
}

interface OpenAIChatMessage {
  role?: string;
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIChatPayload {
  choices?: Array<{ message?: OpenAIChatMessage }>;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * Built-in OpenAI-compatible chat-completions client used by the native
 * harness. baseURL / apiKey / model are injectable, and the HTTP function
 * itself can be replaced for offline testing.
 */
export class OpenAICompatibleClient implements LLMClient {
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly model: string;
  private readonly fetchFn: FetchLike;
  private readonly temperature?: number;

  constructor(options: OpenAICompatibleClientOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.temperature = options.temperature;
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  }

  async complete(messages: LLMMessage[], tools: LLMToolDefinition[]): Promise<LLMResponse> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.toOpenAIMessages(messages),
      ...(tools.length > 0 ? { tools: this.toOpenAITools(tools) } : {}),
      ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
    };

    const response = await this.fetchFn(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LLM request failed with HTTP ${response.status}: ${detail.slice(0, 500)}`);
    }

    const payload = (await response.json()) as OpenAIChatPayload;
    const message: OpenAIChatMessage = payload.choices?.[0]?.message ?? {};
    const toolCalls: LLMToolCall[] = (message.tool_calls ?? []).map((call) => ({
      id: call.id ?? genCallId(),
      name: call.function?.name ?? 'unknown_tool',
      arguments: parseJsonObject(call.function?.arguments ?? '{}'),
    }));

    return {
      text: typeof message.content === 'string' ? message.content : '',
      thinking: typeof message.reasoning_content === 'string' ? message.reasoning_content : undefined,
      toolCalls,
    };
  }

  private toOpenAIMessages(messages: LLMMessage[]): Array<Record<string, unknown>> {
    return messages.map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: message.toolCallId ?? message.toolName ?? 'unknown_call',
          content: message.content,
        };
      }
      if (message.role === 'assistant') {
        return {
          role: 'assistant',
          content: message.content.length > 0 ? message.content : null,
          ...(message.toolCalls && message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments ?? {}),
                  },
                })),
              }
            : {}),
        };
      }
      return { role: message.role, content: message.content };
    });
  }

  private toOpenAITools(tools: LLMToolDefinition[]): Array<Record<string, unknown>> {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
}

// ---------------------------------------------------------------------------
// Native harness tool registry
// ---------------------------------------------------------------------------

export type NativeToolName =
  | 'read_file'
  | 'write_file'
  | 'edit_file'
  | 'glob_search'
  | 'grep_search'
  | 'run_shell'
  | 'git_status_diff'
  | 'dispatch_to_external_harness';

interface ToolExecutionResult {
  output: string;
  isError: boolean;
}

interface NativeTool {
  name: NativeToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  modes: AgentMode[];
  /** When true, tool_call_start events ask the orchestrator/UI for approval. */
  requiresApproval?: boolean;
  executor: (args: Record<string, unknown>) => Promise<ToolExecutionResult>;
}

const IGNORED_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', '.agent', 'target']);
const MAX_TOOL_OUTPUT_CHARS = 8000;
const MAX_GREP_HITS = 80;

function requireStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required string argument '${key}'`);
  }
  return value;
}

function toPosix(relPath: string): string {
  return relPath.replace(/\\/g, '/');
}

/**
 * Mini glob matcher: the globstar (double star) matches zero or more whole
 * path segments, so "src" + globstar + "*.ts" also matches "src/a.ts";
 * a single star stays within one segment, "?" matches one non-separator
 * character.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let source = escaped;
  // Placeholder substitutions happen first so the inserted quantifiers are
  // not mangled by the single-star replacement below.
  // \u0000 expands to "(?:[\s\S]*/)?" (zero or more segments, each with its
  // own trailing slash — the slash before the placeholder stays literal),
  // \u0001 expands to "[\s\S]*".
  source = source.replace(/\/\*\*\//g, '/\u0000');
  source = source.replace(/^\*\*\//, '\u0000');
  source = source.replace(/\/\*\*$/, '/\u0001');
  source = source.replace(/\*\*/g, '\u0001');
  source = source.replace(/\*/g, '[^/]*');
  source = source.replace(/\?/g, '[^/]');
  source = source.replace(/\u0000/g, '(?:[\\s\\S]*/)?');
  source = source.replace(/\u0001/g, '[\\s\\S]*');
  return new RegExp(`^${source}$`);
}

function truncateOutput(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n... (output truncated)`;
}

/**
 * Minimal blacklist of well-known catastrophic shell commands for run_shell.
 *
 * SANDBOX LIMITATIONS (read before trusting this): run_shell is NOT a hard
 * sandbox. Commands execute with the daemon's OS privileges in the project
 * cwd; neither this blacklist nor the cwd prevents arbitrary commands from
 * touching files outside the project root (e.g. via absolute paths or
 * `cd`). The guard exists to reject obvious foot-guns, and run_shell
 * `tool_call_start` events always carry `requiresApproval: true` so
 * orchestrators/UIs can gate every shell execution behind explicit human
 * approval. For hard isolation, run the daemon inside a container or OS
 * sandbox instead of relying on this layer.
 */
const BLOCKED_SHELL_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  {
    // rm -rf /, rm -fr /, rm --recursive --force /, rm -r -f ~, rm "/" ...
    pattern: /\brm\b(?:\s+-{1,2}[\w-]+)*\s+["']?[/~]\s*(?:$|["'])/,
    label: 'recursive force-removal of the filesystem root or home directory (rm -rf /)',
  },
  {
    pattern: /\bformat\s+[a-z]:/i,
    label: 'formatting a disk drive (format <drive>)',
  },
  {
    pattern: /\bdel\b(?=[^&|]*\/s\b)(?=[^&|]*\/q\b)/i,
    label: 'silent recursive deletion (del /s /q)',
  },
  {
    pattern: /\brd(?:ir)?\b(?=[^&|]*\/s\b)(?=[^&|]*\/q\b)/i,
    label: 'silent recursive directory removal (rd /s /q)',
  },
  {
    pattern: /\bmkfs/i,
    label: 'creating a new filesystem (mkfs)',
  },
  {
    pattern: /\bdd\b[^&|]*\bof=\/dev\//i,
    label: 'raw write to a device node (dd of=/dev/...)',
  },
  {
    pattern: /\bremove-item\b(?=[^&|]*-recurse)(?=[^&|]*-force)/i,
    label: 'PowerShell recursive force removal (Remove-Item -Recurse -Force)',
  },
];

function matchBlockedShellCommand(command: string): string | null {
  for (const entry of BLOCKED_SHELL_PATTERNS) {
    if (entry.pattern.test(command)) return entry.label;
  }
  return null;
}

/**
 * Kills a spawned process and, on Windows, its whole process tree.
 * `child.kill()` only signals the direct child; when `shell: true` is used
 * the real command often runs as a grandchild that would otherwise survive,
 * so win32 falls back to `taskkill /T /F /PID`.
 */
function killProcessTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    nodeSpawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], {
      windowsHide: true,
    });
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // already dead
  }
}

export interface PendingToolApproval {
  callId: string;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: string;
}

export interface CrossCodeNativeHarnessOptions {
  projectPath: string;
  mode?: AgentMode;
  llmClient?: LLMClient;
  /** External harness adapters available to dispatch_to_external_harness (orchestrate mode). */
  externalAdapters?: Partial<Record<HarnessId, BaseHarnessAdapter>>;
  maxSteps?: number;
  providerId?: string;
  /**
   * When true, any tool with `requiresApproval: true` (such as `run_shell`)
   * pauses after emitting `tool_call_start` until `resolveToolApproval(callId, approved)`
   * or `abort()` is called.
   */
  enforceApprovalGate?: boolean;
}

/**
 * CrossCode's first-class built-in agent kernel.
 *
 * Runs a ReAct loop against an injectable LLMClient, executes a built-in
 * tool registry against the real project, persists progress to the `.agent`
 * workspace, and (in orchestrate mode) can dispatch subtasks to external
 * harness adapters while forwarding their events.
 */
export class CrossCodeNativeHarness {
  public readonly harnessId: HarnessId = 'crosscode-native';

  private readonly projectPath: string;
  private readonly llm: LLMClient;
  private readonly externalAdapters: Partial<Record<HarnessId, BaseHarnessAdapter>>;
  private readonly maxSteps: number;
  private readonly providerId: string | undefined;
  private readonly enforceApprovalGate: boolean;
  private readonly tools: Map<string, NativeTool>;
  private readonly bus = new HarnessEventBus();
  private readonly pendingToolApprovals = new Map<
    string,
    { record: PendingToolApproval; resolve: (approved: boolean) => void }
  >();

  private mode: AgentMode;
  private sessionIdValue: string | null = null;
  private running = false;
  private abortRequested = false;

  constructor(options: CrossCodeNativeHarnessOptions) {
    this.projectPath = path.resolve(options.projectPath);
    this.mode = options.mode ?? 'build';
    this.externalAdapters = options.externalAdapters ?? {};
    this.maxSteps = options.maxSteps ?? 12;
    this.providerId = options.providerId;
    this.enforceApprovalGate = options.enforceApprovalGate ?? false;
    this.llm =
      options.llmClient ??
      new OpenAICompatibleClient({
        baseURL: process.env.CROSSCODE_LLM_BASE_URL ?? 'https://api.openai.com/v1',
        apiKey: process.env.CROSSCODE_LLM_API_KEY ?? process.env.OPENAI_API_KEY,
        model: process.env.CROSSCODE_LLM_MODEL ?? 'gpt-4o-mini',
      });
    this.tools = this.buildToolRegistry();
  }

  // ---------------------------------------------------------------------------
  // Public API
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

  getMode(): AgentMode {
    return this.mode;
  }

  setMode(mode: AgentMode): void {
    this.mode = mode;
  }

  getToolNames(): string[] {
    return this.toolsForMode().map((tool) => tool.name);
  }

  getToolDefinitions(): LLMToolDefinition[] {
    return this.toolsForMode().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /**
   * Lists tool calls currently blocked waiting for human approval.
   */
  listPendingToolApprovals(): PendingToolApproval[] {
    return [...this.pendingToolApprovals.values()].map((entry) => ({
      ...entry.record,
      args: { ...entry.record.args },
    }));
  }

  /**
   * Resolves a pending tool call approval by its `callId`. Returns `true`
   * when a matching pending tool call was found and unblocked.
   */
  resolveToolApproval(callId: string, approved: boolean): boolean {
    const entry = this.pendingToolApprovals.get(callId);
    if (!entry) return false;
    this.pendingToolApprovals.delete(callId);
    entry.resolve(approved);
    return true;
  }

  private waitForToolApproval(
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.abortRequested) {
      return Promise.resolve(false);
    }
    const record: PendingToolApproval = {
      callId,
      sessionId: this.requireSessionId(),
      toolName,
      args: { ...args },
      createdAt: new Date().toISOString(),
    };
    return new Promise<boolean>((resolve) => {
      this.pendingToolApprovals.set(callId, { record, resolve });
    });
  }

  /**
   * Runs one full ReAct session for the given prompt and resolves when the
   * task finishes (final text), pauses (step limit), or fails (normalized
   * error event + persisted log).
   */
  async start(prompt: string): Promise<void> {
    if (this.running) {
      throw new Error('CrossCodeNativeHarness session is already running');
    }
    this.running = true;
    this.abortRequested = false;
    this.sessionIdValue = randomUUID();

    try {
      await ensureAgentWorkspace(this.projectPath, { activeHarness: 'crosscode-native' });
      const workspace = await readAgentWorkspaceContext(this.projectPath);
      const completedSteps = [...workspace.activeTask.completedSteps];

      const freshTask =
        workspace.activeTask.status === 'idle' || workspace.activeTask.taskId === 'TASK-INIT';
      await updateActiveTask(this.projectPath, {
        ...(freshTask
          ? { taskId: `TASK-${randomUUID().replace(/-/g, '').slice(0, 8)}`, title: prompt.slice(0, 120) }
          : {}),
        status: 'in_progress',
        currentHarness: 'crosscode-native',
        currentStep: 'Starting native ReAct loop',
        nextSteps: [],
      });

      const messages: LLMMessage[] = [
        { role: 'system', content: this.buildSystemPrompt(workspace) },
        { role: 'user', content: prompt },
      ];
      const toolDefs = this.getToolDefinitions();

      for (let step = 1; step <= this.maxSteps; step++) {
        if (this.abortRequested) {
          this.emitTextDelta('[crosscode-native] Task aborted by user request.');
          await updateActiveTask(this.projectPath, {
            status: 'in_progress',
            currentStep: 'Aborted by user',
            completedSteps,
          });
          return;
        }

        let response: LLMResponse;
        try {
          response = await this.llm.complete(messages, toolDefs);
        } catch (err) {
          await this.handleFatalError(err);
          return;
        }

        if (response.thinking) this.emitThinkingDelta(response.thinking);
        if (response.text) this.emitTextDelta(response.text);
        const toolCalls = response.toolCalls ?? [];
        messages.push({ role: 'assistant', content: response.text ?? '', toolCalls });

        if (toolCalls.length === 0) {
          completedSteps.push('Produced final answer');
          await updateActiveTask(this.projectPath, {
            status: 'completed',
            currentStep: 'Completed by crosscode-native',
            completedSteps,
          });
          return;
        }

        for (const call of toolCalls) {
          const knownTool = this.tools.get(call.name);
          const callArgs = asRecord(call.arguments) ?? {};
          const requiresApproval = knownTool?.requiresApproval === true;
          this.emitToolCallStart(
            call.id,
            call.name,
            callArgs,
            requiresApproval,
          );
          let result: ToolExecutionResult;
          if (requiresApproval && this.enforceApprovalGate) {
            await updateActiveTask(this.projectPath, {
              currentStep: `Awaiting approval for ${call.name}`,
              completedSteps,
            });
            const approved = await this.waitForToolApproval(call.id, call.name, callArgs);
            if (this.abortRequested) {
              this.emitTextDelta('[crosscode-native] Task aborted by user request.');
              await updateActiveTask(this.projectPath, {
                status: 'in_progress',
                currentStep: 'Aborted by user',
                completedSteps,
              });
              return;
            }
            if (!approved) {
              result = {
                output: 'Tool execution rejected by user (CC-TOOL-4002: permission denied by user).',
                isError: true,
              };
            } else {
              result = await this.executeToolCall(call);
            }
          } else {
            result = await this.executeToolCall(call);
          }
          this.emitToolCallResult(call.id, call.name, truncateOutput(result.output), result.isError);
          if (result.isError) {
            await this.logToolFailure(call.name, result.output);
          }
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            toolName: call.name,
            content: result.output,
          });
          completedSteps.push(`Ran ${call.name}`);
          await updateActiveTask(this.projectPath, {
            currentStep: `Executed ${call.name}`,
            completedSteps,
          });
        }
      }

      // Step limit reached without a final answer: pause for a later resume.
      // Do not fabricate placeholder steps here — an honest empty nextSteps
      // list keeps the cross-harness relay context clean.
      this.emitTextDelta(`[crosscode-native] Step limit (${this.maxSteps}) reached; task paused.`);
      await updateActiveTask(this.projectPath, {
        status: 'in_progress',
        currentStep: 'Paused: step limit reached',
        completedSteps,
        nextSteps: [],
      });
    } finally {
      for (const [callId, entry] of this.pendingToolApprovals) {
        this.pendingToolApprovals.delete(callId);
        entry.resolve(false);
      }
      this.running = false;
    }
  }

  /** Requests cancellation; takes effect between ReAct iterations or while awaiting approval. */
  abort(): void {
    this.abortRequested = true;
    for (const [callId, entry] of this.pendingToolApprovals) {
      this.pendingToolApprovals.delete(callId);
      entry.resolve(false);
    }
  }

  stop(): void {
    this.abort();
  }

  // ---------------------------------------------------------------------------
  // ReAct helpers
  // ---------------------------------------------------------------------------

  private toolsForMode(): NativeTool[] {
    return [...this.tools.values()].filter((tool) => tool.modes.includes(this.mode));
  }

  private buildSystemPrompt(workspace: AgentWorkspaceContext): string {
    const modeInstructions: Record<AgentMode, string> = {
      plan:
        'You are in PLAN mode: analyze the project with read-only tools and finish with a concrete step-by-step plan as your final text. Do not modify anything.',
      build:
        'You are in BUILD mode: use the provided tools to implement the requested change, then finish with a short summary as your final text.',
      orchestrate:
        'You are in ORCHESTRATE mode: delegate self-contained subtasks to external harnesses with the dispatch_to_external_harness tool, observe their results, then finish with a short summary as your final text.',
    };
    const lines = [
      'You are CrossCode Native, the built-in first-class agent kernel of the CrossCode daemon.',
      modeInstructions[this.mode],
      'Work in a ReAct loop: call tools when needed, observe their results, and reply with final text when the task is done.',
    ];
    if (workspace.projectMemory) {
      lines.push('', '## Shared project memory (.agent)', workspace.projectMemory.slice(0, 2000));
    }
    const task = workspace.activeTask;
    if (task.status === 'in_progress' && (task.completedSteps.length > 0 || task.nextSteps.length > 0)) {
      lines.push(
        '',
        '## In-progress task context',
        `Task: ${task.taskId} — ${task.title}`,
        `Completed steps: ${task.completedSteps.join('; ') || '(none)'}`,
        `Remaining steps: ${task.nextSteps.join('; ') || '(none)'}`,
      );
    }
    return lines.join('\n');
  }

  private async executeToolCall(call: { id: string; name: string; arguments?: Record<string, unknown> }): Promise<ToolExecutionResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        output: `Unknown tool '${call.name}'. Available tools: ${this.getToolNames().join(', ')}`,
        isError: true,
      };
    }
    if (!tool.modes.includes(this.mode)) {
      return {
        output: `Tool '${call.name}' is not available in ${this.mode} mode.`,
        isError: true,
      };
    }
    try {
      return await tool.executor(asRecord(call.arguments) ?? {});
    } catch (err) {
      return {
        output: err instanceof Error ? err.message : String(err),
        isError: true,
      };
    }
  }

  private async handleFatalError(err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const error = normalizeHarnessError('crosscode-native', message, this.providerId);
    this.emitNormalizedError(error);
    try {
      await appendNormalizedErrorLog(this.projectPath, error);
      await updateActiveTask(this.projectPath, {
        status: 'in_progress',
        currentStep: `Interrupted by ${error.code}`,
      });
    } catch {
      // workspace persistence is best-effort
    }
  }

  private async logToolFailure(toolName: string, output: string): Promise<void> {
    const error = normalizeHarnessError(
      'crosscode-native',
      `tool ${toolName} failed: ${output}`,
      this.providerId,
    );
    try {
      await appendNormalizedErrorLog(this.projectPath, error);
    } catch {
      // workspace persistence is best-effort
    }
  }

  // ---------------------------------------------------------------------------
  // Event emit helpers
  // ---------------------------------------------------------------------------

  private emitEvent(event: UnifiedStreamEvent): void {
    this.bus.emit(event);
  }

  private requireSessionId(): string {
    if (!this.sessionIdValue) {
      throw new Error('CrossCodeNativeHarness has no active session');
    }
    return this.sessionIdValue;
  }

  private emitTextDelta(text: string): void {
    if (!text) return;
    this.emitEvent({
      type: 'text_delta',
      sessionId: this.requireSessionId(),
      harness: this.harnessId,
      text,
    });
  }

  private emitThinkingDelta(text: string): void {
    if (!text) return;
    this.emitEvent({
      type: 'thinking_delta',
      sessionId: this.requireSessionId(),
      harness: this.harnessId,
      text,
    });
  }

  private emitToolCallStart(
    callId: string,
    toolName: string,
    args: Record<string, unknown>,
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

  private emitToolCallResult(
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

  private emitNormalizedError(error: NormalizedAgentError): void {
    this.emitEvent({
      type: 'normalized_error',
      sessionId: this.requireSessionId(),
      error,
    });
  }

  // ---------------------------------------------------------------------------
  // Built-in tool registry
  // ---------------------------------------------------------------------------

  private buildToolRegistry(): Map<string, NativeTool> {
    const readOnlyModes: AgentMode[] = ['plan', 'build', 'orchestrate'];
    const writeModes: AgentMode[] = ['build', 'orchestrate'];

    const tools: NativeTool[] = [
      {
        name: 'read_file',
        description: 'Read a UTF-8 text file relative to the project root.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string', description: 'Relative file path' } },
          required: ['path'],
        },
        modes: readOnlyModes,
        executor: (args) => this.execReadFile(args),
      },
      {
        name: 'write_file',
        description: 'Create or overwrite a UTF-8 text file relative to the project root.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Relative file path' },
            content: { type: 'string', description: 'Full file content' },
          },
          required: ['path', 'content'],
        },
        modes: writeModes,
        executor: (args) => this.execWriteFile(args),
      },
      {
        name: 'edit_file',
        description: 'Replace an exact substring inside an existing file.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            oldString: { type: 'string' },
            newString: { type: 'string' },
            replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false)' },
          },
          required: ['path', 'oldString', 'newString'],
        },
        modes: writeModes,
        executor: (args) => this.execEditFile(args),
      },
      {
        name: 'glob_search',
        description:
          'List project files matching a glob pattern such as "src/**/*.ts" (supports **, *, ?).',
        inputSchema: {
          type: 'object',
          properties: { pattern: { type: 'string' } },
          required: ['pattern'],
        },
        modes: readOnlyModes,
        executor: (args) => this.execGlobSearch(args),
      },
      {
        name: 'grep_search',
        description:
          'Search file contents for a query (case-insensitive substring, or regex with useRegex=true), optionally filtered by a glob.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            glob: { type: 'string', description: 'Optional file glob filter, e.g. "**/*.ts"' },
            useRegex: { type: 'boolean' },
          },
          required: ['query'],
        },
        modes: readOnlyModes,
        executor: (args) => this.execGrepSearch(args),
      },
      {
        name: 'run_shell',
        description:
          'Run a shell command in the project root with a timeout. Returns exit code, stdout and stderr. Gated by the shell guard and always requires approval.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            timeoutMs: { type: 'number', description: 'Timeout in ms (1000-120000, default 30000)' },
          },
          required: ['command'],
        },
        modes: writeModes,
        requiresApproval: true,
        executor: (args) => this.execRunShell(args),
      },
      {
        name: 'git_status_diff',
        description: 'Show `git status --porcelain` and `git diff --stat` for the project.',
        inputSchema: { type: 'object', properties: {} },
        modes: readOnlyModes,
        executor: () => this.execGitStatusDiff(),
      },
      {
        name: 'dispatch_to_external_harness',
        description:
          'Dispatch a self-contained subtask to an external harness adapter (e.g. {"harness":"opencode","task":"..."}) and return its text output.',
        inputSchema: {
          type: 'object',
          properties: {
            harness: { type: 'string', description: 'Target harness id' },
            task: { type: 'string', description: 'Self-contained subtask prompt' },
          },
          required: ['harness', 'task'],
        },
        modes: ['orchestrate'],
        executor: (args) => this.execDispatchToExternalHarness(args),
      },
    ];

    return new Map(tools.map((tool) => [tool.name, tool]));
  }

  /**
   * Resolves a user-supplied path against the project root and verifies it
   * stays inside the project.
   *
   * Two layers of protection:
   * 1. Textual clamp: `path.relative` must not escape the root.
   * 2. Symlink/junction protection: resolve the deepest existing ancestor of
   *    the target with `fs.realpath` and compare it against the real project
   *    root, so in-project symlinks/junctions pointing outside are rejected.
   *    Because `write_file` targets may not exist yet (realpath would throw),
   *    the walk goes up to the deepest ancestor that does exist.
   */
  private async resolveWithinProject(relPath: string): Promise<string> {
    const absPath = path.resolve(this.projectPath, relPath);
    const rel = path.relative(this.projectPath, absPath);
    if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Refusing to access a path outside the project root: ${relPath}`);
    }
    const realRoot = await fs.realpath(this.projectPath).catch(() => null);
    if (!realRoot) return absPath;
    let probe = absPath;
    for (;;) {
      const realProbe = await fs.realpath(probe).catch(() => null);
      if (realProbe) {
        const realRel = path.relative(realRoot, realProbe);
        if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
          throw new Error(
            `Refusing to access '${toPosix(relPath)}': it resolves outside the project root through a symlink/junction`,
          );
        }
        return absPath;
      }
      const parent = path.dirname(probe);
      if (parent === probe) {
        // Reached the filesystem root without finding anything that exists;
        // fall back to the textual check above.
        return absPath;
      }
      probe = parent;
    }
  }

  private async collectProjectFiles(): Promise<string[]> {
    const results: string[] = [];
    const walk = async (relDir: string): Promise<void> => {
      const absDir = relDir ? path.join(this.projectPath, relDir) : this.projectPath;
      let entries;
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue;
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(rel);
        } else if (entry.isFile()) {
          results.push(rel);
        }
      }
    };
    await walk('');
    return results.sort();
  }

  private async execReadFile(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const relPath = requireStringArg(args, 'path');
    const absPath = await this.resolveWithinProject(relPath);
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat || !stat.isFile()) {
      return { output: `File not found: ${toPosix(relPath)}`, isError: true };
    }
    const content = await fs.readFile(absPath, 'utf8');
    if (content.length > 100_000) {
      return { output: `${content.slice(0, 100_000)}\n... (truncated)`, isError: false };
    }
    return { output: content.length > 0 ? content : '(empty file)', isError: false };
  }

  private async execWriteFile(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const relPath = requireStringArg(args, 'path');
    const content = typeof args.content === 'string' ? args.content : '';
    const absPath = await this.resolveWithinProject(relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, content, 'utf8');
    return {
      output: `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${toPosix(relPath)}`,
      isError: false,
    };
  }

  private async execEditFile(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const relPath = requireStringArg(args, 'path');
    const oldString = requireStringArg(args, 'oldString');
    const newString = requireStringArg(args, 'newString');
    const replaceAll = args.replaceAll === true;
    const absPath = await this.resolveWithinProject(relPath);
    const content = await fs.readFile(absPath, 'utf8');
    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) {
      return { output: `oldString not found in ${toPosix(relPath)}`, isError: true };
    }
    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, () => newString);
    await fs.writeFile(absPath, updated, 'utf8');
    return {
      output: `Edited ${toPosix(relPath)}: replaced ${replaceAll ? occurrences : 1} occurrence(s).`,
      isError: false,
    };
  }

  private async execGlobSearch(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const pattern = toPosix(requireStringArg(args, 'pattern'));
    const matcher = globToRegExp(pattern);
    const files = await this.collectProjectFiles();
    const matches = files.filter((file) => matcher.test(file)).slice(0, 200);
    return {
      output: matches.length > 0 ? matches.join('\n') : '(no matches)',
      isError: false,
    };
  }

  private async execGrepSearch(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const query = requireStringArg(args, 'query');
    const globFilter = readString(args.glob);
    const fileMatcher = globFilter ? globToRegExp(toPosix(globFilter)) : null;
    let queryRegex: RegExp | null = null;
    if (args.useRegex === true) {
      try {
        queryRegex = new RegExp(query, 'i');
      } catch {
        return { output: `Invalid regular expression: ${query}`, isError: true };
      }
    }

    const files = await this.collectProjectFiles();
    const hits: string[] = [];
    outer: for (const rel of files) {
      if (fileMatcher && !fileMatcher.test(rel)) continue;
      const absPath = path.join(this.projectPath, rel);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > 1024 * 1024) continue;
      const content = await fs.readFile(absPath, 'utf8').catch(() => null);
      if (content === null) continue;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const matched = queryRegex
          ? queryRegex.test(line)
          : line.toLowerCase().includes(query.toLowerCase());
        if (matched) {
          hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
          if (hits.length >= MAX_GREP_HITS) break outer;
        }
      }
    }
    return { output: hits.length > 0 ? hits.join('\n') : '(no matches)', isError: false };
  }

  private execCapture(
    command: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string; spawnError?: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const child = nodeSpawn(command, {
        shell: true,
        cwd: this.projectPath,
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);
      child.stdout?.on('data', (chunk: unknown) => {
        if (stdout.length < 64 * 1024) stdout += typeof chunk === 'string' ? chunk : String(chunk);
      });
      child.stderr?.on('data', (chunk: unknown) => {
        if (stderr.length < 64 * 1024) stderr += typeof chunk === 'string' ? chunk : String(chunk);
      });
      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: null, stdout, stderr, spawnError: err.message });
      });
      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: code,
          stdout,
          stderr,
          spawnError: timedOut ? `Command timed out after ${timeoutMs}ms` : undefined,
        });
      });
    });
  }

  private async execRunShell(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const command = requireStringArg(args, 'command');
    // Minimal catastrophic-command guard (see BLOCKED_SHELL_PATTERNS for the
    // documented sandbox limitations). requiresApproval is always true for
    // run_shell tool_call_start events.
    const blockedLabel = matchBlockedShellCommand(command);
    if (blockedLabel) {
      return {
        output: `Blocked by the CrossCode shell guard (${blockedLabel}). The command was NOT executed: ${command}`,
        isError: true,
      };
    }
    const requested = Number(args.timeoutMs ?? 30_000);
    const timeoutMs = Number.isFinite(requested)
      ? Math.min(Math.max(requested, 1_000), 120_000)
      : 30_000;
    const result = await this.execCapture(command, timeoutMs);
    const header = result.spawnError ?? `exit code: ${result.exitCode}`;
    return {
      output: `${header}\n--- stdout ---\n${result.stdout.trim() || '(empty)'}\n--- stderr ---\n${result.stderr.trim() || '(empty)'}`,
      isError:
        result.spawnError !== undefined || (result.exitCode !== null && result.exitCode !== 0),
    };
  }

  private async execGitStatusDiff(): Promise<ToolExecutionResult> {
    const status = await this.execCapture('git status --porcelain', 15_000);
    if (status.spawnError) {
      return { output: `git unavailable: ${status.spawnError}`, isError: false };
    }
    if (status.exitCode !== 0) {
      return {
        output: `Not a git repository (git status exited with code ${status.exitCode}).`,
        isError: false,
      };
    }
    const diffStat = await this.execCapture('git diff --stat', 15_000);
    return {
      output: `--- git status ---\n${status.stdout.trim() || '(working tree clean)'}\n--- diff stat ---\n${diffStat.stdout.trim() || '(no unstaged diffs)'}`,
      isError: false,
    };
  }

  private async readActiveTaskSnapshot(): Promise<ActiveTaskState | null> {
    const taskPath = path.join(this.projectPath, '.agent', 'context', 'active-task.json');
    try {
      const raw = await fs.readFile(taskPath, 'utf8');
      const parsed = JSON.parse(raw) as ActiveTaskState;
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  private async restoreActiveTaskSnapshot(snapshot: ActiveTaskState): Promise<void> {
    const taskPath = path.join(this.projectPath, '.agent', 'context', 'active-task.json');
    try {
      const restored: ActiveTaskState = { ...snapshot, updatedAt: new Date().toISOString() };
      await fs.writeFile(taskPath, `${JSON.stringify(restored, null, 2)}\n`, 'utf8');
    } catch {
      // best-effort: keep dispatch results even if the restore fails
    }
  }

  /**
   * Meta-tool: dispatches a subtask to an external harness adapter and
   * forwards every UnifiedStreamEvent it produces onto this harness's
   * event stream.
   */
  private async execDispatchToExternalHarness(args: Record<string, unknown>): Promise<ToolExecutionResult> {
    const harnessId = (readString(args.harness) ?? '') as HarnessId;
    const task = readString(args.task) ?? '';
    if (!harnessId || !task) {
      return {
        output: "dispatch_to_external_harness requires string arguments 'harness' and 'task'.",
        isError: true,
      };
    }
    const adapter = this.externalAdapters[harnessId];
    if (!adapter) {
      const registered = Object.keys(this.externalAdapters);
      return {
        output: `No external adapter registered for harness '${harnessId}'. Registered: ${
          registered.length > 0 ? registered.join(', ') : '(none)'
        }.`,
        isError: true,
      };
    }

    const collectedText: string[] = [];
    const unsubscribe = adapter.subscribe((event) => {
      this.emitEvent(event);
      if (event.type === 'text_delta') collectedText.push(event.text);
    });
    // Snapshot the orchestrating task's state before dispatch: the external
    // adapter updates the shared .agent/context/active-task.json (and marks
    // it completed on success), which must not leak into / clobber the outer
    // task. The snapshot is restored once the dispatch settles.
    const snapshot = await this.readActiveTaskSnapshot();
    try {
      // adapter.start() resolves once the external process has fully exited,
      // so no extra waitForExit() is needed here.
      await adapter.start(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Dispatch to ${harnessId} failed: ${message}`, isError: true };
    } finally {
      unsubscribe();
      if (snapshot) await this.restoreActiveTaskSnapshot(snapshot);
    }

    const summary = collectedText.join('').trim();
    return {
      output: summary.length > 0
        ? `Harness ${harnessId} completed. Output: ${summary}`
        : `Harness ${harnessId} completed with no text output.`,
      isError: false,
    };
  }
}
