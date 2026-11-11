import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { HarnessId } from '@crosscode/shared';

export const SKILLS_REGISTRY_SCHEMA_VERSION = '1.0.0';
export const SKILLS_REGISTRY_FILENAME = 'skills-registry.json';

/** Harness that owns the SSOT (single source of truth) master skills repo. */
const SSOT_SOURCE_HARNESS: HarnessId = 'crosscode-native';

export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

/**
 * Minimal, dependency-free frontmatter parser for SKILL.md files.
 * Only extracts `name` and `description` (the fields the skills registry
 * needs); all other keys are ignored. Handles CRLF and quoted values.
 */
export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  const normalized = content.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return null;
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '---' || trimmed === '...') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return null;
  }

  const result: SkillFrontmatter = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const sep = line.indexOf(':');
    if (sep === -1) {
      continue;
    }
    const key = line.slice(0, sep).trim().toLowerCase();
    let value = line.slice(sep + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key === 'name') {
      result.name = value;
    } else if (key === 'description') {
      result.description = value;
    }
  }
  return result;
}

/**
 * How a skill is exposed to a given app:
 * - `junction`: zero-copy Windows junction from the app's skill dir to the skill directory.
 * - `native`: the skill physically lives in this app's private skill dir.
 * - `prompt-injection`: the app cannot follow standard skill directories; it consumes
 *   the merged prompt injection block instead.
 * - `none`: the skill is not yet exposed to this app (pending junction sync).
 */
export type SkillMountStrategy = 'junction' | 'native' | 'prompt-injection' | 'none';

export interface SkillMountInfo {
  harness: HarnessId;
  strategy: SkillMountStrategy;
  /** Whether the skill is currently visible to this app. */
  mounted: boolean;
  /** App-side path of the mount (the junction path or the native skill dir). */
  mountPath?: string;
}

export interface SkillRegistryEntry {
  name: string;
  description: string;
  /** Harness that owns the canonical copy of this skill. */
  sourceHarness: HarnessId;
  /** Canonical (SSOT) directory of the skill. */
  ssotPath: string;
  /** Where the skill was physically discovered during the last scan. */
  originPath: string;
  /** True when the canonical copy lives in the SSOT master skills repo. */
  isShared: boolean;
  /** Per-app mount states, one row per configured app. */
  mounts: SkillMountInfo[];
}

export interface SkillsRegistryApp {
  harness: HarnessId;
  skillsDir: string;
  junctionCompatible: boolean;
}

export interface SkillsRegistry {
  schemaVersion: string;
  generatedAt: string;
  ssotRoot: string;
  apps: SkillsRegistryApp[];
  skills: SkillRegistryEntry[];
}

export interface AppSkillsConfig {
  harness: HarnessId;
  /** The app's private skills directory (e.g. ~/.claude/skills). */
  skillsDir: string;
  /**
   * Whether the app follows standard skill directories (so junction mounts work).
   * Incompatible tools are served via the merged prompt injection block instead.
   */
  junctionCompatible: boolean;
}

export interface SkillVirtualizerOptions {
  /** SSOT master skills repo. Defaults to ~/.agents/skills. */
  ssotRoot?: string;
  /** App private skill dirs and their compatibility flags. All paths injectable for tests. */
  apps?: AppSkillsConfig[];
  /** Registry output path. Defaults to ~/.agent/runtime/skills-registry.json. */
  registryOutputPath?: string;
}

export interface SyncToAppsOptions {
  /** Reuse a previously scanned/synced registry instead of re-scanning. */
  registry?: SkillsRegistry;
}

export type SkillSyncStatus = 'created' | 'already-linked' | 'skipped' | 'failed';

export interface SkillSyncOperation {
  harness: HarnessId;
  skillName: string;
  status: SkillSyncStatus;
  mountPath: string;
  detail?: string;
}

export interface SyncToAppsResult {
  operations: SkillSyncOperation[];
  created: number;
  alreadyLinked: number;
  skipped: number;
  failed: number;
  /** Apps that must consume the merged prompt injection block instead of junctions. */
  promptInjectionHarnesses: HarnessId[];
  /** Registry with mount states updated to reflect this sync. */
  registry: SkillsRegistry;
}

/**
 * Default per-app skill directory configuration for the supported harnesses.
 * Computed lazily so that `os.homedir()` is never baked in at module load and
 * tests can always inject their own directories.
 */
