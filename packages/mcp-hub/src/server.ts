/**
 * Unified MCP Server.
 *
 * Registers the full CrossCode toolset on a single MCP server (stdio by
 * default, any SDK transport works):
 * - 6 built-in browser tools   (`browser_builtin_*`)
 * - 3 external browser tools   (`browser_external_*`)
 * - 7 computer use tools       (`computer_*`)
 * - 2 skills tools             (`skills_list`, `skills_prompt_injection_block`)
 *
 * Every backing service (browser pool, external bridge, PowerShell executor,
 * skills virtualizer) is injectable, and the whole toolset can be replaced via
 * `options.tools` so tests stay fully offline and side-effect free.
 *
 * `registerIntoAppConfigs(apps)` merges the CrossCode unified MCP server as an
 * idempotent `mcpServers` entry into each target app's MCP config JSON file.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ContentBlock,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { SkillVirtualizer, type SkillVirtualizerOptions } from './skills/skill-virtualizer.js';
import {
  BuiltinBrowser,
  BuiltinBrowserError,
  builtinBrowserNormalizedError,
  type BuiltinBrowserOptions,
} from './tools/builtin-browser.js';
import {
  ComputerUseWin32,
  type ComputerUseOptions,
} from './tools/computer-use-win32.js';
import {
  ExternalBrowserBridge,
  type ExternalBrowserBridgeOptions,
} from './tools/external-browser-bridge.js';

// ---------------------------------------------------------------------------
// Unified tool model (plain JSON Schema — no zod in the tool layer)
// ---------------------------------------------------------------------------

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  default?: unknown;
}

export interface UnifiedToolJsonSchema {
  type: 'object';
  /** Index signature keeps the schema structurally compatible with the SDK Tool type. */
  [key: string]: unknown;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export type UnifiedToolContentItem =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface UnifiedToolCallResult {
  content: UnifiedToolContentItem[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface UnifiedToolDefinition {
  name: string;
  description: string;
  inputSchema: UnifiedToolJsonSchema;
  handler(args: Record<string, unknown>): Promise<UnifiedToolCallResult>;
}

// ---------------------------------------------------------------------------
// Tool name catalog
// ---------------------------------------------------------------------------

export const BUILTIN_BROWSER_TOOL_NAMES = [
  'browser_builtin_open',
  'browser_builtin_snapshot',
  'browser_builtin_click',
  'browser_builtin_fill',
  'browser_builtin_screenshot',
  'browser_builtin_console',
] as const;

export const EXTERNAL_BROWSER_TOOL_NAMES = [
  'browser_external_list_tabs',
  'browser_external_activate_tab',
  'browser_external_exec_action',
] as const;

export const COMPUTER_USE_TOOL_NAMES = [
  'computer_screenshot',
  'computer_mouse_action',
  'computer_keyboard_action',
  'computer_window_list',
  'computer_window_focus',
  'computer_list_pending_approvals',
  'computer_resolve_approval',
] as const;

export const SKILLS_TOOL_NAMES = ['skills_list', 'skills_prompt_injection_block'] as const;

export const UNIFIED_TOOL_NAMES: readonly string[] = [
  ...BUILTIN_BROWSER_TOOL_NAMES,
  ...EXTERNAL_BROWSER_TOOL_NAMES,
  ...COMPUTER_USE_TOOL_NAMES,
  ...SKILLS_TOOL_NAMES,
];

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

export function textResult(text: string, structuredContent?: Record<string, unknown>): UnifiedToolCallResult {
  const result: UnifiedToolCallResult = { content: [{ type: 'text', text }] };
  if (structuredContent) {
    result.structuredContent = structuredContent;
  }
  return result;
}

export function jsonResult(value: Record<string, unknown>, text?: string): UnifiedToolCallResult {
  return textResult(text ?? JSON.stringify(value, null, 2), value);
}

export function imageResult(base64: string, mimeType: string, caption?: string): UnifiedToolCallResult {
  const content: UnifiedToolContentItem[] = [{ type: 'image', data: base64, mimeType }];
  if (caption) {
    content.unshift({ type: 'text', text: caption });
  }
  return { content };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Missing required number argument: ${key}`);
  }
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Argument ${key} must be a number`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Argument ${key} must be a string`);
  }
  return value;
}

function requireBoolean(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (typeof value !== 'boolean') {
    throw new Error(`Missing required boolean argument: ${key}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Tool set creators (exported so tests can compose partial sets with fakes)
// ---------------------------------------------------------------------------

export function createBuiltinBrowserTools(browser: BuiltinBrowser): UnifiedToolDefinition[] {
  return [
    {
      name: 'browser_builtin_open',
      description:
        'Open a URL in the CrossCode built-in Chromium browser (lazily launched page pool). ' +
        'Subsequent browser_builtin_* tools act on the most recently opened page.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Absolute URL to navigate to' } },
        required: ['url'],
      },
      handler: async (args) => {
        const url = requireString(args, 'url');
        const result = await browser.open(url);
        return jsonResult(
          { ...result },
          `Opened ${result.url} — "${result.title}" (pool size ${result.poolSize}).`,
        );
      },
    },
    {
      name: 'browser_builtin_snapshot',
      description:
        'Accessibility snapshot of the active built-in browser page as text with @eN element refs. ' +
        'Use the refs with browser_builtin_click / browser_builtin_fill.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const snapshot = await browser.snapshot();
        return {
          content: [{ type: 'text', text: snapshot.text }],
          structuredContent: { url: snapshot.url, title: snapshot.title, refCount: snapshot.refCount },
        };
      },
    },
    {
      name: 'browser_builtin_click',
      description: 'Click the element referenced by an @eN ref from the latest browser_builtin_snapshot.',
      inputSchema: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'Element ref, e.g. @e2' } },
        required: ['ref'],
      },
      handler: async (args) => {
        const ref = requireString(args, 'ref');
        const result = await browser.click(ref);
        return jsonResult(
          { ...result },
          `Clicked ${result.clickedRef} [${result.role}]${result.name ? ` "${result.name}"` : ''}.`,
        );
      },
    },
    {
      name: 'browser_builtin_fill',
      description: 'Type text into the element referenced by an @eN ref from the latest browser_builtin_snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Element ref, e.g. @e3' },
          text: { type: 'string', description: 'Text to type into the element' },
        },
        required: ['ref', 'text'],
      },
      handler: async (args) => {
        const ref = requireString(args, 'ref');
        const text = requireString(args, 'text');
        const result = await browser.fill(ref, text);
        return jsonResult({ ...result }, `Filled ${result.filledRef} [${result.role}] with the provided text.`);
      },
    },
    {
      name: 'browser_builtin_screenshot',
      description: 'Take a PNG screenshot of the active built-in browser page (returned as base64 image).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const shot = await browser.screenshot();
        return imageResult(shot.base64, shot.mimeType, 'Builtin browser page screenshot (PNG).');
      },
    },
    {
      name: 'browser_builtin_console',
      description: 'Read the console/pageerror log buffer of the active built-in browser page.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const entries = browser.console();
        const text =
          entries.length === 0
            ? '(no console entries)'
            : entries
                .map((entry) => `[${entry.timestamp}] [${entry.level}] ${entry.text}`)
                .join('\n');
        return textResult(text, { entries });
      },
    },
  ];
}

