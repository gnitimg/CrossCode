/**
 * Windows desktop control (computer use) — zero native-build dependencies.
 *
 * Everything runs through PowerShell:
 * - screenshot: `System.Drawing` `CopyFromScreen` → PNG → base64 (optionally
 *   scaled down to `maxScreenshotEdge`) plus coordinate ruler info (screen
 *   width/height the base64 image maps onto).
 * - mouse: user32 `SetCursorPos` + `mouse_event` (move, left/right click,
 *   double click, drag).
 * - keyboard: `SendKeys` for literal text, user32 `keybd_event` sequences for
 *   hotkey combos (Ctrl+C, Alt+Tab, Win+D, ...).
 * - windows: user32 `EnumWindows` list + `SetForegroundWindow` focus.
 *
 * Every PowerShell invocation goes through the injectable `PowerShellExecutor`
 * interface. The production default shells out via
 * `child_process.execFile('powershell.exe', ... -EncodedCommand ...)`. Tests
 * inject a fake executor and assert on the generated script text and the
 * safety-gate behavior — no real desktop is ever touched.
 *
 * Safety gate (`SafetyPolicy`): configurable high-risk rules — full-screen
 * mouse gestures (click/drag without explicit coordinates), keyboard combos
 * containing Alt+Tab or the Win key (denied list), and sensitive window
 * titles on focus. A rule hit does NOT execute: it returns a pending-approval
 * result shaped after `CC-TOOL-4002` (`recoveryAction = 'AWAIT_APPROVAL'`,
 * `approvalId`, original action echoed back) and the exact action can later be
 * executed via `approve(approvalId)` or discarded via `reject(approvalId)`.
 */

import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import type { NormalizedAgentError } from '@crosscode/shared';

// ---------------------------------------------------------------------------
// PowerShell executor (injectable)
// ---------------------------------------------------------------------------

export interface PowerShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PowerShellExecutor {
  exec(script: string): Promise<PowerShellResult>;
}

export class ComputerUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComputerUseError';
  }
}

/**
 * Production executor: runs the script via powershell.exe -EncodedCommand
 * (UTF-16LE base64, immune to quoting issues). Non-zero exit codes resolve
 * (not reject) so callers can inspect stderr; only spawn failures reject.
 */
