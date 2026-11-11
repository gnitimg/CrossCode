import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  ALL_HARNESS_IDS,
  type AgentWorkspaceManifest,
  type HarnessId,
  type UnifiedProject,
} from '@crosscode/shared';
import { ensureAgentWorkspace } from '../workspace/agent-workspace.js';

export interface ProjectScanOptions {
  workspaceRoots?: string[];
  appConfigDirs?: Partial<Record<HarnessId, string | string[]>>;
  maxWorkspaceDepth?: number;
  autoInitAgentWorkspace?: boolean;
  defaultProviderId?: string;
  defaultModelId?: string;
}

interface DiscoveredRecord {
  resolvedPath: string;
  discoveredFrom: Set<HarnessId>;
  lastActiveAt: string;
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.agent',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
]);

const PROJECT_MARKERS = [
  '.git',
  '.agent',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
];

const PATH_FIELD_NAMES = [
  'path',
  'projectPath',
  'workspacePath',
  'cwd',
  'directory',
  'worktree',
  'rootPath',
  'folder',
  'projectDir',
  'repoPath',
] as const;

const TIMESTAMP_FIELD_NAMES = [
  'lastActiveAt',
  'updatedAt',
  'timestamp',
  'lastOpenedAt',
  'createdAt',
] as const;

const COLLECTION_FIELD_NAMES = [
  'projects',
  'workspaces',
  'recentProjects',
  'recentWorkspaces',
  'sessions',
  'history',
  'folders',
] as const;

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isProjectDirectory(dirPath: string): Promise<boolean> {
  for (const marker of PROJECT_MARKERS) {
    if (await fileExists(path.join(dirPath, marker))) {
      return true;
    }
  }
  return false;
}

function normalizePathKey(resolvedPath: string): string {
  return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

function createProjectId(resolvedPath: string): string {
  const base = path
    .basename(resolvedPath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
  const hash = crypto
    .createHash('sha1')
    .update(normalizePathKey(resolvedPath))
    .digest('hex')
    .slice(0, 8);
  return `proj-${base}-${hash}`;
}

function looksLikeFilesystemPath(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed.length < 2 || trimmed.length > 512) return false;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.startsWith('/') || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return true;
  }
  return false;
}

function expandHome(inputPath: string): string {
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function extractPathsFromUnknown(
  node: unknown,
  results: Array<{ rawPath: string; timestamp?: string }>,
): void {
  if (!node) return;

  if (typeof node === 'string') {
    if (looksLikeFilesystemPath(node)) {
      results.push({ rawPath: node });
    }
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      extractPathsFromUnknown(item, results);
    }
    return;
  }

  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;

    let foundTimestamp: string | undefined;
    for (const tsField of TIMESTAMP_FIELD_NAMES) {
      const val = obj[tsField];
      if (typeof val === 'string' && val.length > 0) {
        foundTimestamp = val;
        break;
      } else if (typeof val === 'number' && Number.isFinite(val)) {
        foundTimestamp = new Date(val).toISOString();
        break;
      }
    }

    for (const field of PATH_FIELD_NAMES) {
      const val = obj[field];
      if (typeof val === 'string' && looksLikeFilesystemPath(val)) {
        results.push({ rawPath: val, timestamp: foundTimestamp });
      }
    }

    for (const collField of COLLECTION_FIELD_NAMES) {
      const coll = obj[collField];
      if (!coll) continue;
      if (Array.isArray(coll)) {
        extractPathsFromUnknown(coll, results);
      } else if (typeof coll === 'object') {
        for (const [key, val] of Object.entries(coll as Record<string, unknown>)) {
          if (looksLikeFilesystemPath(key)) {
            let entryTs = foundTimestamp;
            if (val && typeof val === 'object') {
              const valObj = val as Record<string, unknown>;
              for (const tsField of TIMESTAMP_FIELD_NAMES) {
                if (typeof valObj[tsField] === 'string') {
                  entryTs = valObj[tsField] as string;
                  break;
                }
              }
            }
            results.push({ rawPath: key, timestamp: entryTs });
          }
          extractPathsFromUnknown(val, results);
        }
      }
    }

    // Also inspect top-level keys if they are filesystem paths
    for (const [key, val] of Object.entries(obj)) {
      if (looksLikeFilesystemPath(key)) {
        results.push({ rawPath: key, timestamp: foundTimestamp });
      }
      if (
        !PATH_FIELD_NAMES.includes(key as (typeof PATH_FIELD_NAMES)[number]) &&
        !COLLECTION_FIELD_NAMES.includes(key as (typeof COLLECTION_FIELD_NAMES)[number]) &&
        typeof val === 'object' &&
        val !== null
      ) {
        extractPathsFromUnknown(val, results);
      }
    }
  }
}

