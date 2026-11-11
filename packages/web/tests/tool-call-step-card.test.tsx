import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCallStepCard } from '../src/components/ToolCallStepCard';
import {
  resetWorkbenchStore,
  useWorkbenchStore,
  type TimelineToolStep,
} from '../src/store/workbench';
import type { SessionTransport } from '../src/api/ws-client';

const baseStep: TimelineToolStep = {
  kind: 'tool',
  id: 'c1',
  callId: 'c1',
  sessionId: 'sess-1',
  toolName: 'browser_click',
  args: { selector: '#merge-btn', url: 'https://example.com/pr' },
  requiresApproval: true,
  status: 'running',
};

beforeEach(() => {
  resetWorkbenchStore();
});

afterEach(() => {
  cleanup();
  useWorkbenchStore.getState().setTransport(null);
});

function fakeTransport(): SessionTransport & { calls: Array<[string, boolean]> } {
  const calls: Array<[string, boolean]> = [];
  return {
    calls,
    sendPrompt: () => undefined,
    switchProvider: () => undefined,
    respondApproval: (approvalId, approved) => {
      calls.push([approvalId, approved]);
    },
  };
}

function seedApproval(approvalId: string): void {
  useWorkbenchStore.getState().addApproval({
    approvalId,
    sessionId: 'sess-1',
    callId: 'c1',
    toolName: 'browser_click',
    args: { selector: '#merge-btn' },
    createdAt: new Date().toISOString(),
  });
}

describe('ToolCallStepCard', () => {
  it('renders the tool name, argument summary and browser thumbnail placeholder', () => {
    render(<ToolCallStepCard item={baseStep} />);
    expect(screen.getByText('browser_click')).toBeTruthy();
    expect(screen.getByText(/selector: #merge-btn/)).toBeTruthy();
    expect(screen.getByText('执行中')).toBeTruthy();
    expect(screen.getByText(/浏览器 \/ 桌面画面占位/)).toBeTruthy();
  });

  it('shows the approval card and uplinks approve through the transport', async () => {
    seedApproval('apr_1');
    // Replace the transport so calls are observable.
    const transport = fakeTransport();
    useWorkbenchStore.getState().setTransport(transport);

    render(<ToolCallStepCard item={baseStep} />);
    expect(screen.getByText('高危操作需要审批')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /批准执行/ }));

    expect(transport.calls).toEqual([['apr_1', true]]);
    // Optimistically removed from the pending list.
    expect(useWorkbenchStore.getState().approvals).toHaveLength(0);
  });

  it('uplinks reject with false', async () => {
    seedApproval('apr_2');
    const transport = fakeTransport();
    useWorkbenchStore.getState().setTransport(transport);

    render(<ToolCallStepCard item={baseStep} />);
    await userEvent.click(screen.getByRole('button', { name: /拒绝/ }));

    expect(transport.calls).toEqual([['apr_2', false]]);
  });

  it('renders no approval buttons when nothing is pending', () => {
    render(<ToolCallStepCard item={baseStep} />);
    expect(screen.queryByText('高危操作需要审批')).toBeNull();
    expect(screen.queryByRole('button', { name: /批准执行/ })).toBeNull();
  });

  it('styles failed results and renders the output preview', () => {
    const failed: TimelineToolStep = {
      ...baseStep,
      status: 'error',
      isError: true,
      output: 'Command failed with exit code 1: ENOENT',
    };
    render(<ToolCallStepCard item={failed} />);
    expect(screen.getByText('失败')).toBeTruthy();
    expect(screen.getByText(/Command failed with exit code 1/)).toBeTruthy();
  });
});
