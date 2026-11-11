import {
  cleanCliNoiseLine,
  BaseHarnessAdapter,
  type HarnessAdapterOptions,
} from './base-adapter.js';

/**
 * Adapter for the Qoder CLI in streaming run mode:
 *   qoder run --stream "<prompt>"
 *
 * Qoder emits human-readable interactive lines; they are cleaned of ANSI
 * color codes, log-level noise, and spinner frames before being forwarded
 * as text_delta events.
 */
export class QoderAdapter extends BaseHarnessAdapter {
  constructor(options: HarnessAdapterOptions) {
    super('qoder', options);
  }

  protected getCommand(): string {
    return 'qoder';
  }

  public buildCliArgs(prompt: string): string[] {
    return ['run', '--stream', prompt];
  }

  protected handleStdoutLine(line: string): void {
    const cleaned = cleanCliNoiseLine(line);
    if (cleaned) this.emitTextDelta(cleaned);
  }
}
