import {
  cleanCliNoiseLine,
  BaseHarnessAdapter,
  type HarnessAdapterOptions,
} from './base-adapter.js';

/**
 * Adapter for the ZCode CLI in non-interactive print mode:
 *   zcode --print "<prompt>"
 *
 * Output is an interactive line stream; ANSI color codes, log-level noise
 * and spinner frames are stripped before forwarding text_delta events.
 */
export class ZCodeAdapter extends BaseHarnessAdapter {
  constructor(options: HarnessAdapterOptions) {
    super('zcode', options);
  }

  protected getCommand(): string {
    return 'zcode';
  }

  public buildCliArgs(prompt: string): string[] {
    return ['--print', prompt];
  }

  protected handleStdoutLine(line: string): void {
    const cleaned = cleanCliNoiseLine(line);
    if (cleaned) this.emitTextDelta(cleaned);
  }
}