async function detectGitBranch(projectPath: string): Promise<string | undefined> {
  try {
    const headPath = path.join(projectPath, '.git', 'HEAD');
    if (!(await fileExists(headPath))) return undefined;
    const headContent = (await fs.readFile(headPath, 'utf8')).trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(headContent);
    return match ? match[1].trim() : headContent.slice(0, 7);
  } catch {
    return undefined;
  }
}

export function getDefaultAppConfigDirs(): Record<HarnessId, string[]> {
  const home = os.homedir();
  const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
  return {
    'crosscode-native': [path.join(home, '.crosscode')],
    'claude-code': [path.join(home, '.claude')],
    opencode: [
      path.join(home, '.local', 'share', 'opencode'),
      path.join(home, '.config', 'opencode'),
    ],
    codex: [path.join(home, '.codex')],
    qoder: [path.join(home, '.qoder'), path.join(appData, 'Qoder')],
    zcode: [path.join(home, '.zcode'), path.join(appData, 'ZCode')],
    'deepseek-harness': [path.join(home, '.deepseek')],
  };
}

export class ProjectScanner {
  private readonly defaultOptions: ProjectScanOptions;

  constructor(defaultOptions: ProjectScanOptions = {}) {
    this.defaultOptions = defaultOptions;
  }

  static async scanAll(options: ProjectScanOptions = {}): Promise<UnifiedProject[]> {
    const scanner = new ProjectScanner(options);
    return scanner.scanAll(options);
  }

