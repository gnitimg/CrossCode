import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsDialog } from '../src/components/SettingsDialog';
import { resetWorkbenchStore, useWorkbenchStore } from '../src/store/workbench';
import type { DaemonApiClient, PairingSnapshot } from '../src/api/client';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

function snapshot(overrides: Partial<PairingSnapshot> = {}): PairingSnapshot {
  return {
    pin: '482913',
    expiresAt: new Date(NOW + 5 * 60_000).toISOString(),
    expiresAtMs: NOW + 5 * 60_000,
    ttlMs: 5 * 60_000,
    lanUrls: ['http://192.168.1.24:4610'],
    ...overrides,
  };
}

function openWith(pairing: PairingSnapshot | null): void {
  act(() => {
    useWorkbenchStore.setState({ settingsOpen: true, pairing, pairingError: null });
  });
}

beforeEach(() => {
  resetWorkbenchStore();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  useWorkbenchStore.getState().setMode('live');
  useWorkbenchStore.getState().setWsStatus('live');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SettingsDialog — connection', () => {
  it('renders nothing while closed', () => {
    render(<SettingsDialog />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows the live PIN, 5-minute window and countdown', () => {
    openWith(snapshot());
    render(<SettingsDialog />);

    expect(screen.getByRole('dialog', { name: '设置' })).toBeTruthy();
    expect(screen.getByText('482 913')).toBeTruthy();
    expect(screen.getByText('5 分钟有效')).toBeTruthy();
    expect(screen.getByText('05:00')).toBeTruthy();
    expect(screen.getByText('http://192.168.1.24:4610')).toBeTruthy();
    expect(screen.getByText('已自动授权（桌面端无需 PIN）')).toBeTruthy();
  });

  it('counts down and refetches once the window lapses', async () => {
    const getPairing = vi.fn(async () => snapshot({ pin: '731204', expiresAtMs: NOW + 60_000 }));
    useWorkbenchStore.getState().setApiClient({ getPairing, rotatePin: vi.fn() } as unknown as DaemonApiClient);
    openWith(snapshot({ expiresAtMs: NOW + 2_000 }));
    render(<SettingsDialog />);

    expect(screen.getByText('00:02')).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(getPairing).toHaveBeenCalled();
  });

  it('rotates the PIN through the gateway when refresh is pressed', async () => {
    // userEvent schedules its own timers; real timers keep the click path simple.
    vi.useRealTimers();
    const rotatePin = vi.fn(async () => snapshot({ pin: '905671' }));
    useWorkbenchStore
      .getState()
      .setApiClient({ getPairing: vi.fn(async () => snapshot()), rotatePin } as unknown as DaemonApiClient);
    openWith(snapshot());
    render(<SettingsDialog />);

    await userEvent.click(screen.getByRole('button', { name: '刷新' }));

    expect(rotatePin).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('905 671')).toBeTruthy();
  });
});
