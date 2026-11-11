import { useEffect, useState } from 'react';
import { Hexagon, Loader2 } from 'lucide-react';
import { useWorkbenchStore } from './store/workbench';
import { bootWorkbench, submitPairing, watchProjectSwitch } from './lib/bootstrap';
import { TopSwitchboardBar } from './components/TopSwitchboardBar';
import { SidebarProjectMatrix } from './components/SidebarProjectMatrix';
import { UnifiedAgentStream } from './components/UnifiedAgentStream';
import { InspectorRightPane } from './components/InspectorRightPane';
import { CommandPalette } from './components/CommandPalette';
import { ErrorSelfHealBanner } from './components/ErrorSelfHealBanner';
import { MobileNav } from './components/MobileNav';
import { cn } from './lib/cn';

/**
 * Workbench shell. Desktop (>=768px) renders the three-pane IDE layout
 * (project matrix / unified stream / inspector), each collapsible from the top
 * bar; below 768px a single pane follows the mobile nav selection with a
 * bottom thumb bar and switchboard drawer.
 */
export default function App() {
  const mode = useWorkbenchStore((state) => state.mode);

  useEffect(() => {
    void bootWorkbench();
    return watchProjectSwitch();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        useWorkbenchStore.getState().togglePalette();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (mode === 'boot') return <BootScreen />;
  if (mode === 'offline') return <PairingGate />;
  return <Workbench />;
}

function BootScreen() {
  return (
    <div className="app-aurora relative grid h-dvh place-items-center bg-obsidian text-slate-300">
      <div className="relative z-10 flex flex-col items-center gap-3">
        <div className="grid h-14 w-14 place-items-center rounded-2xl border hairline bg-panel">
          <Hexagon className="breathe h-7 w-7 text-aurora" />
        </div>
        <div className="flex items-center gap-2 text-[13px] text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在连接守护进程…
        </div>
      </div>
    </div>
  );
}

/** 6-digit PIN pairing gate shown when no (or an invalid) JWT is stored. */
function PairingGate() {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enterDemoMode = useWorkbenchStore((state) => state.enterDemoMode);

  const submit = async (): Promise<void> => {
    if (pin.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    const message = await submitPairing(pin);
    setBusy(false);
    if (message) setError(message);
  };

  return (
    <div className="app-aurora relative grid h-dvh place-items-center bg-obsidian text-slate-300">
      <div className="panel rise relative z-10 flex w-[380px] max-w-[92vw] flex-col items-center gap-4 p-7">
        <div className="grid h-12 w-12 place-items-center rounded-xl border hairline bg-gradient-to-br from-aurora/25 to-glacier/10">
          <Hexagon className="h-6 w-6 text-aurora" />
        </div>
        <div className="text-center">
          <div className="text-[16px] font-semibold text-slate-100">配对守护进程</div>
          <div className="mt-1 text-[12px] text-slate-500">输入 daemon 显示的 6 位配对 PIN，换取长期 JWT</div>
        </div>
        <input
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="6 位配对 PIN"
          placeholder="······"
          className="w-full rounded-xl border hairline bg-obsidian/60 py-2.5 text-center font-mono text-[22px] tracking-[0.5em] text-slate-100 outline-none transition focus:border-aurora/50 focus:ring-2 focus:ring-aurora/20"
        />
        {error && <div className="text-[12px] text-rosefire">{error}</div>}
        <button
          type="button"
          className="btn btn-primary w-full !h-10"
          disabled={pin.length !== 6 || busy}
          onClick={() => void submit()}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {busy ? '配对中…' : '配对'}
        </button>
        <div className="flex w-full items-center gap-3">
          <span className="h-px flex-1 bg-white/[0.07]" />
          <span className="text-[10px] text-slate-600">或</span>
          <span className="h-px flex-1 bg-white/[0.07]" />
        </div>
        <button
          type="button"
          className="btn btn-ghost w-full !h-9"
          onClick={() => enterDemoMode('手动进入离线演示模式')}
        >
          进入离线演示模式（无需 daemon）
        </button>
        <div className="text-center text-[10px] leading-relaxed text-slate-600">
          默认经 Vite 代理访问 daemon（/api 与 /ws），
          <br />
          可用 VITE_DAEMON_URL / CROSSCODE_DAEMON_URL 指定直连地址
        </div>
      </div>
    </div>
  );
}

function Workbench() {
  const leftOpen = useWorkbenchStore((state) => state.leftOpen);
  const rightOpen = useWorkbenchStore((state) => state.rightOpen);
  const mobilePane = useWorkbenchStore((state) => state.mobilePane);
  const hasErrors = useWorkbenchStore((state) => state.errors.length > 0);

  return (
    <div className="app-aurora relative flex h-dvh flex-col overflow-hidden bg-obsidian text-slate-200">
      <TopSwitchboardBar />
      {hasErrors && <ErrorSelfHealBanner />}
      <div className="relative z-10 flex min-h-0 flex-1 pb-14 md:pb-0">
        <aside
          className={cn(
            'min-w-0 flex-col border-r hairline bg-panel/40',
            mobilePane === 'projects' ? 'flex w-full' : 'hidden',
            leftOpen ? 'md:flex md:w-72' : 'md:hidden',
          )}
        >
          <SidebarProjectMatrix />
        </aside>
        <main
          className={cn(
            'min-w-0 flex-1',
            mobilePane === 'stream' ? 'flex flex-col' : 'hidden md:flex md:flex-col',
          )}
        >
          <UnifiedAgentStream />
        </main>
        <aside
          className={cn(
            'min-w-0 flex-col border-l hairline bg-panel/40',
            mobilePane === 'inspector' ? 'flex w-full' : 'hidden',
            rightOpen ? 'md:flex md:w-[360px]' : 'md:hidden',
          )}
        >
          <InspectorRightPane />
        </aside>
      </div>
      <MobileNav />
      <CommandPalette />
    </div>
  );
}
