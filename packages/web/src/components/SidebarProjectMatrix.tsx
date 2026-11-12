import { GitBranch } from 'lucide-react';
import { useWorkbenchStore } from '../store/workbench';
import { HARNESS_META, relativeTime } from '../lib/harness';
import { cn } from '../lib/cn';

export function SidebarProjectMatrix() {
  const projects = useWorkbenchStore((state) => state.projects);
  const activeProjectId = useWorkbenchStore((state) => state.activeProjectId);
  const setActiveProject = useWorkbenchStore((state) => state.setActiveProject);
  const mode = useWorkbenchStore((state) => state.mode);

  return (
    <div className="flex h-full flex-col select-none">
      <div className="flex h-8 shrink-0 items-center justify-between border-b hairline px-3">
        <span className="font-mono text-[10.5px] font-medium uppercase tracking-wider text-zinc-500">
          Workspaces
        </span>
        <span className="font-mono text-[10.5px] text-zinc-600">{projects.length}</span>
      </div>

      <nav className="stream-scroll min-h-0 flex-1 overflow-y-auto p-1.5 space-y-0.5">
        {projects.length === 0 ? (
          <div className="px-3 py-8 text-center font-mono text-[11px] text-zinc-600">
            No workspaces discovered
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
                  'group relative block w-full rounded px-2.5 py-2 text-left transition',
                  active
                    ? 'bg-white/[0.06] text-zinc-100'
                    : 'text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-200',
                )}
              >
                {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] bg-zinc-200" />}
                <div className="flex items-center gap-2">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: meta.color }}
                    title={meta.label}
                  />
                  <span className="truncate text-[12.5px] font-medium">{project.name}</span>
                  {pendingDiff > 0 && (
                    <span
                      className="ml-auto shrink-0 font-mono text-[10.5px] text-amber-400"
                      title={`${pendingDiff} modified files`}
                    >
                      ±{pendingDiff}
                    </span>
                  )}
                </div>

                <div className="mt-0.5 truncate font-mono text-[10.5px] text-zinc-600" title={project.path}>
                  {project.path}
                </div>

                <div className="mt-1.5 flex items-center gap-2 font-mono text-[10px] text-zinc-500">
                  <span className="text-zinc-400">{meta.short}</span>
                  {project.gitBranch && (
                    <span className="inline-flex items-center gap-0.5 truncate">
                      <GitBranch className="h-2.5 w-2.5 shrink-0" />
                      {project.gitBranch}
                    </span>
                  )}
                  {project.hasAgentDir && (
                    <span className="text-emerald-500/80" title=".agent context mounted">
                      .agent
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-zinc-600">{relativeTime(project.lastActiveAt)}</span>
                </div>
              </button>
            );
          })
        )}
      </nav>

      <div className="flex h-7 shrink-0 items-center justify-between border-t hairline px-3 font-mono text-[10px] text-zinc-600">
        <span>{mode === 'demo' ? 'mode: mock' : 'mode: daemon'}</span>
        <span>v0.1.0</span>
      </div>
    </div>
  );
}
