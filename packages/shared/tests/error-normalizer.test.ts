import { describe, it, expect } from 'vitest';
import {
  ALL_HARNESS_IDS,
  ALL_STANDARD_ERROR_CODES,
  ERROR_CATALOG,
  normalizeHarnessError,
  isRecoverableByFailover,
} from '../src/index.js';

describe('UnifiedErrorNormalizer', () => {
  it('defines ERROR_CATALOG entries for all 11 standard error codes', () => {
    const catalogCodes = ERROR_CATALOG.map((entry) => entry.code);
    for (const code of ALL_STANDARD_ERROR_CODES) {
      expect(catalogCodes).toContain(code);
    }
    expect(ERROR_CATALOG).toHaveLength(11);
    for (const entry of ERROR_CATALOG) {
      expect(entry.userTitle.length).toBeGreaterThan(0);
      expect(Array.isArray(entry.patterns)).toBe(true);
    }
  });

  it('maps CC-AUTH-1001 (API Key invalid / missing / 401 unauthorized)', () => {
    const err1 = normalizeHarnessError(
      'claude-code',
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
      'anthropic-main',
    );
    expect(err1.code).toBe('CC-AUTH-1001');
    expect(err1.category).toBe('AUTH');
    expect(err1.harness).toBe('claude-code');
    expect(err1.providerId).toBe('anthropic-main');
    expect(err1.recoveryAction).toBe('SWITCH_PROVIDER');
    expect(isRecoverableByFailover(err1)).toBe(true);

    const err2 = normalizeHarnessError('opencode', 'Error: 401 Unauthorized - missing api key');
    expect(err2.code).toBe('CC-AUTH-1001');
    expect(err2.recoveryAction).toBe('SWITCH_PROVIDER');
  });

  it('maps CC-AUTH-1002 (OAuth expired / 403 forbidden / permission_error)', () => {
    const err1 = normalizeHarnessError(
      'qoder',
      'Error: OAuth token expired, please re-authenticate',
    );
    expect(err1.code).toBe('CC-AUTH-1002');
    expect(err1.category).toBe('AUTH');
    expect(err1.recoveryAction).toBe('SWITCH_PROVIDER');
    expect(isRecoverableByFailover(err1)).toBe(true);

    const err2 = normalizeHarnessError('zcode', 'HTTP 403 Forbidden: permission_error on model');
    expect(err2.code).toBe('CC-AUTH-1002');
    expect(err2.recoveryAction).toBe('SWITCH_PROVIDER');
  });

  it('maps CC-QUOTA-2001 (Rate limit 429 / too many requests / rate_limit_exceeded)', () => {
    const err = normalizeHarnessError(
      'opencode',
      'Error: 429 Too Many Requests - rate_limit_exceeded',
      'openai-primary',
    );
    expect(err.code).toBe('CC-QUOTA-2001');
    expect(err.category).toBe('QUOTA');
    expect(err.recoveryAction).toBe('RETRY_BACKOFF');
    expect(isRecoverableByFailover(err)).toBe(false);
  });

  it('maps CC-QUOTA-2002 (Insufficient quota / billing hard limit / balance is insufficient / credit balance is too low)', () => {
    const err1 = normalizeHarnessError(
      'deepseek-harness',
      'insufficient_quota: You exceeded your current quota, please check your plan and billing details',
    );
    expect(err1.code).toBe('CC-QUOTA-2002');
    expect(err1.category).toBe('QUOTA');
    expect(err1.recoveryAction).toBe('SWITCH_PROVIDER');
    expect(isRecoverableByFailover(err1)).toBe(true);

    const err2 = normalizeHarnessError(
      'claude-code',
      'Your credit balance is too low to access the Anthropic API.',
    );
    expect(err2.code).toBe('CC-QUOTA-2002');

    const err3 = normalizeHarnessError(
      'crosscode-native',
      'Error: account balance is insufficient (billing_hard_limit_reached)',
    );
    expect(err3.code).toBe('CC-QUOTA-2002');
  });

  it('maps CC-CTX-3001 (Context window exceeded / prompt is too long / maximum context length)', () => {
    const err = normalizeHarnessError(
      'codex',
      'prompt is too long: 215400 tokens > 200000 maximum context length (context_length_exceeded)',
    );
    expect(err.code).toBe('CC-CTX-3001');
    expect(err.category).toBe('CTX');
    expect(err.recoveryAction).toBe('COMPACT_CONTEXT');
    expect(isRecoverableByFailover(err)).toBe(false);
  });

  it('maps CC-CTX-3002 (Tool call JSON parse error / invalid_tool_input / unexpected end of JSON input)', () => {
    const err1 = normalizeHarnessError(
      'crosscode-native',
      'SyntaxError: Unexpected end of JSON input while parsing tool call arguments',
    );
    expect(err1.code).toBe('CC-CTX-3002');
    expect(err1.category).toBe('CTX');
    expect(err1.recoveryAction).toBe('RETRY_BACKOFF');

    const err2 = normalizeHarnessError('claude-code', 'invalid_tool_input: failed to parse tool call');
    expect(err2.code).toBe('CC-CTX-3002');
  });

  it('maps CC-TOOL-4001 (MCP tool timeout / MCP server disconnected / tool execution timed out)', () => {
    const err1 = normalizeHarnessError(
      'opencode',
      'Error: MCP server disconnected unexpectedly during tool invocation',
    );
    expect(err1.code).toBe('CC-TOOL-4001');
    expect(err1.category).toBe('TOOL');
    expect(err1.recoveryAction).toBe('RESTART_PROCESS');

    const err2 = normalizeHarnessError(
      'crosscode-native',
      'MCP tool timeout: tool execution timed out after 30000ms',
    );
    expect(err2.code).toBe('CC-TOOL-4001');
  });

  it('maps CC-TOOL-4002 (Tool approval required / permission denied by user / awaiting tool approval / safety guard blocked)', () => {
    const err1 = normalizeHarnessError(
      'claude-code',
      'Tool execution paused: awaiting tool approval from user',
    );
    expect(err1.code).toBe('CC-TOOL-4002');
    expect(err1.category).toBe('TOOL');
    expect(err1.recoveryAction).toBe('AWAIT_APPROVAL');

    const err2 = normalizeHarnessError('qoder', 'Safety guard blocked dangerous shell command');
    expect(err2.code).toBe('CC-TOOL-4002');
  });

  it('maps CC-TOOL-4003 (File lock conflict / EBUSY / EPERM / EACCES / file is being used by another process)', () => {
    const err1 = normalizeHarnessError(
      'codex',
      "Error: EBUSY: resource busy or locked, open 'F:\\cs\\CrossCode\\package.json'",
    );
    expect(err1.code).toBe('CC-TOOL-4003');
    expect(err1.category).toBe('TOOL');
    expect(err1.recoveryAction).toBe('RETRY_BACKOFF');

    const err2 = normalizeHarnessError(
      'zcode',
      'The process cannot access the file because the file is being used by another process (EPERM / EACCES)',
    );
    expect(err2.code).toBe('CC-TOOL-4003');
  });

  it('maps CC-PROC-5002 (Network disconnect / ECONNRESET / ETIMEDOUT / ECONNREFUSED / socket hang up)', () => {
    const err1 = normalizeHarnessError(
      'deepseek-harness',
      'FetchError: request to https://api.deepseek.com/v1/chat/completions failed, reason: read ECONNRESET',
    );
    expect(err1.code).toBe('CC-PROC-5002');
    expect(err1.category).toBe('PROC');
    expect(err1.recoveryAction).toBe('RETRY_BACKOFF');

    const err2 = normalizeHarnessError('opencode', 'Error: socket hang up (ETIMEDOUT / ECONNREFUSED)');
    expect(err2.code).toBe('CC-PROC-5002');
  });

  it('maps CC-PROC-5001 as default fallback for process crash / exit code != 0 / unknown fatal error across all harnesses', () => {
    for (const harness of ALL_HARNESS_IDS) {
      const err = normalizeHarnessError(
        harness,
        new Error('Process exited with code 137 (SIGKILL): unexpected fatal crash'),
      );
      expect(err.code).toBe('CC-PROC-5001');
      expect(err.category).toBe('PROC');
      expect(err.harness).toBe(harness);
      expect(err.recoveryAction).toBe('RESTART_PROCESS');
      expect(err.rawMessage).toContain('Process exited with code 137');
      expect(isRecoverableByFailover(err)).toBe(false);
    }

    const syntheticSwitchHarnessError = {
      ...normalizeHarnessError('opencode', 'unknown crash'),
      recoveryAction: 'SWITCH_HARNESS' as const,
    };
    expect(isRecoverableByFailover(syntheticSwitchHarnessError)).toBe(true);
  });
});
