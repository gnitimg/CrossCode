/**
 * Built-in browser automation tool layer.
 *
 * Wraps a lazily-launched pool of Playwright Chromium pages behind a small,
 * driver-agnostic tool API:
 *
 * - `open(url)`              — launch (or reuse) a page and navigate it
 * - `snapshot()`             — accessibility tree text with `@eN` element refs
 * - `click(ref)`             — click the element referenced by `@eN`
 * - `fill(ref, text)`        — type text into the element referenced by `@eN`
 * - `screenshot()`           — PNG screenshot of the active page (base64)
 * - `console()`              — buffered console/pageerror log of the active page
 *
 * EVERY side-effecting edge is injectable:
 * - `BrowserDriverFactory` creates pages (tests inject fakes; production
 *   defaults to a lazy playwright-core Chromium wrapper that only launches
 *   when a tool actually needs a page — playwright-core never downloads a
 *   browser by itself).
 * - `BrowserPageDriver` is the per-page object interface (navigation,
 *   accessibility tree, click/fill by driver-specific selector, screenshot,
 *   console buffer).
 *
 * Reference numbering: `snapshot()` walks the accessibility tree depth-first
 * and assigns `@e1`, `@e2`, ... `@eN`; the mapping is kept so `click`/`fill`
 * can dispatch to the matching node's selector.
 */

import { Buffer } from 'node:buffer';
import type { NormalizedAgentError } from '@crosscode/shared';

// ---------------------------------------------------------------------------
// Injected driver interfaces
// ---------------------------------------------------------------------------

/** A single node of the page's accessibility tree (no refs — refs are assigned by this module). */
export interface AccessibilityNodeSnapshot {
  /** ARIA-ish role, e.g. `button`, `heading`, `textbox`, `link`, `page`. */
  role: string;
  /** Accessible name, e.g. the button label. */
  name?: string;
  /** Current value for form-ish roles. */
  value?: string;
  /**
   * Driver-specific opaque selector used by `click`/`fill` to target this node.
   * Drivers that cannot address nodes may omit it (such nodes are still listed
   * in the snapshot but are not clickable).
   */
  selector?: string;
  children?: AccessibilityNodeSnapshot[];
}

export type ConsoleLogLevel = 'log' | 'info' | 'warn' | 'error' | 'pageerror';

export interface ConsoleLogEntry {
  level: ConsoleLogLevel;
  text: string;
  timestamp: string;
}

/**
 * Per-page object abstraction. One instance corresponds to one open browser
 * page/tab. Tests inject fakes; the production default wraps playwright-core.
 */
export interface BrowserPageDriver {
  /** Navigate to `url`; resolves with the final URL. */
  navigate(url: string): Promise<string>;
  getUrl(): string;
  getTitle(): Promise<string>;
  /** Structured role/name accessibility tree of the current page. */
  getAccessibilityTree(): Promise<AccessibilityNodeSnapshot>;
  /** Click the element identified by the driver-specific `selector`. */
  click(selector: string): Promise<void>;
  /** Fill the element identified by the driver-specific `selector` with `text`. */
  fill(selector: string, text: string): Promise<void>;
  /** PNG screenshot of the viewport. */
  screenshotPng(): Promise<Uint8Array>;
  /** Console + uncaught page error entries buffered since page creation. */
  listConsoleEntries(): ConsoleLogEntry[];
  close(): Promise<void>;
}

export interface BrowserDriverFactory {
  /** Launch a fresh page (implementation may lazily start the browser binary here). */
  launchPage(): Promise<BrowserPageDriver>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BuiltinBrowserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuiltinBrowserError';
  }
}

