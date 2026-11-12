import { useEffect, useState } from 'react';
import { Loader2, Terminal } from 'lucide-react';
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
    <div className="grid h-dvh place-items-center bg-obsidian text-zinc-400">
      <div className="flex items-center gap-2.5 font-mono text-[12px]">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-300" />
        <span>connecting to crosscode daemon...</span>
      </div>
    </div>
  );
}

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
    <div className="grid h-dvh place-items-center bg-obsidian text-zinc-300">
      <div className="panel flex w-[340px] max-w-[92vw] flex-col gap-4 p-6">
        <div className="flex items-center gap-2 border-b hairline pb-3">
          <Terminal className="h-4 w-4 text-zinc-200" />
          <span className="font-mono text-[13px] font-semibold text-zinc-100">CrossCode Daemon</span>
          <span className="chip ml-auto">AUTH</span>
        </div>

        <div className="text-[12px] text-zinc-400">
          输入本地终端输出的 6 位 PIN 码以授权当前设备访问。
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
          placeholder="000000"
          className="w-full rounded border hairline bg-obsidian py-2 text-center font-mono text-[20px] tracking-[0.45em] text-zinc-100 outline-none transition focus:border-zinc-500"
        />

        {error && <div className="font-mono text-[11px] text-rosefire">{error}</div>}

        <button
          type="button"
          className="btn btn-primary w-full !h-8"
          disabled={pin.length !== 6 || busy}
          onClick={() => void submit()}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {busy ? '验证中…' : '连接守护进程'}
        </button>

        <button
          type="button"
          className="btn btn-ghost w-full !h-7 font-mono text-[11px]"
          onClick={() => enterDemoMode('offline preview')}
        >
          离线预览 (Mock 数据)
        </button>
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
    <div className="flex h-dvh flex-col overflow-hidden bg-obsidian text-zinc-200">
      <TopSwitchboardBar />
      {hasErrors && <ErrorSelfHealBanner />}
      <div className="flex min-h-0 flex-1 pb-12 md:pb-0">
        <aside
          className={cn(
            'min-w-0 flex-col border-r hairline bg-panel',
            mobilePane === 'projects' ? 'flex w-full' : 'hidden',
            leftOpen ? 'md:flex md:w-64' : 'md:hidden',
          )}
        >
          <SidebarProjectMatrix />
        </aside>
        <main
          className={cn(
            'min-w-0 flex-1 bg-obsidian',
            mobilePane === 'stream' ? 'flex flex-col' : 'hidden md:flex md:flex-col',
          )}
        >
          <UnifiedAgentStream />
        </main>
        <aside
          className={cn(
            'min-w-0 flex-col border-l hairline bg-panel',
            mobilePane === 'inspector' ? 'flex w-full' : 'hidden',
            rightOpen ? 'md:flex md:w-[340px]' : 'md:hidden',
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
