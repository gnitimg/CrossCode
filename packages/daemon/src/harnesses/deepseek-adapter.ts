import {
  cleanCliNoiseLine,
  BaseHarnessAdapter,
  type HarnessAdapterOptions,
} from './base-adapter.js';

/**
 * Adapter for the DeepSeek harness CLI in non-interactive run mode:
 *   deepseek run --non-interactive "<prompt>"
 *
 * Output is an interactive line stream; ANSI color codes, log-level noise
 * and spinner frames are stripped before forwarding text_delta events.
 */
export class DeepSeekAdapter extends BaseHarnessAdapter {
  constructor(options: HarnessAdapterOptions) {
    super('deepseek-harness', options);
  }

  protected getCommand(): string {
    return 'deepseek';
  }

  public buildCliArgs(prompt: string): string[] {
    return ['run', '--non-interactive', prompt];
  }

  protected handleStdoutLine(line: string): void {
    const cleaned = cleanCliNoiseLine(line);
    if (cleaned) this.emitTextDelta(cleaned);
  }
}
