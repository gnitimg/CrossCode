import { useEffect, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Brain,
  ChevronDown,
  FileDiff,
  Hexagon,
  MessageSquare,
  SendHorizontal,
  ShieldAlert,
  Sparkles,
  WifiOff,
} from 'lucide-react';
import { useWorkbenchStore, type TimelineItem, type TimelineThinking, type TimelineFileChange } from '../store/workbench';
import { HARNESS_META } from '../lib/harness';
import { renderLiteMarkdown } from '../lib/markdown-lite';
import { ToolCallStepCard } from './ToolCallStepCard';
import { cn } from '../lib/cn';

/**
 * Central streaming timeline: user prompts, collapsible thinking accordions,
 * incremental assistant text, tool-call step cards, file-change stat bars,
 * normalized error cards and harness-switch system lines — plus the prompt
 * composer and empty/loading/reconnecting states.
 */

const QUICK_PROMPTS = ['梳理当前项目结构', '运行测试并修复失败用例', '审阅未提交的变更并总结'];

function ThinkingAccordion({ item }: { item: TimelineThinking }) {
  const [collapsed, setCollapsed] = useState(true);
  return (
    <div className="rise rounded-xl border hairline bg-panel/50">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition hover:bg-white/[0.04]"
      >
        <Brain className="h-3.5 w-3.5 shrink-0 text-aurora" />
        <span className="text-[12px] font-medium text-slate-300">深度思考</span>
        <span className="chip !h-4.5 !px-1.5 font-mono !text-[10px] text-slate-600">{item.text.length} 字符</span>
        <ChevronDown className={cn('ml-auto h-3.5 w-3.5 text-slate-500 transition-transform', !collapsed && 'rotate-180')} />
      </button>
      {!collapsed && (
        <pre className="stream-scroll max-h-72 overflow-y-auto whitespace-pre-wrap border-t hairline px-3 py-2.5 font-mono text-[12px] leading-relaxed text-slate-400">
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
  const total = item.additions + item.deletions;
  const addPct = total === 0 ? 50 : Math.round((item.additions / total) * 100);

  return (
    <button
      type="button"
      onClick={() => {
        setInspectorTab('changes');
        setRightOpen(true);
        setMobilePane('inspector');
      }}
      className="rise w-full rounded-xl border hairline bg-panel/60 px-3 py-2 text-left transition hover:border-white/[0.14] hover:bg-white/[0.04]"
      title="在检视器中打开 Changes"
    >
      <div className="flex items-center gap-2 text-[12px]">
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-glacier" />
        <span className="truncate font-mono text-slate-300">{item.filePath}</span>
        <span className="ml-auto shrink-0 font-mono text-[11px] text-jade">+{item.additions}</span>
        <span className="shrink-0 font-mono text-[11px] text-rosefire">−{item.deletions}</span>
      </div>
      <div className="mt-1.5 flex h-1 gap-px overflow-hidden rounded-full bg-white/[0.06]">
        <div style={{ width: `${addPct}%`, backgroundColor: '#10b981' }} />
        <div style={{ width: `${100 - addPct}%`, backgroundColor: '#f43f5e' }} />
      </div>
    </button>
  );
}

function ErrorItemCard({ item }: { item: Extract<TimelineItem, { kind: 'error' }> }) {
  const color = '#f43f5e';
  return (
    <div className="rise rounded-xl border border-rosefire/35 bg-rosefire/[0.06] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="h-4 w-4 shrink-0" style={{ color }} />
        <span className="chip border-rosefire/40 bg-rosefire/10 font-mono text-rosefire">{item.error.code}</span>
        <span className="text-[12.5px] text-slate-200">{item.error.userTitle}</span>
      </div>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-[11px] text-slate-500 transition hover:text-slate-400">原始报错</summary>
        <pre className="stream-scroll mt-1 max-h-24 overflow-auto whitespace-pre-wrap rounded-lg bg-black/40 p-2 font-mono text-[10.5px] text-slate-400">
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
        <div className="rise flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md border border-aurora/30 bg-aurora/10 px-3.5 py-2 text-[13px] leading-relaxed text-slate-100">
            {item.text}
          </div>
        </div>
      );
    case 'thinking':
      return <ThinkingAccordion item={item} />;
    case 'message':
      return (
        <div className="rise flex gap-2.5">
          <div className="mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-md border hairline bg-panel">
            <Hexagon className="h-3.5 w-3.5 text-aurora" />
          </div>
          <div className="min-w-0 max-w-[calc(100%-2.25rem)] rounded-2xl rounded-tl-md border hairline bg-panel px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-200">
            {renderLiteMarkdown(item.text)}
          </div>
        </div>
      );
    case 'tool':
      return <ToolCallStepCard item={item} />;
    case 'file':
      return <FileChangeRow item={item} />;
    case 'error':
      return <ErrorItemCard item={item} />;
    case 'harness_switched':
      return (
        <div className="rise flex items-center justify-center gap-2 py-1 text-[11.5px] text-slate-500">
          <ArrowRightLeft className="h-3.5 w-3.5" />
          <span className="font-mono">
            {HARNESS_META[item.fromHarness]?.label ?? item.fromHarness} → {HARNESS_META[item.toHarness]?.label ?? item.toHarness}
          </span>
          <span className="truncate text-slate-600">· {item.reason}</span>
        </div>
      );
    case 'system':
      return (
        <div className="rise flex items-center justify-center gap-1.5 py-0.5 text-[11px] italic text-slate-600">
          <Sparkles className="h-3 w-3" />
          {item.text}
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
      <div className="flex h-full flex-col items-center justify-center gap-3">
        {[72, 88, 60].map((width, index) => (
          <div key={index} className="h-3 animate-pulse rounded-full bg-white/[0.06]" style={{ width }} />
        ))}
        <span className="mt-2 text-[12px] text-slate-500">正在建立会话…</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl border hairline bg-panel">
        <Hexagon className="breathe h-7 w-7 text-aurora" />
      </div>
      <div>
        <div className="text-[15px] font-medium text-slate-200">会话空闲</div>
        <div className="mt-1 text-[12px] text-slate-500">
          连接 daemon 后，这里将实时呈现 thinking / 工具调用 / 文件变更流
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {QUICK_PROMPTS.map((prompt) => (
          <button key={prompt} type="button" className="btn btn-ghost" onClick={() => sendPrompt(prompt)}>
            <MessageSquare className="h-3.5 w-3.5 text-slate-500" />
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
    <div className="flex items-center gap-2 border-t border-amber-400/25 bg-amber-400/[0.07] px-4 py-1.5 text-[12px] text-amber-200">
      <WifiOff className="h-3.5 w-3.5" />
      与守护进程的连接中断，正在自动重连（第 {reconnectAttempt} 次尝试）…
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
    <div className="border-t hairline bg-panel/60 p-3 pb-4">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          placeholder={canSend ? '向 agent 发送指令…（Enter 发送，Shift+Enter 换行）' : '等待会话就绪…'}
          disabled={!canSend}
          onChange={(event) => {
            setDraft(event.target.value);
            const el = event.target;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          className="stream-scroll max-h-32 min-h-[38px] flex-1 resize-none rounded-xl border hairline bg-obsidian/60 px-3 py-2 text-[13px] text-slate-200 outline-none transition focus:border-aurora/50 focus:ring-2 focus:ring-aurora/20 disabled:opacity-50"
        />
        <button
          type="button"
          className="btn btn-primary !h-[38px] !px-3.5"
          disabled={!draft.trim() || !canSend}
          onClick={submit}
          aria-label="发送提示词"
        >
          <SendHorizontal className="h-4 w-4" />
        </button>
      </div>
      <div className="mx-auto mt-1.5 max-w-3xl text-[10px] text-slate-600">
        Enter 发送 · Shift+Enter 换行 · Ctrl+K 命令面板 · Esc 关闭
      </div>
    </div>
  );
}

export function UnifiedAgentStream() {
  const timeline = useWorkbenchStore((state) => state.timeline);
  const sessionId = useWorkbenchStore((state) => state.sessionId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [timeline.length]);

  return (
    <section className="flex h-full min-w-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b hairline px-4">
        <MessageSquare className="h-3.5 w-3.5 text-slate-500" />
        <span className="text-[11px] font-medium tracking-wide text-slate-400">统一事件流</span>
        {sessionId && <span className="chip font-mono !text-[10px]">session {sessionId.slice(0, 8)}</span>}
        <span className="chip ml-auto !text-[10px]">{timeline.length} 条事件</span>
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
