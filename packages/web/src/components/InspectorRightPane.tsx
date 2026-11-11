import { useEffect, useState } from 'react';
import {
  BrainCircuit,
  Check,
  Circle,
  FileText,
  FileDiff,
  GitBranch,
  Globe,
  Monitor,
  MonitorPlay,
  MonitorSmartphone,
  RotateCw,
  Undo2,
} from 'lucide-react';
import type { SharedSkillMeta } from '@crosscode/shared';
import { useWorkbenchStore } from '../store/workbench';
import { HARNESS_META } from '../lib/harness';
import { cn } from '../lib/cn';
import type { ScreenFrameView } from '../store/model';

/**
 * Right three-in-one inspector:
 * Tab 1 — Changes & Diff (per-file +/− stats, Accept/Discard)
 * Tab 2 — Live Screen/Browser (screen_frame rendering + history strip)
 * Tab 3 — `.agent` Brain (project-memory.md, active-task.json, shared skills)
 */

const TABS = [
  { id: 'changes', label: '变更', icon: FileDiff },
  { id: 'screen', label: '实况', icon: MonitorPlay },
  { id: 'brain', label: 'Brain', icon: BrainCircuit },
] as const;

function statusChipClass(status: string): string {
  const normalized = status.trim() || '?';
  if (normalized === 'M') return 'border-solar/30 bg-solar/10 text-solar';
  if (normalized === 'A') return 'border-jade/30 bg-jade/10 text-jade';
  if (normalized === 'D') return 'border-rosefire/30 bg-rosefire/10 text-rosefire';
  if (normalized === '??') return 'border-glacier/30 bg-glacier/10 text-glacier';
  return 'hairline text-slate-400';
}

