import { contextBridge, ipcRenderer } from 'electron';

/**
 * Narrow, context-isolated bridge. The renderer never gets Node or ipcRenderer
 * directly — only these explicit capabilities.
 */
const api = {
  isDesktop: true as const,
  platform: process.platform,
  /** Fires when the global shortcut (default Alt+Shift+C) asks for the palette. */
  onTogglePalette(callback: () => void): () => void {
    const listener = (): void => callback();
    ipcRenderer.on('crosscode:toggle-palette', listener);
    return () => ipcRenderer.removeListener('crosscode:toggle-palette', listener);
  },
  /** Fires when the window regains focus while approvals are pending. */
  onFocusApprovals(callback: () => void): () => void {
    const listener = (): void => callback();
    ipcRenderer.on('crosscode:focus-approvals', listener);
    return () => ipcRenderer.removeListener('crosscode:focus-approvals', listener);
  },
};

contextBridge.exposeInMainWorld('crosscodeDesktop', api);

export type CrossCodeDesktopBridge = typeof api;
