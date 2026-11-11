import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export * from './skills/skill-virtualizer.js';
export * from './tools/builtin-browser.js';
export * from './tools/external-browser-bridge.js';
export * from './tools/computer-use-win32.js';
export * from './server.js';

import { createUnifiedMcpServer } from './server.js';

/**
 * CLI entry: `node index.js --mcp-stdio` serves the CrossCode unified MCP
 * server over stdio (this is the command written into app `mcpServers`
 * entries by `registerIntoAppConfigs`). Importing this module never starts
 * the server — the guard only matches direct execution.
 */
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const thisFilePath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath === thisFilePath && process.argv.includes('--mcp-stdio')) {
  const server = createUnifiedMcpServer();
  await server.connectStdio();
}
