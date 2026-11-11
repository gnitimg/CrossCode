import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ALL_HARNESS_IDS,
  type ActiveTaskState,
  type AgentWorkspaceManifest,
  type HarnessId,
  type NormalizedAgentError,
} from '@crosscode/shared';

export interface EnsureAgentWorkspaceOptions {
  projectName?: string;
  description?: string;
  activeHarness?: HarnessId;
  supportedHarnesses?: HarnessId[];
  skillsRoot?: string;
  unifiedMcpEndpoint?: string;
  currentPhase?: string;
  activePlan?: string;
}

export interface AgentWorkspaceContext {
  manifest: AgentWorkspaceManifest;
  projectMemory: string;
  activeTask: ActiveTaskState;
  errorLogs: NormalizedAgentError[];
}

const AGENT_SUBDIRS = ['plans', 'context', 'runtime', 'logs'] as const;

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function ensureIgnoreEntry(ignoreFilePath: string, entry = '.agent/'): Promise<void> {
  let content = '';
  if (await fileExists(ignoreFilePath)) {
    content = await fs.readFile(ignoreFilePath, 'utf8');
  }

  const lines = content.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes('.agent/') || lines.includes('.agent') || lines.includes('/.agent/')) {
    return;
  }

  const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  await fs.mkdir(path.dirname(ignoreFilePath), { recursive: true });
  await fs.writeFile(ignoreFilePath, `${content}${prefix}${entry}\n`, 'utf8');
}

