import {
  asRecord,
  extractTextContent,
  genCallId,
  stripAnsi,
  tryParseJsonLine,
  BaseHarnessAdapter,
  type HarnessAdapterOptions,
  type ExternalCliOptions,
} from './base-adapter.js';

export interface ClaudeCodeAdapterOptions extends HarnessAdapterOptions, ExternalCliOptions {}

interface AssistantContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ToolResultBlock {
  type?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/**
 * Adapter for the `claude` CLI in headless print mode with stream-json output:
 *   claude -p "<prompt>" --output-format stream-json --verbose [--mcp-config <path>]
 */
export class ClaudeCodeAdapter extends BaseHarnessAdapter {
  private readonly model?: string;
  private readonly mcpConfigPath?: string;
  private readonly permissionMode?: string;
  private readonly toolNameByCallId = new Map<string, string>();

  constructor(options: ClaudeCodeAdapterOptions) {
    super('claude-code', options);
    this.model = options.model;
    this.mcpConfigPath = options.mcpConfigPath;
    this.permissionMode = options.permissionMode;
  }

  protected getCommand(): string {
    return 'claude';
  }

  public buildCliArgs(prompt: string): string[] {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (this.model) args.push('--model', this.model);
    if (this.permissionMode) args.push('--permission-mode', this.permissionMode);
    // Auto-mount the shared MCP endpoint config when provided.
    if (this.mcpConfigPath) args.push('--mcp-config', this.mcpConfigPath);
    return args;
  }

  protected onSessionStart(): void {
    this.toolNameByCallId.clear();
  }

  protected handleStdoutLine(line: string): void {
    const payload = tryParseJsonLine(line);
    if (!payload) {
      this.emitTextDelta(stripAnsi(line));
      return;
    }

    const type = typeof payload.type === 'string' ? payload.type : '';
    if (type === 'assistant') {
      this.handleAssistantMessage(asRecord(payload.message));
    } else if (type === 'user') {
      this.handleUserMessage(asRecord(payload.message));
    } else if (type === 'result') {
      const result = payload.result;
      if (typeof result === 'string' && result.length > 0) {
        this.emitTextDelta(result);
      }
    }
    // 'system' / 'stream_event' envelopes are ignored.
  }

  private handleAssistantMessage(message: Record<string, unknown> | null): void {
    if (!message) return;
    const content = message.content;
    if (typeof content === 'string') {
      this.emitTextDelta(content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const rawBlock of content) {
      const block = asRecord(rawBlock) as AssistantContentBlock | null;
      if (!block) continue;
      if (block.type === 'thinking') {
        this.emitThinkingDelta(block.thinking ?? '');
      } else if (block.type === 'text') {
        this.emitTextDelta(block.text ?? '');
      } else if (block.type === 'tool_use') {
        const callId = block.id && block.id.length > 0 ? block.id : genCallId();
        const toolName = block.name && block.name.length > 0 ? block.name : 'unknown_tool';
        this.toolNameByCallId.set(callId, toolName);
        this.emitToolCallStart(callId, toolName, block.input ?? {});
      }
    }
  }

  private handleUserMessage(message: Record<string, unknown> | null): void {
    if (!message) return;
    const content = message.content;
    if (!Array.isArray(content)) return;
    for (const rawBlock of content) {
      const block = asRecord(rawBlock) as ToolResultBlock | null;
      if (!block || block.type !== 'tool_result') continue;
      const callId = block.tool_use_id ?? 'unknown_call';
      const toolName = this.toolNameByCallId.get(callId) ?? 'unknown_tool';
      this.emitToolCallResult(callId, toolName, extractTextContent(block.content), block.is_error === true);
    }
  }
}
