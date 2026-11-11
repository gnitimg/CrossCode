import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { HarnessId, UnifiedStreamEvent } from '@crosscode/shared';
import {
  ClaudeCodeAdapter,
  CodexAdapter,
  CrossCodeNativeHarness,
  DeepSeekAdapter,
  OpenAICompatibleClient,
  OpenCodeAdapter,
  QoderAdapter,
  ZCodeAdapter,
  ensureAgentWorkspace,
  globToRegExp,
  readAgentWorkspaceContext,
  updateActiveTask,
  type FetchLike,
  type HarnessChildProcess,
  type LLMClient,
  type LLMResponse,
} from '../src/index.js';

interface SpawnScript {
  stdoutLines?: string[];
  stderrText?: string;
  exitCode?: number;
}

interface SpawnCapture {
  commands: string[];
  allArgs: string[][];
}

function createFakeProcess(): HarnessChildProcess {
  const proc = new EventEmitter() as unknown as HarnessChildProcess;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = null;
  proc.exitCode = null;
  proc.kill = () => true;
  return proc;
}

function makeFakeSpawn(script: SpawnScript, capture?: SpawnCapture) {
  return (
    command: string,
    args: readonly string[],
    _options?: { cwd?: string },
  ): HarnessChildProcess => {
    if (capture) {
      capture.commands.push(command);
      capture.allArgs.push([...args]);
    }
    const proc = createFakeProcess();
    setImmediate(() => {
      for (const line of script.stdoutLines ?? []) {
        proc.stdout!.emit('data', Buffer.from(`${line}\n`, 'utf8'));
      }
      if (script.stderrText !== undefined) {
        proc.stderr!.emit('data', Buffer.from(script.stderrText, 'utf8'));
      }
      proc.exitCode = script.exitCode ?? 0;
      proc.emit('exit', proc.exitCode, null);
    });
    return proc;
  };
}

function collectEvents(
  source: { subscribe(listener: (event: UnifiedStreamEvent) => void): () => void },
): UnifiedStreamEvent[] {
  const events: UnifiedStreamEvent[] = [];
  source.subscribe((event) => events.push(event));
  return events;
}

function eventsOfType<T extends UnifiedStreamEvent['type']>(
  events: UnifiedStreamEvent[],
  type: T,
): Extract<UnifiedStreamEvent, { type: T }>[] {
  return events.filter(
    (event): event is Extract<UnifiedStreamEvent, { type: T }> => event.type === type,
  );
}

function scriptedLLM(responses: LLMResponse[]): {
  client: LLMClient;
  requests: { messages: Array<{ role: string; content?: string }>; tools: string[] }[];
} {
  const requests: { messages: Array<{ role: string; content?: string }>; tools: string[] }[] = [];
  let index = 0;
  const client: LLMClient = {
    complete: async (messages, tools) => {
      requests.push({
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        tools: tools.map((t) => t.name),
      });
      const next = responses[index];
      index += 1;
      if (!next) throw new Error('Scripted LLM has no more responses');
      return next;
    },
  };
  return { client, requests };
}

