import type { HarnessId, NormalizedAgentError, UnifiedStreamEvent } from '@crosscode/shared';

/**
 * Timeline folding: raw `UnifiedStreamEvent`s from the gateway are folded into
 * display items — consecutive text/thinking deltas merge into one item, tool
 * calls pair with their results by callId, everything else appends as-is.
 */

export interface TimelineUserPrompt {
  kind: 'user_prompt';
  id: string;
  text: string;
}
export interface TimelineThinking {
  kind: 'thinking';
  id: string;
  sessionId: string;
  harness: HarnessId;
  text: string;
}
export interface TimelineMessage {
  kind: 'message';
  id: string;
  sessionId: string;
  harness: HarnessId;
  text: string;
}
export interface TimelineToolStep {
  kind: 'tool';
  id: string;
  callId: string;
  sessionId: string;
  toolName: string;
  args: Record<string, unknown>;
  requiresApproval: boolean;
  status: 'running' | 'ok' | 'error';
  output?: string;
  isError?: boolean;
  previewImageBase64?: string;
}
export interface TimelineFileChange {
  kind: 'file';
  id: string;
  sessionId: string;
  filePath: string;
  additions: number;
  deletions: number;
}
export interface TimelineErrorItem {
  kind: 'error';
  id: string;
  sessionId: string;
  error: NormalizedAgentError;
}
export interface TimelineHarnessSwitch {
  kind: 'harness_switched';
  id: string;
  sessionId: string;
  fromHarness: HarnessId;
  toHarness: HarnessId;
  reason: string;
}
export interface TimelineSystemNote {
  kind: 'system';
  id: string;
  text: string;
}

export type TimelineItem =
  | TimelineUserPrompt
  | TimelineThinking
  | TimelineMessage
  | TimelineToolStep
  | TimelineFileChange
  | TimelineErrorItem
  | TimelineHarnessSwitch
  | TimelineSystemNote;

let itemSeq = 0;
export function nextItemId(): string {
  itemSeq += 1;
  return `t${Date.now().toString(36)}-${itemSeq}`;
}

/** Rough token estimate (chars/4) used for the live token-usage readout. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

function findLastToolIndex(timeline: TimelineItem[], callId: string): number {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i];
    if (item && item.kind === 'tool' && item.callId === callId) return i;
  }
  return -1;
}

export function foldEventIntoTimeline(timeline: TimelineItem[], event: UnifiedStreamEvent): TimelineItem[] {
  switch (event.type) {
    case 'text_delta':
    case 'thinking_delta': {
      const kind = event.type === 'text_delta' ? 'message' : 'thinking';
      const last = timeline.at(-1);
      if (last && last.kind === kind && last.sessionId === event.sessionId) {
        const merged = { ...last, text: last.text + event.text };
        return [...timeline.slice(0, -1), merged];
      }
      const item =
        kind === 'message'
          ? { kind: 'message' as const, id: nextItemId(), sessionId: event.sessionId, harness: event.harness, text: event.text }
          : { kind: 'thinking' as const, id: nextItemId(), sessionId: event.sessionId, harness: event.harness, text: event.text };
      return [...timeline, item];
    }
    case 'tool_call_start':
      return [
        ...timeline,
        {
          kind: 'tool',
          id: event.callId,
          callId: event.callId,
          sessionId: event.sessionId,
          toolName: event.toolName,
          args: event.args,
          requiresApproval: event.requiresApproval,
          status: 'running' as const,
        },
      ];
    case 'tool_call_result': {
      const index = findLastToolIndex(timeline, event.callId);
      const patch: Partial<TimelineToolStep> = {
        status: event.isError ? ('error' as const) : ('ok' as const),
        output: event.output,
        isError: event.isError,
        ...(event.previewImageBase64 ? { previewImageBase64: event.previewImageBase64 } : {}),
      };
      if (index === -1) {
        const item: TimelineToolStep = {
          kind: 'tool',
          id: event.callId,
          callId: event.callId,
          sessionId: event.sessionId,
          toolName: event.toolName,
          args: {},
          requiresApproval: false,
          status: 'ok',
          ...patch,
        };
        return [...timeline, item];
      }
      const target = timeline[index];
      if (!target || target.kind !== 'tool') return timeline;
      const updated: TimelineToolStep = { ...target, ...patch };
      return [...timeline.slice(0, index), updated, ...timeline.slice(index + 1)];
    }
    case 'file_change':
      return [
        ...timeline,
        {
          kind: 'file',
          id: nextItemId(),
          sessionId: event.sessionId,
          filePath: event.filePath,
          additions: event.additions,
          deletions: event.deletions,
        },
      ];
    case 'normalized_error':
      return [...timeline, { kind: 'error', id: nextItemId(), sessionId: event.sessionId, error: event.error }];
    case 'harness_switched':
      return [
        ...timeline,
        {
          kind: 'harness_switched',
          id: nextItemId(),
          sessionId: event.sessionId,
          fromHarness: event.fromHarness,
          toHarness: event.toHarness,
          reason: event.reason,
        },
      ];
    case 'screen_frame':
      // Screen frames render in the right-pane inspector, not in the timeline.
      return timeline;
  }
}
