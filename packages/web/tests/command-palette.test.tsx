import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandPalette } from '../src/components/CommandPalette';
import { resetWorkbenchStore, useWorkbenchStore } from '../src/store/workbench';
import type { UnifiedProject } from '@crosscode/shared';

function project(id: string, name: string, harness: UnifiedProject['activeHarness']): UnifiedProject {
  return {
    id,
    name,
    path: `F:\\cs\\${id}`,
    discoveredFrom: ['crosscode-native'],
    activeHarness: harness,
    activeProviderId: 'deepseek',
    activeModelId: 'deepseek-chat',
    hasAgentDir: true,
    lastActiveAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  resetWorkbenchStore();
  const store = useWorkbenchStore.getState();
  store.setProjects([
    project('p1', 'CrossCode 主仓库', 'crosscode-native'),
    project('p2', '飞书审批机器人', 'claude-code'),
  ]);
  store.setProviders([
    { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', models: [] },
    { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', models: [] },
  ]);
  store.setActiveProject('p1');
});

afterEach(() => {
  cleanup();
  useWorkbenchStore.getState().closePalette();
});

describe('CommandPalette', () => {
  it('renders nothing while closed and lists grouped commands when open', () => {
    render(<CommandPalette />);
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => {
      useWorkbenchStore.getState().openPalette();
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getAllByRole('option').length).toBeGreaterThan(5);
  });

  it('filters commands by query (the prompt command always matches its own text)', async () => {
    useWorkbenchStore.getState().openPalette();
    render(<CommandPalette />);

    const input = screen.getByPlaceholderText(/输入命令或提示词/);
    await userEvent.type(input, 'qoder');

    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]?.textContent).toContain('发送提示词');
    expect(options[1]?.textContent).toContain('Qoder');
  });

  it('executes the highlighted command with Enter (harness switch)', async () => {
    useWorkbenchStore.getState().openPalette();
    render(<CommandPalette />);

    const input = screen.getByPlaceholderText(/输入命令或提示词/);
    await userEvent.type(input, 'qoder');
    // Index 0 is the send-prompt command; step down onto the harness command.
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');

    expect(useWorkbenchStore.getState().projects[0]?.activeHarness).toBe('qoder');
    expect(useWorkbenchStore.getState().paletteOpen).toBe(false);
  });

  it('navigates with ArrowDown / ArrowUp including wrap-around', async () => {
    useWorkbenchStore.getState().openPalette();
    render(<CommandPalette />);

    const selectedIndex = (): number =>
      screen
        .getAllByRole('option')
        .findIndex((option) => option.getAttribute('aria-selected') === 'true');

    expect(selectedIndex()).toBe(0);

    const input = screen.getByPlaceholderText(/输入命令或提示词/);
    await userEvent.type(input, '{ArrowDown}');
    expect(selectedIndex()).toBe(1);

    await userEvent.type(input, '{ArrowUp}{ArrowUp}');
    // Wraps backwards past index 0 to the last command.
    const total = screen.getAllByRole('option').length;
    expect(selectedIndex()).toBe(total - 1);
  });

  it('sends the typed text as a prompt via the 提示词 command', async () => {
    useWorkbenchStore.getState().openPalette();
    render(<CommandPalette />);

    const input = screen.getByPlaceholderText(/输入命令或提示词/);
    await userEvent.type(input, '修复登录页的焦点丢失问题');
    // The send-prompt command is always first when a query exists.
    expect(screen.getAllByRole('option')[0]?.textContent).toContain('发送提示词');
    await userEvent.keyboard('{Enter}');

    const prompts = useWorkbenchStore.getState().timeline.filter((item) => item.kind === 'user_prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ kind: 'user_prompt', text: '修复登录页的焦点丢失问题' });
    expect(useWorkbenchStore.getState().paletteOpen).toBe(false);
  });

  it('switches project and provider through palette commands', async () => {
    useWorkbenchStore.getState().openPalette();
    render(<CommandPalette />);

    const input = screen.getByPlaceholderText(/输入命令或提示词/);
    await userEvent.type(input, '飞书');
    // Index 0 is the send-prompt command; step down onto the project command.
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    expect(useWorkbenchStore.getState().activeProjectId).toBe('p2');

    // Reopen the same (still mounted) palette instance.
    act(() => {
      useWorkbenchStore.getState().openPalette();
    });
    const reopened = screen.getByPlaceholderText(/输入命令或提示词/);
    await userEvent.type(reopened, 'OpenAI');
    await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    expect(useWorkbenchStore.getState().projects.find((entry) => entry.id === 'p2')?.activeProviderId).toBe('openai');
  });
});
