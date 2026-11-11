import { useState } from 'react';
import { Check, ChevronDown, ShieldAlert, X } from 'lucide-react';
import { useWorkbenchStore, type TimelineToolStep } from '../store/workbench';
import type { ApprovalCard } from '../store/model';
import { isVisualTool, toolVisual, truncate } from '../lib/tool-meta';
import { cn } from '../lib/cn';

/**
 * One tool invocation in the unified stream: argument summary chips, a
 * browser/desktop thumbnail placeholder, result preview — and the high-risk
 * Approve/Reject card when the gateway raised a pending approval.
 */
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
        'rise overflow-hidden rounded-xl border bg-panel/70',
        item.status === 'error' ? 'border-rosefire/35' : item.status === 'running' ? 'border-glacier/30' : 'hairline',
      )}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white/[0.06]" style={{ color: visual.color }}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="truncate font-mono text-[12px] text-slate-200" title={item.toolName}>
          {item.toolName}
        </span>
        <span className="chip hidden font-mono !text-[10px] text-slate-600 sm:inline-flex">{item.callId.slice(0, 8)}</span>
        <span className="ml-auto shrink-0">
          {item.status === 'running' ? (
            <span className="chip border-glacier/30 bg-glacier/10 text-glacier">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-glacier" />
              执行中
            </span>
          ) : item.status === 'ok' ? (
            <span className="chip border-jade/30 bg-jade/10 text-jade">
              <Check className="h-3 w-3" />
              完成
            </span>
          ) : (
            <span className="chip border-rosefire/30 bg-rosefire/10 text-rosefire">
              <X className="h-3 w-3" />
              失败
            </span>
          )}
        </span>
      </div>

      {argEntries.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2">
          {argEntries.map(([key, value]) => (
            <span key={key} className="chip max-w-[260px] font-mono !text-[10.5px] text-slate-400" title={`${key}: ${String(value)}`}>
              {key}: {truncate(String(value), 42)}
            </span>
          ))}
        </div>
      )}

      {isVisualTool(visual.kind) && (
        <div className="px-3 pb-2">
          {item.previewImageBase64 ? (
            <img
              src={`data:image/png;base64,${item.previewImageBase64}`}
              alt={`${item.toolName} 结果截图`}
              className="max-h-44 w-full rounded-lg border border-white/[0.06] object-cover"
            />
          ) : (
            <div className="flex aspect-[16/9] max-h-44 w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/[0.09] bg-black/30 text-slate-600">
              <Icon className="h-5 w-5" />
              <span className="text-[10.5px]">浏览器 / 桌面画面占位 — 等待结果预览</span>
            </div>
          )}
        </div>
      )}

      {item.output !== undefined && (
        <div className="px-3 pb-2">
          <pre
            className={cn(
              'stream-scroll overflow-auto whitespace-pre-wrap rounded-lg border border-white/[0.06] bg-black/40 p-2.5 font-mono text-[11px] leading-relaxed text-slate-300',
              item.isError ? 'text-rosefire/90' : '',
              outputExpanded ? 'max-h-96' : 'max-h-40',
            )}
          >
            {truncate(item.output, outputExpanded ? 4000 : 400)}
          </pre>
          {item.output.length > 400 && (
            <button
              type="button"
              onClick={() => setOutputExpanded((value) => !value)}
              className="mt-1 inline-flex items-center gap-1 text-[10.5px] text-slate-500 transition hover:text-slate-300"
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
    <div className="mx-3 mb-3 rounded-lg border border-amber-400/40 bg-amber-400/[0.07] p-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-amber-200">
        <ShieldAlert className="h-4 w-4 shrink-0" />
        <span className="font-medium">高危操作需要审批</span>
        <span className="chip border-amber-400/30 font-mono text-amber-300">{approval.toolName}</span>
      </div>
      <div className="mt-2 flex gap-2">
        <button type="button" className="btn btn-jade" onClick={() => onRespond(approval.approvalId, true)}>
          <Check className="h-3.5 w-3.5" />
          批准执行
        </button>
        <button type="button" className="btn btn-danger" onClick={() => onRespond(approval.approvalId, false)}>
          <X className="h-3.5 w-3.5" />
          拒绝
        </button>
      </div>
    </div>
  );
}
