import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorSelfHealBanner } from '../src/components/ErrorSelfHealBanner';
import { resetWorkbenchStore, useWorkbenchStore } from '../src/store/workbench';
import type { DaemonApiClient, ProviderCatalogEntry } from '../src/api/client';
import type { NormalizedAgentError, RecoveryAction } from '@crosscode/shared';

function makeError(recoveryAction: RecoveryAction, overrides: Partial<NormalizedAgentError> = {}): NormalizedAgentError {
  return {
    code: 'CC-QUOTA-2002',
    category: 'QUOTA',
    harness: 'deepseek-harness',
    rawMessage: 'Error 429: insufficient_quota — plan/billing exceeded (deepseek-chat).',
    userTitle: 'DeepSeek 额度已耗尽，建议切换备用 Provider 继续',
    recoveryAction,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const PROVIDERS: ProviderCatalogEntry[] = [
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', models: [] },
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', models: [] },
];

function seedProject(providerId: string, harness: NormalizedAgentError['harness'] = 'deepseek-harness'): void {
  useWorkbenchStore.getState().setProjects([
    {
      id: 'p1',
      name: 'demo',
      path: 'F:\\demo',
      discoveredFrom: ['crosscode-native'],
      activeHarness: harness,
      activeProviderId: providerId,
      activeModelId: 'deepseek-chat',
      hasAgentDir: true,
      lastActiveAt: new Date().toISOString(),
    },
  ]);
  useWorkbenchStore.getState().setActiveProject('p1');
}

beforeEach(() => {
  resetWorkbenchStore();
  const store = useWorkbenchStore.getState();
  store.setProviders(PROVIDERS);
  seedProject('deepseek');
});

afterEach(() => {
  cleanup();
  useWorkbenchStore.getState().setApiClient(null);
  useWorkbenchStore.getState().setTransport(null);
});

const RECOVERY_LABELS: ReadonlyArray<[RecoveryAction, RegExp]> = [
  ['SWITCH_PROVIDER', /切换备用 Provider/],
  ['SWITCH_HARNESS', /切换 Harness/],
  ['COMPACT_CONTEXT', /压缩上下文/],
  ['RETRY_BACKOFF', /退避重试/],
  ['AWAIT_APPROVAL', /查看待审批/],
  ['RESTART_PROCESS', /重启进程/],
];

describe('ErrorSelfHealBanner', () => {
  it('renders nothing without errors', () => {
    render(<ErrorSelfHealBanner />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(RECOVERY_LABELS)('renders the mapped recovery button for %s', (recoveryAction) => {
    useWorkbenchStore.getState().pushNormalizedError(makeError(recoveryAction));
    render(<ErrorSelfHealBanner />);
    const [, label] = RECOVERY_LABELS.find(([action]) => action === recoveryAction)!;
    expect(screen.getByRole('button', { name: label })).toBeTruthy();
  });

  it('shows the CC badge, Chinese user title and collapsible raw message', () => {
    useWorkbenchStore.getState().pushNormalizedError(makeError('SWITCH_PROVIDER'));
    render(<ErrorSelfHealBanner />);
    expect(screen.getByText('CC-QUOTA-2002')).toBeTruthy();
    expect(screen.getByText('DeepSeek 额度已耗尽，建议切换备用 Provider 继续')).toBeTruthy();
    expect(screen.getByText('原始报错')).toBeTruthy();
  });

  it('SWITCH_PROVIDER switches to the next provider in the catalog and dismisses', async () => {
    const switchCalls: string[] = [];
    const fakeApi = {
      switchProvider: async (_projectId: string, providerId: string) => {
        switchCalls.push(providerId);
        return { ok: true };
      },
      switchHarness: async () => ({ ok: true }),
      getDiff: async () => {
        throw new Error('not used');
      },
      acceptDiff: async () => ({ ok: true, accepted: [] }),
      discardDiff: async () => ({ ok: true, discarded: [] }),
      putSkill: async () => ({ skills: {}, updatedAt: '' }),
    } as unknown as DaemonApiClient;
    useWorkbenchStore.getState().setApiClient(fakeApi);

    useWorkbenchStore.getState().pushNormalizedError(makeError('SWITCH_PROVIDER', { providerId: 'deepseek' }));
    render(<ErrorSelfHealBanner />);

    await userEvent.click(screen.getByRole('button', { name: /切换备用 Provider/ }));

    expect(switchCalls).toEqual(['openai']);
    expect(useWorkbenchStore.getState().projects[0]?.activeProviderId).toBe('openai');
    expect(useWorkbenchStore.getState().errors).toHaveLength(0);
  });

  it('RETRY_BACKOFF resends the last prompt', async () => {
    const store = useWorkbenchStore.getState();
    store.sendPrompt('修复失败的测试');
    store.pushNormalizedError(makeError('RETRY_BACKOFF'));

    render(<ErrorSelfHealBanner />);
    await userEvent.click(screen.getByRole('button', { name: /退避重试/ }));

    const prompts = useWorkbenchStore.getState().timeline.filter((item) => item.kind === 'user_prompt');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatchObject({ kind: 'user_prompt', text: '修复失败的测试' });
    expect(useWorkbenchStore.getState().errors).toHaveLength(0);
  });

  it('COMPACT_CONTEXT sends the /compact prompt', async () => {
    useWorkbenchStore.getState().pushNormalizedError(makeError('COMPACT_CONTEXT'));
    render(<ErrorSelfHealBanner />);
    await userEvent.click(screen.getByRole('button', { name: /压缩上下文/ }));
    const last = useWorkbenchStore.getState().timeline.at(-1);
    expect(last).toMatchObject({ kind: 'user_prompt' });
    expect((last as { text: string }).text).toContain('/compact');
  });

  it('SWITCH_HARNESS cycles to the next harness', async () => {
    seedProject('deepseek', 'crosscode-native');
    useWorkbenchStore.getState().pushNormalizedError(makeError('SWITCH_HARNESS'));
    render(<ErrorSelfHealBanner />);
    await userEvent.click(screen.getByRole('button', { name: /切换 Harness/ }));
    expect(useWorkbenchStore.getState().projects[0]?.activeHarness).toBe('opencode');
  });

  it('RESTART_PROCESS restarts the session transport', async () => {
    let restarts = 0;
    useWorkbenchStore.getState().setTransport({
      sendPrompt: () => undefined,
      switchProvider: () => undefined,
      respondApproval: () => undefined,
      restart: () => {
        restarts += 1;
      },
    });
    useWorkbenchStore.getState().pushNormalizedError(makeError('RESTART_PROCESS'));
    render(<ErrorSelfHealBanner />);
    await userEvent.click(screen.getByRole('button', { name: /重启进程/ }));
    expect(restarts).toBe(1);
  });

  it('AWAIT_APPROVAL focuses the stream and reports the pending count', async () => {
    const store = useWorkbenchStore.getState();
    store.addApproval({
      approvalId: 'apr_x',
      sessionId: 's',
      callId: 'c',
      toolName: 'browser_click',
      args: {},
      createdAt: new Date().toISOString(),
    });
    store.pushNormalizedError(makeError('AWAIT_APPROVAL'));

    render(<ErrorSelfHealBanner />);
    expect(screen.getByText('1 个待审批')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /查看待审批/ }));
    expect(useWorkbenchStore.getState().mobilePane).toBe('stream');
  });

  it('dismiss button drops the active error', async () => {
    useWorkbenchStore.getState().pushNormalizedError(makeError('SWITCH_PROVIDER'));
    render(<ErrorSelfHealBanner />);
    await userEvent.click(screen.getByRole('button', { name: '忽略此错误' }));
    expect(useWorkbenchStore.getState().errors).toHaveLength(0);
  });
});