export async function ensureAgentWorkspace(
  projectPath: string,
  options: EnsureAgentWorkspaceOptions = {},
): Promise<AgentWorkspaceManifest> {
  const resolvedPath = path.resolve(projectPath);
  const agentDir = path.join(resolvedPath, '.agent');

  await fs.mkdir(agentDir, { recursive: true });
  for (const subdir of AGENT_SUBDIRS) {
    await fs.mkdir(path.join(agentDir, subdir), { recursive: true });
  }

  const now = new Date().toISOString();
  const projectName = options.projectName ?? path.basename(resolvedPath);
  const activeHarness = options.activeHarness ?? 'crosscode-native';

  const manifestPath = path.join(agentDir, 'manifest.json');
  let manifest: AgentWorkspaceManifest;

  if (await fileExists(manifestPath)) {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const existing = JSON.parse(raw) as AgentWorkspaceManifest;
    manifest = {
      ...existing,
      ...(options.projectName ? { projectName: options.projectName } : {}),
      ...(options.description ? { description: options.description } : {}),
      ...(options.activeHarness ? { activeHarness: options.activeHarness } : {}),
      ...(options.currentPhase ? { currentPhase: options.currentPhase } : {}),
      ...(options.activePlan ? { activePlan: options.activePlan } : {}),
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } else {
    manifest = {
      schemaVersion: '1.0.0',
      projectName,
      projectPath: resolvedPath,
      ...(options.description ? { description: options.description } : {}),
      activeHarness,
      supportedHarnesses: options.supportedHarnesses ?? [...ALL_HARNESS_IDS],
      sharedCapabilities: {
        skillsRoot: options.skillsRoot ?? path.join(os.homedir(), '.agents', 'skills'),
        unifiedMcpEndpoint: options.unifiedMcpEndpoint ?? 'http://127.0.0.1:4399/mcp',
        builtinBrowser: true,
        externalBrowserBridge: true,
        computerUse: true,
      },
      currentPhase: options.currentPhase ?? 'initialized',
      ...(options.activePlan ? { activePlan: options.activePlan } : {}),
      updatedAt: now,
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  const memoryPath = path.join(agentDir, 'context', 'project-memory.md');
  if (!(await fileExists(memoryPath))) {
    const defaultMemory = [
      `# ${manifest.projectName} — CrossCode Shared Project Memory`,
      '',
      `- **Project Path**: \`${resolvedPath}\``,
      `- **Primary Harness**: \`${manifest.activeHarness}\``,
      '',
      '## Architecture & Context Notes',
      '- Managed by CrossCode `.agent` workspace middleware.',
      '',
    ].join('\n');
    await fs.writeFile(memoryPath, defaultMemory, 'utf8');
  }

  const activeTaskPath = path.join(agentDir, 'context', 'active-task.json');
  if (!(await fileExists(activeTaskPath))) {
    const defaultTask: ActiveTaskState = {
      taskId: 'TASK-INIT',
      title: `Initialize ${manifest.projectName} workspace`,
      status: 'idle',
      currentHarness: manifest.activeHarness,
      currentStep: 'Workspace ready',
      completedSteps: [],
      nextSteps: [],
      updatedAt: now,
    };
    await fs.writeFile(activeTaskPath, `${JSON.stringify(defaultTask, null, 2)}\n`, 'utf8');
  }

  // Ensure .agent/ is ignored in git (.gitignore and .git/info/exclude when .git directory exists)
  const gitignorePath = path.join(resolvedPath, '.gitignore');
  await ensureIgnoreEntry(gitignorePath, '.agent/');

  const gitDirPath = path.join(resolvedPath, '.git');
  if (await isDirectory(gitDirPath)) {
    const gitExcludePath = path.join(gitDirPath, 'info', 'exclude');
    await ensureIgnoreEntry(gitExcludePath, '.agent/');
  }

  return manifest;
}

export async function readAgentWorkspaceContext(
  projectPath: string,
): Promise<AgentWorkspaceContext> {
  const resolvedPath = path.resolve(projectPath);
  const manifest = await ensureAgentWorkspace(resolvedPath);
  const agentDir = path.join(resolvedPath, '.agent');

  const memoryPath = path.join(agentDir, 'context', 'project-memory.md');
  const activeTaskPath = path.join(agentDir, 'context', 'active-task.json');
  const errorLogPath = path.join(agentDir, 'logs', 'agent-errors.jsonl');

  const projectMemory = await fs.readFile(memoryPath, 'utf8');
  const activeTaskRaw = await fs.readFile(activeTaskPath, 'utf8');
  const activeTask = JSON.parse(activeTaskRaw) as ActiveTaskState;

  const errorLogs: NormalizedAgentError[] = [];
  if (await fileExists(errorLogPath)) {
    const rawLogs = await fs.readFile(errorLogPath, 'utf8');
    for (const line of rawLogs.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        errorLogs.push(JSON.parse(trimmed) as NormalizedAgentError);
      } catch {
        // Ignore malformed log line
      }
    }
  }

  return {
    manifest,
    projectMemory,
    activeTask,
    errorLogs,
  };
}

export async function updateActiveTask(
  projectPath: string,
  patch: Partial<ActiveTaskState>,
): Promise<ActiveTaskState> {
  const resolvedPath = path.resolve(projectPath);
  await ensureAgentWorkspace(resolvedPath);
  const agentDir = path.join(resolvedPath, '.agent');
  const activeTaskPath = path.join(agentDir, 'context', 'active-task.json');

  const currentRaw = await fs.readFile(activeTaskPath, 'utf8');
  const current = JSON.parse(currentRaw) as ActiveTaskState;

  const updated: ActiveTaskState = {
    ...current,
    ...patch,
    updatedAt: patch.updatedAt ?? new Date().toISOString(),
  };

  await fs.writeFile(activeTaskPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');

  if (patch.currentHarness) {
    const manifestPath = path.join(agentDir, 'manifest.json');
    if (await fileExists(manifestPath)) {
      const manifestRaw = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestRaw) as AgentWorkspaceManifest;
      manifest.activeHarness = patch.currentHarness;
      manifest.updatedAt = updated.updatedAt;
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }
  }

  return updated;
}

export async function updateProjectMemory(
  projectPath: string,
  content: string,
): Promise<void> {
  const resolvedPath = path.resolve(projectPath);
  await ensureAgentWorkspace(resolvedPath);
  const memoryPath = path.join(resolvedPath, '.agent', 'context', 'project-memory.md');
  await fs.writeFile(memoryPath, content, 'utf8');
}

export async function appendNormalizedErrorLog(
  projectPath: string,
  error: NormalizedAgentError,
): Promise<void> {
  const resolvedPath = path.resolve(projectPath);
  await ensureAgentWorkspace(resolvedPath);
  const errorLogPath = path.join(resolvedPath, '.agent', 'logs', 'agent-errors.jsonl');
  await fs.appendFile(errorLogPath, `${JSON.stringify(error)}\n`, 'utf8');
}
