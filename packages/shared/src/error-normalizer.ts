import type {
  ErrorCategory,
  HarnessId,
  NormalizedAgentError,
  RecoveryAction,
  StandardErrorCode,
} from './types.js';

export interface ErrorCatalogEntry {
  code: StandardErrorCode;
  category: ErrorCategory;
  userTitle: string;
  recoveryAction: RecoveryAction;
  patterns: RegExp[];
}

export const ERROR_CATALOG: readonly ErrorCatalogEntry[] = [
  {
    code: 'CC-AUTH-1001',
    category: 'AUTH',
    patterns: [
      /invalid[_\s-]?api[_\s-]?key/i,
      /missing[_\s-]?api[_\s-]?key/i,
      /invalid x-api-key/i,
      /authentication_error/i,
      /\b401\b.*unauthorized/i,
      /\bunauthorized\b.*\b401\b/i,
      /not logged in/i,
    ],
    userTitle: 'API 密钥无效或未登录',
    recoveryAction: 'SWITCH_PROVIDER',
  },
  {
    code: 'CC-AUTH-1002',
    category: 'AUTH',
    patterns: [
      /permission_error/i,
      /oauth.*expired/i,
      /\b403\b.*forbidden/i,
      /\bforbidden\b.*\b403\b/i,
    ],
    userTitle: '账户权限不足或授权已过期',
    recoveryAction: 'SWITCH_PROVIDER',
  },
  {
    code: 'CC-QUOTA-2002',
    category: 'QUOTA',
    patterns: [
      /insufficient_quota/i,
      /insufficient quota/i,
      /billing[_\s-]?hard[_\s-]?limit/i,
      /balance is insufficient/i,
      /credit balance is too low/i,
    ],
    userTitle: '模型提供商账户额度已耗尽',
    recoveryAction: 'SWITCH_PROVIDER',
  },
  {
    code: 'CC-QUOTA-2001',
    category: 'QUOTA',
    patterns: [
      /rate_limit_exceeded/i,
      /rate limit/i,
      /too many requests/i,
      /\b429\b/,
    ],
    userTitle: '触发请求速率限制 (429)',
    recoveryAction: 'RETRY_BACKOFF',
  },
  {
    code: 'CC-CTX-3001',
    category: 'CTX',
    patterns: [
      /context_length_exceeded/i,
      /context window exceeded/i,
      /prompt is too long/i,
      /maximum context length/i,
    ],
    userTitle: '上下文长度超出模型上限',
    recoveryAction: 'COMPACT_CONTEXT',
  },
  {
    code: 'CC-CTX-3002',
    category: 'CTX',
    patterns: [
      /invalid_tool_input/i,
      /failed to parse tool call/i,
      /tool call json parse error/i,
      /unexpected end of json input/i,
    ],
    userTitle: '工具调用参数解析异常',
    recoveryAction: 'RETRY_BACKOFF',
  },
  {
    code: 'CC-TOOL-4001',
    category: 'TOOL',
    patterns: [
      /mcp tool timeout/i,
      /mcp server disconnected/i,
      /tool execution timed out/i,
    ],
    userTitle: 'MCP 工具调用超时或服务断开',
    recoveryAction: 'RESTART_PROCESS',
  },
  {
    code: 'CC-TOOL-4002',
    category: 'TOOL',
    patterns: [
      /tool approval required/i,
      /permission denied by user/i,
      /awaiting tool approval/i,
      /safety guard blocked/i,
    ],
    userTitle: '高危工具操作等待远程人工审批',
    recoveryAction: 'AWAIT_APPROVAL',
  },
  {
    code: 'CC-TOOL-4003',
    category: 'TOOL',
    patterns: [
      /file lock conflict/i,
      /\bEBUSY\b/,
      /\bEPERM\b/,
      /\bEACCES\b/,
      /file is being used by another process/i,
    ],
    userTitle: '本地文件锁冲突或系统权限受限',
    recoveryAction: 'RETRY_BACKOFF',
  },
  {
    code: 'CC-PROC-5002',
    category: 'PROC',
    patterns: [
      /network disconnect/i,
      /\bECONNRESET\b/,
      /\bETIMEDOUT\b/,
      /\bECONNREFUSED\b/,
      /socket hang up/i,
    ],
    userTitle: '上游模型网络连接中断或超时',
    recoveryAction: 'RETRY_BACKOFF',
  },
  {
    code: 'CC-PROC-5001',
    category: 'PROC',
    patterns: [
      /process exited with code/i,
      /exit code [1-9]\d*/i,
      /fatal error/i,
    ],
    userTitle: '底层 Agent 进程或未知运行异常',
    recoveryAction: 'RESTART_PROCESS',
  },
] as const;

const DEFAULT_FALLBACK_ENTRY: ErrorCatalogEntry = ERROR_CATALOG.find(
  (entry) => entry.code === 'CC-PROC-5001',
)!;

export function normalizeHarnessError(
  harness: HarnessId,
  rawInput: string | Error,
  providerId?: string,
): NormalizedAgentError {
  const rawMessage = rawInput instanceof Error ? rawInput.message : String(rawInput);

  for (const rule of ERROR_CATALOG) {
    if (rule.code === 'CC-PROC-5001') {
      continue;
    }
    if (rule.patterns.some((re) => re.test(rawMessage))) {
      return {
        code: rule.code,
        category: rule.category,
        harness,
        providerId,
        rawMessage,
        userTitle: rule.userTitle,
        recoveryAction: rule.recoveryAction,
        timestamp: new Date().toISOString(),
      };
    }
  }

  return {
    code: DEFAULT_FALLBACK_ENTRY.code,
    category: DEFAULT_FALLBACK_ENTRY.category,
    harness,
    providerId,
    rawMessage,
    userTitle: DEFAULT_FALLBACK_ENTRY.userTitle,
    recoveryAction: DEFAULT_FALLBACK_ENTRY.recoveryAction,
    timestamp: new Date().toISOString(),
  };
}

export function isRecoverableByFailover(err: NormalizedAgentError): boolean {
  return (
    err.recoveryAction === 'SWITCH_PROVIDER' ||
    err.recoveryAction === 'SWITCH_HARNESS'
  );
}
