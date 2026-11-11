import { FileDiff, FolderSearch, GitBranch, LayoutGrid } from 'lucide-react';
import { useWorkbenchStore } from '../store/workbench';
import { HARNESS_META, relativeTime } from '../lib/harness';
import { cn } from '../lib/cn';

/**
 * Left project matrix: every discovered workspace with its harness brand
 * breathing lamp, `.agent` mount badge, git branch, relative last-active time
 * and pending diff count badge.
 */
export function SidebarProjectMatrix() {
  const projects = useWorkbenchStore((state) => state.projects);
  const activeProjectId = useWorkbenchStore((state) => state.activeProjectId);
  const setActiveProject = useWorkbenchStore((state) => state.setActiveProject);
  const mode = useWorkbenchStore((state) => state.mode);
  const demoNotice = useWorkbenchStore((state) => state.demoNotice);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <LayoutGrid className="h-3.5 w-3.5 text-slate-500" />
        <span className="text-[11px] font-semibold tracking-wider text-slate-400">项目矩阵</span>
        <span className="chip ml-auto">{projects.length}</span>
      </div>

      <nav className="stream-scroll min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 pb-3">
        {projects.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <FolderSearch className="h-6 w-6 text-slate-600" />
            <span className="text-[12px] text-slate-500">未发现任何项目</span>
            <span className="text-[10.5px] text-slate-600">确认 daemon 的扫描目录后重试</span>
          </div>
        ) : (
          projects.map((project) => {
            const meta = HARNESS_META[project.activeHarness];
            const active = project.id === activeProjectId;
            const pendingDiff = project.pendingDiffCount ?? 0;
            return (
              <button
                key={project.id}
                type="button"
                onClick={() => setActiveProject(project.id)}
                className={cn(
                  'relative block w-full rounded-xl border px-3 py-2.5 text-left transition',
                  active
                    ? 'border-aurora/40 bg-aurora/[0.07] shadow-[0_0_18px_rgba(139,92,246,0.12)]'
                    : 'border-transparent hover:border-white/10 hover:bg-white/[0.03]',
                )}
              >
                {active && <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-full bg-aurora" />}
                <div className="flex items-center gap-2">
                  <span className="breathe h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: meta.color, color: meta.color }} />
                  <span className="truncate text-[13px] font-medium text-slate-100">{project.name}</span>
                  {pendingDiff > 0 && (
                    <span className="chip ml-auto shrink-0 border-solar/30 bg-solar/10 text-solar" title={`${pendingDiff} 个未处理变更`}>
                      <FileDiff className="h-3 w-3" />
                      {pendingDiff}
                    </span>
                  )}
                </div>
                <div className="mt-1 truncate font-mono text-[10.5px] text-slate-500" title={project.path}>
                  {project.path}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-slate-500">
                  <span
                    className={cn(
                      'rounded border px-1 py-px font-mono',
                      project.hasAgentDir ? 'border-jade/30 bg-jade/10 text-jade' : 'hairline bg-white/[0.03] text-slate-500',
                    )}
                    title={project.hasAgentDir ? '.agent 工作区已挂载' : '未发现 .agent 目录'}
                  >
                    {project.hasAgentDir ? '.agent ✓' : '.agent ✗'}
                  </span>
                  {project.gitBranch && (
                    <span className="inline-flex items-center gap-0.5 truncate font-mono">
                      <GitBranch className="h-3 w-3 shrink-0" />
                      {project.gitBranch}
                    </span>
                  )}
                  <span className="ml-auto shrink-0">{relativeTime(project.lastActiveAt)}</span>
                </div>
              </button>
            );
          })
        )}
      </nav>

      <div className="border-t hairline px-3 py-2">
        <span className="truncate text-[10px] text-slate-600" title={demoNotice ?? undefined}>
          {mode === 'demo' ? (demoNotice ?? '离线演示模式') : 'JWT 已配对 · 直连 daemon'}
        </span>
      </div>
    </div>
  );
}