  async scanAll(options: ProjectScanOptions = {}): Promise<UnifiedProject[]> {
    const mergedOptions: ProjectScanOptions = {
      ...this.defaultOptions,
      ...options,
    };

    const workspaceRoots = mergedOptions.workspaceRoots ?? [];
    const appConfigDirs = mergedOptions.appConfigDirs ?? getDefaultAppConfigDirs();
    const maxDepth = mergedOptions.maxWorkspaceDepth ?? 2;
    const defaultProviderId = mergedOptions.defaultProviderId ?? 'deepseek-official';
    const defaultModelId = mergedOptions.defaultModelId ?? 'deepseek-chat';

    const recordsByKey = new Map<string, DiscoveredRecord>();

    const upsertRecord = (
      candidatePath: string,
      sourceHarness?: HarnessId,
      timestamp?: string,
    ): DiscoveredRecord => {
      const resolvedPath = path.resolve(expandHome(candidatePath));
      const key = normalizePathKey(resolvedPath);
      let record = recordsByKey.get(key);
      if (!record) {
        record = {
          resolvedPath,
          discoveredFrom: new Set<HarnessId>(),
          lastActiveAt: timestamp ?? new Date().toISOString(),
        };
        recordsByKey.set(key, record);
      } else if (timestamp && timestamp > record.lastActiveAt) {
        record.lastActiveAt = timestamp;
      }
      if (sourceHarness) {
        record.discoveredFrom.add(sourceHarness);
      }
      return record;
    };

    // 1. Scan workspace roots
    for (const root of workspaceRoots) {
      await this.scanWorkspaceDirectory(root, 0, maxDepth, upsertRecord);
    }

    // 2. Scan app metadata directories
    for (const harnessId of ALL_HARNESS_IDS) {
      const configured = appConfigDirs[harnessId];
      if (!configured) continue;
      const dirs = Array.isArray(configured) ? configured : [configured];
      for (const dir of dirs) {
        await this.scanAppConfigDirectory(dir, harnessId, 0, 3, upsertRecord);
      }
    }

    // 3. Build UnifiedProject list
    const projects: UnifiedProject[] = [];

    for (const record of recordsByKey.values()) {
      if (!(await isDirectory(record.resolvedPath))) {
        continue;
      }

      if (mergedOptions.autoInitAgentWorkspace) {
        await ensureAgentWorkspace(record.resolvedPath);
      }

      const agentDir = path.join(record.resolvedPath, '.agent');
      const manifestPath = path.join(agentDir, 'manifest.json');
      const hasAgentDir = await isDirectory(agentDir);

      let manifest: AgentWorkspaceManifest | undefined;
      if (hasAgentDir && (await fileExists(manifestPath))) {
        try {
          const raw = await fs.readFile(manifestPath, 'utf8');
          manifest = JSON.parse(raw) as AgentWorkspaceManifest;
        } catch {
          // Ignore malformed manifest
        }
      }

      if (hasAgentDir) {
        record.discoveredFrom.add('crosscode-native');
        if (manifest?.activeHarness) {
          record.discoveredFrom.add(manifest.activeHarness);
        }
      }

      if (record.discoveredFrom.size === 0) {
        record.discoveredFrom.add('crosscode-native');
      }

      const discoveredFrom = Array.from(record.discoveredFrom);
      const activeHarness: HarnessId =
        manifest?.activeHarness ??
        discoveredFrom.find((h) => h !== 'crosscode-native') ??
        discoveredFrom[0] ??
        'crosscode-native';

      const gitBranch = await detectGitBranch(record.resolvedPath);

      projects.push({
        id: createProjectId(record.resolvedPath),
        name: manifest?.projectName ?? path.basename(record.resolvedPath),
        path: record.resolvedPath,
        discoveredFrom,
        activeHarness,
        activeProviderId: defaultProviderId,
        activeModelId: defaultModelId,
        hasAgentDir,
        lastActiveAt: manifest?.updatedAt ?? record.lastActiveAt,
        ...(gitBranch ? { gitBranch } : {}),
        pendingDiffCount: 0,
      });
    }

    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async scanWorkspaceDirectory(
    currentDir: string,
    depth: number,
    maxDepth: number,
    upsertRecord: (
      candidatePath: string,
      sourceHarness?: HarnessId,
      timestamp?: string,
    ) => DiscoveredRecord,
  ): Promise<void> {
    const resolved = path.resolve(expandHome(currentDir));
    if (!(await isDirectory(resolved))) {
      return;
    }

    if (depth > 0 && (await isProjectDirectory(resolved))) {
      upsertRecord(resolved);
      return;
    }

    if (depth >= maxDepth) {
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(resolved, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await this.scanWorkspaceDirectory(
        path.join(resolved, entry.name),
        depth + 1,
        maxDepth,
        upsertRecord,
      );
    }
  }

  private async scanAppConfigDirectory(
    configDir: string,
    harnessId: HarnessId,
    depth: number,
    maxDepth: number,
    upsertRecord: (
      candidatePath: string,
      sourceHarness?: HarnessId,
      timestamp?: string,
    ) => DiscoveredRecord,
  ): Promise<void> {
    const resolved = path.resolve(expandHome(configDir));
    if (!(await isDirectory(resolved))) {
      return;
    }

    let entries;
    try {
      entries = await fs.readdir(resolved, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(resolved, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth && !IGNORED_DIRS.has(entry.name)) {
          await this.scanAppConfigDirectory(
            fullPath,
            harnessId,
            depth + 1,
            maxDepth,
            upsertRecord,
          );
        }
        continue;
      }

      if (!entry.isFile()) continue;

      const lower = entry.name.toLowerCase();
      if (!lower.endsWith('.json') && !lower.endsWith('.jsonl')) {
        continue;
      }

      try {
        const raw = await fs.readFile(fullPath, 'utf8');
        const extracted: Array<{ rawPath: string; timestamp?: string }> = [];

        if (lower.endsWith('.jsonl')) {
          for (const line of raw.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsedLine = JSON.parse(trimmed);
              extractPathsFromUnknown(parsedLine, extracted);
            } catch {
              // Ignore invalid JSONL line
            }
          }
        } else {
          const parsed = JSON.parse(raw);
          extractPathsFromUnknown(parsed, extracted);
        }

        for (const item of extracted) {
          const candidateResolved = path.resolve(expandHome(item.rawPath));
          if (await isDirectory(candidateResolved)) {
            upsertRecord(candidateResolved, harnessId, item.timestamp);
          }
        }
      } catch {
        // Ignore unreadable or non-JSON metadata files
      }
    }
  }
}
