import { useEffect, useState } from 'react';
import {
  Check,
  Circle,
  GitBranch,
  Globe,
  Monitor,
  RotateCw,
  Undo2,
} from 'lucide-react';
import type { SharedSkillMeta } from '@crosscode/shared';
import { useWorkbenchStore } from '../store/workbench';
import { HARNESS_META } from '../lib/harness';
import { cn } from '../lib/cn';
import type { ScreenFrameView } from '../store/model';

const TABS = [
  { id: 'changes', label: 'Diff' },
  { id: 'screen', label: 'Screen' },
  { id: 'brain', label: '.agent' },
] as const;

function statusColorClass(status: string): string {
  const normalized = status.trim() || '?';
  if (normalized === 'M') return 'text-amber-400';
  if (normalized === 'A') return 'text-emerald-400';
  if (normalized === 'D') return 'text-rose-400';
  if (normalized === '??') return 'text-sky-400';
  return 'text-zinc-500';
}

function ChangesTab() {
  const diff = useWorkbenchStore((state) => state.diff);
  const acceptDiff = useWorkbenchStore((state) => state.acceptDiff);
  const discardDiff = useWorkbenchStore((state) => state.discardDiff);
  const refreshDiff = useWorkbenchStore((state) => state.refreshDiff);

  if (!diff) {
    return (
      <div className="py-10 text-center font-mono text-[11px] text-zinc-600">
        No diff loaded
      </div>
    );
  }
  if (!diff.isGitRepo) {
    return (
      <div className="py-10 text-center font-mono text-[11px] text-zinc-600">
        Not a git repository
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        {diff.branch && (
          <span className="inline-flex items-center gap-1 text-zinc-300">
            <GitBranch className="h-3 w-3 text-zinc-500" />
            {diff.branch}
          </span>
        )}
        <span className="text-emerald-400">+{diff.totalAdditions}</span>
        <span className="text-rose-400">−{diff.totalDeletions}</span>
        <button
          type="button"
          className="btn btn-ghost ml-auto !h-6 !w-6 !p-0"
          onClick={() => void refreshDiff()}
          aria-label="刷新 Diff"
          title="Refresh diff"
        >
          <RotateCw className="h-3 w-3" />
        </button>
      </div>

      {diff.files.length === 0 ? (
        <div className="py-8 text-center font-mono text-[11px] text-zinc-600">
          Working tree clean
        </div>
      ) : (
        <>
          <div className="flex gap-1.5">
            <button type="button" className="btn btn-jade flex-1 !h-7 font-mono text-[11px]" onClick={() => void acceptDiff()}>
              <Check className="h-3 w-3" />
              Stage All
            </button>
            <button type="button" className="btn btn-danger flex-1 !h-7 font-mono text-[11px]" onClick={() => void discardDiff()}>
              <Undo2 className="h-3 w-3" />
              Discard All
            </button>
          </div>
          <div className="divide-y divide-white/[0.05] rounded border hairline bg-obsidian">
            {diff.files.map((file) => (
              <div
                key={file.file}
                className="group flex items-center gap-2 px-2.5 py-1.5 font-mono text-[11.5px] hover:bg-white/[0.025]"
              >
                <span className={cn('w-4 shrink-0 text-[10.5px] font-semibold', statusColorClass(file.status))}>
                  {file.status.trim() || '?'}
                </span>
                <span className="truncate text-zinc-300" title={file.file}>
                  {file.file}
                </span>
                <span className="ml-auto shrink-0 text-[10.5px] text-emerald-400">+{file.additions}</span>
                <span className="shrink-0 text-[10.5px] text-rose-400">−{file.deletions}</span>
                <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
                  <button
                    type="button"
                    className="btn btn-ghost !h-5 !px-1"
                    aria-label={`接受 ${file.file}`}
                    title="git add"
                    onClick={() => void acceptDiff([file.file])}
                  >
                    <Check className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost !h-5 !px-1"
                    aria-label={`丢弃 ${file.file}`}
                    title="git checkout --"
                    onClick={() => void discardDiff([file.file])}
                  >
                    <Undo2 className="h-3 w-3" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const SOURCE_LABELS: Record<ScreenFrameView['source'], string> = {
  'builtin-browser': 'builtin-browser',
  'external-browser': 'external-browser',
  'computer-use': 'computer-use',
};

function ScreenTab() {
  const frames = useWorkbenchStore((state) => state.screenFrames);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    setSelected(0);
  }, [frames.length]);

  if (frames.length === 0) {
    return (
      <div className="py-10 text-center font-mono text-[11px] text-zinc-600">
        No active screen frames
      </div>
    );
  }

  const index = Math.min(selected, frames.length - 1);
  const frame = frames[index];
  if (!frame) return null;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="overflow-hidden rounded border hairline bg-obsidian">
        <img
          src={`data:${frame.mime};base64,${frame.imageBase64}`}
          alt={SOURCE_LABELS[frame.source]}
          className="w-full"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-zinc-500">
        <span className="chip">
          {frame.source === 'computer-use' ? <Monitor className="h-3 w-3" /> : <Globe className="h-3 w-3" />}
          {SOURCE_LABELS[frame.source]}
        </span>
        {frame.width !== undefined && frame.height !== undefined && (
          <span className="chip">
            {frame.width}×{frame.height}
          </span>
        )}
        <span className="ml-auto">{new Date(frame.timestamp).toLocaleTimeString('zh-CN')}</span>
      </div>
      {frames.length > 1 && (
        <div className="stream-scroll flex gap-1.5 overflow-x-auto pb-1">
          {frames.map((item, itemIndex) => (
            <button
              key={`${item.timestamp}-${itemIndex}`}
              type="button"
              onClick={() => setSelected(itemIndex)}
              aria-label={`查看第 ${frames.length - itemIndex} 帧`}
              className={cn(
                'h-10 w-16 shrink-0 overflow-hidden rounded border transition',
                itemIndex === index ? 'border-zinc-200' : 'hairline opacity-50 hover:opacity-90',
              )}
            >
              <img src={`data:${item.mime};base64,${item.imageBase64}`} alt="" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SkillToggle({ skillId, meta }: { skillId: string; meta?: SharedSkillMeta }) {
  const enabled = useWorkbenchStore((state) => state.skills[skillId] ?? false);
  const toggleSkill = useWorkbenchStore((state) => state.toggleSkill);

  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 hover:bg-white/[0.025]">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-mono text-[11.5px] text-zinc-200">{meta?.name ?? skillId}</span>
          {(meta?.syncedHarnesses ?? []).map((harnessId) => (
            <span
              key={harnessId}
              className="h-1.5 w-1.5 rounded-full"
              title={HARNESS_META[harnessId]?.label ?? harnessId}
              style={{ backgroundColor: HARNESS_META[harnessId]?.color ?? '#71717a' }}
            />
          ))}
        </div>
        {meta?.description && (
          <div className="truncate text-[10.5px] text-zinc-500" title={meta.description}>
            {meta.description}
          </div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`切换 Skill ${meta?.name ?? skillId}`}
        onClick={() => void toggleSkill(skillId)}
        className={cn(
          'relative h-4 w-7 shrink-0 rounded-full transition',
          enabled ? 'bg-emerald-500/80' : 'bg-zinc-800',
        )}
      >
        <span
          className={cn(
            'absolute top-[2px] h-3 w-3 rounded-full bg-white transition-all',
            enabled ? 'left-[14px]' : 'left-[2px]',
          )}
        />
      </button>
    </div>
  );
}

function BrainTab() {
  const brain = useWorkbenchStore((state) => state.brain);
  const skills = useWorkbenchStore((state) => state.skills);
  const skillMeta = useWorkbenchStore((state) => state.skillMeta);
  const skillIds = Object.keys(skills);

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded border hairline bg-obsidian p-2.5">
        <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-wider text-zinc-500">
          active-task.json
        </div>
        {brain.activeTask ? (
          <div className="flex flex-col gap-1.5 text-[11.5px]">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-zinc-200">{brain.activeTask.title}</span>
              <span className="chip">{brain.activeTask.status}</span>
            </div>
            <div className="font-mono text-[10.5px] text-zinc-500">
              [{HARNESS_META[brain.activeTask.currentHarness]?.short ?? brain.activeTask.currentHarness}] {brain.activeTask.currentStep}
            </div>
            <div className="mt-1 space-y-0.5 font-mono text-[10.5px]">
              {brain.activeTask.completedSteps.map((step) => (
                <div key={step} className="flex items-center gap-1.5 text-emerald-400/90">
                  <Check className="h-3 w-3 shrink-0" />
                  <span className="truncate">{step}</span>
                </div>
              ))}
              {brain.activeTask.nextSteps.map((step) => (
                <div key={step} className="flex items-center gap-1.5 text-zinc-500">
                  <Circle className="h-2.5 w-2.5 shrink-0" />
                  <span className="truncate">{step}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="font-mono text-[11px] text-zinc-600">not mounted</div>
        )}
      </div>

      <div className="rounded border hairline bg-obsidian p-2.5">
        <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-wider text-zinc-500">
          project-memory.md
        </div>
        {brain.memoryMd ? (
          <pre className="stream-scroll max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-zinc-400">
            {brain.memoryMd}
          </pre>
        ) : (
          <div className="font-mono text-[11px] text-zinc-600">not mounted</div>
        )}
      </div>

      <div className="rounded border hairline bg-obsidian">
        <div className="border-b hairline px-2.5 py-1.5 font-mono text-[10.5px] uppercase tracking-wider text-zinc-500">
          Skills ({skillIds.length})
        </div>
        {skillIds.length === 0 ? (
          <div className="p-2.5 font-mono text-[11px] text-zinc-600">no skills registered</div>
        ) : (
          <div className="divide-y divide-white/[0.05]">
            {skillIds.map((skillId) => (
              <SkillToggle key={skillId} skillId={skillId} meta={skillMeta.find((meta) => meta.id === skillId)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function InspectorRightPane() {
  const tab = useWorkbenchStore((state) => state.inspectorTab);
  const setTab = useWorkbenchStore((state) => state.setInspectorTab);

  return (
    <div className="flex h-full flex-col">
      <div role="tablist" aria-label="检视器" className="flex h-8 shrink-0 items-center border-b hairline px-2">
        {TABS.map((entry) => {
          const active = tab === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(entry.id)}
              className={cn(
                'h-full border-b-2 px-3 font-mono text-[11px] transition',
                active
                  ? 'border-zinc-200 text-zinc-100'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300',
              )}
            >
              {entry.label}
            </button>
          );
        })}
      </div>
      <div className="stream-scroll min-h-0 flex-1 overflow-y-auto p-2.5">
        {tab === 'changes' ? <ChangesTab /> : tab === 'screen' ? <ScreenTab /> : <BrainTab />}
      </div>
    </div>
  );
}
