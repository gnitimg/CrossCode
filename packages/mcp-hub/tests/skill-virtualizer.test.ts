import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Dirent } from 'node:fs';
import {
  SkillVirtualizer,
  parseSkillFrontmatter,
  type AppSkillsConfig,
  type SkillsRegistry,
} from '../src/index.js';

describe('Task 4: SkillVirtualizer — cross-app skills virtualization engine', () => {
  let tempRoot: string;
  let ssotRoot: string;
  let claudeSkillsDir: string;
  let opencodeSkillsDir: string;
  let codexSkillsDir: string;
  let qoderSkillsDir: string;
  let registryOutputPath: string;
  /** App skill dirs that may receive junction mounts; cleaned before removing tempRoot. */
  let junctionCandidateDirs: string[];

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crosscode-mcp-hub-test-'));
    ssotRoot = path.join(tempRoot, 'ssot', 'skills');
    claudeSkillsDir = path.join(tempRoot, 'apps', 'claude', 'skills');
    opencodeSkillsDir = path.join(tempRoot, 'apps', 'opencode', 'skills');
    codexSkillsDir = path.join(tempRoot, 'apps', 'codex', 'skills');
    qoderSkillsDir = path.join(tempRoot, 'apps', 'qoder', 'skills');
    registryOutputPath = path.join(tempRoot, '.agent', 'runtime', 'skills-registry.json');
    junctionCandidateDirs = [
      claudeSkillsDir,
      opencodeSkillsDir,
      codexSkillsDir,
      qoderSkillsDir,
    ];
  });

  afterEach(async () => {
    // Windows junctions must be removed before deleting the temp root:
    // fs.rm on a junction only removes the link itself (Node 22+), so the
    // SSOT targets inside the same temp root are never followed/traversed.
    for (const dir of junctionCandidateDirs) {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue; // dir never created in this test
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) {
          await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
        }
      }
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function writeSkill(dir: string, frontmatter: string, body = 'Skill instructions.'): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf8');
  }

  function makeApps(overrides: Partial<Record<string, boolean>> = {}): AppSkillsConfig[] {
    const compat = (harness: string, dflt: boolean): boolean => overrides[harness] ?? dflt;
    return [
      { harness: 'claude-code', skillsDir: claudeSkillsDir, junctionCompatible: compat('claude-code', true) },
      { harness: 'opencode', skillsDir: opencodeSkillsDir, junctionCompatible: compat('opencode', true) },
      { harness: 'codex', skillsDir: codexSkillsDir, junctionCompatible: compat('codex', true) },
      { harness: 'qoder', skillsDir: qoderSkillsDir, junctionCompatible: compat('qoder', false) },
    ];
  }

  describe('parseSkillFrontmatter', () => {
    it('parses minimal name/description frontmatter and ignores body and extra keys', () => {
      expect(parseSkillFrontmatter('---\nname: deploy-aws\ndescription: Deploy things.\n---\n\n# Body\n')).toEqual({
        name: 'deploy-aws',
        description: 'Deploy things.',
      });
    });

    it('handles CRLF line endings, quoted values, and unknown keys', () => {
      expect(
        parseSkillFrontmatter('---\r\nname: "code-review"\r\ndescription: \'Review diffs carefully.\'\r\nversion: 2\r\n---\r\nBody'),
      ).toEqual({ name: 'code-review', description: 'Review diffs carefully.' });
    });

    it('returns null for content without a frontmatter block', () => {
      expect(parseSkillFrontmatter('# Just markdown, no frontmatter\n')).toBeNull();
      expect(parseSkillFrontmatter('---\nname: unterminated-block\n')).toBeNull();
    });
  });

  describe('scan() — SSOT + app-private discovery, frontmatter parsing, registry build', () => {
    it('builds the unified skills registry from the SSOT repo and app skill dirs', async () => {
      await writeSkill(path.join(ssotRoot, 'deploy-aws'), 'name: deploy-aws\ndescription: Deploy services to AWS ECS.');
      // CRLF + quoted values + extra frontmatter key that must be ignored
      await writeSkill(
        path.join(ssotRoot, 'code-review'),
        'name: "code-review"\r\ndescription: \'Review code changes before merge.\'\r\nversion: 2\r\n',
      );
      // Directory without SKILL.md and a plain file must be ignored
      await fs.mkdir(path.join(ssotRoot, 'not-a-skill'), { recursive: true });
      await fs.writeFile(path.join(ssotRoot, 'stray-file.txt'), 'nope', 'utf8');

      // App-private native skill (only lives in claude's dir)
      await writeSkill(
        path.join(claudeSkillsDir, 'private-helper'),
        'name: private-helper\ndescription: Claude-only helper skill.',
      );

      // codex already has a junction mount of the SSOT skill (pre-existing)
      await fs.mkdir(codexSkillsDir, { recursive: true });
      const preexistingJunction = path.join(codexSkillsDir, 'deploy-aws');
      fsSync.symlinkSync(path.join(ssotRoot, 'deploy-aws'), preexistingJunction, 'junction');

      const virtualizer = new SkillVirtualizer({
        ssotRoot,
        apps: makeApps(),
        registryOutputPath,
      });
      const registry = await virtualizer.scan();

      expect(registry.schemaVersion).toBe('1.0.0');
      expect(registry.ssotRoot).toBe(path.resolve(ssotRoot));
      expect(registry.skills.map((s) => s.name).sort()).toEqual([
        'code-review',
        'deploy-aws',
        'private-helper',
      ]);
      expect(registry.apps).toHaveLength(4);

      const deploy = registry.skills.find((s) => s.name === 'deploy-aws')!;
      expect(deploy).toBeDefined();
      expect(deploy.description).toBe('Deploy services to AWS ECS.');
      expect(deploy.sourceHarness).toBe('crosscode-native');
      expect(deploy.isShared).toBe(true);
      expect(deploy.ssotPath).toBe(path.resolve(path.join(ssotRoot, 'deploy-aws')));

      const review = registry.skills.find((s) => s.name === 'code-review')!;
      expect(review.description).toBe('Review code changes before merge.');
      expect(review.sourceHarness).toBe('crosscode-native');

      const helper = registry.skills.find((s) => s.name === 'private-helper')!;
      expect(helper.sourceHarness).toBe('claude-code');
      expect(helper.isShared).toBe(false);

      // Pre-existing codex junction detected as a mount of the SSOT skill (no duplicate entry)
      const codexMount = deploy.mounts.find((m) => m.harness === 'codex')!;
      expect(codexMount.mounted).toBe(true);
      expect(codexMount.strategy).toBe('junction');
      expect(codexMount.mountPath).toBe(path.resolve(preexistingJunction));

      // Junction-compatible app without a junction yet: not mounted, junction strategy planned
      const claudeMount = deploy.mounts.find((m) => m.harness === 'claude-code')!;
      expect(claudeMount.strategy).toBe('junction');
      expect(claudeMount.mounted).toBe(false);

      // Junction-incompatible app is served via prompt injection
      const qoderMount = deploy.mounts.find((m) => m.harness === 'qoder')!;
      expect(qoderMount.strategy).toBe('prompt-injection');
      expect(qoderMount.mounted).toBe(true);

      // Native app sees its own private skill natively
      const helperClaudeMount = helper.mounts.find((m) => m.harness === 'claude-code')!;
      expect(helperClaudeMount.mounted).toBe(true);
      expect(helperClaudeMount.strategy).toBe('native');
    });
  });

  describe('writeRegistry() — skills-registry.json persistence', () => {
    it('writes the registry JSON to the injectable .agent/runtime style output path', async () => {
      await writeSkill(path.join(ssotRoot, 'deploy-aws'), 'name: deploy-aws\ndescription: Deploy services to AWS ECS.');

      const virtualizer = new SkillVirtualizer({
        ssotRoot,
        apps: makeApps(),
        registryOutputPath,
      });

      const writtenPath = await virtualizer.writeRegistry();
      expect(path.resolve(writtenPath)).toBe(path.resolve(registryOutputPath));

      const raw = await fs.readFile(registryOutputPath, 'utf8');
      const parsed = JSON.parse(raw) as SkillsRegistry;
      expect(parsed.schemaVersion).toBe('1.0.0');
      expect(parsed.generatedAt).toBeTruthy();
      expect(parsed.skills).toHaveLength(1);
      expect(parsed.skills[0].name).toBe('deploy-aws');
      expect(parsed.skills[0].description).toBe('Deploy services to AWS ECS.');
      expect(parsed.apps.map((a) => a.harness)).toEqual(
        expect.arrayContaining(['claude-code', 'opencode', 'codex', 'qoder']),
      );
    });
  });

  describe('syncToApps() — zero-copy junction sync with idempotent re-entry', () => {
    it('creates junctions for compatible apps on first run and reports already-linked on re-runs', async () => {
      await writeSkill(path.join(ssotRoot, 'deploy-aws'), 'name: deploy-aws\ndescription: Deploy services to AWS ECS.');
      await writeSkill(path.join(ssotRoot, 'code-review'), 'name: code-review\ndescription: Review code changes before merge.');

      const virtualizer = new SkillVirtualizer({
        ssotRoot,
        apps: makeApps(), // claude-code/opencode/codex junction-compatible; qoder prompt-injection
        registryOutputPath,
      });

      const first = await virtualizer.syncToApps();
      expect(first.created).toBe(6); // 2 SSOT skills x 3 junction-compatible apps
      expect(first.alreadyLinked).toBe(0);
      expect(first.skipped).toBe(0);
      expect(first.failed).toBe(0);
      expect(first.promptInjectionHarnesses).toEqual(['qoder']);

      // Every junction exists, is a symlink, and resolves to the SSOT skill directory
      for (const appDir of [claudeSkillsDir, opencodeSkillsDir, codexSkillsDir]) {
        for (const skillName of ['deploy-aws', 'code-review']) {
          const linkPath = path.join(appDir, skillName);
          const linkStat = await fs.lstat(linkPath);
          expect(linkStat.isSymbolicLink()).toBe(true);
          expect(await fs.realpath(linkPath)).toBe(await fs.realpath(path.join(ssotRoot, skillName)));
        }
      }

      // Zero-copy verification: skill content is readable through the junction
      const viaJunction = await fs.readFile(
        path.join(claudeSkillsDir, 'deploy-aws', 'SKILL.md'),
        'utf8',
      );
      expect(viaJunction).toContain('Deploy services to AWS ECS.');

      // Registry returned by the sync reflects the fresh mount states
      const deploy = first.registry.skills.find((s) => s.name === 'deploy-aws')!;
      expect(deploy.mounts.find((m) => m.harness === 'claude-code')!.mounted).toBe(true);
      expect(deploy.mounts.find((m) => m.harness === 'claude-code')!.strategy).toBe('junction');
      expect(deploy.mounts.find((m) => m.harness === 'qoder')!.strategy).toBe('prompt-injection');

      // Idempotent re-entry with the same registry: nothing recreated, no errors
      const second = await virtualizer.syncToApps({ registry: first.registry });
      expect(second.created).toBe(0);
      expect(second.alreadyLinked).toBe(6);
      expect(second.skipped).toBe(0);
      expect(second.failed).toBe(0);

      // Full idempotency across a fresh scan too
      const third = await virtualizer.syncToApps();
      expect(third.created).toBe(0);
      expect(third.alreadyLinked).toBe(6);
      expect(third.failed).toBe(0);

      // Junctions still resolve to the SSOT directories after re-runs
      expect(await fs.realpath(path.join(opencodeSkillsDir, 'code-review'))).toBe(
        await fs.realpath(path.join(ssotRoot, 'code-review')),
      );
    });

    it('never overwrites real directories or foreign entries in app skill dirs (skipped, no error)', async () => {
      await writeSkill(path.join(ssotRoot, 'deploy-aws'), 'name: deploy-aws\ndescription: Deploy services to AWS ECS.');

      // Pre-existing real directory shadowing the skill name in claude's dir
      await writeSkill(
        path.join(claudeSkillsDir, 'deploy-aws'),
        'name: deploy-aws\ndescription: Local shadow copy that must survive sync.',
      );

      const virtualizer = new SkillVirtualizer({
        ssotRoot,
        apps: makeApps(),
        registryOutputPath,
      });

      const result = await virtualizer.syncToApps();
      expect(result.failed).toBe(0);
      expect(result.created).toBe(2); // opencode + codex only
      expect(result.skipped).toBe(1); // claude-code real directory left untouched

      const claudeOp = result.operations.find(
        (op) => op.harness === 'claude-code' && op.skillName === 'deploy-aws',
      )!;
      expect(claudeOp.status).toBe('skipped');

      // The pre-existing real directory content is intact
      const shadowRaw = await fs.readFile(
        path.join(claudeSkillsDir, 'deploy-aws', 'SKILL.md'),
        'utf8',
      );
      expect(shadowRaw).toContain('Local shadow copy that must survive sync.');
    });
  });

  describe('buildPromptInjectionBlock() — merged prompt block for junction-incompatible tools', () => {
    it('lists every registered skill as a markdown bullet with name and description', async () => {
      await writeSkill(path.join(ssotRoot, 'deploy-aws'), 'name: deploy-aws\ndescription: Deploy services to AWS ECS.');
      await writeSkill(path.join(ssotRoot, 'code-review'), 'name: code-review\ndescription: Review code changes before merge.');

      const virtualizer = new SkillVirtualizer({
        ssotRoot,
        apps: makeApps(),
        registryOutputPath,
      });

      const registry = await virtualizer.scan();
      const block = virtualizer.buildPromptInjectionBlock(registry);

      expect(block).toContain('crosscode:skills-injection BEGIN');
      expect(block).toContain('crosscode:skills-injection END');
      expect(block).toMatch(/## /);
      expect(block).toContain('- **deploy-aws**: Deploy services to AWS ECS.');
      expect(block).toContain('- **code-review**: Review code changes before merge.');
      // Points consumers at the SSOT source of each skill
      expect(block).toContain(path.resolve(path.join(ssotRoot, 'deploy-aws')));
    });

    it('throws a clear error when called before any scan and without a registry argument', async () => {
      const fresh = new SkillVirtualizer({ ssotRoot, apps: makeApps(), registryOutputPath });
      expect(() => fresh.buildPromptInjectionBlock()).toThrow(/scan/i);
    });
  });
});
