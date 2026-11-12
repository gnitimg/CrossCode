import {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  clipboard,
  globalShortcut,
  nativeImage,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startDaemonRuntime, type ApprovalNotification, type DaemonRuntime } from './daemon-runtime.js';

/**
 * CrossCode desktop shell.
 *
 * Responsibilities:
 * - boot the daemon in-process (no external Node/service required),
 * - host the workbench from the daemon origin (single origin for REST + WS),
 * - stay resident in the tray instead of dying with the window,
 * - raise a native notification for `CC-TOOL-4002` approval requests,
 * - register a global shortcut that opens the command palette from anywhere.
 */

const GLOBAL_PALETTE_SHORTCUT = 'Alt+Shift+C';
const isSmokeTest = process.argv.includes('--smoke-test');
const isSmokeWindow = process.argv.includes('--smoke-window');

let runtime: DaemonRuntime | null = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let pendingApprovals = 0;

/** Resolves the built workbench directory in dev and packaged layouts. */
function resolveWebDist(): string {
  const candidates = [
    process.env.CROSSCODE_WEB_DIST,
    path.join(process.resourcesPath ?? '', 'web'),
    path.resolve(__dirname, '../../web/dist'),
    path.resolve(app.getAppPath(), '../web/dist'),
    path.resolve(app.getAppPath(), 'web'),
  ].filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  throw new Error(`workbench build not found (looked in: ${candidates.join(', ')})`);
}

function resolveWorkspaceRoots(): string[] {
  const configured = process.env.CROSSCODE_WORKSPACES;
  if (configured) {
    return configured
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  const home = os.homedir();
  return [path.join(home, 'cs'), path.join(home, 'projects'), home];
}

function showWindow(): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function createWindow(url: string, origin: string): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    show: false,
    backgroundColor: '#0a0a0c',
    title: 'CrossCode',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Keep the shell pinned to its own origin; everything else opens externally.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(origin)) {
      event.preventDefault();
      void shell.openExternal(target);
    }
  });

  // Closing the window hides it: the daemon keeps running in the tray.
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  void mainWindow.loadURL(url);
}

function notifyApproval(approval: ApprovalNotification): void {
  pendingApprovals += 1;
  updateTrayTooltip();

  if (!Notification.isSupported()) return;

  const summary = approval.args.command
    ? String(approval.args.command).slice(0, 120)
    : approval.args.ref ?? approval.args.url ?? JSON.stringify(approval.args).slice(0, 120);

  const notification = new Notification({
    title: `待审批 · ${approval.toolName}`,
    body: `${summary}\n点击打开 CrossCode 处理此操作`,
    urgency: 'critical',
    silent: false,
  });
  notification.on('click', () => {
    showWindow();
    mainWindow?.webContents.send('crosscode:focus-approvals');
  });
  notification.show();
}

function updateTrayTooltip(): void {
  if (!tray) return;
  tray.setToolTip(
    pendingApprovals > 0 ? `CrossCode — ${pendingApprovals} 个待审批操作` : 'CrossCode — 守护进程运行中',
  );
  tray.setTitle(pendingApprovals > 0 ? String(pendingApprovals) : '');
}

function trayIcon(): Electron.NativeImage {
  const iconPath = path.join(__dirname, '../build/tray.png');
  const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  return image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 16, height: 16 });
}

function createTray(): void {
  tray = new Tray(trayIcon());
  updateTrayTooltip();

  const template: MenuItemConstructorOptions[] = [
    { label: '打开 CrossCode', click: () => showWindow() },
    {
      label: '在浏览器中打开',
      click: () => {
        if (runtime) void shell.openExternal(runtime.baseUrl);
      },
    },
    { type: 'separator' },
    {
      label: '复制配对 PIN',
      click: () => {
        if (!runtime) return;
        clipboard.writeText(runtime.pin);
        new Notification({ title: '配对 PIN 已复制', body: runtime.pin }).show();
      },
    },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ];

  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.on('click', () => showWindow());
}

async function bootstrap(): Promise<void> {
  runtime = await startDaemonRuntime({
    webDistDir: resolveWebDist(),
    configDir: app.getPath('userData'),
    workspaceRoots: resolveWorkspaceRoots(),
    onApprovalRequest: notifyApproval,
  });

  if (isSmokeTest) {
    // Headless verification: daemon boots, self-pairs, serves the SPA, rewrites
    // the `/api` prefix and enforces bearer auth on the rewritten route.
    const checks: Array<[string, boolean]> = [];
    const spaResponse = await fetch(runtime.baseUrl, { redirect: 'manual' });
    const html = await spaResponse.text();
    checks.push(['spa', spaResponse.ok && html.includes('<div id="root">')]);

    const assetPath = /src="([^"]+\.js)"/.exec(html)?.[1];
    if (assetPath) {
      const assetResponse = await fetch(`${runtime.baseUrl}${assetPath}`);
      checks.push(['asset', assetResponse.ok && (assetResponse.headers.get('content-type') ?? '').includes('javascript')]);
    } else {
      checks.push(['asset', false]);
    }

    const unauthorized = await fetch(`${runtime.baseUrl}/api/projects`);
    checks.push(['api-prefix+auth', unauthorized.status === 401]);

    const authorized = await fetch(`${runtime.baseUrl}/api/projects`, {
      headers: { authorization: `Bearer ${runtime.token}` },
    });
    const projects = authorized.ok ? ((await authorized.json()) as unknown[]) : null;
    checks.push(['api-authorized', authorized.ok && Array.isArray(projects)]);

    const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
    console.log(
      `[smoke] daemon=${runtime.baseUrl} port=${runtime.port} ` +
        checks.map(([name, ok]) => `${name}=${ok ? 'ok' : 'FAIL'}`).join(' '),
    );
    await runtime.close();
    app.exit(failed.length === 0 ? 0 : 1);
    return;
  }

  createWindow(runtime.url, runtime.baseUrl);

  if (isSmokeWindow) {
    // Verifies the real renderer: preload bridge, React boot, IPC channel.
    const finish = (code: number, detail: string): void => {
      console.log(`[smoke-window] ${detail}`);
      isQuitting = true;
      void runtime?.close().finally(() => app.exit(code));
    };
    const timer = setTimeout(() => finish(1, 'renderer did not load within 25s'), 25_000);
    mainWindow?.webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timer);
      finish(1, `load failed: ${code} ${description}`);
    });
    mainWindow?.webContents.once('did-finish-load', async () => {
      clearTimeout(timer);
      try {
        const probe = (await mainWindow?.webContents.executeJavaScript(
          'Boolean(window.crosscodeDesktop && window.crosscodeDesktop.isDesktop)',
        )) as boolean;
        finish(probe ? 0 : 1, `renderer loaded, preload bridge=${probe}`);
      } catch (error) {
        finish(1, `renderer probe failed: ${String(error)}`);
      }
    });
    return;
  }

  createTray();

  const registered = globalShortcut.register(GLOBAL_PALETTE_SHORTCUT, () => {
    showWindow();
    mainWindow?.webContents.send('crosscode:toggle-palette');
  });
  if (!registered) {
    console.warn(`[crosscode] global shortcut ${GLOBAL_PALETTE_SHORTCUT} is already taken`);
  }
}

if (!isSmokeTest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(bootstrap).catch((error: unknown) => {
    console.error('[crosscode] startup failed', error);
    app.exit(1);
  });

  app.on('activate', () => {
    if (mainWindow) showWindow();
  });

  app.on('window-all-closed', () => {
    // Tray-resident: never quit when the last window closes.
  });

  app.on('before-quit', () => {
    isQuitting = true;
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    void runtime?.close();
  });
}
