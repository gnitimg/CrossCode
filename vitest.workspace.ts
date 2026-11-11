import { defineWorkspace } from 'vitest/config';

/**
 * Vitest workspace: keeps the node-environment suites (shared / daemon /
 * mcp-hub) separate from the jsdom component suites of the web workbench, so
 * a single `pnpm test` at the repo root runs every package green.
 */
export default defineWorkspace([
  'packages/shared',
  'packages/daemon',
  'packages/mcp-hub',
  'packages/web',
]);