describe('Task 6: Harness Adapters & CrossCodeNativeHarness', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'crosscode-harness-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  describe('CLI argument assembly', () => {
    it('assembles correct command and CLI args for all six external adapters', () => {
      const dummyProject = path.join(tempRoot, 'unused-project');

      const opencode = new OpenCodeAdapter({ projectPath: dummyProject });
      expect(opencode.getCommand()).toBe('opencode');
      expect(opencode.buildCliArgs('Fix the bug')).toEqual([
        'run',
        '--format',
        'json',
        'Fix the bug',
      ]);

      const claudePlain = new ClaudeCodeAdapter({ projectPath: dummyProject });
      expect(claudePlain.getCommand()).toBe('claude');
      expect(claudePlain.buildCliArgs('Fix the bug')).toEqual([
        '-p',
        'Fix the bug',
        '--output-format',
        'stream-json',
        '--verbose',
      ]);
      expect(claudePlain.buildCliArgs('Fix the bug')).not.toContain('--mcp-config');

      const mcpConfigPath = path.join('mcp-configs', 'servers.json');
      const claudeWithMcp = new ClaudeCodeAdapter({
        projectPath: dummyProject,
        model: 'claude-sonnet-4-5',
        mcpConfigPath,
      });
      expect(claudeWithMcp.buildCliArgs('Fix the bug')).toEqual([
        '-p',
        'Fix the bug',
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        'claude-sonnet-4-5',
        '--mcp-config',
        mcpConfigPath,
      ]);

      const codex = new CodexAdapter({ projectPath: dummyProject });
      expect(codex.getCommand()).toBe('codex');
      expect(codex.buildCliArgs('Fix the bug')).toEqual(['exec', '--json', 'Fix the bug']);
      const codexWithModel = new CodexAdapter({
        projectPath: dummyProject,
        model: 'gpt-5-codex',
      });
      expect(codexWithModel.buildCliArgs('Fix the bug')).toEqual([
        'exec',
        '--json',
        '--model',
        'gpt-5-codex',
        'Fix the bug',
      ]);

      const qoder = new QoderAdapter({ projectPath: dummyProject });
      expect(qoder.getCommand()).toBe('qoder');
      expect(qoder.buildCliArgs('Do the task')).toEqual(['run', '--stream', 'Do the task']);

      const zcode = new ZCodeAdapter({ projectPath: dummyProject });
      expect(zcode.getCommand()).toBe('zcode');
      expect(zcode.buildCliArgs('Do the task')).toEqual(['--print', 'Do the task']);

      const deepseek = new DeepSeekAdapter({ projectPath: dummyProject });
      expect(deepseek.getCommand()).toBe('deepseek');
      expect(deepseek.buildCliArgs('Do the task')).toEqual([
        'run',
        '--non-interactive',
        'Do the task',
      ]);
    });
  });

  describe('external harness stdout stream parsing', () => {
    it('claude-code stream-json lines produce thinking/text/tool events', async () => {
      const project = path.join(tempRoot, 'claude-app');
      await fs.mkdir(project, { recursive: true });

      const adapter = new ClaudeCodeAdapter({
        projectPath: project,
        spawn: makeFakeSpawn({
          stdoutLines: [
            JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-sess' }),
            JSON.stringify({
              type: 'assistant',
              message: {
                content: [
                  { type: 'thinking', thinking: 'Checking the config file' },
                  { type: 'text', text: 'Let me read the config' },
                  { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'config.json' } },
                ],
              },
            }),
            JSON.stringify({
              type: 'user',
              message: {
                content: [
                  { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file-contents-here' },
                ],
              },
            }),
            JSON.stringify({ type: 'result', subtype: 'success', result: 'Config read successfully' }),
          ],
        }),
      });
      const events = collectEvents(adapter);
      await adapter.start('inspect the project config');

      expect(events).toHaveLength(5);
      expect(events.map((e) => e.type)).toEqual([
        'thinking_delta',
        'text_delta',
        'tool_call_start',
        'tool_call_result',
        'text_delta',
      ]);

      const [thinking, text1, toolStart, toolResult, text2] = events as [
        Extract<UnifiedStreamEvent, { type: 'thinking_delta' }>,
        Extract<UnifiedStreamEvent, { type: 'text_delta' }>,
        Extract<UnifiedStreamEvent, { type: 'tool_call_start' }>,
        Extract<UnifiedStreamEvent, { type: 'tool_call_result' }>,
        Extract<UnifiedStreamEvent, { type: 'text_delta' }>,
      ];

      expect(thinking.text).toBe('Checking the config file');
      expect(text1.text).toBe('Let me read the config');
      expect(toolStart.callId).toBe('toolu_1');
      expect(toolStart.toolName).toBe('read_file');
      expect(toolStart.args).toEqual({ path: 'config.json' });
      expect(toolStart.requiresApproval).toBe(false);
      expect(toolResult.callId).toBe('toolu_1');
      expect(toolResult.toolName).toBe('read_file');
      expect(toolResult.output).toBe('file-contents-here');
      expect(text2.text).toBe('Config read successfully');

      for (const event of events) {
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          expect(event.harness).toBe('claude-code');
        }
      }
    });

    it('opencode JSON lines produce text/tool events and fall back to cleaned plain text', async () => {
      const project = path.join(tempRoot, 'opencode-app');
      await fs.mkdir(project, { recursive: true });

      const adapter = new OpenCodeAdapter({
        projectPath: project,
        spawn: makeFakeSpawn({
          stdoutLines: [
            JSON.stringify({ type: 'step-start' }),
            JSON.stringify({ type: 'text', text: 'hello from opencode' }),
            JSON.stringify({
              type: 'tool-call',
              callID: 'call_9',
              tool: 'bash',
              state: { input: { command: 'ls -la' } },
            }),
            JSON.stringify({ type: 'tool-result', callID: 'call_9', tool: 'bash', output: 'total 0' }),
            `plain fallback with ${'\u001B[31m'}red${'\u001B[0m'}`,
          ],
        }),
      });
      const events = collectEvents(adapter);
      await adapter.start('list the files');

      const textEvents = eventsOfType(events, 'text_delta');
      const starts = eventsOfType(events, 'tool_call_start');
      const results = eventsOfType(events, 'tool_call_result');

      expect(textEvents.map((e) => e.text)).toEqual([
        'hello from opencode',
        'plain fallback with red',
      ]);
      expect(starts).toHaveLength(1);
      expect(starts[0].callId).toBe('call_9');
      expect(starts[0].toolName).toBe('bash');
      expect(starts[0].args).toEqual({ command: 'ls -la' });
      expect(results).toHaveLength(1);
      expect(results[0].callId).toBe('call_9');
      expect(results[0].output).toBe('total 0');
      for (const event of textEvents) expect(event.harness).toBe('opencode');
    });

    it('codex --json item events produce tool and text events', async () => {
      const project = path.join(tempRoot, 'codex-app');
      await fs.mkdir(project, { recursive: true });

      const adapter = new CodexAdapter({
        projectPath: project,
        spawn: makeFakeSpawn({
          stdoutLines: [
            JSON.stringify({
              type: 'item.started',
              item: { type: 'command_execution', id: 'cmd_1', command: 'git status' },
            }),
            JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking about repo state' } }),
            JSON.stringify({
              type: 'item.completed',
              item: {
                type: 'command_execution',
                id: 'cmd_1',
                command: 'git status',
                aggregated_output: 'nothing to commit',
                exit_code: 0,
              },
            }),
            JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Repo is clean' } }),
          ],
        }),
      });
      const events = collectEvents(adapter);
      await adapter.start('check repository state');

      expect(events.map((e) => e.type)).toEqual([
        'tool_call_start',
        'thinking_delta',
        'tool_call_result',
        'text_delta',
      ]);

      const starts = eventsOfType(events, 'tool_call_start');
      const results = eventsOfType(events, 'tool_call_result');
      expect(starts[0].callId).toBe('cmd_1');
      expect(starts[0].toolName).toBe('shell');
      expect(starts[0].args).toEqual({ command: 'git status' });
      expect(results[0].callId).toBe('cmd_1');
      expect(results[0].output).toBe('nothing to commit');
      expect(eventsOfType(events, 'thinking_delta')[0].text).toBe('thinking about repo state');
      expect(eventsOfType(events, 'text_delta')[0].text).toBe('Repo is clean');
    });

    it('qoder / zcode / deepseek interactive lines are cleaned of ANSI and noise', async () => {
      const cases: Array<{ id: HarnessId; make: (projectPath: string) => { subscribe: (listener: (event: UnifiedStreamEvent) => void) => () => void; start: (prompt: string) => Promise<void> } }> = [
        {
          id: 'qoder',
          make: (projectPath) => new QoderAdapter({ projectPath, spawn: makeFakeSpawn({ stdoutLines: NOISY_LINES }) }),
        },
        {
          id: 'zcode',
          make: (projectPath) => new ZCodeAdapter({ projectPath, spawn: makeFakeSpawn({ stdoutLines: NOISY_LINES }) }),
        },
        {
          id: 'deepseek-harness',
          make: (projectPath) => new DeepSeekAdapter({ projectPath, spawn: makeFakeSpawn({ stdoutLines: NOISY_LINES }) }),
        },
      ];

      for (const entry of cases) {
        const project = path.join(tempRoot, `noise-${entry.id}`);
        await fs.mkdir(project, { recursive: true });
        const adapter = entry.make(project);
        const events = collectEvents(adapter);
        await adapter.start('do something');

        const textEvents = eventsOfType(events, 'text_delta');
        expect(textEvents.map((e) => e.text), `harness ${entry.id}`).toEqual([
          '\u25B8 Scanning project',
          '\u2714 Connected to provider',
          'engine started',
          'WARN: deprecated flag used',
          'ERROR: provider timeout',
          'Here is the final answer: 42',
        ]);
        for (const event of textEvents) expect(event.harness).toBe(entry.id);
      }
    });
  });

  describe('stderr normalization and workspace logging', () => {
    it('normalizes non-zero exit stderr into CC-QUOTA-2002 and persists it to the .agent workspace', async () => {
      const project = path.join(tempRoot, 'quota-app');
      await fs.mkdir(project, { recursive: true });

      const adapter = new OpenCodeAdapter({
        projectPath: project,
        spawn: makeFakeSpawn({
          stderrText: 'insufficient_quota: credit balance is too low',
          exitCode: 1,
        }),
      });
      const events = collectEvents(adapter);
      await adapter.start('try to run the task');

      const errorEvents = eventsOfType(events, 'normalized_error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].error.code).toBe('CC-QUOTA-2002');
      expect(errorEvents[0].error.category).toBe('QUOTA');
      expect(errorEvents[0].error.recoveryAction).toBe('SWITCH_PROVIDER');
      expect(errorEvents[0].error.harness).toBe('opencode');
      expect(errorEvents[0].error.rawMessage).toContain('credit balance is too low');

      const context = await readAgentWorkspaceContext(project);
      expect(context.errorLogs).toHaveLength(1);
      expect(context.errorLogs[0].code).toBe('CC-QUOTA-2002');
      expect(context.activeTask.status).toBe('in_progress');
    });
  });

  describe('CrossCodeNativeHarness', () => {
    it('registers built-in tools and gates dispatch_to_external_harness by mode', () => {
      const { client } = scriptedLLM([]);
      const base = { projectPath: path.join(tempRoot, 'gating'), llmClient: client };

      const plan = new CrossCodeNativeHarness({ ...base, mode: 'plan' });
      expect(plan.getMode()).toBe('plan');
      expect(plan.getToolNames()).toEqual(
        expect.arrayContaining(['read_file', 'glob_search', 'grep_search', 'git_status_diff']),
      );
      expect(plan.getToolNames()).not.toContain('write_file');
      expect(plan.getToolNames()).not.toContain('dispatch_to_external_harness');

      plan.setMode('orchestrate');
      expect(plan.getMode()).toBe('orchestrate');
      expect(plan.getToolNames()).toContain('dispatch_to_external_harness');

      const build = new CrossCodeNativeHarness({ ...base, mode: 'build' });
      expect(build.getToolNames()).toEqual(
        expect.arrayContaining(['read_file', 'write_file', 'edit_file', 'run_shell', 'git_status_diff']),
      );
      expect(build.getToolNames()).not.toContain('dispatch_to_external_harness');
    });

    it('runs a ReAct loop with real file tools: write_file then read_file then final text', async () => {
      const project = path.join(tempRoot, 'native-react');
      await fs.mkdir(project, { recursive: true });

      const { client, requests } = scriptedLLM([
        {
          toolCalls: [
            { id: 'call-write', name: 'write_file', arguments: { path: 'out/result.txt', content: 'NATIVE-WROTE' } },
          ],
        },
        { toolCalls: [{ id: 'call-read', name: 'read_file', arguments: { path: 'out/result.txt' } }] },
        { text: 'Wrote and verified NATIVE-WROTE.' },
      ]);

      const harness = new CrossCodeNativeHarness({
        projectPath: project,
        mode: 'build',
        llmClient: client,
        maxSteps: 5,
      });
      const events = collectEvents(harness);
      await harness.start('Write the result file and read it back');

      expect(events.map((e) => e.type)).toEqual([
        'tool_call_start',
        'tool_call_result',
        'tool_call_start',
        'tool_call_result',
        'text_delta',
      ]);

      const starts = eventsOfType(events, 'tool_call_start');
      const results = eventsOfType(events, 'tool_call_result');
      const text = eventsOfType(events, 'text_delta');

      expect(starts[0]).toMatchObject({ toolName: 'write_file', callId: 'call-write' });
      expect(results[0].output).toContain('out/result.txt');
      expect(starts[1]).toMatchObject({ toolName: 'read_file', callId: 'call-read' });
      expect(results[1].output).toBe('NATIVE-WROTE');
      expect(text[0].text).toBe('Wrote and verified NATIVE-WROTE.');
      for (const event of events) {
        if (event.type === 'text_delta') expect(event.harness).toBe('crosscode-native');
      }

      const written = await fs.readFile(path.join(project, 'out', 'result.txt'), 'utf8');
      expect(written).toBe('NATIVE-WROTE');

      // ReAct loop fed tool results back to the LLM as tool messages
      const writeResultMessage = requests[1].messages.find(
        (m) => m.role === 'tool' && (m.content ?? '').includes('out/result.txt'),
      );
      expect(writeResultMessage).toBeDefined();
      const readResultMessage = requests[2].messages.find((m) => m.role === 'tool' && m.content === 'NATIVE-WROTE');
      expect(readResultMessage).toBeDefined();

      const context = await readAgentWorkspaceContext(project);
      expect(context.activeTask.status).toBe('completed');
      expect(context.activeTask.currentHarness).toBe('crosscode-native');
      expect(context.activeTask.completedSteps).toEqual(
        expect.arrayContaining(['Ran write_file', 'Ran read_file']),
      );
    });

    it('executes glob_search and grep_search over the real project tree', async () => {
      const project = path.join(tempRoot, 'native-search');
      await fs.mkdir(path.join(project, 'src', 'sub'), { recursive: true });
      await fs.mkdir(path.join(project, 'docs'), { recursive: true });
      await fs.writeFile(path.join(project, 'src', 'a.ts'), '// TODO: fix this later\nexport const a = 1;\n', 'utf8');
      await fs.writeFile(path.join(project, 'src', 'sub', 'b.ts'), 'export const b = 2;\n', 'utf8');
      await fs.writeFile(path.join(project, 'docs', 'readme.md'), '# docs\n', 'utf8');

      const { client } = scriptedLLM([
        { toolCalls: [{ id: 'g1', name: 'glob_search', arguments: { pattern: '**/*.ts' } }] },
        { toolCalls: [{ id: 'g2', name: 'grep_search', arguments: { query: 'TODO' } }] },
        { text: 'Found the TODO.' },
      ]);

      const harness = new CrossCodeNativeHarness({
        projectPath: project,
        mode: 'build',
        llmClient: client,
      });
      const events = collectEvents(harness);
      await harness.start('Find TODOs');

      const results = eventsOfType(events, 'tool_call_result');
      expect(results[0].isError).toBe(false);
      expect(results[0].output).toContain('src/a.ts');
      expect(results[0].output).toContain('src/sub/b.ts');
      expect(results[0].output).not.toContain('docs/readme.md');
      expect(results[1].output).toContain('src/a.ts:1');
      expect(results[1].output).toContain('// TODO: fix this later');
    });

    it('edit_file replaces content in place', async () => {
      const project = path.join(tempRoot, 'native-edit');
      await fs.mkdir(project, { recursive: true });
      await fs.writeFile(path.join(project, 'notes.txt'), 'alpha beta gamma', 'utf8');

      const { client } = scriptedLLM([
        {
          toolCalls: [
            { id: 'e1', name: 'edit_file', arguments: { path: 'notes.txt', oldString: 'beta', newString: 'delta' } },
          ],
        },
        { text: 'Edited the notes.' },
      ]);

      const harness = new CrossCodeNativeHarness({
        projectPath: project,
        mode: 'build',
        llmClient: client,
      });
      const events = collectEvents(harness);
      await harness.start('Update the notes');

      const results = eventsOfType(events, 'tool_call_result');
      expect(results[0].isError).toBe(false);
      expect(results[0].output).toContain('replaced 1 occurrence');
      expect(await fs.readFile(path.join(project, 'notes.txt'), 'utf8')).toBe('alpha delta gamma');
    });

    it('flags run_shell for approval and blocks catastrophic commands', async () => {
      const project = path.join(tempRoot, 'native-shell-guard');
      await fs.mkdir(project, { recursive: true });

      const { client } = scriptedLLM([
        { toolCalls: [{ id: 's1', name: 'run_shell', arguments: { command: 'rm -rf /' } }] },
        { toolCalls: [{ id: 's2', name: 'run_shell', arguments: { command: 'format C:' } }] },
        { toolCalls: [{ id: 's3', name: 'run_shell', arguments: { command: 'del /s /q C:\\Windows\\Temp' } }] },
        { toolCalls: [{ id: 's4', name: 'run_shell', arguments: { command: 'echo crosscode-safe' } }] },
        { text: 'Shell guard check done.' },
      ]);

      const harness = new CrossCodeNativeHarness({
        projectPath: project,
        mode: 'build',
        llmClient: client,
      });
      const events = collectEvents(harness);
      await harness.start('Run shell commands');

      const starts = eventsOfType(events, 'tool_call_start');
      expect(starts).toHaveLength(4);
      for (const start of starts) {
        expect(start.toolName).toBe('run_shell');
        expect(start.requiresApproval).toBe(true);
      }

      const results = eventsOfType(events, 'tool_call_result');
      expect(results[0].isError).toBe(true);
      expect(results[0].output).toContain('shell guard');
      expect(results[1].isError).toBe(true);
      expect(results[1].output).toContain('shell guard');
      expect(results[2].isError).toBe(true);
      expect(results[2].output).toContain('shell guard');
      expect(results[3].isError).toBe(false);
      expect(results[3].output).toContain('crosscode-safe');
    });

    it('enforceApprovalGate blocks run_shell until resolveToolApproval(callId, true/false) or abort()', async () => {
      const project = path.join(tempRoot, 'native-approval-gate');
      await fs.mkdir(project, { recursive: true });
      const approvedMarker = path.join(project, 'approved-marker.txt');
      const rejectedMarker = path.join(project, 'rejected-marker.txt');

      const { client } = scriptedLLM([
        {
          toolCalls: [
            {
              id: 'call-approve-1',
              name: 'run_shell',
              arguments: { command: 'node -e "require(\'fs\').writeFileSync(\'approved-marker.txt\', \'ok\')"' },
            },
          ],
        },
        {
          toolCalls: [
            {
              id: 'call-reject-2',
              name: 'run_shell',
              arguments: { command: 'node -e "require(\'fs\').writeFileSync(\'rejected-marker.txt\', \'bad\')"' },
            },
          ],
        },
        { text: 'Approval loop finished.' },
      ]);

      const harness = new CrossCodeNativeHarness({
        projectPath: project,
        mode: 'build',
        llmClient: client,
        enforceApprovalGate: true,
      });
      const events = collectEvents(harness);

      const runPromise = harness.start('Test blocking approval gate');

      // Wait until the first run_shell call is pending approval
      const waitUntilPending = async (expectedCallId: string): Promise<void> => {
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          const pending = harness.listPendingToolApprovals();
          if (pending.some((p) => p.callId === expectedCallId)) return;
          await new Promise((r) => setTimeout(r, 15));
        }
        throw new Error(`Timed out waiting for pending tool approval ${expectedCallId}`);
      };

      await waitUntilPending('call-approve-1');
      // Command must NOT have executed before approval
      await expect(fs.access(approvedMarker)).rejects.toThrow();
      expect(eventsOfType(events, 'tool_call_result')).toHaveLength(0);

      // Approve the first call -> it executes and creates approved-marker.txt
      expect(harness.resolveToolApproval('call-approve-1', true)).toBe(true);

      // Wait until the second run_shell call is pending approval
      await waitUntilPending('call-reject-2');
      expect(await fs.readFile(approvedMarker, 'utf8')).toBe('ok');
      await expect(fs.access(rejectedMarker)).rejects.toThrow();

      // Reject the second call -> it must NOT execute, and emits CC-TOOL-4002 error result
      expect(harness.resolveToolApproval('call-reject-2', false)).toBe(true);

      await runPromise;

      await expect(fs.access(rejectedMarker)).rejects.toThrow();
      const results = eventsOfType(events, 'tool_call_result');
      expect(results).toHaveLength(2);
      expect(results[0].callId).toBe('call-approve-1');
      expect(results[0].isError).toBe(false);
      expect(results[1].callId).toBe('call-reject-2');
      expect(results[1].isError).toBe(true);
      expect(results[1].output).toContain('CC-TOOL-4002');

      const workspace = await readAgentWorkspaceContext(project);
      expect(workspace.errorLogs.some((e) => e.code === 'CC-TOOL-4002')).toBe(true);
    });

    it('refuses file tools that escape the project root through a symlink/junction', async () => {
      const project = path.join(tempRoot, 'native-symlink');
      await fs.mkdir(path.join(project, 'real'), { recursive: true });
      const outside = path.join(tempRoot, 'outside-secret');
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret', 'utf8');

      const linkPath = path.join(project, 'real', 'escape');
      try {
        // 'junction' works on Windows without elevated privileges; on POSIX
        // the type argument is ignored and a regular symlink is created.
        await fs.symlink(outside, linkPath, 'junction');
      } catch {
        // Environment without symlink support: skip this scenario.
        return;
      }

      const { client } = scriptedLLM([
        {
          toolCalls: [{ id: 'lk1', name: 'read_file', arguments: { path: 'real/escape/secret.txt' } }],
        },
        { text: 'done' },
      ]);
      const harness = new CrossCodeNativeHarness({
        projectPath: project,
        mode: 'build',
        llmClient: client,
      });
      const events = collectEvents(harness);
      await harness.start('Try to read through a symlink');

      const results = eventsOfType(events, 'tool_call_result');
      expect(results[0].isError).toBe(true);
      expect(results[0].output).toContain('symlink');
      expect(results[0].output).not.toContain('top secret');
    });

    it('orchestrate mode forwards dispatch_to_external_harness events from the external adapter', async () => {
      const project = path.join(tempRoot, 'native-orchestrate');
      await fs.mkdir(project, { recursive: true });

      const opencodeAdapter = new OpenCodeAdapter({
        projectPath: project,
        spawn: makeFakeSpawn({
          stdoutLines: [JSON.stringify({ type: 'text', text: 'subtask output from opencode' })],
        }),
      });

      const { client } = scriptedLLM([
        {
          toolCalls: [
            {
              id: 'd1',
              name: 'dispatch_to_external_harness',
              arguments: { harness: 'opencode', task: 'Run the subtask' },
            },
          ],
        },
        { text: 'orchestration finished' },
      ]);

      const harness = new CrossCodeNativeHarness({
        projectPath: project,
        mode: 'orchestrate',
        llmClient: client,
        externalAdapters: { opencode: opencodeAdapter },
      });
      const events = collectEvents(harness);
      await harness.start('orchestrate the subtask');

      const starts = eventsOfType(events, 'tool_call_start');
      expect(starts[0].toolName).toBe('dispatch_to_external_harness');
      expect(starts[0].args).toEqual({ harness: 'opencode', task: 'Run the subtask' });

      const forwarded = eventsOfType(events, 'text_delta').find(
        (e) => e.harness === 'opencode' && e.text === 'subtask output from opencode',
      );
      expect(forwarded).toBeDefined();

      const dispatchResult = eventsOfType(events, 'tool_call_result');
      expect(dispatchResult[0].isError).toBe(false);
      expect(dispatchResult[0].output).toContain('subtask output from opencode');

      const finalText = eventsOfType(events, 'text_delta').find(
        (e) => e.harness === 'crosscode-native' && e.text === 'orchestration finished',
      );
      expect(finalText).toBeDefined();

      // The dispatch snapshot/restore keeps the orchestrating task intact:
      // the external adapter's own task-state writes must not leak in.
      const context = await readAgentWorkspaceContext(project);
      expect(context.activeTask.currentHarness).toBe('crosscode-native');
      expect(context.activeTask.status).toBe('completed');
      expect(context.activeTask.completedSteps).toContain('Ran dispatch_to_external_harness');
    });
  });

  describe('adapter session robustness', () => {
    it('recovers from a synchronous spawn failure without leaking session state', async () => {
      const project = path.join(tempRoot, 'spawn-fail');
      await fs.mkdir(project, { recursive: true });

      const adapter = new OpenCodeAdapter({
        projectPath: project,
        spawn: () => {
          throw new Error('boom: spawn not available');
        },
      });
      const events = collectEvents(adapter);

      await expect(adapter.start('first attempt')).resolves.toBeUndefined();
      const errors = eventsOfType(events, 'normalized_error');
      expect(errors).toHaveLength(1);
      expect(errors[0].error.code).toBe('CC-PROC-5001');
      expect(adapter.isRunning()).toBe(false);

      // The failed startup reset the session flags, so a second start is
      // accepted (it fails the same way instead of throwing 'already running').
      await expect(adapter.start('second attempt')).resolves.toBeUndefined();
      expect(eventsOfType(events, 'normalized_error')).toHaveLength(2);
      expect(adapter.isRunning()).toBe(false);
    });
  });

  describe('globToRegExp', () => {
    it('supports zero-segment globstar and segment-local wildcards', () => {
      expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true);
      expect(globToRegExp('src/**/*.ts').test('src/sub/b.ts')).toBe(true);
      expect(globToRegExp('src/**/*.ts').test('src/sub/deep/c.ts')).toBe(true);
      expect(globToRegExp('src/**/*.ts').test('docs/readme.md')).toBe(false);
      expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true);
      expect(globToRegExp('**/*.ts').test('x/y/a.ts')).toBe(true);
      expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
      expect(globToRegExp('src/*.ts').test('src/sub/b.ts')).toBe(false);
      expect(globToRegExp('src/**').test('src/sub/b.ts')).toBe(true);
      expect(globToRegExp('?.md').test('a.md')).toBe(true);
      expect(globToRegExp('?.md').test('ab.md')).toBe(false);
    });
  });

  describe('cross-harness context relay via .agent workspace', () => {
    it('claude-code quota failure is recorded, then opencode resumes the task context', async () => {
      const project = path.join(tempRoot, 'relay-app');
      await fs.mkdir(project, { recursive: true });
      await ensureAgentWorkspace(project, { activeHarness: 'claude-code' });
      await updateActiveTask(project, {
        taskId: 'TASK-101',
        title: 'Implement login flow',
        status: 'in_progress',
        currentHarness: 'claude-code',
        currentStep: 'design API',
        completedSteps: ['design API'],
        nextSteps: ['write auth middleware', 'add tests'],
      });

      const claudeCapture: SpawnCapture = { commands: [], allArgs: [] };
      const claudeAdapter = new ClaudeCodeAdapter({
        projectPath: project,
        spawn: makeFakeSpawn(
          { stderrText: 'insufficient_quota: credit balance is too low', exitCode: 1 },
          claudeCapture,
        ),
      });
      const claudeEvents = collectEvents(claudeAdapter);
      await claudeAdapter.start('continue implementing login flow');

      const claudeErrors = eventsOfType(claudeEvents, 'normalized_error');
      expect(claudeErrors).toHaveLength(1);
      expect(claudeErrors[0].error.code).toBe('CC-QUOTA-2002');
      expect(claudeErrors[0].error.recoveryAction).toBe('SWITCH_PROVIDER');
      expect(claudeErrors[0].error.harness).toBe('claude-code');

      const logRaw = await fs.readFile(path.join(project, '.agent', 'logs', 'agent-errors.jsonl'), 'utf8');
      expect(logRaw).toContain('CC-QUOTA-2002');

      const afterClaude = await readAgentWorkspaceContext(project);
      expect(afterClaude.activeTask.status).toBe('in_progress');
      expect(afterClaude.activeTask.currentHarness).toBe('claude-code');
      expect(afterClaude.activeTask.nextSteps).toEqual(['write auth middleware', 'add tests']);

      const opencodeCapture: SpawnCapture = { commands: [], allArgs: [] };
      const opencodeAdapter = new OpenCodeAdapter({
        projectPath: project,
        spawn: makeFakeSpawn(
          { stdoutLines: [JSON.stringify({ type: 'text', text: 'Resuming: write auth middleware' })] },
          opencodeCapture,
        ),
      });
      const opencodeEvents = collectEvents(opencodeAdapter);
      await opencodeAdapter.start('pick up where claude-code left off');

      // The opencode adapter loaded the persisted task context and relayed it into its CLI prompt.
      expect(opencodeAdapter.getWorkspaceContext()?.activeTask.taskId).toBe('TASK-101');
      const relayedPrompt = opencodeCapture.allArgs[0].join('\n');
      expect(relayedPrompt).toContain('TASK-101');
      expect(relayedPrompt).toContain('Implement login flow');
      expect(relayedPrompt).toContain('write auth middleware');
      expect(relayedPrompt).toContain('add tests');

      expect(eventsOfType(opencodeEvents, 'text_delta')[0].text).toBe('Resuming: write auth middleware');

      const afterOpencode = await readAgentWorkspaceContext(project);
      expect(afterOpencode.activeTask.currentHarness).toBe('opencode');
      expect(afterOpencode.activeTask.status).toBe('completed');
    });
  });

  describe('OpenAICompatibleClient', () => {
    it('maps messages/tools to the OpenAI chat protocol and parses tool calls back', async () => {
      const calls: Array<{ url: string; body?: string; headers?: Record<string, string> }> = [];
      const fetchFn: FetchLike = async (url, init) => {
        calls.push({
          url,
          body: init?.body,
          headers: init?.headers as Record<string, string> | undefined,
        });
        return {
          ok: true,
          status: 200,
          text: async () => '',
          json: async () => ({
            choices: [
              {
                message: {
                  content: 'partial answer',
                  reasoning_content: 'chain of thought',
                  tool_calls: [
                    {
                      id: 'tc_1',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
                    },
                    {
                      id: 'tc_2',
                      type: 'function',
                      function: { name: 'grep_search', arguments: 'not-json' },
                    },
                  ],
                },
              },
            ],
          }),
        };
      };

      const client = new OpenAICompatibleClient({
        baseURL: 'https://api.example.com/v1/',
        apiKey: 'sk-test',
        model: 'test-model',
        fetchFn,
      });

      const response = await client.complete(
        [
          { role: 'system', content: 'sys prompt' },
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'prev', name: 'read_file', arguments: { path: 'b.ts' } }],
          },
          { role: 'tool', toolCallId: 'prev', toolName: 'read_file', content: 'file body' },
        ],
        [
          {
            name: 'read_file',
            description: 'Read a file',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://api.example.com/v1/chat/completions');
      expect(calls[0].headers?.Authorization).toBe('Bearer sk-test');

      const body = JSON.parse(calls[0].body ?? '{}');
      expect(body.model).toBe('test-model');
      expect(body.messages[0]).toEqual({ role: 'system', content: 'sys prompt' });
      expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' });
      expect(body.messages[2].tool_calls[0].function).toEqual({
        name: 'read_file',
        arguments: '{"path":"b.ts"}',
      });
      expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'prev', content: 'file body' });
      expect(body.tools[0].function).toEqual({
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      });

      expect(response.text).toBe('partial answer');
      expect(response.thinking).toBe('chain of thought');
      expect(response.toolCalls).toEqual([
        { id: 'tc_1', name: 'read_file', arguments: { path: 'src/a.ts' } },
        { id: 'tc_2', name: 'grep_search', arguments: {} },
      ]);
    });

    it('omits tools when none are provided and throws a descriptive error on HTTP failure', async () => {
      const bodies: string[] = [];
      const okFetch: FetchLike = async (_url, init) => {
        bodies.push(init?.body ?? '');
        return { ok: true, status: 200, text: async () => '', json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
      };
      const client = new OpenAICompatibleClient({
        baseURL: 'https://api.example.com/v1',
        model: 'm1',
        fetchFn: okFetch,
      });

      await client.complete([{ role: 'user', content: 'hi' }], []);
      const body = JSON.parse(bodies[0]);
      expect(body.tools).toBeUndefined();

      const failing = new OpenAICompatibleClient({
        baseURL: 'https://api.example.com/v1',
        model: 'm1',
        fetchFn: async () => ({ ok: false, status: 503, text: async () => 'upstream down', json: async () => ({}) }),
      });
      await expect(failing.complete([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(/HTTP 503/);
    });
  });
});

const NOISY_LINES = [
  '\u001B[36m\u25B8 Scanning project\u001B[0m',
  '',
  'INFO: warming up caches',
  '\u001B[32m\u2714 Connected to provider\u001B[0m',
  '\u280B Loading model weights',
  '2026-11-12 10:00:00 engine started',
  'WARN: deprecated flag used',
  'ERROR: provider timeout',
  'Here is the final answer: 42',
];
