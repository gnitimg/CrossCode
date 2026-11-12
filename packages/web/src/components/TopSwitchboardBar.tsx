import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Command,
  PanelLeftClose,
  PanelLeft,
  PanelRightClose,
  PanelRight,
  Terminal,
} from 'lucide-react';
import { ALL_HARNESS_IDS } from '@crosscode/shared';
import type { AgentMode } from '@crosscode/shared';
import { useWorkbenchStore } from '../store/workbench';
import { HARNESS_META, providerColor } from '../lib/harness';
import { cn } from '../lib/cn';

const MODES: ReadonlyArray<{ id: AgentMode; label: string }> = [
  { id: 'plan', label: 'Plan' },
  { id: 'build', label: 'Build' },
  { id: 'orchestrate', label: 'Orchestrate' },
];

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function StatusIndicator() {
  const mode = useWorkbenchStore((state) => state.mode);
  const wsStatus = useWorkbenchStore((state) => state.wsStatus);
  const reconnectAttempt = useWorkbenchStore((state) => state.reconnectAttempt);
  const latencyMs = useWorkbenchStore((state) => state.latencyMs);
  const tokenUsage = useWorkbenchStore((state) => state.tokenUsage);

  const isDemo = mode === 'demo';
  const isConnecting = wsStatus === 'connecting' || wsStatus === 'authenticating';
  const statusText = isDemo
    ? 'MOCK'
    : wsStatus === 'live'
      ? 'ONLINE'
      : wsStatus === 'reconnecting'
        ? `RETRY #${reconnectAttempt}`
        : isConnecting
          ? 'CONNECTING'
          : 'OFFLINE';

  const dotColor = isDemo
    ? '#a1a1aa'
    : wsStatus === 'live'
      ? '#10b981'
      : isConnecting || wsStatus === 'reconnecting'
        ? '#f59e0b'
        : '#f43f5e';

  const totalTokens = tokenUsage.prompt + tokenUsage.completion;

  return (
    <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-500">
      <span className="inline-flex items-center gap-1.5 text-zinc-300">
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: dotColor }} />
        {statusText}
      </span>
      {latencyMs !== null && (
        <span className="hidden sm:inline" title="API 响应延迟">
          {latencyMs}ms
        </span>
      )}
      {totalTokens > 0 && (
        <span className="hidden sm:inline" title="当前会话累计 Token">
          {formatTokens(totalTokens)} tok
        </span>
      )}
    </div>
  );
}

interface DropdownProps {
  trigger: React.ReactNode;
  menuClassName?: string;
  children: (close: () => void) => React.ReactNode;
}

function Dropdown({ trigger, menuClassName, children }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="btn btn-ghost !h-7 max-w-[180px] gap-1.5 border hairline bg-white/[0.02] px-2 font-mono text-[11.5px]"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {trigger}
        <ChevronDown className={cn('h-3 w-3 shrink-0 text-zinc-500 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            'panel rise absolute left-0 top-[calc(100%+4px)] z-40 flex max-h-[320px] min-w-[200px] flex-col overflow-y-auto p-1 stream-scroll',
            menuClassName,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function HarnessSwitcher() {
  const projects = useWorkbenchStore((state) => state.projects);
  const activeProjectId = useWorkbenchStore((state) => state.activeProjectId);
  const switchHarness = useWorkbenchStore((state) => state.switchHarness);
  const activeHarness = projects.find((project) => project.id === activeProjectId)?.activeHarness ?? 'crosscode-native';
  const meta = HARNESS_META[activeHarness];

  return (
    <Dropdown
      trigger={
        <>
          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
          <span className="truncate text-zinc-200">{meta.label}</span>
        </>
      }
    >
      {(close) => (
        <>
          {ALL_HARNESS_IDS.map((harnessId) => {
            const harnessMeta = HARNESS_META[harnessId];
            const active = harnessId === activeHarness;
            return (
              <button
                key={harnessId}
                type="button"
                role="menuitem"
                className={cn(
                  'flex items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[11.5px] transition',
                  active ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200',
                )}
                onClick={() => {
                  void switchHarness(harnessId);
                  close();
                }}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: harnessMeta.color }} />
                <span className="flex-1 truncate">{harnessMeta.label}</span>
                <span className="text-[10px] text-zinc-600">{harnessMeta.short}</span>
              </button>
            );
          })}
        </>
      )}
    </Dropdown>
  );
}

function ProviderSwitcher() {
  const providers = useWorkbenchStore((state) => state.providers);
  const projects = useWorkbenchStore((state) => state.projects);
  const activeProjectId = useWorkbenchStore((state) => state.activeProjectId);
  const switchProvider = useWorkbenchStore((state) => state.switchProvider);
  const activeProviderId =
    projects.find((project) => project.id === activeProjectId)?.activeProviderId ?? providers[0]?.id ?? null;

  return (
    <Dropdown
      trigger={
        <>
          {activeProviderId && (
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: providerColor(activeProviderId) }}
            />
          )}
          <span className="truncate text-zinc-300">
            {providers.find((provider) => provider.id === activeProviderId)?.label ?? activeProviderId ?? 'Provider'}
          </span>
        </>
      }
    >
      {(close) => (
        <>
          {providers.length === 0 && <div className="px-2 py-1.5 font-mono text-[11px] text-zinc-600">No providers</div>}
          {providers.map((provider) => {
            const active = provider.id === activeProviderId;
            return (
              <button
                key={provider.id}
                type="button"
                role="menuitem"
                className={cn(
                  'flex items-center gap-2 rounded px-2 py-1.5 text-left font-mono text-[11.5px] transition',
                  active ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200',
                )}
                onClick={() => {
                  void switchProvider(provider.id);
                  close();
                }}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: providerColor(provider.id) }}
                />
                <span className="flex-1 truncate">{provider.label}</span>
                <span className="text-[10px] uppercase text-zinc-600">{provider.protocol}</span>
              </button>
            );
          })}
        </>
      )}
    </Dropdown>
  );
}

