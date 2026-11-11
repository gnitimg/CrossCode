import type { ReactNode } from 'react';

/**
 * Extremely small, injection-safe markdown renderer for assistant messages:
 * handles fenced code blocks (```lang ... ```) plus plain paragraphs with
 * preserved whitespace. Everything renders as React nodes — no HTML parsing.
 * An unterminated fence (streaming in progress) degrades gracefully.
 */
export function renderLiteMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const fence = /```(\w*)\n?([\s\S]*?)(?:```|$)/g;
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(
        <p key={key++} className="whitespace-pre-wrap">
          {text.slice(lastIndex, match.index)}
        </p>,
      );
    }
    const lang = match[1] ?? '';
    nodes.push(
      <pre
        key={key++}
        className="stream-scroll my-1.5 overflow-x-auto rounded-lg border border-white/[0.06] bg-black/40 p-2.5 font-mono text-[11.5px] leading-relaxed text-slate-300"
      >
        {lang ? <div className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">{lang}</div> : null}
        <code>{match[2] ?? ''}</code>
      </pre>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(
      <p key={key++} className="whitespace-pre-wrap">
        {text.slice(lastIndex)}
      </p>,
    );
  }
  return nodes;
}
