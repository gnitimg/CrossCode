import {
  asRecord,
  firstString,
  readString,
  stripAnsi,
  tryParseJsonLine,
  genCallId,
  BaseHarnessAdapter,
  type HarnessAdapterOptions,
} from './base-adapter.js';

export class OpenCodeAdapter extends BaseHarnessAdapter {
  constructor(options: HarnessAdapterOptions) {
    super('opencode', options);
  }

  protected getCommand(): string {
    return 'opencode';
  }

  public buildCliArgs(prompt: string): string[] {
    return ['run', '--format', 'json', prompt];
  }

  protected handleStdoutLine(line: string): void {
    const payload = tryParseJsonLine(line);
    if (!payload) {
      // Non-JSON output: clean it and forward as plain text.
      this.emitTextDelta(stripAnsi(line));
      return;
    }

    const type = readString(payload.type) ?? '';
    switch (type) {
      case 'text': {
        const part = asRecord(payload.part);
        this.emitTextDelta(readString(payload.text) ?? readString(part?.text) ?? '');
        break;
      }
      case 'reasoning':
      case 'thinking': {
        this.emitThinkingDelta(readString(payload.text) ?? '');
        break;
      }
      case 'tool-call':
      case 'tool_use':
      case 'tool': {
        const state = asRecord(payload.state);
        const input = asRecord(state?.input) ?? asRecord(payload.input) ?? asRecord(payload.arguments) ?? {};
        const callId = firstString(payload.callID, payload.callId, payload.id) ?? genCallId();
        const toolName = firstString(payload.tool, payload.name) ?? 'unknown_tool';
        this.emitToolCallStart(callId, toolName, input);
        break;
      }
      case 'tool-result': {
        const state = asRecord(payload.state);
        const callId = firstString(payload.callID, payload.callId, payload.id) ?? 'unknown_call';
        const toolName = firstString(payload.tool, payload.name) ?? 'unknown_tool';
        const output = readString(payload.output) ?? readString(state?.output) ?? '';
        this.emitToolCallResult(callId, toolName, output);
        break;
      }
      default:
        // step-start / step-finish / unknown envelope types are ignored
        break;
    }
  }
}
