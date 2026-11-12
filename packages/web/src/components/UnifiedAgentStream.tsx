import { useEffect, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  ChevronRight,
  CornerDownLeft,
  FileDiff,
  ShieldAlert,
  WifiOff,
} from 'lucide-react';
import { useWorkbenchStore, type TimelineItem, type TimelineThinking, type TimelineFileChange } from '../store/workbench';
import { HARNESS_META } from '../lib/harness';
import { renderLiteMarkdown } from '../lib/markdown-lite';
import { ToolCallStepCard } from './ToolCallStepCard';
import { cn } from '../lib/cn';

const QUICK_PROMPTS = ['git status & diff summary', 'run test suite', 'inspect active .agent task'];

function ThinkingRow({ item }: { item: TimelineThinking }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border-l-2 border-zinc-800 pl-3 py-0.5">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="inline-flex items-center gap-1.5 font-mono text-[11px] text-zinc-500 transition hover:text-zinc-300"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')} />
        <span>reasoning</span>
        <span className="text-zinc-600">({item.text.length} chars)</span>
      </button>
      {expanded && (
        <pre className="stream-scroll mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-zinc-500">
          {item.text}
        </pre>
      )}
    </div>
  );
}

function FileChangeRow({ item }: { item: TimelineFileChange }) {
  const setMobilePane = useWorkbenchStore((state) => state.setMobilePane);
  const setInspectorTab = useWorkbenchStore((state) => state.setInspectorTab);
  const setRightOpen = useWorkbenchStore((state) => state.setRightOpen);

  return (
    <button
      type="button"
      onClick={() => {
        setInspectorTab('changes');
        setRightOpen(true);
        setMobilePane('inspector');
      }}
      className="flex w-full items-center gap-2 rounded border hairline bg-panel px-2.5 py-1.5 text-left font-mono text-[11.5px] transition hover:border-zinc-700"
    >
      <FileDiff className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
      <span className="truncate text-zinc-300">{item.filePath}</span>
      <span className="ml-auto shrink-0 text-emerald-400">+{item.additions}</span>
      <span className="shrink-0 text-rose-400">−{item.deletions}</span>
    </button>
  );
}

function ErrorItemCard({ item }: { item: Extract<TimelineItem, { kind: 'error' }> }) {
  return (
    <div className="rounded border border-rose-500/30 bg-rose-500/[0.04] px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-rose-400" />
        <span className="chip border-rose-500/30 bg-rose-500/10 text-rose-300">{item.error.code}</span>
        <span className="text-[12px] text-zinc-200">{item.error.userTitle}</span>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer font-mono text-[10.5px] text-zinc-500 hover:text-zinc-400">
          raw stderr / trace
        </summary>
        <pre className="stream-scroll mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-black/50 p-2 font-mono text-[10.5px] text-zinc-400">
          {item.error.rawMessage}
        </pre>
      </details>
    </div>
  );
}

function StreamItem({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case 'user_prompt':
      return (
        <div className="border-l-2 border-zinc-200 bg-white/[0.025] px-3.5 py-2 text-[13px] leading-relaxed text-zinc-100">
          {item.text}
        </div>
      );
    case 'thinking':
      return <ThinkingRow item={item} />;
    case 'message': {
      const meta = HARNESS_META[item.harness];
      return (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 font-mono text-[10.5px] text-zinc-500">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta?.color ?? '#a1a1aa' }} />
            <span>{meta?.label ?? item.harness}</span>
          </div>
          <div className="text-[13px] leading-relaxed text-zinc-200">
            {renderLiteMarkdown(item.text)}
          </div>
        </div>
      );
    }
    case 'tool':
      return <ToolCallStepCard item={item} />;
    case 'file':
      return <FileChangeRow item={item} />;
    case 'error':
      return <ErrorItemCard item={item} />;
    case 'harness_switched':
      return (
        <div className="flex items-center gap-2 border-l-2 border-amber-500/50 pl-3 py-0.5 font-mono text-[11px] text-zinc-400">
          <ArrowRightLeft className="h-3 w-3 text-amber-400" />
          <span>
            {HARNESS_META[item.fromHarness]?.label ?? item.fromHarness} → {HARNESS_META[item.toHarness]?.label ?? item.toHarness}
          </span>
          <span className="truncate text-zinc-600">({item.reason})</span>
        </div>
      );
    case 'system':
      return (
        <div className="font-mono text-[11px] text-zinc-500">
          — {item.text}
        </div>
      );
  }
}

