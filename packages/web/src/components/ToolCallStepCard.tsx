import { useState } from 'react';
import { Check, ChevronDown, ShieldAlert, X } from 'lucide-react';
import { useWorkbenchStore, type TimelineToolStep } from '../store/workbench';
import type { ApprovalCard } from '../store/model';
import { isVisualTool, toolVisual, truncate } from '../lib/tool-meta';
import { cn } from '../lib/cn';

export function ToolCallStepCard({ item }: { item: TimelineToolStep }) {
  const approval = useWorkbenchStore((state) => state.approvals.find((card) => card.callId === item.callId));
  const respondApproval = useWorkbenchStore((state) => state.respondApproval);
  const [outputExpanded, setOutputExpanded] = useState(false);
  const visual = toolVisual(item.toolName);
  const Icon = visual.icon;

  const argEntries = Object.entries(item.args).slice(0, 6);

  return (
    <div
      className={cn(
        'overflow-hidden rounded border bg-panel',
        item.status === 'error'
          ? 'border-rose-500/35'
          : approval
            ? 'border-amber-500/40'
            : 'hairline',
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5 font-mono text-[11.5px]">
        <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <span className="truncate font-medium text-zinc-200" title={item.toolName}>
          {item.toolName}
        </span>
        <span className="hidden text-[10px] text-zinc-600 sm:inline">{item.callId.slice(0, 8)}</span>
        <span className="ml-auto shrink-0 text-[10.5px]">
          {item.status === 'running' ? (
            <span className="inline-flex items-center gap-1.5 text-sky-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400" />
              执行中
            </span>
          ) : item.status === 'ok' ? (
            <span className="inline-flex items-center gap-1 text-emerald-400">
              <Check className="h-3 w-3" />
              完成
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-rose-400">
              <X className="h-3 w-3" />
              失败
            </span>
          )}
        </span>
      </div>

      {argEntries.length > 0 && (
        <div className="flex flex-wrap gap-1 border-t hairline bg-obsidian/40 px-2.5 py-1.5">
          {argEntries.map(([key, value]) => (
            <span
              key={key}
              className="chip max-w-[280px] !text-[10.5px] text-zinc-400"
              title={`${key}: ${String(value)}`}
            >
              {key}: {truncate(String(value), 48)}
            </span>
          ))}
        </div>
      )}

      {isVisualTool(visual.kind) && (
        <div className="border-t hairline px-2.5 py-2">
          {item.previewImageBase64 ? (
            <img
              src={`data:image/png;base64,${item.previewImageBase64}`}
              alt={`${item.toolName} 结果截图`}
              className="max-h-44 w-full rounded border hairline object-cover"
            />
          ) : (
            <div className="flex h-24 w-full items-center justify-center gap-2 rounded border border-dashed border-zinc-800 bg-obsidian/50 font-mono text-[10.5px] text-zinc-600">
              <Icon className="h-3.5 w-3.5" />
              <span>浏览器 / 桌面画面占位 — 等待结果预览</span>
            </div>
          )}
        </div>
      )}

      {item.output !== undefined && (
        <div className="border-t hairline px-2.5 py-2">
          <pre
            className={cn(
              'stream-scroll overflow-auto whitespace-pre-wrap rounded bg-obsidian p-2 font-mono text-[11px] leading-relaxed text-zinc-300',
              item.isError ? 'text-rose-400' : '',
              outputExpanded ? 'max-h-96' : 'max-h-36',
            )}
          >
            {truncate(item.output, outputExpanded ? 4000 : 400)}
          </pre>
          {item.output.length > 400 && (
            <button
              type="button"
              onClick={() => setOutputExpanded((value) => !value)}
              className="mt-1 inline-flex items-center gap-1 font-mono text-[10.5px] text-zinc-500 transition hover:text-zinc-300"
            >
              <ChevronDown className={cn('h-3 w-3 transition-transform', outputExpanded && 'rotate-180')} />
              {outputExpanded ? '收起输出' : '展开完整输出'}
            </button>
          )}
        </div>
      )}

      {approval && <InlineApprovalCard approval={approval} onRespond={respondApproval} />}
    </div>
  );
}

function InlineApprovalCard({
  approval,
  onRespond,
}: {
  approval: ApprovalCard;
  onRespond: (approvalId: string, approved: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-2">
      <div className="flex items-center gap-2 text-[12px] text-amber-200">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-amber-400" />
        <span className="font-medium">高危操作需要审批</span>
        <span className="chip border-amber-500/30 text-amber-300">{approval.toolName}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <button type="button" className="btn btn-jade !h-6" onClick={() => onRespond(approval.approvalId, true)}>
          <Check className="h-3 w-3" />
          批准执行
        </button>
        <button type="button" className="btn btn-danger !h-6" onClick={() => onRespond(approval.approvalId, false)}>
          <X className="h-3 w-3" />
          拒绝
        </button>
      </div>
    </div>
  );
}
