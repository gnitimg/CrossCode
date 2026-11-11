import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ChevronDown,
  Command,
  Coins,
  Hexagon,
  Hammer,
  Network,
  ClipboardList,
  PanelLeftClose,
  PanelLeft,
  PanelRightClose,
  PanelRight,
  type LucideIcon,
} from 'lucide-react';
import { ALL_HARNESS_IDS } from '@crosscode/shared';
import type { AgentMode } from '@crosscode/shared';
import { useWorkbenchStore } from '../store/workbench';
import { HARNESS_META, providerColor } from '../lib/harness';
import { cn } from '../lib/cn';

/**
 * Top composite switchboard: connection/latency/token readouts + one-click
 * Harness / Provider / 模式 (plan·build·orchestrate) switchers + panel and
 * palette controls. On <md screens the switchers collapse into the mobile
 * drawer (MobileNav) and only status + mode remain here.
 */

const MODES: ReadonlyArray<{ id: AgentMode; label: string; icon: LucideIcon }> = [
  { id: 'plan', label: '规划', icon: ClipboardList },
  { id: 'build', label: '构建', icon: Hammer },
  { id: 'orchestrate', label: '编排', icon: Network },
];

function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

function StatusPill() {
  const mode = useWorkbenchStore((state) => state.mode);
  const wsStatus = useWorkbenchStore((state) => state.wsStatus);
  const reconnectAttempt = useWorkbenchStore((state) => state.reconnectAttempt);
  const demoNotice = useWorkbenchStore((state) => state.demoNotice);

  const demo = mode === 'demo';
  const connecting = wsStatus === 'connecting' || wsStatus === 'authenticating';
  const label = demo
    ? '演示模式'
    : wsStatus === 'live'
      ? 'LIVE'
      : wsStatus === 'reconnecting'
        ? `重连中 ×${reconnectAttempt}`
        : connecting
          ? '连接中'
          : wsStatus === 'failed'
            ? '连接失败'
            : '离线';
  const color = demo ? '#8b5cf6' : wsStatus === 'live' ? '#10b981' : connecting || wsStatus === 'reconnecting' ? '#f59e0b' : '#f43f5e';

  return (
    <span className="chip !h-6 !px-2.5 font-medium" title={demoNotice ?? undefined}>
      <span className="breathe h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color, color }} />
      {label}
    </span>
  );
}