function StreamEmptyState() {
  const sendPrompt = useWorkbenchStore((state) => state.sendPrompt);
  const wsStatus = useWorkbenchStore((state) => state.wsStatus);
  const mode = useWorkbenchStore((state) => state.mode);
  const waiting = wsStatus === 'connecting' || wsStatus === 'authenticating';

  if (waiting && mode !== 'demo') {
    return (
      <div className="flex h-full items-center justify-center font-mono text-[12px] text-zinc-500">
        attaching session...
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="font-mono text-[12px] text-zinc-500">
        No active events in current session.
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            className="btn btn-ghost border hairline font-mono text-[11px]"
            onClick={() => sendPrompt(prompt)}
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

function ReconnectingNotice() {
  const wsStatus = useWorkbenchStore((state) => state.wsStatus);
  const reconnectAttempt = useWorkbenchStore((state) => state.reconnectAttempt);
  if (wsStatus !== 'reconnecting') return null;
  return (
    <div className="flex items-center gap-2 border-t border-amber-500/25 bg-amber-500/[0.06] px-4 py-1.5 font-mono text-[11.5px] text-amber-300">
      <WifiOff className="h-3.5 w-3.5" />
      <span>daemon connection lost, reconnecting (#{reconnectAttempt})...</span>
    </div>
  );
}

function Composer() {
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mode = useWorkbenchStore((state) => state.mode);
  const wsStatus = useWorkbenchStore((state) => state.wsStatus);
  const sendPrompt = useWorkbenchStore((state) => state.sendPrompt);
  const canSend = mode === 'demo' || wsStatus === 'live';

  const submit = (): void => {
    const text = draft.trim();
    if (!text || !canSend) return;
    sendPrompt(text);
    setDraft('');
    const el = textareaRef.current;
    if (el) el.style.height = '';
  };

  return (
    <div className="border-t hairline bg-panel p-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          placeholder={canSend ? '输入指令或任务描述… (Enter 发送, Shift+Enter 换行)' : '等待守护进程连接…'}
          disabled={!canSend}
          onChange={(event) => {
            setDraft(event.target.value);
            const el = event.target;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          className="stream-scroll max-h-36 min-h-[34px] flex-1 resize-none rounded border hairline bg-obsidian px-3 py-1.5 text-[13px] text-zinc-100 outline-none transition focus:border-zinc-500 disabled:opacity-50"
        />
        <button
          type="button"
          className="btn btn-primary !h-[34px] !px-3"
          disabled={!draft.trim() || !canSend}
          onClick={submit}
          aria-label="发送提示词"
        >
          <CornerDownLeft className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

export function UnifiedAgentStream() {
  const timeline = useWorkbenchStore((state) => state.timeline);
  const sessionId = useWorkbenchStore((state) => state.sessionId);
  const activeProjectId = useWorkbenchStore((state) => state.activeProjectId);
  const projects = useWorkbenchStore((state) => state.projects);
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [timeline.length]);

  return (
    <section className="flex h-full min-w-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b hairline px-4 font-mono text-[11px] text-zinc-500">
        <span className="text-zinc-300">{activeProject?.name ?? 'session'}</span>
        {activeProject?.path && (
          <span className="hidden truncate text-zinc-600 sm:inline">{activeProject.path}</span>
        )}
        {sessionId && <span className="ml-auto text-zinc-600">#{sessionId.slice(0, 8)}</span>}
      </div>

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const el = event.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
        className="stream-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {timeline.length === 0 ? (
          <StreamEmptyState />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-3">
            {timeline.map((item) => (
              <StreamItem key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>

      <ReconnectingNotice />
      <Composer />
    </section>
  );
}