export function createExternalBrowserTools(bridge: ExternalBrowserBridge): UnifiedToolDefinition[] {
  return [
    {
      name: 'browser_external_list_tabs',
      description:
        'List tabs of the user-owned external browser (companion extension over WebSocket, or ' +
        'Chrome CDP --remote-debugging-port fallback).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const result = await bridge.listTabs();
        return jsonResult(
          { transport: result.transport, tabs: result.tabs },
          `External browser tabs via ${result.transport}: ${result.tabs.length}.`,
        );
      },
    },
    {
      name: 'browser_external_activate_tab',
      description: 'Bring an external browser tab to the foreground by tab id.',
      inputSchema: {
        type: 'object',
        properties: { tabId: { type: 'string', description: 'Tab id from browser_external_list_tabs' } },
        required: ['tabId'],
      },
      handler: async (args) => {
        const tabId = requireString(args, 'tabId');
        const result = await bridge.activateTab(tabId);
        return jsonResult({ ...result }, `Activated tab ${tabId} via ${result.transport}.`);
      },
    },
    {
      name: 'browser_external_exec_action',
      description:
        'Execute an action in an external browser tab: routed to the companion extension ' +
        '(`action.kind` is a semantic action like click/scroll/evaluate) or, via CDP, as a raw ' +
        'CDP command method with params.',
      inputSchema: {
        type: 'object',
        properties: {
          tabId: { type: 'string', description: 'Tab id from browser_external_list_tabs' },
          action: {
            type: 'object',
            description: 'Action to execute: { kind: string, payload?: object }',
            properties: {
              kind: { type: 'string', description: 'Action kind (extension action or CDP method)' },
              payload: { type: 'object', description: 'Optional action payload' },
            },
            required: ['kind'],
          },
        },
        required: ['tabId', 'action'],
      },
      handler: async (args) => {
        const tabId = requireString(args, 'tabId');
        const actionArg = args.action;
        if (!actionArg || typeof actionArg !== 'object' || Array.isArray(actionArg)) {
          throw new Error('Argument action must be an object like { kind, payload }');
        }
        const kind = (actionArg as Record<string, unknown>).kind;
        if (typeof kind !== 'string' || kind.length === 0) {
          throw new Error('Argument action.kind must be a non-empty string');
        }
        const payloadRaw = (actionArg as Record<string, unknown>).payload;
        const payload =
          payloadRaw !== undefined && payloadRaw !== null
            ? (payloadRaw as Record<string, unknown>)
            : undefined;
        const result = await bridge.execAction(tabId, payload ? { kind, payload } : { kind });
        return jsonResult({ ...result }, `Executed '${kind}' on tab ${tabId} via ${result.transport}.`);
      },
    },
  ];
}

