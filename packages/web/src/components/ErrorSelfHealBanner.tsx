import {
  ArrowRightLeft,
  Power,
  Repeat,
  ShieldAlert,
  Shrink,
  Timer,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { ErrorCategory, RecoveryAction } from '@crosscode/shared';
import { useWorkbenchStore } from '../store/workbench';
import { HARNESS_META } from '../lib/harness';

const CATEGORY_COLORS: Record<ErrorCategory, string> = {
  AUTH: '#f43f5e',
  QUOTA: '#f59e0b',
  CTX: '#38bdf8',
  TOOL: '#a1a1aa',
  PROC: '#fb7185',
};

const RECOVERY_ACTIONS: Record<RecoveryAction, { label: string; icon: LucideIcon }> = {
  SWITCH_PROVIDER: { label: '切换备用 Provider', icon: Repeat },
  SWITCH_HARNESS: { label: '切换 Harness', icon: ArrowRightLeft },
  COMPACT_CONTEXT: { label: '压缩上下文', icon: Shrink },
  RETRY_BACKOFF: { label: '退避重试', icon: Timer },
  AWAIT_APPROVAL: { label: '查看待审批', icon: ShieldAlert },
  RESTART_PROCESS: { label: '重启进程', icon: Power },
};

export function ErrorSelfHealBanner() {
  const error = useWorkbenchStore((state) => state.errors[0]);
  const recover = useWorkbenchStore((state) => state.recoverActiveError);
  const approvalCount = useWorkbenchStore((state) => state.approvals.length);

  if (!error) return null;

  const action = RECOVERY_ACTIONS[error.recoveryAction];
  const ActionIcon = action.icon;
  const categoryColor = CATEGORY_COLORS[error.category];

  return (
    <div
      role="alert"
      className="relative z-20 flex items-start gap-2.5 border-b border-amber-500/25 bg-amber-500/[0.06] px-3 py-2"
    >
      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip border-amber-500/30 bg-amber-500/10" style={{ color: categoryColor }}>
            {error.code}
          </span>
          <span className="text-[12.5px] font-medium text-zinc-100">{error.userTitle}</span>
          <span className="chip !text-[10px]">{HARNESS_META[error.harness]?.label ?? error.harness}</span>
          {error.recoveryAction === 'AWAIT_APPROVAL' && approvalCount > 0 && (
            <span className="chip border-amber-500/30 text-amber-300">{approvalCount} 个待审批</span>
          )}
        </div>
        <details className="mt-1">
          <summary className="cursor-pointer font-mono text-[10.5px] text-zinc-500 hover:text-zinc-400">
            原始报错
          </summary>
          <pre className="stream-scroll mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-black/50 p-2 font-mono text-[10.5px] text-zinc-400">
            {error.rawMessage}
          </pre>
        </details>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button type="button" className="btn btn-amber !h-6" onClick={recover}>
          <ActionIcon className="h-3 w-3" />
          {action.label}
        </button>
        <button
          type="button"
          className="btn btn-ghost !h-6 !w-6 !p-0"
          onClick={() => useWorkbenchStore.setState((state) => ({ errors: state.errors.slice(1) }))}
          aria-label="忽略此错误"
          title="忽略"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