export function createDefaultAppSkillsConfig(): AppSkillsConfig[] {
  const home = os.homedir();
  return [
    { harness: 'claude-code', skillsDir: path.join(home, '.claude', 'skills'), junctionCompatible: true },
    { harness: 'opencode', skillsDir: path.join(home, '.config', 'opencode', 'skills'), junctionCompatible: true },
    { harness: 'codex', skillsDir: path.join(home, '.codex', 'skills'), junctionCompatible: true },
    { harness: 'qoder', skillsDir: path.join(home, '.qoder', 'skills'), junctionCompatible: true },
    { harness: 'zcode', skillsDir: path.join(home, '.zcode', 'skills'), junctionCompatible: true },
  ];
}

function safeRealpath(targetPath: string): Promise<string | null> {
  return fs.realpath(targetPath).then(
    (real) => real,
    () => null,
  );
}

async function lstatSafe(targetPath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(targetPath);
  } catch {
    return null;
  }
}

async function isDirectoryPath(targetPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function compareByName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function upsertMount(entry: SkillRegistryEntry, mount: SkillMountInfo): void {
  const existing = entry.mounts.find((m) => m.harness === mount.harness);
  if (existing) {
    existing.strategy = mount.strategy;
    existing.mounted = mount.mounted;
    existing.mountPath = mount.mountPath;
    return;
  }
  entry.mounts.push(mount);
}

interface DiscoveredSkillDir {
  dir: string;
  isLink: boolean;
}

/**
 * Cross-app skills virtualization engine.
 *
 * - `scan()` builds a unified skills registry (`skills-registry.json` shape) from an
 *   injectable SSOT master skills repo plus each app's private skills directory,
 *   parsing SKILL.md frontmatter (name/description) and detecting existing junction
 *   mounts by realpath resolution.
 * - `syncToApps()` creates Windows junctions (`fs.symlinkSync(target, link, 'junction')`,
 *   zero-copy, no admin rights required) from junction-compatible app skill dirs to the
 *   SSOT skill directories. It is idempotent: existing junctions pointing at the same
 *   SSOT dir are reported as `already-linked`, and real directories/foreign links are
 *   never overwritten (`skipped`).
 * - `buildPromptInjectionBlock()` renders a merged markdown block (all skills with
 *   name + description) for apps that cannot follow standard skill directories.
 * - `writeRegistry()` persists the registry JSON to the injectable output path
 *   (`.agent/runtime/skills-registry.json` style).
 *
 * Every filesystem path (SSOT root, app skill dirs, registry output) is injectable so
 * tests never touch real user directories.
 */
export class SkillVirtualizer {
  private readonly ssotRoot: string;
  private readonly apps: AppSkillsConfig[];
  private readonly registryOutputPath: string;
  private lastRegistry: SkillsRegistry | null = null;

  constructor(options: SkillVirtualizerOptions = {}) {
    this.ssotRoot = path.resolve(options.ssotRoot ?? path.join(os.homedir(), '.agents', 'skills'));
    this.apps = (options.apps ?? createDefaultAppSkillsConfig()).map((app) => ({
      ...app,
      skillsDir: path.resolve(app.skillsDir),
    }));
    this.registryOutputPath = path.resolve(
      options.registryOutputPath ?? path.join(os.homedir(), '.agent', 'runtime', SKILLS_REGISTRY_FILENAME),
    );
  }

  get ssotRootPath(): string {
    return this.ssotRoot;
  }

  get appConfigs(): AppSkillsConfig[] {
    return this.apps.map((app) => ({ ...app }));
  }

  get registryPath(): string {
    return this.registryOutputPath;
  }

  private async listSkillDirs(root: string): Promise<DiscoveredSkillDir[]> {
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return []; // root does not exist (or is unreadable): treat as empty
    }
    const out: DiscoveredSkillDir[] = [];
    for (const dirent of dirents) {
      if (dirent.name.startsWith('.')) {
        continue;
      }
      const full = path.join(root, dirent.name);
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) {
        continue; // plain file
      }
      if (!(await isDirectoryPath(full))) {
        continue; // dangling link or non-directory
      }
      out.push({ dir: full, isLink: dirent.isSymbolicLink() });
    }
    return out;
  }

  private async readSkillFrontmatter(skillDir: string): Promise<SkillFrontmatter | null> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
    } catch {
      return null; // no SKILL.md -> not a skill directory
    }
    return parseSkillFrontmatter(raw);
  }

  async scan(): Promise<SkillsRegistry> {
    const entries = new Map<string, SkillRegistryEntry>();
    /** realpath -> registry entry name, used to detect junction mounts across dirs. */
    const realToEntryName = new Map<string, string>();

    // 1) SSOT master skills repo: canonical, shared copies.
    for (const discovered of await this.listSkillDirs(this.ssotRoot)) {
      const parsed = await this.readSkillFrontmatter(discovered.dir);
      if (!parsed) {
        continue;
      }
      const name = parsed.name?.trim() || path.basename(discovered.dir);
      const description = parsed.description?.trim() ?? '';
      const resolved = path.resolve(discovered.dir);
      const real = await safeRealpath(resolved);
      if (real && !realToEntryName.has(real)) {
        realToEntryName.set(real, name);
      }
      if (!entries.has(name)) {
        entries.set(name, {
          name,
          description,
          sourceHarness: SSOT_SOURCE_HARNESS,
          ssotPath: resolved,
          originPath: resolved,
          isShared: true,
          mounts: [],
        });
      }
    }

    // 2) App-private skill dirs: native skills plus existing junction mounts.
    for (const app of this.apps) {
      for (const discovered of await this.listSkillDirs(app.skillsDir)) {
        const parsed = await this.readSkillFrontmatter(discovered.dir);
        if (!parsed) {
          continue;
        }
        const name = parsed.name?.trim() || path.basename(discovered.dir);
        const description = parsed.description?.trim() ?? '';
        const resolved = path.resolve(discovered.dir);
        const real = await safeRealpath(resolved);

        const canonicalName = real ? realToEntryName.get(real) : undefined;
        if (canonicalName) {
          const canonical = entries.get(canonicalName);
          if (canonical) {
            // A link (or path alias) to an already-registered skill: record as a mount.
            upsertMount(canonical, {
              harness: app.harness,
              strategy: discovered.isLink ? 'junction' : 'native',
              mounted: true,
              mountPath: resolved,
            });
            continue;
          }
        }

        if (entries.has(name)) {
          const existing = entries.get(name)!;
          if (existing.isShared) {
            // Real local shadow copy of a shared skill: SSOT entry wins, record as native mount.
            upsertMount(existing, {
              harness: app.harness,
              strategy: 'native',
              mounted: true,
              mountPath: resolved,
            });
          }
          continue;
        }

        entries.set(name, {
          name,
          description,
          sourceHarness: app.harness,
          ssotPath: resolved,
          originPath: resolved,
          isShared: false,
          mounts: [],
        });
        if (real && !realToEntryName.has(real)) {
          realToEntryName.set(real, name);
        }
      }
    }

    // 3) Fill default mount rows so every (skill, app) pair has an explicit state.
    for (const entry of entries.values()) {
      for (const app of this.apps) {
        if (entry.mounts.some((m) => m.harness === app.harness)) {
          continue;
        }
        if (!entry.isShared && entry.sourceHarness === app.harness) {
          entry.mounts.push({
            harness: app.harness,
            strategy: 'native',
            mounted: true,
            mountPath: entry.ssotPath,
          });
        } else if (app.junctionCompatible) {
          entry.mounts.push({ harness: app.harness, strategy: 'junction', mounted: false });
        } else {
          entry.mounts.push({ harness: app.harness, strategy: 'prompt-injection', mounted: true });
        }
      }
      entry.mounts.sort((a, b) =>
        a.harness < b.harness ? -1 : a.harness > b.harness ? 1 : 0,
      );
    }

    const registry: SkillsRegistry = {
      schemaVersion: SKILLS_REGISTRY_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      ssotRoot: this.ssotRoot,
      apps: this.apps.map((app) => ({ ...app })),
      skills: [...entries.values()].sort(compareByName),
    };
    this.lastRegistry = registry;
    return registry;
  }

  async syncToApps(options: SyncToAppsOptions = {}): Promise<SyncToAppsResult> {
    const registry = options.registry
      ? (JSON.parse(JSON.stringify(options.registry)) as SkillsRegistry)
      : await this.scan();
    const sharedSkills = registry.skills.filter((skill) => skill.isShared);

    const ssotReals = new Map<string, string | null>();
    for (const skill of sharedSkills) {
      ssotReals.set(skill.name, await safeRealpath(skill.ssotPath));
    }

    const operations: SkillSyncOperation[] = [];
    const pushOp = (op: SkillSyncOperation): void => {
      operations.push(op);
    };

    for (const app of this.apps) {
      if (!app.junctionCompatible) {
        continue; // served via prompt injection, not filesystem mounts
      }
      try {
        await fs.mkdir(app.skillsDir, { recursive: true });
      } catch (error) {
        for (const skill of sharedSkills) {
          pushOp({
            harness: app.harness,
            skillName: skill.name,
            status: 'failed',
            mountPath: path.join(app.skillsDir, skill.name),
            detail: `cannot create app skills dir: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
        continue;
      }

      for (const skill of sharedSkills) {
        const targetDir = path.join(app.skillsDir, skill.name);
        try {
          const existing = await lstatSafe(targetDir);
          if (existing) {
            if (existing.isSymbolicLink()) {
              const linkReal = await safeRealpath(targetDir);
              const ssotReal = ssotReals.get(skill.name) ?? null;
              if (linkReal && ssotReal && linkReal === ssotReal) {
                pushOp({
                  harness: app.harness,
                  skillName: skill.name,
                  status: 'already-linked',
                  mountPath: targetDir,
                });
              } else {
                pushOp({
                  harness: app.harness,
                  skillName: skill.name,
                  status: 'skipped',
                  mountPath: targetDir,
                  detail: 'existing junction points elsewhere',
                });
              }
            } else {
              pushOp({
                harness: app.harness,
                skillName: skill.name,
                status: 'skipped',
                mountPath: targetDir,
                detail: existing.isDirectory()
                  ? 'existing real directory left untouched'
                  : 'existing file left untouched',
              });
            }
            continue;
          }
          // Zero-copy share: Windows junction, no admin rights required.
          fsSync.symlinkSync(skill.ssotPath, targetDir, 'junction');
          pushOp({
            harness: app.harness,
            skillName: skill.name,
            status: 'created',
            mountPath: targetDir,
          });
        } catch (error) {
          pushOp({
            harness: app.harness,
            skillName: skill.name,
            status: 'failed',
            mountPath: targetDir,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    // Reflect successful syncs in the registry mount states.
    for (const op of operations) {
      if (op.status !== 'created' && op.status !== 'already-linked') {
        continue;
      }
      const entry = registry.skills.find((skill) => skill.name === op.skillName);
      if (!entry) {
        continue;
      }
      upsertMount(entry, {
        harness: op.harness,
        strategy: 'junction',
        mounted: true,
        mountPath: op.mountPath,
      });
    }
    registry.generatedAt = new Date().toISOString();

    const count = (status: SkillSyncStatus): number =>
      operations.filter((op) => op.status === status).length;

    const result: SyncToAppsResult = {
      operations,
      created: count('created'),
      alreadyLinked: count('already-linked'),
      skipped: count('skipped'),
      failed: count('failed'),
      promptInjectionHarnesses: this.apps
        .filter((app) => !app.junctionCompatible)
        .map((app) => app.harness),
      registry,
    };
    this.lastRegistry = registry;
    return result;
  }

  buildPromptInjectionBlock(registry?: SkillsRegistry): string {
    const reg = registry ?? this.lastRegistry;
    if (!reg) {
      throw new Error(
        'No skills registry available. Call scan() (or syncToApps()) first, or pass a SkillsRegistry explicitly.',
      );
    }

    const lines: string[] = [
      '<!-- crosscode:skills-injection BEGIN -->',
      '## CrossCode Virtualized Skills',
      '',
      'The following skills are managed centrally by CrossCode and are available in this session.',
      'To use one, read its SKILL.md first and follow its instructions.',
      '',
    ];
    if (reg.skills.length === 0) {
      lines.push('_No skills are currently registered._');
    } else {
      for (const skill of reg.skills) {
        lines.push(`- **${skill.name}**: ${skill.description || '(no description)'}`);
        lines.push(`  - Source: \`${skill.ssotPath}\``);
      }
    }
    lines.push('');
    lines.push('<!-- crosscode:skills-injection END -->');
    return lines.join('\n');
  }

  async writeRegistry(registry?: SkillsRegistry): Promise<string> {
    const reg = registry ?? (await this.scan());
    await fs.mkdir(path.dirname(this.registryOutputPath), { recursive: true });
    await fs.writeFile(this.registryOutputPath, `${JSON.stringify(reg, null, 2)}\n`, 'utf8');
    return this.registryOutputPath;
  }
}
