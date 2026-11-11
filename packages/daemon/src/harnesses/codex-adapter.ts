import {
  asRecord,
  extractTextContent,
  firstString,
  genCallId,
  readString,
  stripAnsi,
  tryParseJsonLine,
  BaseHarnessAdapter,
  type HarnessAdapterOptions,
} from './base-adapter.js';

export interface CodexAdapterOptions extends HarnessAdapterOptions {
  model?: string;
}

/**
 * Adapter for the `codex` CLI in non-interactive JSON mode:
 *   codex exec --json "<prompt>" [--model <model>]
 *
 * Parses both the current `item.*` event stream and the legacy
 * `msg.type` envelope.
 */
export class CodexAdapter extends BaseHarnessAdapter {
  private readonly model?: string;
  private readonly itemToolNames = new Map<string, string>();

  constructor(options: CodexAdapterOptions) {
    super('codex', options);
    this.model = options.model;
  }

  protected getCommand(): string {
    return 'codex';
  }

  public buildCliArgs(prompt: string): string[] {
    return ['exec', '--json', ...(this.model ? ['--model', this.model] : []), prompt];
  }

  protected onSessionStart(): void {
    this.itemToolNames.clear();
  }

  protected handleStdoutLine(line: string): void {
    const payload = tryParseJsonLine(line);
    if (!payload) {
      this.emitTextDelta(stripAnsi(line));
      return;
    }

    const type = readString(payload.type) ?? '';
    if (type.startsWith('item.')) {
      this.handleItemEvent(type, payload.item);
      return;
    }
    const legacy = asRecord(payload.msg);
    if (legacy) {
      this.handleLegacyMsg(legacy);
    }
  }

  private handleItemEvent(type: string, rawItem: unknown): void {
    const item = asRecord(rawItem);
    if (!item) return;
    const itemType = readString(item.type) ?? '';

    if (type === 'item.started') {
      const callId = firstString(item.id, item.call_id) ?? genCallId();
      if (itemType === 'command_execution') {
        this.itemToolNames.set(callId, 'shell');
        this.emitToolCallStart(callId, 'shell', { command: readString(item.command) ?? '' });
      } else if (itemType === 'mcp_tool_call') {
        const toolName = firstString(item.tool, item.server) ?? 'mcp_tool';
        this.itemToolNames.set(callId, toolName);
        this.emitToolCallStart(callId, toolName, asRecord(item.arguments) ?? {});
      }
      return;
    }

    if (type === 'item.completed') {
      if (itemType === 'agent_message' || itemType === 'message') {
        this.emitTextDelta(readString(item.text) ?? extractTextContent(item.content));
      } else if (itemType === 'reasoning') {
        this.emitThinkingDelta(readString(item.text) ?? readString(item.summary) ?? '');
      } else if (itemType === 'command_execution') {
        const callId = firstString(item.id, item.call_id) ?? 'unknown_call';
        const exitCode = typeof item.exit_code === 'number' ? item.exit_code : 0;
        const output = readString(item.aggregated_output) ?? '';
        this.emitToolCallResult(
          callId,
          this.itemToolNames.get(callId) ?? 'shell',
          output.length > 0 ? output : `(exit code ${exitCode})`,
          exitCode !== 0,
        );
      } else if (itemType === 'mcp_tool_call') {
        const callId = firstString(item.id, item.call_id) ?? 'unknown_call';
        this.emitToolCallResult(
          callId,
          this.itemToolNames.get(callId) ?? firstString(item.tool) ?? 'mcp_tool',
          readString(item.output) ?? extractTextContent(item.result),
        );
      }
      return;
    }
    // item.updated and other envelope types are ignored.
  }

  private handleLegacyMsg(msg: Record<string, unknown>): void {
    const msgType = readString(msg.type) ?? '';
    if (msgType === 'agent_message') {
      this.emitTextDelta(firstString(msg.message, msg.text) ?? '');
    } else if (msgType === 'agent_reasoning') {
      this.emitThinkingDelta(firstString(msg.text, msg.message) ?? '');
    } else if (msgType === 'exec_command_begin') {
      const callId = firstString(msg.call_id, msg.id) ?? genCallId();
      this.itemToolNames.set(callId, 'shell');
      this.emitToolCallStart(callId, 'shell', { command: readString(msg.command) ?? '' });
    } else if (msgType === 'exec_command_end') {
      const callId = firstString(msg.call_id, msg.id) ?? 'unknown_call';
      this.emitToolCallResult(
        callId,
        this.itemToolNames.get(callId) ?? 'shell',
        firstString(msg.aggregated_output, msg.stdout) ?? '',
      );
    }
    // token_count / task_started / task_complete / etc are ignored.
  }
}