export function createDefaultPowerShellExecutor(options: { timeoutMs?: number } = {}): PowerShellExecutor {
  const timeoutMs = options.timeoutMs ?? 20_000;
  return {
    exec(script: string): Promise<PowerShellResult> {
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
      return new Promise((resolve, reject) => {
        execFile(
          'powershell.exe',
          args,
          { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
          (error, stdout, stderr) => {
            if (error && typeof (error as { code?: unknown }).code !== 'number') {
              // Spawn-level failure (powershell.exe not found, timeout kill, ...).
              reject(new ComputerUseError(`Failed to run powershell.exe: ${error.message}`));
              return;
            }
            resolve({
              exitCode: error ? Number((error as { code?: unknown }).code ?? 1) : 0,
              stdout: typeof stdout === 'string' ? stdout : '',
              stderr: typeof stderr === 'string' ? stderr : '',
            });
          },
        );
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Safety policy + pending approvals
// ---------------------------------------------------------------------------

export interface SafetyPolicyConfig {
  /**
   * Treat mouse click/drag without explicit coordinates (a gesture that acts
   * on whatever is under the cursor across the whole desktop) as high risk.
   * Default true.
   */
  blockFullScreenClicks?: boolean;
  /**
   * Keyboard combos that require approval, matched against the normalized
   * token set (order-insensitive), e.g. `'alt+tab'`. Default `['alt+tab']`.
   */
  deniedCombos?: string[];
  /** Deny any combo containing the Win/Meta key. Default true. */
  denyWinKey?: boolean;
  /** Window title rules (case-insensitive substring or RegExp) that require approval on focus. Default none. */
  sensitiveWindowTitles?: Array<string | RegExp>;
}

interface ResolvedSafetyPolicy {
  blockFullScreenClicks: boolean;
  deniedCombos: Set<string>;
  denyWinKey: boolean;
  sensitiveWindowTitles: Array<string | RegExp>;
}

export interface PendingApproval {
  approvalId: string;
  toolName: string;
  reason: string;
  originalAction: Record<string, unknown>;
  createdAt: string;
}

/** Result returned instead of executing when the safety gate hits. */
export interface ApprovalRequiredResult {
  status: 'approval_required';
  code: 'CC-TOOL-4002';
  category: 'TOOL';
  recoveryAction: 'AWAIT_APPROVAL';
  approvalId: string;
  toolName: string;
  reason: string;
  originalAction: Record<string, unknown>;
  /** Ready-to-emit `normalized_error` event payload. */
  error: NormalizedAgentError;
}

export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  executed: boolean;
  result?: unknown;
  reason?: string;
}

export function buildApprovalRequiredError(rawMessage: string): NormalizedAgentError {
  return {
    code: 'CC-TOOL-4002',
    category: 'TOOL',
    harness: 'crosscode-native',
    rawMessage,
    userTitle: '高危工具操作等待远程人工审批',
    recoveryAction: 'AWAIT_APPROVAL',
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// ComputerUseWin32
// ---------------------------------------------------------------------------

export type MouseActionKind = 'move' | 'left_click' | 'right_click' | 'double_click' | 'drag';

export interface MouseActionInput {
  action: MouseActionKind;
  /** Target position; omitted = act at the current cursor position (full-screen gesture). */
  x?: number;
  y?: number;
  /** Drag end position. */
  x2?: number;
  y2?: number;
}

export interface MouseActionResult {
  performed: MouseActionKind;
  x?: number;
  y?: number;
}

export interface KeyboardActionInput {
  action: 'type' | 'hotkey';
  /** Literal text to type (SendKeys-special characters are escaped). */
  text?: string;
  /** Hotkey combo, e.g. 'Ctrl+C', 'Alt+Tab', 'Win+D', 'Ctrl+Shift+Esc'. */
  keys?: string;
}

export interface KeyboardActionResult {
  performed: 'type' | 'hotkey';
  keys?: string;
  text?: string;
}

export interface WindowListItem {
  hwnd: number;
  title: string;
}

export interface WindowListResult {
  windows: WindowListItem[];
}

export interface WindowFocusInput {
  /** Window handle from computer_window_list. */
  hwnd?: number;
  /** Exact window title to look up. */
  title?: string;
}

export interface WindowFocusResult {
  focused: boolean;
  hwnd?: number;
  title?: string;
}

export interface ComputerUseOptions {
  /** PowerShell executor. Defaults to child_process.execFile('powershell.exe', ...). */
  executor?: PowerShellExecutor;
  /** Safety policy overrides. */
  safetyPolicy?: SafetyPolicyConfig;
  /** Screenshot is scaled down so the longer edge stays within this bound. Default 1600. */
  maxScreenshotEdge?: number;
  /** Pending approvals expire (are discarded) after this long. Default 5 minutes. */
  pendingApprovalTtlMs?: number;
  /** Maximum number of simultaneously pending approvals; the oldest is evicted. Default 100. */
  maxPendingApprovals?: number;
  /**
   * Optional hook invoked synchronously whenever a high-risk desktop action
   * hits the CC-TOOL-4002 safety gate and is stored as a pending approval.
   */
  onApprovalRequested?: (approval: PendingApproval) => void;
}

const SCREEN_MARKER = '__CC_SCREEN_JSON__';
const WINDOW_MARKER = '__CC_WINDOW__';
const WINDOW_SEP = '__SEP__';
const FOCUS_MARKER = '__CC_FOCUS__';
const MOUSE_OK_MARKER = '__CC_MOUSE_OK__';
const TYPE_OK_MARKER = '__CC_TYPE_OK__';
const HOTKEY_OK_MARKER = '__CC_HOTKEY_OK__';
const TITLE_MARKER = '__CC_TITLE__';

/**
 * Prepended to every generated script: without it powershell.exe writes
 * stdout in the legacy console codepage and non-ASCII window titles (e.g.
 * `记事本`) are decoded as mojibake by execFile's utf8 decoding.
 */
const PS_OUTPUT_ENCODING_HEADER = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8';

const DEFAULT_MAX_SCREENSHOT_EDGE = 1600;
const DEFAULT_PENDING_APPROVAL_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_PENDING_APPROVALS = 100;

export class ComputerUseWin32 {
  private readonly executor: PowerShellExecutor;
  private readonly policy: ResolvedSafetyPolicy;
  private readonly maxScreenshotEdge: number;
  private readonly pendingApprovalTtlMs: number;
  private readonly maxPendingApprovals: number;
  private readonly pendingApprovals = new Map<
    string,
    { record: PendingApproval; run: () => Promise<unknown> }
  >();
  private readonly approvalListeners = new Set<(approval: PendingApproval) => void>();

  constructor(options: ComputerUseOptions = {}) {
    this.executor = options.executor ?? createDefaultPowerShellExecutor();
    if (options.onApprovalRequested) {
      this.approvalListeners.add(options.onApprovalRequested);
    }
    const cfg = options.safetyPolicy ?? {};
    this.policy = {
      blockFullScreenClicks: cfg.blockFullScreenClicks ?? true,
      deniedCombos: new Set((cfg.deniedCombos ?? ['alt+tab']).map(normalizeComboTokens)),
      denyWinKey: cfg.denyWinKey ?? true,
      sensitiveWindowTitles: cfg.sensitiveWindowTitles ?? [],
    };
    this.maxScreenshotEdge = Math.max(1, Math.floor(options.maxScreenshotEdge ?? DEFAULT_MAX_SCREENSHOT_EDGE));
    this.pendingApprovalTtlMs = Math.max(
      0,
      Math.floor(options.pendingApprovalTtlMs ?? DEFAULT_PENDING_APPROVAL_TTL_MS),
    );
    this.maxPendingApprovals = Math.max(
      1,
      Math.floor(options.maxPendingApprovals ?? DEFAULT_MAX_PENDING_APPROVALS),
    );
  }

  // ------------------------------ approvals -------------------------------

  private pruneExpiredApprovals(): void {
    const now = Date.now();
    for (const [id, entry] of this.pendingApprovals) {
      if (now - Date.parse(entry.record.createdAt) > this.pendingApprovalTtlMs) {
        this.pendingApprovals.delete(id);
      }
    }
  }

  private evictOverflowingApprovals(): void {
    while (this.pendingApprovals.size >= this.maxPendingApprovals) {
      const oldest = this.pendingApprovals.keys().next();
      if (oldest.done || oldest.value === undefined) {
        break;
      }
      this.pendingApprovals.delete(oldest.value);
    }
  }

  /**
   * Subscribe to newly created CC-TOOL-4002 pending approvals. Returns an
   * unsubscribe function so gateways/session managers can bridge desktop
   * safety-gate hits to remote approval clients.
   */
  onApprovalRequest(listener: (approval: PendingApproval) => void): () => void {
    this.approvalListeners.add(listener);
    return () => {
      this.approvalListeners.delete(listener);
    };
  }

  listPendingApprovals(): PendingApproval[] {
    this.pruneExpiredApprovals();
    return [...this.pendingApprovals.values()].map((entry) => ({
      ...entry.record,
      originalAction: { ...entry.record.originalAction },
    }));
  }

  /**
   * Execute the originally requested action for an approved pending item.
   * The pending item is consumed either way.
   */
  async approve(approvalId: string): Promise<ApprovalDecision> {
    this.pruneExpiredApprovals();
    const entry = this.pendingApprovals.get(approvalId);
    if (!entry) {
      throw new ComputerUseError(`Unknown approval id: ${approvalId}`);
    }
    this.pendingApprovals.delete(approvalId);
    const result = await entry.run();
    return { approvalId, approved: true, executed: true, result };
  }

  /** Discard a pending action without executing it. */
  reject(approvalId: string, reason?: string): ApprovalDecision {
    this.pruneExpiredApprovals();
    const entry = this.pendingApprovals.get(approvalId);
    if (!entry) {
      throw new ComputerUseError(`Unknown approval id: ${approvalId}`);
    }
    this.pendingApprovals.delete(approvalId);
    return {
      approvalId,
      approved: false,
      executed: false,
      reason: reason ?? 'rejected by operator',
    };
  }

  private requestApproval(
    toolName: string,
    reason: string,
    originalAction: Record<string, unknown>,
    run: () => Promise<unknown>,
  ): ApprovalRequiredResult {
    this.pruneExpiredApprovals();
    this.evictOverflowingApprovals();
    const approvalId = randomUUID();
    const record: PendingApproval = {
      approvalId,
      toolName,
      reason,
      originalAction: { ...originalAction },
      createdAt: new Date().toISOString(),
    };
    this.pendingApprovals.set(approvalId, { record, run });
    for (const listener of this.approvalListeners) {
      listener({
        ...record,
        originalAction: { ...record.originalAction },
      });
    }
    return {
      status: 'approval_required',
      code: 'CC-TOOL-4002',
      category: 'TOOL',
      recoveryAction: 'AWAIT_APPROVAL',
      approvalId,
      toolName,
      reason,
      originalAction: record.originalAction,
      error: buildApprovalRequiredError(
        `Tool approval required (${toolName}): ${reason}`,
      ),
    };
  }

  // ------------------------------ screenshot ------------------------------

  async screenshot(): Promise<{
    mimeType: 'image/png';
    imageBase64: string;
    /** Physical screen size the coordinates act on. */
    width: number;
    height: number;
    /** Pixel size of the returned (possibly scaled) PNG. */
    scaledWidth: number;
    scaledHeight: number;
  }> {
    const script = this.buildScreenshotScript();
    const result = await this.executor.exec(script);
    if (result.exitCode !== 0) {
      throw new ComputerUseError(`computer_screenshot failed: ${result.stderr || result.stdout}`);
    }
    const payload = parseMarkedJson(result.stdout, SCREEN_MARKER);
    return {
      mimeType: 'image/png',
      imageBase64: String(payload.base64),
      width: Number(payload.width),
      height: Number(payload.height),
      scaledWidth: Number(payload.scaledWidth),
      scaledHeight: Number(payload.scaledHeight),
    };
  }

  private buildScreenshotScript(): string {
    const maxEdge = this.maxScreenshotEdge;
    return [
      "$ErrorActionPreference = 'Stop'",
      PS_OUTPUT_ENCODING_HEADER,
      'Add-Type -AssemblyName System.Drawing',
      'Add-Type -AssemblyName System.Windows.Forms',
      '$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
      '$w = [int]$bounds.Width',
      '$h = [int]$bounds.Height',
      `$maxEdge = ${maxEdge}`,
      '$scale = 1.0',
      'if ($w -gt $maxEdge) { $scale = $maxEdge / $w }',
      'if (($h * $scale) -gt $maxEdge) { $scale = $maxEdge / $h }',
      '$sw = [Math]::Max(1, [int]($w * $scale))',
      '$sh = [Math]::Max(1, [int]($h * $scale))',
      '$bmp = New-Object System.Drawing.Bitmap($w, $h)',
      '$graphics = [System.Drawing.Graphics]::FromImage($bmp)',
      '$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)',
      '$graphics.Dispose()',
      '$out = $bmp',
      'if ($scale -lt 1.0) {',
      '  $out = New-Object System.Drawing.Bitmap($bmp, $sw, $sh)',
      '  $bmp.Dispose()',
      '}',
      '$memory = New-Object System.IO.MemoryStream',
      '$out.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)',
      '$base64 = [Convert]::ToBase64String($memory.ToArray())',
      '$memory.Dispose()',
      '$out.Dispose()',
      `Write-Output ('${SCREEN_MARKER}{"width":' + $w + ',"height":' + $h + ',"scaledWidth":' + $sw + ',"scaledHeight":' + $sh + ',"base64":"' + $base64 + '"}')`,
    ].join('\n');
  }

  // ------------------------------ mouse -----------------------------------

  async mouseAction(input: MouseActionInput): Promise<MouseActionResult | ApprovalRequiredResult> {
    const risk = this.assessMouseRisk(input);
    if (risk) {
      return this.requestApproval('computer_mouse_action', risk, { ...input }, async () => {
        return this.executeMouseAction(input);
      });
    }
    return this.executeMouseAction(input);
  }

  private assessMouseRisk(input: MouseActionInput): string | null {
    const gesture = input.action !== 'move';
    const fullScreen =
      input.x === undefined || input.y === undefined ||
      (input.action === 'drag' && (input.x2 === undefined || input.y2 === undefined));
    if (gesture && fullScreen && this.policy.blockFullScreenClicks) {
      return `Full-screen mouse gesture ('${input.action}' without explicit coordinates) requires approval`;
    }
    return null;
  }

  private async executeMouseAction(input: MouseActionInput): Promise<MouseActionResult> {
    if (input.action === 'drag') {
      if (input.x === undefined || input.y === undefined || input.x2 === undefined || input.y2 === undefined) {
        throw new ComputerUseError("computer_mouse_action drag requires x, y, x2 and y2");
      }
    }
    const script = this.buildMouseScript(input);
    const result = await this.executor.exec(script);
    if (result.exitCode !== 0) {
      throw new ComputerUseError(`computer_mouse_action failed: ${result.stderr || result.stdout}`);
    }
    parseMarkedJson(result.stdout, MOUSE_OK_MARKER);
    const outcome: MouseActionResult = { performed: input.action };
    if (input.x !== undefined) outcome.x = input.x;
    if (input.y !== undefined) outcome.y = input.y;
    return outcome;
  }

  private buildMouseScript(input: MouseActionInput): string {
    const hasTarget = input.x !== undefined && input.y !== undefined;
    const lines: string[] = [
      "$ErrorActionPreference = 'Stop'",
      PS_OUTPUT_ENCODING_HEADER,
      NATIVE_MOUSE_TYPE,
      ...NATIVE_MOUSE_BOOT,
    ];
    switch (input.action) {
      case 'move': {
        if (!hasTarget) {
          throw new ComputerUseError('computer_mouse_action move requires x and y');
        }
        lines.push(...mouseMoveLines(input.x!, input.y!));
        break;
      }
      case 'left_click': {
        if (hasTarget) lines.push(...mouseMoveLines(input.x!, input.y!));
        lines.push(...mouseClickLines('0x2', '0x4'));
        break;
      }
      case 'double_click': {
        if (hasTarget) lines.push(...mouseMoveLines(input.x!, input.y!));
        lines.push(...mouseClickLines('0x2', '0x4'));
        lines.push(...mouseClickLines('0x2', '0x4'));
        break;
      }
      case 'right_click': {
        if (hasTarget) lines.push(...mouseMoveLines(input.x!, input.y!));
        lines.push(...mouseClickLines('0x8', '0x10'));
        break;
      }
      case 'drag': {
        lines.push(...mouseMoveLines(input.x!, input.y!));
        lines.push('[CCNativeMouse]::mouse_event(0x2, 0, 0, 0, [UIntPtr]::Zero)');
        lines.push(...mouseMoveLines(input.x2!, input.y2!));
        lines.push('Start-Sleep -Milliseconds 20');
        lines.push('[CCNativeMouse]::mouse_event(0x4, 0, 0, 0, [UIntPtr]::Zero)');
        break;
      }
    }
    lines.push(
      `Write-Output ('${MOUSE_OK_MARKER}{"performed":"' + '${input.action}' + '"}')`,
    );
    return lines.join('\n');
  }

  // ------------------------------ keyboard --------------------------------

  async keyboardAction(
    input: KeyboardActionInput,
  ): Promise<KeyboardActionResult | ApprovalRequiredResult> {
    if (input.action === 'hotkey') {
      const combo = input.keys?.trim();
      if (!combo) {
        throw new ComputerUseError('computer_keyboard_action hotkey requires keys');
      }
      const risk = this.assessHotkeyRisk(combo);
      if (risk) {
        return this.requestApproval('computer_keyboard_action', risk, { ...input }, async () => {
          return this.executeKeyboardAction(input);
        });
      }
      return this.executeKeyboardAction(input);
    }
    if (input.action === 'type') {
      if (typeof input.text !== 'string') {
        throw new ComputerUseError('computer_keyboard_action type requires text');
      }
      return this.executeKeyboardAction(input);
    }
    throw new ComputerUseError(`Unknown keyboard action: ${String((input as { action?: unknown }).action)}`);
  }

  private assessHotkeyRisk(combo: string): string | null {
    const tokens = combo.toLowerCase().split('+').map((token) => token.trim()).filter(Boolean);
    if (tokens.length === 0) {
      throw new ComputerUseError(`Invalid hotkey combo: ${combo}`);
    }
    const normalized = normalizeComboTokens(tokens);
    if (this.policy.denyWinKey && tokens.some((token) => WIN_KEY_TOKENS.has(token))) {
      return `Hotkey combo '${combo}' contains the Win/Meta key and requires approval`;
    }
    if (this.policy.deniedCombos.has(normalized)) {
      return `Hotkey combo '${combo}' matches the denied combo list and requires approval`;
    }
    return null;
  }

  private async executeKeyboardAction(input: KeyboardActionInput): Promise<KeyboardActionResult> {
    if (input.action === 'type') {
      const script = this.buildTypeScript(input.text!);
      const result = await this.executor.exec(script);
      if (result.exitCode !== 0) {
        throw new ComputerUseError(`computer_keyboard_action type failed: ${result.stderr || result.stdout}`);
      }
      parseMarkedJson(result.stdout, TYPE_OK_MARKER);
      return { performed: 'type', text: input.text };
    }
    const combo = input.keys!.trim();
    const vkSequence = resolveComboVkSequence(combo);
    const script = this.buildHotkeyScript(vkSequence);
    const result = await this.executor.exec(script);
    if (result.exitCode !== 0) {
      throw new ComputerUseError(`computer_keyboard_action hotkey failed: ${result.stderr || result.stdout}`);
    }
    parseMarkedJson(result.stdout, HOTKEY_OK_MARKER);
    return { performed: 'hotkey', keys: combo };
  }

  private buildTypeScript(text: string): string {
    const escaped = escapeSendKeys(text);
    const psLiteral = escapePsSingleQuoted(escaped);
    return [
      "$ErrorActionPreference = 'Stop'",
      PS_OUTPUT_ENCODING_HEADER,
      'Add-Type -AssemblyName System.Windows.Forms',
      '[System.Windows.Forms.SendKeys]::SendWait(\'' + psLiteral + '\')',
      `Write-Output ('${TYPE_OK_MARKER}{"performed":"type"}')`,
    ].join('\n');
  }

  private buildHotkeyScript(sequence: Array<{ vk: number; isModifier: boolean }>): string {
    const lines: string[] = [
      "$ErrorActionPreference = 'Stop'",
      PS_OUTPUT_ENCODING_HEADER,
      NATIVE_KEYBOARD_TYPE,
      ...NATIVE_KEYBOARD_BOOT,
    ];
    for (const step of sequence.filter((step) => step.isModifier)) {
      lines.push(`[CCNativeKeyboard]::keybd_event(0x${step.vk.toString(16)}, 0, 0, [UIntPtr]::Zero)`);
    }
    for (const step of sequence.filter((step) => !step.isModifier)) {
      lines.push(`[CCNativeKeyboard]::keybd_event(0x${step.vk.toString(16)}, 0, 0, [UIntPtr]::Zero)`);
    }
    lines.push('Start-Sleep -Milliseconds 30');
    const reversed = [...sequence].reverse();
    for (const step of reversed) {
      lines.push(`[CCNativeKeyboard]::keybd_event(0x${step.vk.toString(16)}, 0, 2, [UIntPtr]::Zero)`);
    }
    lines.push(
      `Write-Output ('${HOTKEY_OK_MARKER}{"performed":"hotkey"}')`,
    );
    return lines.join('\n');
  }

  // ------------------------------ windows ---------------------------------

  async windowList(): Promise<WindowListResult> {
    const script = this.buildWindowListScript();
    const result = await this.executor.exec(script);
    if (result.exitCode !== 0) {
      throw new ComputerUseError(`computer_window_list failed: ${result.stderr || result.stdout}`);
    }
    const windows: WindowListItem[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.startsWith(WINDOW_MARKER)) {
        continue;
      }
      const body = line.slice(WINDOW_MARKER.length);
      const sep = body.indexOf(WINDOW_SEP);
      if (sep === -1) {
        continue;
      }
      windows.push({
        hwnd: Number(body.slice(0, sep)),
        title: body.slice(sep + WINDOW_SEP.length),
      });
    }
    return { windows };
  }

  private buildWindowListScript(): string {
    return [
      "$ErrorActionPreference = 'Stop'",
      PS_OUTPUT_ENCODING_HEADER,
      NATIVE_WINDOW_TYPE,
      ...NATIVE_WINDOW_BOOT,
      `$items = [CCWindowEnum]::Enumerate()`,
      `foreach ($item in $items) { Write-Output ('${WINDOW_MARKER}' + $item) }`,
    ].join('\n');
  }

  /**
   * Read back a window's title by handle (used before the safety policy runs
   * on hwnd-only focus requests, so sensitive-title rules cannot be bypassed).
   * The title travels base64-encoded, immune to console codepage issues.
   */
  private async resolveWindowTitle(hwnd: number): Promise<string> {
    const script = this.buildWindowTitleScript(hwnd);
    const result = await this.executor.exec(script);
    if (result.exitCode !== 0) {
      throw new ComputerUseError(`computer_window_focus title readback failed: ${result.stderr || result.stdout}`);
    }
    return parseMarkedBase64(result.stdout, TITLE_MARKER);
  }

  private buildWindowTitleScript(hwnd: number): string {
    return [
      "$ErrorActionPreference = 'Stop'",
      PS_OUTPUT_ENCODING_HEADER,
      NATIVE_WINDOW_TYPE,
      ...NATIVE_WINDOW_BOOT,
      `$target = [IntPtr]::new(${Math.floor(hwnd)})`,
      '$title = [CCWindowEnum]::GetTitle($target)',
      `Write-Output ('${TITLE_MARKER}' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($title)))`,
    ].join('\n');
  }

  async windowFocus(input: WindowFocusInput): Promise<WindowFocusResult | ApprovalRequiredResult> {
    if (input.hwnd === undefined && !input.title) {
      throw new ComputerUseError('computer_window_focus requires hwnd or title');
    }
    if (input.title !== undefined) {
      const risk = this.assessWindowFocusRisk(input.title);
      if (risk) {
        return this.requestApproval('computer_window_focus', risk, { ...input }, async () => {
          return this.executeWindowFocus(input);
        });
      }
      return this.executeWindowFocus(input);
    }
    // hwnd-only path: resolve the window title first so sensitive-title rules
    // cannot be bypassed by focusing by handle instead of by title.
    if (this.policy.sensitiveWindowTitles.length > 0) {
      const resolvedTitle = await this.resolveWindowTitle(input.hwnd!);
      const risk = this.assessWindowFocusRisk(resolvedTitle);
      if (risk) {
        return this.requestApproval(
          'computer_window_focus',
          risk,
          { ...input, resolvedTitle },
          async () => {
            return this.executeWindowFocus(input);
          },
        );
      }
    }
    return this.executeWindowFocus(input);
  }

  private assessWindowFocusRisk(title: string): string | null {
    for (const rule of this.policy.sensitiveWindowTitles) {
      if (rule instanceof RegExp) {
        if (rule.test(title)) {
          return `Window title '${title}' matches sensitive title pattern ${rule} and requires approval`;
        }
      } else if (title.toLowerCase().includes(rule.toLowerCase())) {
        return `Window title '${title}' matches sensitive title rule '${rule}' and requires approval`;
      }
    }
    return null;
  }

  private async executeWindowFocus(input: WindowFocusInput): Promise<WindowFocusResult> {
    const script = this.buildWindowFocusScript(input);
    const result = await this.executor.exec(script);
    if (result.exitCode !== 0) {
      throw new ComputerUseError(`computer_window_focus failed: ${result.stderr || result.stdout}`);
    }
    const payload = parseMarkedJson(result.stdout, FOCUS_MARKER);
    const outcome: WindowFocusResult = {
      focused: payload.focused === true || payload.focused === 'True' || payload.focused === 'true',
    };
    if (payload.hwnd !== undefined && payload.hwnd !== null && payload.hwnd !== '') {
      outcome.hwnd = Number(payload.hwnd);
    }
    if (typeof payload.title === 'string' && payload.title.length > 0) {
      outcome.title = payload.title;
    }
    return outcome;
  }

  private buildWindowFocusScript(input: WindowFocusInput): string {
    const lines: string[] = [
      "$ErrorActionPreference = 'Stop'",
      PS_OUTPUT_ENCODING_HEADER,
      NATIVE_WINDOW_TYPE,
      ...NATIVE_WINDOW_BOOT,
    ];
    if (input.hwnd !== undefined) {
      lines.push(`$target = [IntPtr]::new(${Math.floor(input.hwnd)})`);
    } else {
      lines.push(`$target = [CCWindowEnum]::FindWindow($null, '${escapePsSingleQuoted(input.title!)}')`);
    }
    lines.push('if ($target -eq [IntPtr]::Zero) { throw "window not found" }');
    lines.push('$null = [CCWindowEnum]::ShowWindow($target, 9)');
    lines.push('$ok = [CCWindowEnum]::SetForegroundWindow($target)');
    if (input.title !== undefined) {
      // The title is echoed inside a JSON string literal: escape backslashes and
      // double quotes for JSON, then escape single quotes for the PS literal.
      const jsonTitle = escapePsDoubleQuoted(input.title);
      lines.push(
        `Write-Output ('${FOCUS_MARKER}{"focused":' + $ok + ',"hwnd":' + ([long]$target) + ',"title":"' + '${escapePsSingleQuoted(jsonTitle)}' + '"}')`,
      );
    } else {
      lines.push(
        `Write-Output ('${FOCUS_MARKER}{"focused":' + $ok + ',"hwnd":' + ([long]$target) + '}')`,
      );
    }
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Script building blocks (no PS backtick escapes anywhere — quote doubling only)
// ---------------------------------------------------------------------------

const NATIVE_MOUSE_TYPE = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class CCNativeMouse {',
  '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);',
  '}',
  '"@',
].join('\n');

const NATIVE_MOUSE_BOOT = ['$null = [CCNativeMouse]'];

const NATIVE_KEYBOARD_TYPE = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'public static class CCNativeKeyboard {',
  '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
  '}',
  '"@',
].join('\n');

const NATIVE_KEYBOARD_BOOT = ['$null = [CCNativeKeyboard]'];

const NATIVE_WINDOW_TYPE = [
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Text;',
  'using System.Collections.Generic;',
  'using System.Runtime.InteropServices;',
  'public static class CCWindowEnum {',
  '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string windowName);',
  '  public static string GetTitle(IntPtr hWnd) {',
  '    var sb = new StringBuilder(512);',
  '    GetWindowText(hWnd, sb, 512);',
  '    return sb.ToString();',
  '  }',
  '  public static List<string> Enumerate() {',
  '    var list = new List<string>();',
  '    EnumWindows((hWnd, lParam) => {',
  '      if (!IsWindowVisible(hWnd)) return true;',
  '      var sb = new StringBuilder(512);',
  '      GetWindowText(hWnd, sb, 512);',
  '      var title = sb.ToString();',
  '      if (title.Length == 0) return true;',
  '      list.Add(((long)hWnd).ToString() + "__SEP__" + title);',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return list;',
  '  }',
  '}',
  '"@',
].join('\n');

const NATIVE_WINDOW_BOOT = ['$null = [CCWindowEnum]'];

function mouseMoveLines(x: number, y: number): string[] {
  return [
    `$null = [CCNativeMouse]::SetCursorPos(${Math.floor(x)}, ${Math.floor(y)})`,
  ];
}

function mouseClickLines(downFlag: string, upFlag: string): string[] {
  return [
    `[CCNativeMouse]::mouse_event(${downFlag}, 0, 0, 0, [UIntPtr]::Zero)`,
    'Start-Sleep -Milliseconds 10',
    `[CCNativeMouse]::mouse_event(${upFlag}, 0, 0, 0, [UIntPtr]::Zero)`,
    'Start-Sleep -Milliseconds 10',
  ];
}

// ------------------------------ parsing helpers ---------------------------

function parseMarkedJson(stdout: string, marker: string): Record<string, unknown> {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(marker)) {
      continue;
    }
    const body = line.slice(marker.length);
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch (error) {
      throw new ComputerUseError(
        `Failed to parse PowerShell output: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new ComputerUseError(`PowerShell output did not contain the ${marker} marker`);
}

/** Parse a base64-encoded UTF-8 value printed after `marker` (codepage-proof channel). */
function parseMarkedBase64(stdout: string, marker: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(marker)) {
      continue;
    }
    const body = line.slice(marker.length).trim();
    return Buffer.from(body, 'base64').toString('utf8');
  }
  throw new ComputerUseError(`PowerShell output did not contain the ${marker} marker`);
}
/** Escape a value for embedding inside a PowerShell single-quoted literal. */
function escapePsSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

/** Escape a value for embedding inside a PowerShell double-quoted JSON fragment. */
function escapePsDoubleQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ------------------------------ keyboard helpers --------------------------

const WIN_KEY_TOKENS = new Set(['win', 'meta', 'windows']);

function escapeSendKeys(text: string): string {
  let out = '';
  for (const char of text) {
    if ('+^%~(){}[]'.includes(char)) {
      out += `{${char}}`;
    } else {
      out += char;
    }
  }
  return out;
}

const KEY_TOKEN_VK: Record<string, number> = buildKeyTokenVk();

function buildKeyTokenVk(): Record<string, number> {
  const table: Record<string, number> = {
    ctrl: 0x11,
    control: 0x11,
    alt: 0x12,
    shift: 0x10,
    win: 0x5b,
    meta: 0x5b,
    windows: 0x5b,
    tab: 0x09,
    enter: 0x0d,
    return: 0x0d,
    esc: 0x1b,
    escape: 0x1b,
    space: 0x20,
    backspace: 0x08,
    delete: 0x2e,
    del: 0x2e,
    insert: 0x2d,
    home: 0x24,
    end: 0x23,
    pageup: 0x21,
    pagedown: 0x22,
    up: 0x26,
    down: 0x28,
    left: 0x25,
    right: 0x27,
    printscreen: 0x2c,
    capslock: 0x14,
  };
  for (let i = 0x41; i <= 0x5a; i++) {
    table[String.fromCharCode(i).toLowerCase()] = i;
  }
  for (let i = 0x30; i <= 0x39; i++) {
    table[String.fromCharCode(i)] = i;
  }
  for (let i = 1; i <= 12; i++) {
    table[`f${i}`] = 0x6f + i;
  }
  return table;
}

function normalizeComboTokens(input: string | string[]): string {
  const tokens =
    typeof input === 'string'
      ? input.split('+')
      : input;
  return tokens
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join('+');
}

function normalizeCombo(combo: string): string[] {
  return combo.toLowerCase().split('+').map((token) => token.trim()).filter(Boolean);
}

const MODIFIER_TOKENS = new Set(['ctrl', 'control', 'alt', 'shift', 'win', 'meta', 'windows']);

function resolveComboVkSequence(
  combo: string,
): Array<{ vk: number; isModifier: boolean }> {
  const tokens = normalizeCombo(combo);
  if (tokens.length === 0) {
    throw new ComputerUseError(`Invalid hotkey combo: ${combo}`);
  }
  const sequence: Array<{ vk: number; isModifier: boolean }> = [];
  for (const token of tokens) {
    const vk = KEY_TOKEN_VK[token];
    if (vk === undefined) {
      throw new ComputerUseError(`Unknown key token '${token}' in combo '${combo}'`);
    }
    sequence.push({ vk, isModifier: MODIFIER_TOKENS.has(token) });
  }
  return sequence;
}
