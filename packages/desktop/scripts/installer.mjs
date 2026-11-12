import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the NSIS installer from the already-packaged portable directory.
 *
 * Using `--prepackaged` makes electron-builder wrap the existing
 * `release/CrossCode` tree instead of re-extracting the Electron runtime,
 * which is what fails with EBUSY on locked `default_app.asar` files.
 */

const root = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(root, '..');
const prepackaged = path.join(packageRoot, 'release/CrossCode');

if (!fs.existsSync(path.join(prepackaged, 'CrossCode.exe'))) {
  console.error('[installer] run "node scripts/package.mjs" first');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    path.join(packageRoot, 'node_modules/electron-builder/out/cli/cli.js'),
    '--prepackaged',
    prepackaged,
    '--win',
    'nsis',
  ],
  { cwd: packageRoot, stdio: 'inherit' },
);

process.exit(result.status ?? 1);
