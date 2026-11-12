/**
 * Bridge injected by the Electron preload (`packages/desktop/src/preload.ts`).
 * Absent in a plain browser, so every use site must be optional.
 */
export interface CrossCodeDesktopBridge {
  readonly isDesktop: true;
  readonly platform: string;
  /** Global shortcut (Alt+Shift+C) asks the workbench to open the palette. */
  onTogglePalette(callback: () => void): () => void;
  /** A native approval notification was clicked. */
  onFocusApprovals(callback: () => void): () => void;
}

declare global {
  interface Window {
    crosscodeDesktop?: CrossCodeDesktopBridge;
  }
}

export function getDesktopBridge(): CrossCodeDesktopBridge | null {
  return globalThis.window?.crosscodeDesktop ?? null;
}

export function isDesktopShell(): boolean {
  return getDesktopBridge() !== null;
}