function TelemetryChips() {
  const latencyMs = useWorkbenchStore((state) => state.latencyMs);
  const tokenUsage = useWorkbenchStore((state) => state.tokenUsage);
  const latencyColor = latencyMs === null ? '#64748b' : latencyMs < 150 ? '#10b981' : latencyMs < 400 ? '#f59e0b' : '#f43f5e';
  const total = tokenUsage.prompt + tokenUsage.completion;

  return (
    <div className="hidden items-center gap-1.5 sm:flex">
      <span className="chip font-mono" title="最近一次 REST 调用延迟">
        <Activity className="h-3 w-3" style={{ color: latencyColor }} />
        {latencyMs === null ? '—' : `${latencyMs}ms`}
      </span>
      <span className="chip font-mono" title="估算 token 消耗（输入/输出）">
        <Coins className="h-3 w-3 text-solar" />≈ {formatTokens(total)}
      </span>
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
        className="btn btn-ghost !h-8 max-w-[190px] gap-1.5"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {trigger}
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-slate-500 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            'panel rise absolute left-0 top-[calc(100%+6px)] z-40 flex max-h-[340px] min-w-[220px] flex-col overflow-y-auto p-1.5 stream-scroll',
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
          <span className="breathe h-2 w-2 rounded-full" style={{ backgroundColor: meta.color, color: meta.color }} />
          <span className="truncate text-[12px]">{meta.label}</span>
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
                  'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition',
                  active ? 'bg-white/[0.07] text-slate-100' : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200',
                )}
                onClick={() => {
                  void switchHarness(harnessId);
                  close();
                }}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: harnessMeta.color, color: harnessMeta.color }} />
                <span className="flex-1 truncate">{harnessMeta.label}</span>
                <span className="font-mono text-[10px] text-slate-600">{harnessMeta.short}</span>
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
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: providerColor(activeProviderId), color: providerColor(activeProviderId) }}
            />
          )}
          <span className="truncate text-[12px]">
            {providers.find((provider) => provider.id === activeProviderId)?.label ?? activeProviderId ?? 'Provider'}
          </span>
        </>
      }
    >
      {(close) => (
        <>
          {providers.length === 0 && <div className="px-2.5 py-2 text-[11px] text-slate-600">暂无可用 Provider</div>}
          {providers.map((provider) => {
            const active = provider.id === activeProviderId;
            return (
              <button
                key={provider.id}
                type="button"
                role="menuitem"
                className={cn(
                  'flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] transition',
                  active ? 'bg-white/[0.07] text-slate-100' : 'text-slate-400 hover:bg-white/[0.05] hover:text-slate-200',
                )}
                onClick={() => {
                  void switchProvider(provider.id);
                  close();
                }}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: providerColor(provider.id), color: providerColor(provider.id) }}
                />
                <span className="flex-1 truncate">{provider.label}</span>
                <span className="font-mono text-[10px] uppercase text-slate-600">{provider.protocol}</span>
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
    <div className="flex items-center gap-0.5 rounded-[10px] border hairline bg-white/[0.03] p-0.5">
      {MODES.map((mode) => {
        const active = agentMode === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            aria-pressed={active}
            title={`模式：${mode.label}`}
            onClick={() => {
              setAgentMode(mode.id);
              setDrawer(false);
            }}
            className={cn(
              'btn !h-7 px-2.5',
              active && 'bg-aurora/25 text-white shadow-[0_0_10px_rgba(139,92,246,0.25)]',
            )}
          >
            <mode.icon className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">{mode.label}</span>
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
    <header className="relative z-30 flex h-14 shrink-0 items-center gap-2 border-b hairline bg-panel/80 px-3 backdrop-blur">
      <div className="flex items-center gap-2">
        <div className="grid h-8 w-8 place-items-center rounded-lg border hairline bg-gradient-to-br from-aurora/25 to-glacier/10">
          <Hexagon className="h-[17px] w-[17px] text-aurora" />
        </div>
        <div className="hidden leading-tight md:block">
          <div className="text-[13px] font-semibold tracking-wide text-slate-100">CrossCode</div>
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-500">workbench</div>
        </div>
      </div>

      <StatusPill />
      <TelemetryChips />

      <div className="mx-1 hidden h-6 w-px bg-white/[0.07] md:block" />

      <div className="hidden items-center gap-1.5 md:flex">
        <HarnessSwitcher />
        <ProviderSwitcher />
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        <ModeSwitcher />
        <button
          type="button"
          onClick={openPalette}
          className="btn btn-ghost !h-8 gap-2"
          aria-label="打开命令面板"
          title="命令面板 (Ctrl+K)"
        >
          <Command className="h-3.5 w-3.5" />
          <span className="kbd hidden sm:inline-flex">Ctrl K</span>
        </button>
        <div className="hidden items-center gap-1.5 md:flex">
          <button
            type="button"
            onClick={toggleLeft}
            className="btn btn-ghost !h-8 !px-2"
            aria-label={leftOpen ? '收起左侧项目栏' : '展开左侧项目栏'}
            aria-pressed={leftOpen}
            title={leftOpen ? '收起项目矩阵' : '展开项目矩阵'}
          >
            {leftOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={toggleRight}
            className="btn btn-ghost !h-8 !px-2"
            aria-label={rightOpen ? '收起右侧检视器' : '展开右侧检视器'}
            aria-pressed={rightOpen}
            title={rightOpen ? '收起检视器' : '展开检视器'}
          >
            {rightOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRight className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </header>
  );
}
