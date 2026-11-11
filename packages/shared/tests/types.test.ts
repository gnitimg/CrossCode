import { describe, it, expect } from 'vitest';
import {
  ALL_HARNESS_IDS,
  ALL_STANDARD_ERROR_CODES,
  type HarnessId,
  type AgentMode,
  type ErrorCategory,
  type StandardErrorCode,
  type RecoveryAction,
  type NormalizedAgentError,
  type ProviderConfig,
  type SharedSkillMeta,
  type UnifiedProject,
  type AgentWorkspaceManifest,
  type ActiveTaskState,
  type UnifiedStreamEvent,
} from '../src/index.js';

describe('@crosscode/shared core contracts smoke test', () => {
  it('exports all supported HarnessId constants and types', () => {
    expect(ALL_HARNESS_IDS).toEqual([
      'crosscode-native',
      'opencode',
      'claude-code',
      'codex',
      'qoder',
      'zcode',
      'deepseek-harness',
    ]);
    const harness: HarnessId = 'crosscode-native';
    const mode: AgentMode = 'orchestrate';
    expect(harness).toBe('crosscode-native');
    expect(mode).toBe('orchestrate');
  });

  it('exports all StandardErrorCode constants and NormalizedAgentError contract', () => {
    expect(ALL_STANDARD_ERROR_CODES).toHaveLength(11);
    const category: ErrorCategory = 'QUOTA';
    const code: StandardErrorCode = 'CC-QUOTA-2002';
    const recovery: RecoveryAction = 'SWITCH_PROVIDER';

    const error: NormalizedAgentError = {
      code,
      category,
      harness: 'claude-code',
      providerId: 'anthropic-main',
      rawMessage: 'insufficient_quota',
      userTitle: '模型提供商账户额度已耗尽',
      recoveryAction: recovery,
      timestamp: '2026-11-11T00:00:00.000Z',
    };

    expect(error.code).toBe('CC-QUOTA-2002');
    expect(error.recoveryAction).toBe('SWITCH_PROVIDER');
  });

  it('validates ProviderConfig, SharedSkillMeta, UnifiedProject, and .agent workspace contracts', () => {
    const provider: ProviderConfig = {
      id: 'deepseek-official',
      name: 'DeepSeek Official',
      protocol: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      enabled: true,
      latencyMs: 120,
    };

    const skill: SharedSkillMeta = {
      id: 'browser',
      name: 'Browser',
      description: 'Built-in browser control',
      sourcePath: 'C:\\Users\\GNiTi\\.agents\\skills\\browser',
      syncedHarnesses: ['crosscode-native', 'opencode', 'claude-code'],
      enabled: true,
    };

    const project: UnifiedProject = {
      id: 'proj-crosscode',
      name: 'CrossCode',
      path: 'F:\\cs\\CrossCode',
      discoveredFrom: ['crosscode-native', 'opencode'],
      activeHarness: 'crosscode-native',
      activeProviderId: provider.id,
      activeModelId: 'deepseek-chat',
      hasAgentDir: true,
      lastActiveAt: '2026-11-11T00:00:00.000Z',
      gitBranch: 'main',
      pendingDiffCount: 0,
    };

    const manifest: AgentWorkspaceManifest = {
      schemaVersion: '1.0.0',
      projectName: 'CrossCode',
      projectPath: 'F:\\cs\\CrossCode',
      description: 'Unified Coding Agent Orchestrator',
      activeHarness: 'crosscode-native',
      supportedHarnesses: [...ALL_HARNESS_IDS],
      sharedCapabilities: {
        skillsRoot: 'C:\\Users\\GNiTi\\.agents\\skills',
        unifiedMcpEndpoint: 'http://127.0.0.1:4399/mcp',
        builtinBrowser: true,
        externalBrowserBridge: true,
        computerUse: true,
      },
      currentPhase: 'implementation',
      activePlan: '.agent/plans/2026-11-11-crosscode-implementation-plan.md',
      updatedAt: '2026-11-11T00:00:00.000Z',
    };

    const taskState: ActiveTaskState = {
      taskId: 'TASK-001',
      title: 'Initialize Monorepo',
      status: 'in_progress',
      currentHarness: 'opencode',
      currentStep: 'Task 1',
      completedSteps: [],
      nextSteps: ['Task 2'],
      updatedAt: '2026-11-11T00:00:00.000Z',
    };

    const streamEvent: UnifiedStreamEvent = {
      type: 'screen_frame',
      sessionId: 'ses-1',
      source: 'computer-use',
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      width: 1920,
      height: 1080,
      timestamp: '2026-11-11T00:00:00.000Z',
    };

    expect(provider.protocol).toBe('openai');
    expect(skill.syncedHarnesses).toContain('opencode');
    expect(project.hasAgentDir).toBe(true);
    expect(manifest.sharedCapabilities.computerUse).toBe(true);
    expect(taskState.currentHarness).toBe('opencode');
    expect(streamEvent.type).toBe('screen_frame');
  });
});
