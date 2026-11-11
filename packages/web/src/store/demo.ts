import type { ActiveTaskState, NormalizedAgentError, SharedSkillMeta, UnifiedProject } from '@crosscode/shared';
import type { ProviderCatalogEntry } from '../api/client';
import { toDiffSummaryView, type DiffSummaryView } from '../lib/diff';
import type { ApprovalCard, ScreenFrameView } from './model';
import { nextItemId, type TimelineItem } from './event-fold';

/**
 * Offline demo dataset — the workbench degrades into this when the daemon is
 * unreachable (or when VITE_DEMO=1) so the whole UI stays browsable. Includes
 * a CC-QUOTA-2002 normalized error to exercise the self-heal banner.
 */

function fakeDiff(file: string, additions: number, deletions: number): string {
  const lines = [
    `diff --git a/${file} b/${file}`,
    'index 0000001..0000002 100644',
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${deletions + 1} +1,${additions + 1} @@`,
  ];
  for (let i = 0; i < additions; i += 1) lines.push(`+// demo added line ${i + 1}`);
  for (let i = 0; i < deletions; i += 1) lines.push(`-// removed line ${i + 1}`);
  return lines.join('\n');
}

/** ASCII-only SVG mock of a browser window, inlined as a data URI. */
function demoScreenFrame(timestamp: string): ScreenFrameView {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">' +
    '<rect width="1280" height="800" fill="#0b0d14"/>' +
    '<rect width="1280" height="44" fill="#12141d"/>' +
    '<circle cx="24" cy="22" r="6" fill="#f43f5e"/><circle cx="46" cy="22" r="6" fill="#f59e0b"/><circle cx="68" cy="22" r="6" fill="#10b981"/>' +
    '<rect x="90" y="10" width="460" height="24" rx="6" fill="#1a1d2a"/>' +
    '<text x="104" y="27" font-family="monospace" font-size="13" fill="#64748b">localhost:5273 -- CrossCode Workbench</text>' +
    '<rect x="24" y="70" width="270" height="700" rx="10" fill="#11131c" stroke="rgba(255,255,255,0.07)"/>' +
    '<rect x="24" y="330" width="270" height="3" fill="#8b5cf6"/>' +
    '<text x="40" y="110" font-family="sans-serif" font-size="15" fill="#e2e8f0">CrossCode</text>' +
    '<rect x="318" y="70" width="640" height="700" rx="10" fill="#11131c" stroke="rgba(255,255,255,0.07)"/>' +
    '<rect x="340" y="100" width="596" height="52" rx="10" fill="#8b5cf6" opacity="0.12"/>' +
    '<text x="356" y="132" font-family="sans-serif" font-size="16" fill="#c4b5fd">Unified Agent Stream</text>' +
    '<rect x="340" y="180" width="596" height="90" rx="10" fill="#181b28"/>' +
    '<rect x="982" y="70" width="274" height="700" rx="10" fill="#11131c" stroke="rgba(255,255,255,0.07)"/>' +
    '<rect x="1006" y="100" width="226" height="140" rx="10" fill="#181b28"/>' +
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
  userTitle: 'DeepSeek 额度已耗尽，建议切换备用 Provider 继续',
  recoveryAction: 'SWITCH_PROVIDER',
  timestamp: new Date().toISOString(),
};

const DEMO_ACTIVE_TASK: ActiveTaskState = {
  taskId: 'task-8-web-workbench',
  title: '构建博采众长的高颜值响应式前端工作台',
  status: 'in-progress',
  currentHarness: 'crosscode-native',
  currentStep: 'Task 8 前端工作台实现与联调',
  completedSteps: ['Task 4-7 后端能力已就绪', '三栏 IDE 布局与设计 token', 'WS 会话协议客户端'],
  nextSteps: ['组件测试补齐', '移动端抽屉细节打磨', '接入真实 daemon 联调'],
  updatedAt: new Date().toISOString(),
};

const DEMO_MEMORY_MD = [
  '# project-memory',
  '',
  '- **项目**: CrossCode — 多 Harness 统一 Agent 工作台',
  '- **当前阶段**: Task 8 / 前端工作台',
  '- **关键结论**: WS 协议为 UnifiedStreamEvent + approval_request；',
  '  REST 网关覆盖 pair/projects/harness/provider/skills/diff。',
  '- **偏好**: 深邃曜石黑设计语言；中文用户文案；等宽字体呈现代码。',
  '',
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
      name: 'CrossCode 主仓库',
      path: 'F:\\cs\\CrossCode',
      discoveredFrom: ['crosscode-native', 'claude-code'],
      activeHarness: 'crosscode-native',
      activeProviderId: 'deepseek',
      activeModelId: 'deepseek-chat',
      hasAgentDir: true,
      lastActiveAt: iso(3 * 60_000),
      gitBranch: 'feat/task-8-web',
      pendingDiffCount: 3,
    },
    {
      id: 'proj-feishu-bot',
      name: '飞书审批机器人',
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
      name: '数据同步管道',
      path: 'D:\\work\\data-pipeline',
      discoveredFrom: ['opencode'],
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
    { id: 'anthropic', label: 'Anthropic (Claude)', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'] },
    { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', models: ['deepseek-chat', 'deepseek-reasoner'] },
    { id: 'gemini', label: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
    { id: 'ollama', label: 'Ollama (local)', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen3-coder', 'llama3.1', 'deepseek-r1'] },
    { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4.1', 'gpt-4o', 'o3'] },
    { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', models: ['openrouter/auto', 'anthropic/claude-sonnet-4.5', 'deepseek/deepseek-chat'] },
  ];

  const skills: Record<string, boolean> = {
    pdf: true,
    'browser-use': true,
    'computer-use': false,
    xlsx: true,
    'obsidian-bases': true,
    'verification-before-completion': true,
  };

  const skillMeta: SharedSkillMeta[] = [
    { id: 'pdf', name: 'pdf', description: 'PDF 处理四套工作流（读取/生成/合并/表单）', sourcePath: '~/.agents/skills/pdf', syncedHarnesses: ['crosscode-native', 'claude-code', 'opencode'], enabled: true },
    { id: 'browser-use', name: 'browser-use', description: '受控浏览器自动化（导航/点击/抓取）', sourcePath: '~/.agents/skills/browser-use', syncedHarnesses: ['crosscode-native', 'claude-code'], enabled: true },
    { id: 'computer-use', name: 'computer-use', description: 'win32 桌面级鼠标键盘操控', sourcePath: '~/.agents/skills/computer-use', syncedHarnesses: ['crosscode-native'], enabled: false },
    { id: 'xlsx', name: 'xlsx', description: 'Excel 读取、公式与图表处理', sourcePath: '~/.agents/skills/xlsx', syncedHarnesses: ['crosscode-native', 'codex'], enabled: true },
    { id: 'obsidian-bases', name: 'obsidian-bases', description: 'Obsidian Bases 视图构建', sourcePath: '~/.agents/skills/obsidian-bases', syncedHarnesses: ['qoder', 'zcode'], enabled: true },
    { id: 'verification-before-completion', name: 'verification-before-completion', description: '完成前强制跑验证并留存证据', sourcePath: '~/.agents/skills/verification-before-completion', syncedHarnesses: ['crosscode-native', 'claude-code', 'codex', 'zcode'], enabled: true },
  ];

  const diff = toDiffSummaryView({
    projectId: 'proj-crosscode',
    projectPath: 'F:\\cs\\CrossCode',
    isGitRepo: true,
    branch: 'feat/task-8-web',
    changes: [
      { status: 'M ', file: 'packages/web/src/App.tsx', staged: false },
      { status: 'A ', file: 'packages/web/src/components/InspectorRightPane.tsx', staged: false },
      { status: 'M ', file: 'packages/web/src/store/workbench.ts', staged: false },
      { status: '??', file: 'packages/web/README.md', staged: false },
    ],
    diff: [
      fakeDiff('packages/web/src/App.tsx', 24, 4),
      fakeDiff('packages/web/src/components/InspectorRightPane.tsx', 38, 0),
      fakeDiff('packages/web/src/store/workbench.ts', 17, 3),
    ].join('\n'),
  });

  const timeline: TimelineItem[] = [
    { kind: 'user_prompt', id: 'demo-1', text: '审阅当前未提交的变更，运行测试，然后总结 Task 8 的完成度' },
    {
      kind: 'thinking',
      id: 'demo-2',
      sessionId: 'demo-session',
      harness: 'crosscode-native',
      text:
        '用户想要一次完整的工作台自检。\n1. 读取 git status 与 diff 统计\n2. 运行 vitest 全量测试\n3. 汇总 Task 4-8 的交付物与遗留项\n（这是一条演示 thinking 事件，折叠手风琴默认收起。）',
    },
    {
      kind: 'message',
      id: 'demo-3',
      sessionId: 'demo-session',
      harness: 'crosscode-native',
      text: '我先查看工作区状态，然后运行测试套件。\n\n```bash\ngit status --short && pnpm test\n```',
    },
    {
      kind: 'tool',
      id: 'call-shell-1',
      callId: 'call-shell-1',
      sessionId: 'demo-session',
      toolName: 'shell_exec',
      args: { command: 'pnpm test', cwd: 'F:\\cs\\CrossCode' },
      requiresApproval: false,
      status: 'ok',
      output: 'Test Files  7 passed (7)\n     Tests  101 passed (101)\n  Duration  5.88s',
    },
    {
      kind: 'tool',
      id: 'call-browser-1',
      callId: 'call-browser-1',
      sessionId: 'demo-session',
      toolName: 'browser_navigate',
      args: { url: 'http://localhost:5273', waitUntil: 'networkidle' },
      requiresApproval: false,
      status: 'ok',
      output: '页面标题：CrossCode 控制台 · 博采众长的 Agent 工作台',
    },
    {
      kind: 'tool',
      id: 'call-browser-click',
      callId: 'call-browser-click',
      sessionId: 'demo-session',
      toolName: 'browser_click',
      args: { selector: '#merge-btn', risk: 'high' },
      requiresApproval: true,
      status: 'running',
    },
    { kind: 'file', id: 'demo-4', sessionId: 'demo-session', filePath: 'packages/web/src/components/InspectorRightPane.tsx', additions: 210, deletions: 0 },
    { kind: 'file', id: 'demo-5', sessionId: 'demo-session', filePath: 'packages/web/src/store/workbench.ts', additions: 96, deletions: 12 },
    { kind: 'file', id: 'demo-6', sessionId: 'demo-session', filePath: 'pnpm-lock.yaml', additions: 44, deletions: 2 },
    {
      kind: 'harness_switched',
      id: 'demo-7',
      sessionId: 'demo-session',
      fromHarness: 'deepseek-harness',
      toHarness: 'crosscode-native',
      reason: 'CC-QUOTA-2002 触发自愈切换',
    },
    { kind: 'error', id: 'demo-8', sessionId: 'demo-session', error: DEMO_ERROR },
  ];

  const approvals: ApprovalCard[] = [
    {
      approvalId: 'apr-demo-1',
      sessionId: 'demo-session',
      callId: 'call-browser-click',
      toolName: 'browser_click',
      args: { selector: '#merge-btn' },
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

/** Canned echo reply used when a prompt is sent in demo mode. */
export function demoReplyFor(prompt: string): TimelineItem[] {
  return [
    {
      kind: 'thinking',
      id: nextItemId(),
      sessionId: 'demo-session',
      harness: 'crosscode-native',
      text: `收到指令「${prompt}」。\n演示模式下没有真实 harness 在运行：\n- 解析意图 ✓\n- 规划步骤 ✓\n- 等待接入真实 daemon 后即可执行`,
    },
    {
      kind: 'message',
      id: nextItemId(),
      sessionId: 'demo-session',
      harness: 'crosscode-native',
      text: '这是离线演示模式的回声回复。启动 daemon 后，同样的指令会路由到真实 harness 并产生流式事件（thinking / tool_call / file_change…）。',
    },
  ];
}
