import type { ActiveTaskState, NormalizedAgentError, SharedSkillMeta, UnifiedProject } from '@crosscode/shared';
import type { ProviderCatalogEntry } from '../api/client';
import { toDiffSummaryView, type DiffSummaryView } from '../lib/diff';
import type { ApprovalCard, ScreenFrameView } from './model';
import { nextItemId, type TimelineItem } from './event-fold';

function fakeDiff(file: string, additions: number, deletions: number): string {
  const lines = [
    `diff --git a/${file} b/${file}`,
    'index 84c19a0..e91b220 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${deletions + 1} +1,${additions + 1} @@`,
  ];
  for (let i = 0; i < additions; i += 1) lines.push(`+  // updated line ${i + 1}`);
  for (let i = 0; i < deletions; i += 1) lines.push(`-  // previous line ${i + 1}`);
  return lines.join('\n');
}

function demoScreenFrame(timestamp: string): ScreenFrameView {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">' +
    '<rect width="1280" height="800" fill="#0a0a0c"/>' +
    '<rect width="1280" height="36" fill="#111114"/>' +
    '<text x="20" y="23" font-family="monospace" font-size="12" fill="#a1a1aa">http://127.0.0.1:4399/projects</text>' +
    '<rect x="24" y="56" width="1232" height="720" rx="4" fill="#111114" stroke="rgba(255,255,255,0.07)"/>' +
    '<text x="48" y="96" font-family="monospace" font-size="14" fill="#e4e4e7">200 OK - 3 workspaces indexed</text>' +
    '</svg>';
  return {
    imageBase64: globalThis.btoa(svg),
    mime: 'image/svg+xml',
    source: 'builtin-browser',
    width: 1280,
    height: 800,
    timestamp,
  };
}

const DEMO_ERROR: NormalizedAgentError = {
  code: 'CC-QUOTA-2002',
  category: 'QUOTA',
  harness: 'deepseek-harness',
  providerId: 'deepseek',
  rawMessage:
    'Error 429: insufficient_quota — You exceeded your current quota, please check your plan and billing details (deepseek-chat).',
  userTitle: 'DeepSeek 账户配额已耗尽',
  recoveryAction: 'SWITCH_PROVIDER',
  timestamp: new Date().toISOString(),
};

const DEMO_ACTIVE_TASK: ActiveTaskState = {
  taskId: 'TASK-001',
  title: '闭合 daemon 与 mcp-hub 跨层工具审批链路',
  status: 'in_progress',
  currentHarness: 'crosscode-native',
  currentStep: '验证 WebSocket approve/reject 对 run_shell 与 computer_use 的阻塞控制',
  completedSteps: ['实现 CrossCodeNativeHarness.enforceApprovalGate', '暴露 MCP computer_resolve_approval 工具'],
  nextSteps: ['执行端到端集成测试'],
  updatedAt: new Date().toISOString(),
};

const DEMO_MEMORY_MD = [
  '# CrossCode Workspace Memory',
  '',
  '- Architecture: Monorepo (`shared`, `mcp-hub`, `daemon`, `web`)',
  '- Active MCP Endpoint: `stdio` / `127.0.0.1:4399`',
  '- Rule: `.agent/` directory is git-ignored across all managed repositories.',
].join('\n');

export interface DemoData {
  projects: UnifiedProject[];
  providers: ProviderCatalogEntry[];
  skills: Record<string, boolean>;
  skillsUpdatedAt: string;
  skillMeta: SharedSkillMeta[];
  brain: { memoryMd: string; activeTask: ActiveTaskState };
  diff: DiffSummaryView;
  timeline: TimelineItem[];
  approvals: ApprovalCard[];
  screenFrames: ScreenFrameView[];
}