function ChangesTab() {
  const diff = useWorkbenchStore((state) => state.diff);
  const acceptDiff = useWorkbenchStore((state) => state.acceptDiff);
  const discardDiff = useWorkbenchStore((state) => state.discardDiff);
  const refreshDiff = useWorkbenchStore((state) => state.refreshDiff);

  if (!diff) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <FileDiff className="h-6 w-6 text-slate-600" />
        <span className="text-[12px] text-slate-500">尚未加载 Diff</span>
      </div>
    );
  }
  if (!diff.isGitRepo) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <GitBranch className="h-6 w-6 text-slate-600" />
        <span className="text-[12px] text-slate-500">该项目不是 git 仓库</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {diff.branch && <span className="chip font-mono text-slate-300"><GitBranch className="h-3 w-3" />{diff.branch}</span>}
        <span className="chip font-mono text-jade">+{diff.totalAdditions}</span>
        <span className="chip font-mono text-rosefire">−{diff.totalDeletions}</span>
        <button
          type="button"
          className="btn btn-ghost ml-auto !h-7 !px-2"
          onClick={() => void refreshDiff()}
          aria-label="刷新 Diff"
          title="刷新 Diff"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {diff.files.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <Check className="h-6 w-6 text-jade" />
          <span className="text-[12px] text-slate-500">工作区干净，没有未提交的变更</span>
        </div>
      ) : (
        <>
          <div className="flex gap-2">
            <button type="button" className="btn btn-jade flex-1" onClick={() => void acceptDiff()}>
              <Check className="h-3.5 w-3.5" />
              全部接受（git add）
            </button>
            <button type="button" className="btn btn-danger flex-1" onClick={() => void discardDiff()}>
              <Undo2 className="h-3.5 w-3.5" />
              全部丢弃（checkout）
            </button>
          </div>
          <div className="flex flex-col">
            {diff.files.map((file) => (
              <div
                key={file.file}
                className="group rounded-lg border border-transparent px-2 py-1.5 transition hover:border-white/10 hover:bg-white/[0.03]"
              >
                <div className="flex items-center gap-2 text-[12px]">
                  <span className={cn('chip !h-5 !px-1.5 font-mono !text-[10px]', statusChipClass(file.status))}>
                    {file.status.trim() || '?'}
                  </span>
                  <span className="truncate font-mono text-slate-300" title={file.file}>
                    {file.file}
                  </span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-jade">+{file.additions}</span>
                  <span className="shrink-0 font-mono text-[11px] text-rosefire">−{file.deletions}</span>
                  <span className="hidden shrink-0 items-center gap-1 group-hover:flex">
                    <button
                      type="button"
                      className="btn btn-ghost !h-6 !px-1.5"
                      aria-label={`接受 ${file.file}`}
                      title="接受（git add）"
                      onClick={() => void acceptDiff([file.file])}
                    >
                      <Check className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost !h-6 !px-1.5"
                      aria-label={`丢弃 ${file.file}`}
                      title="丢弃（checkout --）"
                      onClick={() => void discardDiff([file.file])}
                    >
                      <Undo2 className="h-3 w-3" />
                    </button>
                  </span>
                </div>
                {file.staged && <div className="mt-0.5 pl-1 text-[10px] text-jade/80">已暂存（staged）</div>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const SOURCE_LABELS: Record<ScreenFrameView['source'], string> = {
  'builtin-browser': '内置浏览器',
  'external-browser': '外部浏览器桥',
  'computer-use': '桌面操控',
};

function ScreenTab() {
  const frames = useWorkbenchStore((state) => state.screenFrames);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    setSelected(0);
  }, [frames.length]);

  if (frames.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <MonitorSmartphone className="h-6 w-6 text-slate-600" />
        <span className="text-[12px] text-slate-500">暂无实况画面</span>
        <span className="max-w-[220px] text-[10.5px] text-slate-600">
          当 harness 推送 screen_frame 事件时，这里会实时渲染浏览器 / 桌面画面
        </span>
      </div>
    );
  }

  const index = Math.min(selected, frames.length - 1);
  const frame = frames[index];
  if (!frame) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-xl border hairline bg-black/40">
        <img
          src={`data:${frame.mime};base64,${frame.imageBase64}`}
          alt={`实况画面（${SOURCE_LABELS[frame.source]}）`}
          className="w-full"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-400">
        <span className="chip">
          {frame.source === 'computer-use' ? <Monitor className="h-3 w-3" /> : <Globe className="h-3 w-3" />}
          {SOURCE_LABELS[frame.source]}
        </span>
        {frame.width !== undefined && frame.height !== undefined && (
          <span className="chip font-mono">
            {frame.width}×{frame.height}
          </span>
        )}
        <span className="chip font-mono">{new Date(frame.timestamp).toLocaleTimeString('zh-CN')}</span>
      </div>
      {frames.length > 1 && (
        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-slate-600">历史帧（{frames.length}）</div>
          <div className="stream-scroll flex gap-1.5 overflow-x-auto pb-1">
            {frames.map((item, itemIndex) => (
              <button
                key={`${item.timestamp}-${itemIndex}`}
                type="button"
                onClick={() => setSelected(itemIndex)}
                aria-label={`查看第 ${frames.length - itemIndex} 帧`}
                className={cn(
                  'h-12 w-20 shrink-0 overflow-hidden rounded-md border transition',
                  itemIndex === index ? 'border-aurora/60 ring-1 ring-aurora/40' : 'hairline opacity-60 hover:opacity-100',
                )}
              >
                <img src={`data:${item.mime};base64,${item.imageBase64}`} alt="" className="h-full w-full object-cover" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SkillToggle({ skillId, meta }: { skillId: string; meta?: SharedSkillMeta }) {
  const enabled = useWorkbenchStore((state) => state.skills[skillId] ?? false);
  const toggleSkill = useWorkbenchStore((state) => state.toggleSkill);

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-transparent px-2 py-1.5 transition hover:border-white/10 hover:bg-white/[0.03]">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-[12px] text-slate-200">{meta?.name ?? skillId}</span>
          {(meta?.syncedHarnesses ?? []).map((harnessId) => (
            <span
              key={harnessId}
              className="h-1.5 w-1.5 rounded-full"
              title={HARNESS_META[harnessId]?.label ?? harnessId}
              style={{ backgroundColor: HARNESS_META[harnessId]?.color ?? '#64748b' }}
            />
          ))}
        </div>
        {meta?.description && <div className="mt-0.5 truncate text-[10.5px] text-slate-500" title={meta.description}>{meta.description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label={`切换 Skill ${meta?.name ?? skillId}`}
        onClick={() => void toggleSkill(skillId)}
        className={cn(
          'relative mt-0.5 h-[18px] w-8 shrink-0 rounded-full transition',
          enabled ? 'bg-jade/70' : 'bg-white/10',
        )}
      >
        <span
          className={cn(
            'absolute top-[3px] h-3 w-3 rounded-full bg-white transition-all',
            enabled ? 'left-[17px]' : 'left-[3px]',
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
      <div className="rounded-xl border hairline bg-panel/60 p-3">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-slate-400">
          <FileText className="h-3.5 w-3.5 text-aurora" />
          project-memory.md
        </div>
        {brain.memoryMd ? (
          <pre className="stream-scroll max-h-48 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-400">
            {brain.memoryMd}
          </pre>
        ) : (
          <div className="text-[11px] text-slate-600">daemon 未提供该文件（需 .agent 工作区挂载）</div>
        )}
      </div>

      <div className="rounded-xl border hairline bg-panel/60 p-3">
        <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-slate-400">
          <BrainCircuit className="h-3.5 w-3.5 text-glacier" />
          active-task.json
        </div>
        {brain.activeTask ? (
          <div className="flex flex-col gap-1.5 text-[11.5px]">
            <div className="flex items-center gap-2">
              <span className="text-slate-200">{brain.activeTask.title}</span>
              <span className="chip border-jade/30 bg-jade/10 text-jade">{brain.activeTask.status}</span>
            </div>
            <div className="flex flex-wrap gap-1.5 text-slate-400">
              <span className="chip font-mono">{HARNESS_META[brain.activeTask.currentHarness]?.label ?? brain.activeTask.currentHarness}</span>
              <span className="truncate text-[11px] text-slate-500">{brain.activeTask.currentStep}</span>
            </div>
            <div className="mt-1 space-y-0.5">
              {brain.activeTask.completedSteps.map((step) => (
                <div key={step} className="flex items-center gap-1.5 text-[11px] text-jade/80">
                  <Check className="h-3 w-3 shrink-0" />
                  {step}
                </div>
              ))}
              {brain.activeTask.nextSteps.map((step) => (
                <div key={step} className="flex items-center gap-1.5 text-[11px] text-slate-500">
                  <Circle className="h-3 w-3 shrink-0" />
                  {step}
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="text-[11px] text-slate-600">daemon 未提供该文件（需 .agent 工作区挂载）</div>
        )}
      </div>

      <div className="rounded-xl border hairline bg-panel/60 p-3">
        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold tracking-wide text-slate-400">
          <BrainCircuit className="h-3.5 w-3.5 text-solar" />
          共享 Skills 挂载
        </div>
        {skillIds.length === 0 ? (
          <div className="text-[11px] text-slate-600">尚无 Skills 状态</div>
        ) : (
          <div className="flex flex-col">
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
      <div role="tablist" aria-label="检视器" className="flex shrink-0 items-center gap-1 border-b hairline px-2 pt-1.5">
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
                'flex items-center gap-1.5 rounded-t-lg px-3 pb-2 pt-1.5 text-[12px] transition',
                active ? 'border-b-2 border-aurora bg-white/[0.03] text-slate-100' : 'text-slate-500 hover:text-slate-300',
              )}
            >
              <entry.icon className="h-3.5 w-3.5" />
              {entry.label}
            </button>
          );
        })}
      </div>
      <div className="stream-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {tab === 'changes' ? <ChangesTab /> : tab === 'screen' ? <ScreenTab /> : <BrainTab />}
      </div>
    </div>
  );
}
