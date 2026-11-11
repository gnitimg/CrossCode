/** UI-level model types shared between store slices and components. */

export type ConnectionMode = 'boot' | 'offline' | 'live' | 'demo';
export type WsStatus = 'idle' | 'connecting' | 'authenticating' | 'live' | 'reconnecting' | 'closed' | 'failed';
export type InspectorTab = 'changes' | 'screen' | 'brain';
export type MobilePane = 'projects' | 'stream' | 'inspector';

/** High-risk tool call awaiting an approve/reject decision (gateway card). */
export interface ApprovalCard {
  approvalId: string;
  sessionId: string;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  createdAt: string;
}

/** Latest `screen_frame` render payload for the Live inspector tab. */
export interface ScreenFrameView {
  imageBase64: string;
  mime: string;
  source: 'builtin-browser' | 'external-browser' | 'computer-use';
  width?: number;
  height?: number;
  timestamp: string;
}