export function createComputerUseTools(computerUse: ComputerUseWin32): UnifiedToolDefinition[] {
  return [
    {
      name: 'computer_screenshot',
      description:
        'Capture the Windows desktop via PowerShell CopyFromScreen. Returns a scaled PNG (base64) ' +
        'plus coordinate ruler info: the physical screen width/height the screenshot maps onto.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const shot = await computerUse.screenshot();
        const caption =
          `Desktop screenshot: screen ${shot.width}x${shot.height}, image ${shot.scaledWidth}x${shot.scaledHeight}. ` +
          'Multiply model pixel estimates by width/scaledWidth to get screen coordinates.';
        const result = imageResult(shot.imageBase64, shot.mimeType, caption);
        result.structuredContent = {
          width: shot.width,
          height: shot.height,
          scaledWidth: shot.scaledWidth,
          scaledHeight: shot.scaledHeight,
        };
        return result;
      },
    },
    {
      name: 'computer_mouse_action',
      description:
        'Move the cursor or click/drag on the Windows desktop (user32 SetCursorPos/mouse_event). ' +
        'Actions: move | left_click | right_click | double_click | drag. Click/drag without ' +
        'explicit coordinates is a full-screen gesture and requires approval (CC-TOOL-4002).',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['move', 'left_click', 'right_click', 'double_click', 'drag'],
            description: 'Mouse action to perform',
          },
          x: { type: 'number', description: 'Target screen X (omit for current position)' },
          y: { type: 'number', description: 'Target screen Y (omit for current position)' },
          x2: { type: 'number', description: 'Drag end X' },
          y2: { type: 'number', description: 'Drag end Y' },
        },
        required: ['action'],
      },
      handler: async (args) => {
        const action = requireString(args, 'action');
        const input = {
          action: action as 'move' | 'left_click' | 'right_click' | 'double_click' | 'drag',
          x: optionalNumber(args, 'x'),
          y: optionalNumber(args, 'y'),
          x2: optionalNumber(args, 'x2'),
          y2: optionalNumber(args, 'y2'),
        };
        const result = await computerUse.mouseAction(input);
        return jsonResult({ ...result });
      },
    },
    {
      name: 'computer_keyboard_action',
      description:
        'Type literal text or press a hotkey combo on Windows (SendKeys / user32 keybd_event). ' +
        'Combos containing Alt+Tab or the Win key require approval (CC-TOOL-4002).',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['type', 'hotkey'],
            description: 'type = literal text input; hotkey = key combo like Ctrl+C',
          },
          text: { type: 'string', description: 'Text to type (action=type)' },
          keys: { type: 'string', description: "Combo like 'Ctrl+C', 'Alt+F4' (action=hotkey)" },
        },
        required: ['action'],
      },
      handler: async (args) => {
        const action = requireString(args, 'action');
        if (action !== 'type' && action !== 'hotkey') {
          throw new Error("Argument action must be 'type' or 'hotkey'");
        }
        const result = await computerUse.keyboardAction({
          action,
          text: optionalString(args, 'text'),
          keys: optionalString(args, 'keys'),
        });
        return jsonResult({ ...result });
      },
    },
    {
      name: 'computer_window_list',
      description: 'List visible top-level Windows windows (hwnd + title).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const result = await computerUse.windowList();
        return jsonResult(
          { windows: result.windows },
          `${result.windows.length} visible window(s).`,
        );
      },
    },
    {
      name: 'computer_window_focus',
      description:
        'Bring a Windows window to the foreground by hwnd or exact title (SetForegroundWindow). ' +
        'Focusing windows whose title matches the sensitive-title policy requires approval (CC-TOOL-4002).',
      inputSchema: {
        type: 'object',
        properties: {
          hwnd: { type: 'number', description: 'Window handle from computer_window_list' },
          title: { type: 'string', description: 'Exact window title to look up' },
        },
      },
      handler: async (args) => {
        const hwnd = optionalNumber(args, 'hwnd');
        const title = optionalString(args, 'title');
        if (hwnd === undefined && title === undefined) {
          throw new Error('Provide either hwnd or title');
        }
        const result = await computerUse.windowFocus({ hwnd, title });
        return jsonResult({ ...result });
      },
    },
    {
      name: 'computer_list_pending_approvals',
      description:
        'List pending Windows desktop actions awaiting human approval (CC-TOOL-4002 safety gate).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const approvals = computerUse.listPendingApprovals();
        return jsonResult(
          { approvals },
          `${approvals.length} pending approval(s).`,
        );
      },
    },
    {
      name: 'computer_resolve_approval',
      description:
        'Approve (and execute) or reject (and discard) a pending Windows desktop action held by the CC-TOOL-4002 safety gate.',
      inputSchema: {
        type: 'object',
        properties: {
          approvalId: {
            type: 'string',
            description: 'Approval ID returned by a CC-TOOL-4002 safety gate hit',
          },
          approved: {
            type: 'boolean',
            description: 'true = approve and execute the held action; false = reject and discard',
          },
          reason: {
            type: 'string',
            description: 'Optional rejection reason when approved is false',
          },
        },
        required: ['approvalId', 'approved'],
      },
      handler: async (args) => {
        const approvalId = requireString(args, 'approvalId');
        const approved = requireBoolean(args, 'approved');
        const reason = optionalString(args, 'reason');
        const decision = approved
          ? await computerUse.approve(approvalId)
          : computerUse.reject(approvalId, reason);
        return jsonResult(
          { ...decision },
          approved
            ? `Approved and executed pending action ${approvalId}.`
            : `Rejected pending action ${approvalId}: ${decision.reason ?? 'rejected by operator'}.`,
        );
      },
    },
  ];
}

