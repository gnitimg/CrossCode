export type HarnessId =
  | 'crosscode-native'
  | 'opencode'
  | 'claude-code'
  | 'codex'
  | 'qoder'
  | 'zcode'
  | 'deepseek-harness';

export type AgentMode = 'plan' | 'build' | 'orchestrate';

export type ErrorCategory = 'AUTH' | 'QUOTA' | 'CTX' | 'TOOL' | 'PROC';

export type StandardErrorCode =
  | 'CC-AUTH-1001'
  | 'CC-AUTH-1002'
  | 'CC-QUOTA-2001'
  | 'CC-QUOTA-2002'
  | 'CC-CTX-3001'
  | 'CC-CTX-3002'
  | 'CC-TOOL-4001'
  | 'CC-TOOL-4002'
  | 'CC-TOOL-4003'
  | 'CC-PROC-5001'
  | 'CC-PROC-5002';

export type RecoveryAction =
  | 'SWITCH_PROVIDER'
  | 'SWITCH_HARNESS'
  | 'COMPACT_CONTEXT'
  | 'RETRY_BACKOFF'
  | 'AWAIT_APPROVAL'
  | 'RESTART_PROCESS';

export interface NormalizedAgentError {
  code: StandardErrorCode;
  category: ErrorCategory;
  harness: HarnessId;
  providerId?: string;
  rawMessage: string;
  userTitle: string;
  recoveryAction: RecoveryAction;
  timestamp: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  protocol: 'anthropic' | 'openai' | 'gemini' | 'custom';
  baseUrl: string;
  apiKeyEnv: string;
  models: string[];
  enabled: boolean;
  latencyMs?: number;
}

export interface SharedSkillMeta {
  id: string;
  name: string;
  description: string;
  sourcePath: string;
  syncedHarnesses: HarnessId[];
  enabled: boolean;
}

export interface UnifiedProject {
  id: string;
  name: string;
  path: string;
  discoveredFrom: HarnessId[];
  activeHarness: HarnessId;
  activeProviderId: string;
  activeModelId: string;
  hasAgentDir: boolean;
  lastActiveAt: string;
  gitBranch?: string;
  pendingDiffCount?: number;
}

export interface AgentWorkspaceManifest {
  schemaVersion: string;
  projectName: string;
  projectPath: string;
  description?: string;
  activeHarness: HarnessId;
  supportedHarnesses: HarnessId[];
  sharedCapabilities: {
    skillsRoot: string;
    unifiedMcpEndpoint: string;
    builtinBrowser: boolean;
    externalBrowserBridge: boolean;
    computerUse: boolean;
  };
  currentPhase: string;
  activePlan?: string;
  updatedAt: string;
}

export interface ActiveTaskState {
  taskId: string;
  title: string;
  status: string;
  currentHarness: HarnessId;
  currentStep: string;
  completedSteps: string[];
  nextSteps: string[];
  updatedAt: string;
}

export type UnifiedStreamEvent =
  | {
      type: 'thinking_delta';
      sessionId: string;
      harness: HarnessId;
      text: string;
    }
  | {
      type: 'text_delta';
      sessionId: string;
      harness: HarnessId;
      text: string;
    }
  | {
      type: 'tool_call_start';
      sessionId: string;
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      requiresApproval: boolean;
    }
  | {
      type: 'tool_call_result';
      sessionId: string;
      callId: string;
      toolName: string;
      output: string;
      isError?: boolean;
      previewImageBase64?: string;
    }
  | {
      type: 'file_change';
      sessionId: string;
      filePath: string;
      additions: number;
      deletions: number;
      diffPatch: string;
    }
  | {
      type: 'normalized_error';
      sessionId: string;
      error: NormalizedAgentError;
    }
  | {
      type: 'harness_switched';
      sessionId: string;
      fromHarness: HarnessId;
      toHarness: HarnessId;
      reason: string;
    }
  | {
      type: 'screen_frame';
      sessionId: string;
      source: 'builtin-browser' | 'external-browser' | 'computer-use';
      imageBase64: string;
      width?: number;
      height?: number;
      timestamp: string;
    };

export const ALL_HARNESS_IDS: readonly HarnessId[] = [
  'crosscode-native',
  'opencode',
  'claude-code',
  'codex',
  'qoder',
  'zcode',
  'deepseek-harness',
] as const;

export const ALL_STANDARD_ERROR_CODES: readonly StandardErrorCode[] = [
  'CC-AUTH-1001',
  'CC-AUTH-1002',
  'CC-QUOTA-2001',
  'CC-QUOTA-2002',
  'CC-CTX-3001',
  'CC-CTX-3002',
  'CC-TOOL-4001',
  'CC-TOOL-4002',
  'CC-TOOL-4003',
  'CC-PROC-5001',
  'CC-PROC-5002',
] as const;
