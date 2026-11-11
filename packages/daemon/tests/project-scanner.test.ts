import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  normalizeHarnessError,
  type HarnessId,
} from '@crosscode/shared';
import {
  ensureAgentWorkspace,
  readAgentWorkspaceContext,
  updateActiveTask,
  updateProjectMemory,
  appendNormalizedErrorLog,
  ProjectScanner,
} from '../src/index.js';

describe('Task 3: .agent Workspace Manager & Cross-App ProjectScanner', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crosscode-daemon-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  describe('ensureAgentWorkspace', () => {
    it('creates .agent subdirectories, manifest.json, project-memory.md, and active-task.json if missing', async () => {
      const projectPath = path.join(tempRoot, 'sample-app');
      await fs.mkdir(projectPath, { recursive: true });

      const manifest = await ensureAgentWorkspace(projectPath, {
        projectName: 'SampleApp',
        description: 'Sample project for testing .agent workspace initialization',
        activeHarness: 'opencode',
      });

      expect(manifest.projectName).toBe('SampleApp');
      expect(manifest.projectPath).toBe(path.resolve(projectPath));
      expect(manifest.activeHarness).toBe('opencode');
      expect(manifest.supportedHarnesses).toContain('crosscode-native');
      expect(manifest.supportedHarnesses).toContain('opencode');
      expect(manifest.sharedCapabilities.builtinBrowser).toBe(true);
      expect(manifest.sharedCapabilities.externalBrowserBridge).toBe(true);
      expect(manifest.sharedCapabilities.computerUse).toBe(true);

      // Verify directories exist
      const subdirs = ['plans', 'context', 'runtime', 'logs'];
      for (const dir of subdirs) {
        const stat = await fs.stat(path.join(projectPath, '.agent', dir));
        expect(stat.isDirectory()).toBe(true);
      }

      // Verify files exist
      const manifestRaw = await fs.readFile(path.join(projectPath, '.agent', 'manifest.json'), 'utf8');
      const parsedManifest = JSON.parse(manifestRaw);
      expect(parsedManifest.projectName).toBe('SampleApp');

      const memoryRaw = await fs.readFile(
        path.join(projectPath, '.agent', 'context', 'project-memory.md'),
        'utf8',
      );
      expect(memoryRaw).toContain('SampleApp');

      const activeTaskRaw = await fs.readFile(
        path.join(projectPath, '.agent', 'context', 'active-task.json'),
        'utf8',
      );
      const parsedTask = JSON.parse(activeTaskRaw);
      expect(parsedTask.currentHarness).toBe('opencode');
      expect(Array.isArray(parsedTask.completedSteps)).toBe(true);
      expect(Array.isArray(parsedTask.nextSteps)).toBe(true);
    });

    it('ensures .gitignore and .git/info/exclude contain .agent/ without duplicating entries', async () => {
      const projectPath = path.join(tempRoot, 'git-app');
      await fs.mkdir(path.join(projectPath, '.git', 'info'), { recursive: true });
      await fs.writeFile(path.join(projectPath, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
      await fs.writeFile(path.join(projectPath, '.git', 'info', 'exclude'), '# git ls-files\n', 'utf8');

      await ensureAgentWorkspace(projectPath);
      // Call a second time to verify idempotency (no duplicate .agent/ lines)
      await ensureAgentWorkspace(projectPath);

      const gitignore = await fs.readFile(path.join(projectPath, '.gitignore'), 'utf8');
      const exclude = await fs.readFile(path.join(projectPath, '.git', 'info', 'exclude'), 'utf8');

      expect(gitignore).toContain('.agent/');
      expect(exclude).toContain('.agent/');

      const gitignoreMatches = gitignore.split(/\r?\n/).filter((line) => line.trim() === '.agent/');
      const excludeMatches = exclude.split(/\r?\n/).filter((line) => line.trim() === '.agent/');
      expect(gitignoreMatches).toHaveLength(1);
      expect(excludeMatches).toHaveLength(1);
    });
  });

  describe('readAgentWorkspaceContext, updateActiveTask, and appendNormalizedErrorLog', () => {
    it('reads and updates active-task.json, project-memory.md, and appends JSONL error records', async () => {
      const projectPath = path.join(tempRoot, 'context-app');
      await fs.mkdir(projectPath, { recursive: true });
      await ensureAgentWorkspace(projectPath, {
        projectName: 'ContextApp',
        activeHarness: 'claude-code',
      });

      const updatedTask = await updateActiveTask(projectPath, {
        taskId: 'TASK-42',
        title: 'Implement Unified Scanner',
        status: 'in_progress',
        currentHarness: 'opencode',
        currentStep: 'Writing unit tests',
        completedSteps: ['Setup daemon package'],
        nextSteps: ['Run vitest'],
      });

      expect(updatedTask.taskId).toBe('TASK-42');
      expect(updatedTask.currentHarness).toBe('opencode');
      expect(updatedTask.completedSteps).toEqual(['Setup daemon package']);

      await updateProjectMemory(projectPath, '# ContextApp Memory\n- Key architectural decision: Unified MCP');

      const err1 = normalizeHarnessError(
        'claude-code',
        'insufficient_quota: credit balance is too low',
        'anthropic-main',
      );
      const err2 = normalizeHarnessError(
        'opencode',
        'Error: 429 Too Many Requests - rate_limit_exceeded',
        'deepseek-main',
      );

      await appendNormalizedErrorLog(projectPath, err1);
      await appendNormalizedErrorLog(projectPath, err2);

      const logFilePath = path.join(projectPath, '.agent', 'logs', 'agent-errors.jsonl');
      const rawJsonl = await fs.readFile(logFilePath, 'utf8');
      const lines = rawJsonl.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).code).toBe('CC-QUOTA-2002');
      expect(JSON.parse(lines[1]).code).toBe('CC-QUOTA-2001');

      const context = await readAgentWorkspaceContext(projectPath);
      expect(context.manifest.projectName).toBe('ContextApp');
      expect(context.activeTask.taskId).toBe('TASK-42');
      expect(context.activeTask.currentHarness).toBe('opencode');
      expect(context.projectMemory).toContain('Unified MCP');
      expect(context.errorLogs).toHaveLength(2);
      expect(context.errorLogs[0].code).toBe('CC-QUOTA-2002');
      expect(context.errorLogs[1].code).toBe('CC-QUOTA-2001');
    });
  });

  describe('ProjectScanner.scanAll', () => {
    it('scans workspace roots and 6 app metadata directories, deduplicates physical paths, merges discoveredFrom, and detects hasAgentDir', async () => {
      const workspaceRoot = path.join(tempRoot, 'workspaces');
      const projAlpha = path.join(workspaceRoot, 'project-alpha');
      const projBeta = path.join(workspaceRoot, 'project-beta');
      const projExternal = path.join(tempRoot, 'external', 'project-gamma');

      await fs.mkdir(path.join(projAlpha, '.git'), { recursive: true });
      await ensureAgentWorkspace(projAlpha, {
        projectName: 'project-alpha',
        activeHarness: 'claude-code',
      });

      await fs.mkdir(projBeta, { recursive: true });
      await fs.writeFile(
        path.join(projBeta, 'package.json'),
        JSON.stringify({ name: 'project-beta', version: '1.0.0' }),
        'utf8',
      );

      await fs.mkdir(path.join(projExternal, '.git'), { recursive: true });

      // Simulate app metadata directories for all 6 external harnesses
      const appDirs: Record<HarnessId, string> = {
        'crosscode-native': path.join(tempRoot, 'apps', 'crosscode'),
        'claude-code': path.join(tempRoot, 'apps', 'claude'),
        opencode: path.join(tempRoot, 'apps', 'opencode'),
        codex: path.join(tempRoot, 'apps', 'codex'),
        qoder: path.join(tempRoot, 'apps', 'qoder'),
        zcode: path.join(tempRoot, 'apps', 'zcode'),
        'deepseek-harness': path.join(tempRoot, 'apps', 'deepseek'),
      };

      for (const dir of Object.values(appDirs)) {
        await fs.mkdir(dir, { recursive: true });
      }

      // 1. claude-code: ~/.claude/projects.json with object keyed by path (using unnormalized path with ..)
      const unnormalizedAlpha = path.join(workspaceRoot, 'project-beta', '..', 'project-alpha');
      await fs.writeFile(
        path.join(appDirs['claude-code'], 'projects.json'),
        JSON.stringify({
          projects: {
            [unnormalizedAlpha]: { lastActiveAt: '2026-11-11T10:00:00.000Z' },
          },
        }),
        'utf8',
      );

      // 2. opencode: session history listing both project-alpha and project-beta
      await fs.writeFile(
        path.join(appDirs.opencode, 'projects.json'),
        JSON.stringify([
          { path: projAlpha, updatedAt: '2026-11-11T12:00:00.000Z' },
          { directory: projBeta, updatedAt: '2026-11-11T11:00:00.000Z' },
        ]),
        'utf8',
      );

      // 3. codex: history.jsonl referencing project-beta
      await fs.writeFile(
        path.join(appDirs.codex, 'history.jsonl'),
        `${JSON.stringify({ cwd: projBeta, timestamp: '2026-11-11T09:30:00.000Z' })}\n`,
        'utf8',
      );

      // 4. qoder: recent-workspaces.json referencing project-gamma (outside workspaceRoot)
      await fs.writeFile(
        path.join(appDirs.qoder, 'recent-workspaces.json'),
        JSON.stringify({
          workspaces: [{ projectPath: projExternal }],
        }),
        'utf8',
      );

      // 5. zcode: state.json referencing project-gamma
      await fs.writeFile(
        path.join(appDirs.zcode, 'state.json'),
        JSON.stringify({
          recentProjects: [projExternal],
        }),
        'utf8',
      );

      // 6. deepseek-harness: sessions.json referencing project-alpha and project-gamma
      await fs.writeFile(
        path.join(appDirs['deepseek-harness'], 'sessions.json'),
        JSON.stringify({
          sessions: [
            { workspacePath: projAlpha },
            { workspacePath: projExternal },
          ],
        }),
        'utf8',
      );

      const projects = await ProjectScanner.scanAll({
        workspaceRoots: [workspaceRoot],
        appConfigDirs: appDirs,
      });

      expect(projects).toHaveLength(3);

      const alpha = projects.find((p) => p.path === path.resolve(projAlpha));
      const beta = projects.find((p) => p.path === path.resolve(projBeta));
      const gamma = projects.find((p) => p.path === path.resolve(projExternal));

      expect(alpha).toBeDefined();
      expect(alpha!.hasAgentDir).toBe(true);
      expect(alpha!.discoveredFrom).toEqual(
        expect.arrayContaining(['claude-code', 'opencode', 'deepseek-harness']),
      );

      expect(beta).toBeDefined();
      expect(beta!.hasAgentDir).toBe(false);
      expect(beta!.discoveredFrom).toEqual(
        expect.arrayContaining(['opencode', 'codex']),
      );

      expect(gamma).toBeDefined();
      expect(gamma!.hasAgentDir).toBe(false);
      expect(gamma!.discoveredFrom).toEqual(
        expect.arrayContaining(['qoder', 'zcode', 'deepseek-harness']),
      );
    });
  });
});
