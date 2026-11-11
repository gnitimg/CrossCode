import { useEffect, useMemo, useState } from 'react';
import {
  Cloud,
  FolderGit2,
  GitBranch,
  Repeat,
  Search,
  SendHorizontal,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { AgentMode } from '@crosscode/shared';
import { useWorkbenchStore } from '../store/workbench';
import { HARNESS_META } from '../lib/harness';
import { cn } from '../lib/cn';

/**
 * Ctrl/Cmd+K command palette: switch project / harness / provider / mode and
 * send the typed text as a prompt. Full keyboard navigation — ArrowUp/Down to
 * move, Enter to execute, Esc to dismiss.
 */

interface PaletteCommand {
  id: string;
  icon: LucideIcon;
  label: string;
  group: string;
  run: () => void;
}

const MODE_COMMANDS: ReadonlyArray<{ id: AgentMode; label: string }> = [
  { id: 'plan', label: '规划 (plan)' },
  { id: 'build', label: '构建 (build)' },
  { id: 'orchestrate', label: '编排 (orchestrate)' },
];

export function CommandPalette() {
  const open = useWorkbenchStore((state) => state.paletteOpen);
  const close = useWorkbenchStore((state) => state.closePalette);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const projects = useWorkbenchStore((state) => state.projects);
  const providers = useWorkbenchStore((state) => state.providers);
  const sendPrompt = useWorkbenchStore((state) => state.sendPrompt);
  const setActiveProject = useWorkbenchStore((state) => state.setActiveProject);
  const switchHarness = useWorkbenchStore((state) => state.switchHarness);
  const switchProvider = useWorkbenchStore((state) => state.switchProvider);
  const setAgentMode = useWorkbenchStore((state) => state.setAgentMode);

  const trimmed = query.trim();
  const commands = useMemo((): PaletteCommand[] => {
    const list: PaletteCommand[] = [];
    if (trimmed) {
      list.push({
        id: 'send-prompt',
        icon: SendHorizontal,
        label: `发送提示词「${trimmed}」`,
        group: '提示词',
        run: () => sendPrompt(trimmed),
      });
    }
    for (const project of projects) {
      list.push({
        id: `project-${project.id}`,
        icon: FolderGit2,
        label: `切换项目 → ${project.name}`,
        group: '项目',
        run: () => setActiveProject(project.id),
      });
    }
    for (const harness of Object.values(HARNESS_META)) {
      list.push({
        id: `harness-${harness.id}`,
        icon: Repeat,
        label: `Harness → ${harness.label}`,
        group: 'Harness',
        run: () => void switchHarness(harness.id),
      });
    }
    for (const provider of providers) {
      list.push({
        id: `provider-${provider.id}`,
        icon: Cloud,
        label: `Provider → ${provider.label}`,
        group: 'Provider',
        run: () => void switchProvider(provider.id),
      });
    }
    for (const mode of MODE_COMMANDS) {
      list.push({
        id: `mode-${mode.id}`,
        icon: Workflow,
        label: `模式 → ${mode.label}`,
        group: '模式',
        run: () => setAgentMode(mode.id),
      });
    }
    return list;
  }, [trimmed, projects, providers, sendPrompt, setActiveProject, switchHarness, switchProvider, setAgentMode]);

  const filtered = useMemo(() => {
    const needle = trimmed.toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) => command.label.toLowerCase().includes(needle));
  }, [commands, trimmed]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [trimmed]);

  useEffect(() => {
    const el = document.getElementById(`cmd-opt-${activeIndex}`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

  const clampedIndex = Math.min(activeIndex, Math.max(0, filtered.length - 1));

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (filtered.length > 0) setActiveIndex((index) => (index + 1) % filtered.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (filtered.length > 0) setActiveIndex((index) => (index - 1 + filtered.length) % filtered.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const command = filtered[clampedIndex];
      if (command) {
        command.run();
        close();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  return (
    <div
      role="dialog"
      aria-label="命令面板"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-sm"
      onMouseDown={close}
    >
      <div
        className="panel rise !rounded-2xl w-[560px] max-w-[92vw] overflow-hidden"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b hairline px-3.5 py-3">
          <Search className="h-4 w-4 shrink-0 text-slate-500" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="输入命令或提示词…（↑↓ 选择，Enter 执行）"
            aria-label="命令面板输入"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-slate-100 outline-none"
          />
          <span className="kbd">ESC</span>
        </div>
        <div role="listbox" aria-label="命令列表" className="stream-scroll max-h-[320px] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-slate-600">没有匹配的命令</div>
          ) : (
            filtered.map((command, index) => (
              <button
                key={command.id}
                id={`cmd-opt-${index}`}
                type="button"
                role="option"
                aria-selected={index === clampedIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  command.run();
                  close();
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition',
                  index === clampedIndex
                    ? 'bg-aurora/[0.14] text-slate-100 shadow-[inset_2px_0_0_0_#8b5cf6]'
                    : 'text-slate-400 hover:bg-white/[0.04]',
                )}
              >
                <command.icon className="h-4 w-4 shrink-0 text-slate-500" />
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                <span className="chip shrink-0 !text-[10px]">{command.group}</span>
              </button>
            ))
          )}
        </div>
        <div className="flex items-center gap-3 border-t hairline px-3.5 py-2 text-[10px] text-slate-600">
          <span><span className="kbd">↑</span> <span className="kbd">↓</span> 选择</span>
          <span><span className="kbd">Enter</span> 执行</span>
          <span><span className="kbd">Esc</span> 关闭</span>
          <span className="ml-auto inline-flex items-center gap-1">
            <GitBranch className="h-3 w-3" />
            {filtered.length} 条命令
          </span>
        </div>
      </div>
    </div>
  );
}