export function buildDemoData(): DemoData {
  const now = Date.now();
  const iso = (deltaMs: number): string => new Date(now - deltaMs).toISOString();
  const timestamp = iso(90_000);

  const projects: UnifiedProject[] = [
    {
      id: 'proj-crosscode',
      name: 'CrossCode',
      path: 'F:\\cs\\CrossCode',
      discoveredFrom: ['crosscode-native', 'opencode', 'claude-code'],
      activeHarness: 'crosscode-native',
      activeProviderId: 'deepseek',
      activeModelId: 'deepseek-chat',
      hasAgentDir: true,
      lastActiveAt: iso(2 * 60_000),
      gitBranch: 'main',
      pendingDiffCount: 3,
    },
    {
      id: 'proj-feishu-bot',
      name: 'feishu-approval-bot',
      path: 'F:\\cs\\feishu-approval-bot',
      discoveredFrom: ['claude-code'],
      activeHarness: 'claude-code',
      activeProviderId: 'anthropic',
      activeModelId: 'claude-sonnet-4-5',
      hasAgentDir: true,
      lastActiveAt: iso(42 * 60_000),
      gitBranch: 'main',
      pendingDiffCount: 1,
    },
    {
      id: 'proj-data-pipeline',
      name: 'data-pipeline',
      path: 'D:\\work\\data-pipeline',
      discoveredFrom: ['opencode', 'codex'],
      activeHarness: 'opencode',
      activeProviderId: 'openrouter',
      activeModelId: 'openrouter/auto',
      hasAgentDir: false,
      lastActiveAt: iso(5 * 3_600_000),
      gitBranch: 'dev',
      pendingDiffCount: 0,
    },
  ];

  const providers: ProviderCatalogEntry[] = [
    { id: 'anthropic', label: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-sonnet-4-5', 'claude-opus-4-1'] },
    { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
    { id: 'gemini', label: 'Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
    { id: 'ollama', label: 'Ollama', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen3-coder', 'deepseek-r1'] },
    { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4.1', 'o3'] },
    { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: ['openrouter/auto'] },
  ];

  const skills: Record<string, boolean> = {
    'test-driven-development': true,
    'systematic-debugging': true,
    'computer-use': false,
    'verification-before-completion': true,
  };

  const skillMeta: SharedSkillMeta[] = [
    { id: 'test-driven-development', name: 'test-driven-development', description: 'Write failing test before implementation', sourcePath: '~/.agents/skills/test-driven-development', syncedHarnesses: ['crosscode-native', 'claude-code', 'opencode'], enabled: true },
    { id: 'systematic-debugging', name: 'systematic-debugging', description: 'Root-cause investigation before fixes', sourcePath: '~/.agents/skills/systematic-debugging', syncedHarnesses: ['crosscode-native', 'claude-code', 'codex'], enabled: true },
    { id: 'computer-use', name: 'computer-use', description: 'Win32 desktop screenshot & input control', sourcePath: '~/.agents/skills/computer-use', syncedHarnesses: ['crosscode-native'], enabled: false },
    { id: 'verification-before-completion', name: 'verification-before-completion', description: 'Verify build and tests before completion claims', sourcePath: '~/.agents/skills/verification-before-completion', syncedHarnesses: ['crosscode-native', 'claude-code', 'opencode', 'codex'], enabled: true },
  ];

  const diff = toDiffSummaryView({
    projectId: 'proj-crosscode',
    projectPath: 'F:\\cs\\CrossCode',
    isGitRepo: true,
    branch: 'main',
    changes: [
      { status: 'M ', file: 'packages/daemon/src/harnesses/crosscode-native-harness.ts', staged: false },
      { status: 'A ', file: 'packages/daemon/src/server/daemon-session-manager.ts', staged: false },
      { status: 'M ', file: 'packages/mcp-hub/src/server.ts', staged: false },
    ],
    diff: [
      fakeDiff('packages/daemon/src/harnesses/crosscode-native-harness.ts', 42, 6),
      fakeDiff('packages/daemon/src/server/daemon-session-manager.ts', 128, 0),
      fakeDiff('packages/mcp-hub/src/server.ts', 34, 4),
    ].join('\n'),
  });

  const timeline: TimelineItem[] = [
    { kind: 'user_prompt', id: 'demo-1', text: '检查 daemon 与 mcp-hub 的审批链路，确保 run_shell 在未获批前阻塞执行' },
    {
      kind: 'thinking',
      id: 'demo-2',
      sessionId: 'demo-session',
      harness: 'crosscode-native',
      text:
        '1. Check CrossCodeNativeHarness.executeToolCall flow when requiresApproval=true\n2. Add waitForToolApproval promise gate\n3. Verify with vitest suite',
    },
    {
      kind: 'message',
      id: 'demo-3',
      sessionId: 'demo-session',
      harness: 'crosscode-native',
      text: '正在运行测试套件并检查工作区状态：\n\n```bash\npnpm --filter @crosscode/daemon test\n```',
    },
    {
      kind: 'tool',
      id: 'call-shell-1',
      callId: 'call-shell-1',
      sessionId: 'demo-session',
      toolName: 'read_file',
      args: { path: 'packages/daemon/src/harnesses/crosscode-native-harness.ts' },
      requiresApproval: false,
      status: 'ok',
      output: 'Read 1177 lines from packages/daemon/src/harnesses/crosscode-native-harness.ts',
    },
    {
      kind: 'tool',
      id: 'call-shell-approve',
      callId: 'call-shell-approve',
      sessionId: 'demo-session',
      toolName: 'run_shell',
      args: { command: 'pnpm vitest run packages/daemon/tests/gateway.test.ts' },
      requiresApproval: true,
      status: 'running',
    },
    { kind: 'file', id: 'demo-4', sessionId: 'demo-session', filePath: 'packages/daemon/src/server/daemon-session-manager.ts', additions: 128, deletions: 0 },
    {
      kind: 'harness_switched',
      id: 'demo-7',
      sessionId: 'demo-session',
      fromHarness: 'deepseek-harness',
      toHarness: 'crosscode-native',
      reason: 'CC-QUOTA-2002 failover',
    },
    { kind: 'error', id: 'demo-8', sessionId: 'demo-session', error: DEMO_ERROR },
  ];

  const approvals: ApprovalCard[] = [
    {
      approvalId: 'apr-demo-1',
      sessionId: 'demo-session',
      callId: 'call-shell-approve',
      toolName: 'run_shell',
      args: { command: 'pnpm vitest run packages/daemon/tests/gateway.test.ts' },
      createdAt: timestamp,
    },
  ];

  return {
    projects,
    providers,
    skills,
    skillsUpdatedAt: timestamp,
    skillMeta,
    brain: { memoryMd: DEMO_MEMORY_MD, activeTask: DEMO_ACTIVE_TASK },
    diff,
    timeline,
    approvals,
    screenFrames: [demoScreenFrame(timestamp)],
  };
}

export function demoReplyFor(prompt: string): TimelineItem[] {
  return [
    {
      kind: 'thinking',
      id: nextItemId(),
      sessionId: 'demo-session',
      harness: 'crosscode-native',
      text: `mock dispatch: "${prompt}"`,
    },
    {
      kind: 'message',
      id: nextItemId(),
      sessionId: 'demo-session',
      harness: 'crosscode-native',
      text: `当前处于离线预览模式。连接本地 daemon 后，指令将直接派发给所选 Harness 执行。`,
    },
  ];
}