/** Normalized `CC-TOOL-4001`-shaped error for MCP tool-layer reporting. */
export function builtinBrowserNormalizedError(rawMessage: string): NormalizedAgentError {
  return {
    code: 'CC-TOOL-4001',
    category: 'TOOL',
    harness: 'crosscode-native',
    rawMessage,
    userTitle: '内置浏览器操作失败',
    recoveryAction: 'RESTART_PROCESS',
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pool + tool-level API
// ---------------------------------------------------------------------------

export interface BuiltinBrowserOptions {
  /** Page factory. Defaults to the lazy playwright-core Chromium wrapper. */
  driverFactory?: BrowserDriverFactory;
  /** Maximum number of simultaneously open pages. Default 3. */
  maxInstances?: number;
}

export interface BuiltinSnapshotResult {
  /** Rendered tree text with `@eN` refs (what the model reads). */
  text: string;
  url: string;
  title: string;
  /** Number of refs assigned (`@e1..@eN`). */
  refCount: number;
}

export interface BuiltinScreenshotResult {
  /** Base64-encoded PNG. */
  base64: string;
  mimeType: 'image/png';
}

export interface BuiltinOpenResult {
  url: string;
  title: string;
  /** Number of currently open pages in the pool. */
  poolSize: number;
}

interface RefTarget {
  ref: string;
  node: AccessibilityNodeSnapshot;
}

const DEFAULT_MAX_INSTANCES = 3;
const REF_PATTERN = /^@e(\d+)$/;

export class BuiltinBrowser {
  private readonly factory: BrowserDriverFactory;
  private readonly maxInstances: number;
  /** Open pages in creation order (oldest first). */
  private readonly pages: BrowserPageDriver[] = [];
  private activePage: BrowserPageDriver | null = null;
  /** Ref targets from the most recent snapshot of the active page. */
  private refTargets = new Map<string, AccessibilityNodeSnapshot>();
  private nextRefIndex = 0;

  constructor(options: BuiltinBrowserOptions = {}) {
    this.factory = options.driverFactory ?? createPlaywrightBrowserDriverFactory();
    this.maxInstances = Math.max(1, Math.floor(options.maxInstances ?? DEFAULT_MAX_INSTANCES));
  }

  get poolSize(): number {
    return this.pages.length;
  }

  get maxPoolSize(): number {
    return this.maxInstances;
  }

  /**
   * Open a page (launching the browser lazily on first use) and navigate it.
   * When the pool is full the oldest pages are closed first.
   */
  async open(url: string): Promise<BuiltinOpenResult> {
    const page = await this.factory.launchPage();
    const finalUrl = await page.navigate(url);
    this.pages.push(page);
    this.activePage = page;
    this.refTargets = new Map();
    while (this.pages.length > this.maxInstances) {
      const oldest = this.pages.shift();
      if (oldest && oldest !== page) {
        await oldest.close().catch(() => undefined);
      }
    }
    const title = await page.getTitle();
    return { url: finalUrl, title, poolSize: this.pages.length };
  }

  private requireActivePage(): BrowserPageDriver {
    if (!this.activePage) {
      throw new BuiltinBrowserError(
        'No builtin browser page is open. Call browser_builtin_open first.',
      );
    }
    return this.activePage;
  }

  /**
   * Render the active page's accessibility tree as text with `@eN` refs.
   * Refs are assigned depth-first; click/fill dispatch uses them.
   */
  async snapshot(): Promise<BuiltinSnapshotResult> {
    const page = this.requireActivePage();
    const tree = await page.getAccessibilityTree();
    this.refTargets = new Map();
    this.nextRefIndex = 0;
    const lines: string[] = [];
    const title = await page.getTitle();
    lines.push(`page "${title}" (${page.getUrl()})`);
    this.renderNode(tree, 1, lines);
    return {
      text: lines.join('\n'),
      url: page.getUrl(),
      title,
      refCount: this.nextRefIndex,
    };
  }

  private renderNode(node: AccessibilityNodeSnapshot, depth: number, lines: string[]): void {
    this.nextRefIndex += 1;
    const ref = `@e${this.nextRefIndex}`;
    this.refTargets.set(ref, node);
    const name = node.name !== undefined ? ` "${node.name}"` : '';
    lines.push(`${'  '.repeat(depth)}- ${ref} [${node.role}]${name}`);
    for (const child of node.children ?? []) {
      this.renderNode(child, depth + 1, lines);
    }
  }

  private resolveRef(ref: string): AccessibilityNodeSnapshot {
    const normalized = ref.trim();
    if (!REF_PATTERN.test(normalized)) {
      throw new BuiltinBrowserError(
        `Invalid element ref "${ref}". Refs look like @e1, @e2, ... (from browser_builtin_snapshot).`,
      );
    }
    const node = this.refTargets.get(normalized);
    if (!node) {
      throw new BuiltinBrowserError(
        `Unknown element ref "${normalized}". Call browser_builtin_snapshot again to refresh refs.`,
      );
    }
    return node;
  }

  /** Click the node referenced by `ref` (e.g. `@e2`). */
  async click(ref: string): Promise<{ clickedRef: string; role: string; name?: string }> {
    const page = this.requireActivePage();
    const node = this.resolveRef(ref);
    if (!node.selector) {
      throw new BuiltinBrowserError(
        `Element ${ref} [${node.role}] has no addressable selector and cannot be clicked.`,
      );
    }
    await page.click(node.selector);
    return { clickedRef: ref.trim(), role: node.role, name: node.name };
  }

  /** Fill the node referenced by `ref` with `text`. */
  async fill(
    ref: string,
    text: string,
  ): Promise<{ filledRef: string; role: string; text: string }> {
    const page = this.requireActivePage();
    const node = this.resolveRef(ref);
    if (!node.selector) {
      throw new BuiltinBrowserError(
        `Element ${ref} [${node.role}] has no addressable selector and cannot be filled.`,
      );
    }
    await page.fill(node.selector, text);
    return { filledRef: ref.trim(), role: node.role, text };
  }

  /** Screenshot the active page; returns base64 PNG. */
  async screenshot(): Promise<BuiltinScreenshotResult> {
    const page = this.requireActivePage();
    const png = await page.screenshotPng();
    return { base64: Buffer.from(png).toString('base64'), mimeType: 'image/png' };
  }

  /** Console/pageerror log buffer of the active page. */
  console(): ConsoleLogEntry[] {
    const page = this.requireActivePage();
    return page.listConsoleEntries().map((entry) => ({ ...entry }));
  }

  /** Close every pooled page. */
  async closeAll(): Promise<void> {
    for (const page of this.pages) {
      await page.close().catch(() => undefined);
    }
    this.pages.length = 0;
    this.activePage = null;
    this.refTargets = new Map();
  }
}

// ---------------------------------------------------------------------------
// Default driver factory: lazy playwright-core Chromium (types + lazy import)
// ---------------------------------------------------------------------------

/** Selector encoding used by the default playwright driver: `role=<role>|name=<name>`. */
function encodeRoleSelector(role: string, name?: string): string {
  return `role=${role}|name=${name ?? ''}`;
}

function decodeRoleSelector(selector: string): { role: string; name?: string } | null {
  if (!selector.startsWith('role=')) {
    return null;
  }
  const body = selector.slice('role='.length);
  const sep = body.indexOf('|name=');
  if (sep === -1) {
    return { role: body };
  }
  const role = body.slice(0, sep);
  const name = body.slice(sep + '|name='.length);
  return { role, name: name.length > 0 ? name : undefined };
}

interface PlaywrightAxNode {
  role?: string;
  name?: string;
  value?: string;
  children?: PlaywrightAxNode[];
}

/**
 * Production driver factory. playwright-core is imported lazily on first
 * `launchPage()` call, and the Chromium binary only launches at that moment —
 * importing this module (or constructing `BuiltinBrowser`) never starts a
 * browser process.
 */
export function createPlaywrightBrowserDriverFactory(): BrowserDriverFactory {
  let chromiumLaunch: ((options?: { headless?: boolean }) => Promise<unknown>) | null = null;

  async function importChromium(): Promise<{
    launch: (options?: { headless?: boolean }) => Promise<unknown>;
  }> {
    const pw = (await import('playwright-core')) as unknown as {
      chromium: { launch: (options?: { headless?: boolean }) => Promise<unknown> };
    };
    return pw.chromium;
  }

  return {
    async launchPage(): Promise<BrowserPageDriver> {
      if (!chromiumLaunch) {
        chromiumLaunch = (await importChromium()).launch;
      }
      const browser = (await chromiumLaunch({ headless: true })) as {
        newContext: () => Promise<{
          newPage: () => Promise<PlaywrightPageLike>;
          close: () => Promise<void>;
        }>;
        close: () => Promise<void>;
      };
      const context = await browser.newContext();
      const page = await context.newPage();
      return new PlaywrightPageDriver(page, context, browser);
    },
  };
}

/** Structural subset of a playwright Page (keeps this module decoupled from playwright's exact typing). */
interface PlaywrightPageLike {
  goto(url: string): Promise<{ url(): string } | null>;
  url(): string;
  title(): Promise<string>;
  accessibility?: {
    snapshot(): Promise<PlaywrightAxNode | null>;
  };
  getByRole(role: string, options?: { name?: string }): {
    first(): { click(): Promise<void>; fill(text: string): Promise<void> };
  };
  screenshot(options?: { type: 'png' }): Promise<Uint8Array>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  close(): Promise<void>;
}

class PlaywrightPageDriver implements BrowserPageDriver {
  private readonly consoleBuffer: ConsoleLogEntry[] = [];

  constructor(
    private readonly page: PlaywrightPageLike,
    private readonly context: { close: () => Promise<void> },
    private readonly browser: { close: () => Promise<void> },
  ) {
    page.on('console', (...args: unknown[]) => {
      const msg = args[0] as { type?: () => string; text?: () => string } | undefined;
      if (!msg) return;
      const level = msg.type?.() ?? 'log';
      this.consoleBuffer.push({
        level: (['log', 'info', 'warn', 'error'] as string[]).includes(level)
          ? (level as ConsoleLogLevel)
          : 'log',
        text: msg.text?.() ?? '',
        timestamp: new Date().toISOString(),
      });
    });
    page.on('pageerror', (...args: unknown[]) => {
      const err = args[0];
      this.consoleBuffer.push({
        level: 'pageerror',
        text: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    });
  }

  async navigate(url: string): Promise<string> {
    const response = await this.page.goto(url);
    return response ? response.url() : this.page.url();
  }

  getUrl(): string {
    return this.page.url();
  }

  async getTitle(): Promise<string> {
    return this.page.title();
  }

  async getAccessibilityTree(): Promise<AccessibilityNodeSnapshot> {
    const ax = this.page.accessibility;
    const root = ax ? await ax.snapshot() : null;
    if (!root) {
      return {
        role: 'page',
        name: await this.page.title(),
        selector: 'role=page',
        children: [],
      };
    }
    return this.mapAxNode(root);
  }

  private mapAxNode(node: PlaywrightAxNode): AccessibilityNodeSnapshot {
    const role = node.role ?? 'generic';
    const mapped: AccessibilityNodeSnapshot = {
      role,
      children: (node.children ?? []).map((child) => this.mapAxNode(child)),
    };
    if (node.name !== undefined) mapped.name = node.name;
    if (node.value !== undefined) mapped.value = node.value;
    mapped.selector = encodeRoleSelector(role, node.name);
    return mapped;
  }

  async click(selector: string): Promise<void> {
    const decoded = decodeRoleSelector(selector);
    if (!decoded) {
      throw new BuiltinBrowserError(`Unsupported selector for default driver: ${selector}`);
    }
    await this.page
      .getByRole(decoded.role, { name: decoded.name })
      .first()
      .click();
  }

  async fill(selector: string, text: string): Promise<void> {
    const decoded = decodeRoleSelector(selector);
    if (!decoded) {
      throw new BuiltinBrowserError(`Unsupported selector for default driver: ${selector}`);
    }
    await this.page
      .getByRole(decoded.role, { name: decoded.name })
      .first()
      .fill(text);
  }

  async screenshotPng(): Promise<Uint8Array> {
    return this.page.screenshot({ type: 'png' });
  }

  listConsoleEntries(): ConsoleLogEntry[] {
    return this.consoleBuffer.map((entry) => ({ ...entry }));
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined);
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }
}
