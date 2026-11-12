import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Bundles the Electron main process and preload into single CJS files.
 *
 * Bundling (rather than shipping node_modules) keeps the packaged app small and
 * sidesteps pnpm workspace symlinks inside asar. `electron` and the optional
 * native accelerators used by `ws` stay external.
 */
const root = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(root, '..');

// Icons are generated (not committed); make sure they exist before bundling.
if (!fs.existsSync(path.join(packageRoot, 'build/tray.png'))) {
  const generated = spawnSync(process.execPath, [path.join(root, 'make-icons.mjs')], { stdio: 'inherit' });
  if (generated.status !== 0) process.exit(generated.status ?? 1);
}

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
};

await build({
  ...shared,
  entryPoints: [path.join(packageRoot, 'src/main.ts')],
  outfile: path.join(packageRoot, 'dist/main.cjs'),
});

await build({
  ...shared,
  entryPoints: [path.join(packageRoot, 'src/preload.ts')],
  outfile: path.join(packageRoot, 'dist/preload.cjs'),
});
