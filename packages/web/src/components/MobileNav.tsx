import {
  Check,
  FolderGit2,
  MessagesSquare,
  PanelRight,
  SlidersHorizontal,
  X,
  type LucideIcon,
} from 'lucide-react';
import { ALL_HARNESS_IDS } from '@crosscode/shared';
import type { AgentMode } from '@crosscode/shared';
import { useWorkbenchStore } from '../store/workbench';
import { HARNESS_META, providerColor } from '../lib/harness';
import { cn } from '../lib/cn';

const MOBILE_TABS: ReadonlyArray<{ id: 'projects' | 'stream' | 'inspector'; label: string; icon: LucideIcon }> = [
  { id: 'projects', label: '项目', icon: FolderGit2 },
  { id: 'stream', label: '会话', icon: MessagesSquare },
  { id: 'inspector', label: '检视', icon: PanelRight },
];

const DRAWER_MODES: ReadonlyArray<{ id: AgentMode; label: string }> = [
  { id: 'plan', label: 'Plan' },
  { id: 'build', label: 'Build' },
  { id: 'orchestrate', label: 'Orchestrate' },
];

function SwitchboardDrawer() {
  const close = () => useWorkbenchStore.getState().setSwitchboardDrawerOpen(false);
  const projects = useWorkbenchStore((state) => state.projects);
  const activeProjectId = useWorkbenchStore((state) => state.activeProjectId);
  const activeHarness = projects.find((project) => project.id === activeProjectId)?.activeHarness ?? 'crosscode-native';
  const activeProviderId = projects.find((project) => project.id === activeProjectId)?.activeProviderId ?? null;
  const providers = useWorkbenchStore((state) => state.providers);
  const agentMode = useWorkbenchStore((state) => state.agentMode);
  const switchHarness = useWorkbenchStore((state) => state.switchHarness);
  const switchProvider = useWorkbenchStore((state) => state.switchProvider);
  const setAgentMode = useWorkbenchStore((state) => state.setAgentMode);

  return (
    <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-label="切换器抽屉">
      <div className="absolute inset-0 bg-black/70" onClick={close} />
      <div className="drawer-up panel absolute inset-x-0 bottom-0 max-h-[76vh] overflow-y-auto stream-scroll rounded-b-none p-4 pb-8">
        <div className="mb-3 flex items-center border-b hairline pb-2">
          <span className="font-mono text-[12px] font-semibold text-zinc-200">Switchboard</span>
          <button type="button" className="btn btn-ghost ml-auto !h-6 !w-6 !p-0" onClick={close} aria-label="关闭抽屉">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="mb-4">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">Mode</div>
          <div className="flex gap-1.5">
            {DRAWER_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                aria-pressed={agentMode === mode.id}
                onClick={() => setAgentMode(mode.id)}
                className={cn(
                  'btn flex-1 border hairline font-mono text-[11.5px]',
                  agentMode === mode.id ? 'bg-zinc-200 text-zinc-950 font-semibold' : 'btn-ghost',
                )}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>

        <div className="mb-4">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">Harness</div>
          <div className="grid grid-cols-2 gap-1.5">
            {ALL_HARNESS_IDS.map((harnessId) => {
              const meta = HARNESS_META[harnessId];
              const active = harnessId === activeHarness;
              return (
                <button
                  key={harnessId}
                  type="button"
                  aria-pressed={active}
                  onClick={() => void switchHarness(harnessId)}
                  className={cn(
                    'btn btn-ghost justify-start border hairline font-mono text-[11.5px]',
                    active && 'border-zinc-500 bg-white/[0.08] text-zinc-100',
                  )}
                >
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
                  {meta.label}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500">Provider</div>
          <div className="flex flex-col gap-1">
            {providers.map((provider) => {
              const active = provider.id === activeProviderId;
              return (
                <button
                  key={provider.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => void switchProvider(provider.id)}
                  className={cn(
                    'btn btn-ghost !h-7 justify-start border hairline font-mono text-[11.5px]',
                    active && 'border-zinc-500 bg-white/[0.08] text-zinc-100',
                  )}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: providerColor(provider.id) }}
                  />
                  <span className="truncate">{provider.label}</span>
                  {active && <Check className="ml-auto h-3 w-3 text-zinc-200" />}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function MobileNav() {
  const pane = useWorkbenchStore((state) => state.mobilePane);
  const setPane = useWorkbenchStore((state) => state.setMobilePane);
  const drawerOpen = useWorkbenchStore((state) => state.switchboardDrawerOpen);
  const setDrawer = useWorkbenchStore((state) => state.setSwitchboardDrawerOpen);

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 flex h-12 items-stretch border-t hairline bg-panel md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label="移动端导航"
      >
        {MOBILE_TABS.map((tab) => {
          const active = pane === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setPane(tab.id);
                setDrawer(false);
              }}
              className={cn(
                'flex flex-1 flex-col items-center justify-center gap-0.5 font-mono text-[10px] transition',
                active ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
              )}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={drawerOpen}
          onClick={() => setDrawer(!drawerOpen)}
          className={cn(
            'flex flex-1 flex-col items-center justify-center gap-0.5 font-mono text-[10px] transition',
            drawerOpen ? 'text-zinc-100' : 'text-zinc-500 hover:text-zinc-300',
          )}
        >
          <SlidersHorizontal className="h-4 w-4" />
          切换
        </button>
      </nav>
      {drawerOpen && <SwitchboardDrawer />}
    </>
  );
}