export function createSkillsTools(virtualizer: SkillVirtualizer): UnifiedToolDefinition[] {
  return [
    {
      name: 'skills_list',
      description: 'List all CrossCode virtualized skills (SSOT master repo + per-app mounts).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const registry = await virtualizer.scan();
        const text =
          registry.skills.length === 0
            ? '(no skills registered)'
            : registry.skills
                .map(
                  (skill) =>
                    `- **${skill.name}**: ${skill.description || '(no description)'} — source: ${skill.ssotPath}`,
                )
                .join('\n');
        return textResult(text, {
          ssotRoot: registry.ssotRoot,
          skills: registry.skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            ssotPath: skill.ssotPath,
            isShared: skill.isShared,
          })),
        });
      },
    },
    {
      name: 'skills_prompt_injection_block',
      description:
        'Render the merged CrossCode skills prompt-injection block (for tools that cannot follow ' +
        'standard skill directories).',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const registry = await virtualizer.scan();
        const block = virtualizer.buildPromptInjectionBlock(registry);
        return textResult(block, { skillCount: registry.skills.length });
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Unified MCP server
// ---------------------------------------------------------------------------

export interface UnifiedMcpServerOptions {
  /** Server name advertised over MCP. Default `crosscode-unified-mcp`. */
  name?: string;
  /** Server version advertised over MCP. Default `0.1.0`. */
  version?: string;
  /** Full toolset override (tests inject fakes). `extraTools` is still appended. */
  tools?: UnifiedToolDefinition[];
  /** Additional tools appended to the (default or overridden) toolset. */
  extraTools?: UnifiedToolDefinition[];
  /** Builtin browser instance or construction options. */
  builtinBrowser?: BuiltinBrowser | BuiltinBrowserOptions;
  /** External browser bridge instance or construction options. */
  externalBridge?: ExternalBrowserBridge | ExternalBrowserBridgeOptions;
  /** Computer use instance or construction options. */
  computerUse?: ComputerUseWin32 | ComputerUseOptions;
  /** Skills virtualizer instance or construction options. */
  skills?: SkillVirtualizer | SkillVirtualizerOptions;
}

export interface UnifiedMcpServer {
  readonly name: string;
  readonly version: string;
  readonly underlyingServer: Server;
  /** Underlying Windows computer-use controller when the default toolset is active. */
  readonly computerUse?: ComputerUseWin32;
  /** Registered tool definitions in registration order. */
  listTools(): UnifiedToolDefinition[];
  getTool(name: string): UnifiedToolDefinition | undefined;
  connect(transport: Transport): Promise<void>;
  /** Connect over stdio (the primary CrossCode transport). */
  connectStdio(): Promise<void>;
}

export function createUnifiedMcpServer(options: UnifiedMcpServerOptions = {}): UnifiedMcpServer {
  const name = options.name ?? 'crosscode-unified-mcp';
  const version = options.version ?? '0.1.0';

  let tools: UnifiedToolDefinition[];
  let computerUseInstance: ComputerUseWin32 | undefined;
  if (options.tools) {
    tools = [...options.tools, ...(options.extraTools ?? [])];
    if (options.computerUse instanceof ComputerUseWin32) {
      computerUseInstance = options.computerUse;
    }
  } else {
    const builtinBrowser =
      options.builtinBrowser instanceof BuiltinBrowser
        ? options.builtinBrowser
        : new BuiltinBrowser(options.builtinBrowser);
    const externalBridge =
      options.externalBridge instanceof ExternalBrowserBridge
        ? options.externalBridge
        : new ExternalBrowserBridge(options.externalBridge);
    const computerUse =
      options.computerUse instanceof ComputerUseWin32
        ? options.computerUse
        : new ComputerUseWin32(options.computerUse);
    computerUseInstance = computerUse;
    const skills =
      options.skills instanceof SkillVirtualizer
        ? options.skills
        : new SkillVirtualizer(options.skills ?? {});
    tools = [
      ...createBuiltinBrowserTools(builtinBrowser),
      ...createExternalBrowserTools(externalBridge),
      ...createComputerUseTools(computerUse),
      ...createSkillsTools(skills),
      ...(options.extraTools ?? []),
    ];
  }

  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));

  const server = new Server({ name, version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const toolsResult: Tool[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    return { tools: toolsResult };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const tool = toolMap.get(toolName);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${toolName}`);
    }
    try {
      const result = await tool.handler(request.params.arguments ?? {});
      return toSdkCallToolResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure: UnifiedToolCallResult = {
        content: [{ type: 'text', text: `Tool ${toolName} failed: ${message}` }],
        isError: true,
      };
      if (error instanceof BuiltinBrowserError) {
        // Normalize builtin-browser failures into the CC-TOOL-4001 envelope so
        // callers can emit a `normalized_error` UnifiedStreamEvent directly.
        failure.structuredContent = { error: builtinBrowserNormalizedError(message) };
      }
      return toSdkCallToolResult(failure);
    }
  });

  return {
    name,
    version,
    underlyingServer: server,
    computerUse: computerUseInstance,
    listTools(): UnifiedToolDefinition[] {
      return [...tools];
    },
    getTool(toolName: string): UnifiedToolDefinition | undefined {
      return toolMap.get(toolName);
    },
    async connect(transport: Transport): Promise<void> {
      await server.connect(transport);
    },
    async connectStdio(): Promise<void> {
      await server.connect(new StdioServerTransport());
    },
  };
}

function toSdkCallToolResult(result: UnifiedToolCallResult): CallToolResult {
  const content: ContentBlock[] = result.content.map((item) =>
    item.type === 'image'
      ? ({ type: 'image', data: item.data, mimeType: item.mimeType } as ContentBlock)
      : ({ type: 'text', text: item.text } as ContentBlock),
  );
  const sdkResult: CallToolResult = { content };
  if (result.isError) {
    sdkResult.isError = true;
  }
  if (result.structuredContent) {
    sdkResult.structuredContent = result.structuredContent;
  }
  return sdkResult;
}

// ---------------------------------------------------------------------------
// registerIntoAppConfigs — idempotent mcpServers merge into app config JSONs
// ---------------------------------------------------------------------------

export interface McpServerConfigEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpAppConfigTarget {
  /** Absolute path of the app's MCP config JSON file. */
  path: string;
  /** Entry name under `mcpServers`. Default `crosscode`. */
  serverName?: string;
  /** Entry payload written under `mcpServers.<serverName>`. */
  serverEntry?: McpServerConfigEntry;
}

export interface McpAppConfigRegistrationResult {
  path: string;
  serverName: string;
  status: 'created' | 'updated' | 'unchanged';
  /** The entry that existed before this call, if any. */
  previousEntry?: unknown;
}

export const CROSSCODE_MCP_SERVER_NAME = 'crosscode';

/** Default stdio entry: `node <this package>/index.js --mcp-stdio`. */
export function defaultMcpServerEntry(): McpServerConfigEntry {
  return {
    command: 'node',
    args: [fileURLToPath(new URL('./index.js', import.meta.url)), '--mcp-stdio'],
  };
}

export interface RegisterIntoAppConfigsOptions {
  /** Default entry name for targets that do not override `serverName`. */
  serverName?: string;
  /** Default entry payload for targets that do not override `serverEntry`. */
  serverEntry?: McpServerConfigEntry;
}

/**
 * Merge the CrossCode unified MCP server into each app's MCP config JSON file
 * (`{ "mcpServers": { "<serverName>": entry } }`) idempotently:
 * - missing file or missing entry → created
 * - existing entry with identical content → unchanged (file not rewritten)
 * - existing entry with different content → updated in place
 * All unrelated keys in the config file are preserved.
 */
export async function registerIntoAppConfigs(
  targets: McpAppConfigTarget[],
  options: RegisterIntoAppConfigsOptions = {},
): Promise<McpAppConfigRegistrationResult[]> {
  const results: McpAppConfigRegistrationResult[] = [];
  for (const target of targets) {
    const serverName = target.serverName ?? options.serverName ?? CROSSCODE_MCP_SERVER_NAME;
    const serverEntry = target.serverEntry ?? options.serverEntry ?? defaultMcpServerEntry();

    let config: Record<string, unknown> = {};
    let raw: string | null = null;
    try {
      raw = await fs.readFile(target.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`MCP config ${target.path} does not contain a JSON object`);
      }
      config = parsed as Record<string, unknown>;
    }

    const existingServers = config.mcpServers;
    const mcpServers: Record<string, unknown> =
      existingServers && typeof existingServers === 'object' && !Array.isArray(existingServers)
        ? (existingServers as Record<string, unknown>)
        : {};

    const previousEntry = mcpServers[serverName];
    let status: McpAppConfigRegistrationResult['status'];
    if (previousEntry === undefined) {
      status = 'created';
    } else if (JSON.stringify(previousEntry) === JSON.stringify(serverEntry)) {
      status = 'unchanged';
    } else {
      status = 'updated';
    }

    if (status !== 'unchanged') {
      mcpServers[serverName] = serverEntry;
      config.mcpServers = mcpServers;
      await fs.mkdir(path.dirname(target.path), { recursive: true });
      await fs.writeFile(target.path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    }

    const result: McpAppConfigRegistrationResult = { path: target.path, serverName, status };
    if (previousEntry !== undefined) {
      result.previousEntry = previousEntry;
    }
    results.push(result);
  }
  return results;
}