function ModeSwitcher() {
  const agentMode = useWorkbenchStore((state) => state.agentMode);
  const setAgentMode = useWorkbenchStore((state) => state.setAgentMode);
  const setDrawer = useWorkbenchStore((state) => state.setSwitchboardDrawerOpen);

  return (
    <div className="flex items-center rounded border hairline bg-obsidian p-0.5 font-mono text-[11px]">
      {MODES.map((mode) => {
        const active = agentMode === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            aria-pressed={active}
            onClick={() => {
              setAgentMode(mode.id);
              setDrawer(false);
            }}
            className={cn(
              'rounded-[3px] px-2 py-0.5 transition',
              active ? 'bg-zinc-200 font-semibold text-zinc-950' : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            {mode.label}
          </button>
        );
      })}
    </div>
  );
}

export function TopSwitchboardBar() {
  const leftOpen = useWorkbenchStore((state) => state.leftOpen);
  const rightOpen = useWorkbenchStore((state) => state.rightOpen);
  const toggleLeft = useWorkbenchStore((state) => state.toggleLeft);
  const toggleRight = useWorkbenchStore((state) => state.toggleRight);
  const openPalette = useWorkbenchStore((state) => state.openPalette);

  return (
    <header className="relative z-30 flex h-10 shrink-0 items-center gap-2.5 border-b hairline bg-panel px-3">
      <div className="flex items-center gap-2">
        <Terminal className="h-3.5 w-3.5 text-zinc-300" />
        <span className="font-mono text-[12.5px] font-semibold tracking-tight text-zinc-100">CrossCode</span>
      </div>

      <span className="text-zinc-700">/</span>

      <div className="hidden items-center gap-1.5 md:flex">
        <HarnessSwitcher />
        <ProviderSwitcher />
      </div>

      <StatusIndicator />

      <div className="ml-auto flex items-center gap-1.5">
        <ModeSwitcher />
        <button
          type="button"
          onClick={openPalette}
          className="btn btn-ghost !h-7 gap-1.5 border hairline px-2"
          aria-label="打开命令面板"
          title="Command Palette (Ctrl+K)"
        >
          <Command className="h-3 w-3 text-zinc-400" />
          <span className="kbd hidden sm:inline-flex">Ctrl K</span>
        </button>
        <div className="hidden items-center gap-1 md:flex">
          <button
            type="button"
            onClick={toggleLeft}
            className="btn btn-ghost !h-7 !w-7 !p-0"
            aria-label={leftOpen ? '收起左侧项目栏' : '展开左侧项目栏'}
            aria-pressed={leftOpen}
          >
            {leftOpen ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeft className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={toggleRight}
            className="btn btn-ghost !h-7 !w-7 !p-0"
            aria-label={rightOpen ? '收起右侧检视器' : '展开右侧检视器'}
            aria-pressed={rightOpen}
          >
            {rightOpen ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRight className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </header>
  );
}
