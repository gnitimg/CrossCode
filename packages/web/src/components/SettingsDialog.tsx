import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, RefreshCw, Terminal, Wifi, X } from 'lucide-react';
import { useWorkbenchStore } from '../store/workbench';
import { cn } from '../lib/cn';

/**
 * Settings → Connection.
 *
 * Desktop uses a self-minted JWT and never asks for a PIN, so this panel is how
 * you add *remote* devices: it shows the live rotating PIN (5 min), its
 * countdown, and the LAN origins a phone / mini-program can open.
 */

function formatPin(pin: string): string {
  return pin.length === 6 ? `${pin.slice(0, 3)} ${pin.slice(3)}` : pin;
}

function formatCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function useCountdown(expiresAtMs: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAtMs) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAtMs]);
  return expiresAtMs ? Math.max(0, expiresAtMs - now) : 0;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard unavailable (insecure origin) — the value stays visible
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="btn btn-ghost !h-7 gap-1.5 border hairline px-2 font-mono text-[11px]"
      aria-label={label}
      title={label}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      {copied ? '已复制' : '复制'}
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b hairline py-2 last:border-0">
      <span className="shrink-0 font-mono text-[11px] text-zinc-500">{label}</span>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function SettingsDialog() {
  const open = useWorkbenchStore((state) => state.settingsOpen);
  const close = useWorkbenchStore((state) => state.closeSettings);
  const pairing = useWorkbenchStore((state) => state.pairing);
  const pairingError = useWorkbenchStore((state) => state.pairingError);
  const refreshPairing = useWorkbenchStore((state) => state.refreshPairing);
  const rotatePairing = useWorkbenchStore((state) => state.rotatePairing);
  const wsStatus = useWorkbenchStore((state) => state.wsStatus);
  const mode = useWorkbenchStore((state) => state.mode);

  const remaining = useCountdown(pairing?.expiresAtMs);
  const expired = Boolean(pairing?.expiresAtMs) && remaining <= 0;

  // Auto-refresh as soon as the current code lapses.
  useEffect(() => {
    if (open && expired) void refreshPairing();
  }, [open, expired, refreshPairing]);

  const origin = useMemo(() => {
    try {
      return globalThis.location?.origin ?? '—';
    } catch {
      return '—';
    }
  }, []);

  if (!open) return null;

  const statusLabel =
    mode === 'demo' ? 'MOCK' : wsStatus === 'live' ? 'ONLINE' : wsStatus === 'reconnecting' ? 'RECONNECTING' : 'OFFLINE';

  return (
    <div
      role="dialog"
      aria-label="设置"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 pt-[10vh]"
      onMouseDown={close}
    >
      <div
        className="panel rise flex w-[560px] max-w-[94vw] flex-col"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b hairline px-4 py-2.5">
          <Terminal className="h-3.5 w-3.5 text-zinc-400" />
          <span className="font-mono text-[12px] font-semibold text-zinc-100">设置</span>
          <span className="chip ml-1">连接</span>
          <button
            type="button"
            className="btn btn-ghost ml-auto !h-6 !w-6 !p-0"
            onClick={close}
            aria-label="关闭设置"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="stream-scroll max-h-[70vh] overflow-y-auto px-4 py-3">
          <Row label="守护进程">
            <span className="truncate font-mono text-[11.5px] text-zinc-300">{origin}</span>
            <span
              className={cn(
                'chip',
                wsStatus === 'live' && mode !== 'demo'
                  ? 'border-emerald-500/30 text-emerald-400'
                  : 'border-amber-500/30 text-amber-400',
              )}
            >
              {statusLabel}
            </span>
          </Row>

          <Row label="本机访问">
            <span className="truncate font-mono text-[11px] text-zinc-500">已自动授权（桌面端无需 PIN）</span>
          </Row>

          <div className="mt-4 rounded border hairline bg-obsidian p-3">
            <div className="mb-2 flex items-center gap-2">
              <Wifi className="h-3.5 w-3.5 text-zinc-400" />
              <span className="font-mono text-[11px] uppercase tracking-wider text-zinc-400">
                远程设备配对 PIN
              </span>
              {pairing?.ttlMs ? (
                <span className="chip ml-auto" title="PIN 到期后自动轮换">
                  5 分钟有效
                </span>
              ) : null}
            </div>

            {pairingError && (
              <div className="mb-2 rounded border border-rose-500/30 bg-rose-500/[0.06] px-2 py-1 font-mono text-[11px] text-rose-300">
                {pairingError}
              </div>
            )}

            <div className="flex items-center gap-3">
              <span
                className="font-mono text-[30px] leading-none tracking-[0.18em] text-zinc-100"
                aria-label="当前配对 PIN"
              >
                {pairing ? formatPin(pairing.pin) : '— — —'}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                {pairing && <CopyButton value={pairing.pin} label="复制配对 PIN" />}
                <button
                  type="button"
                  className="btn btn-ghost !h-7 gap-1.5 border hairline px-2 font-mono text-[11px]"
                  onClick={() => void rotatePairing()}
                  title="立即更换 PIN"
                >
                  <RefreshCw className="h-3 w-3" />
                  刷新
                </button>
              </div>
            </div>

            <div className="mt-2 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className={cn('h-full transition-[width] duration-1000 ease-linear', expired ? 'bg-rose-500' : 'bg-zinc-300')}
                  style={{
                    width: pairing?.ttlMs ? `${Math.min(100, Math.max(0, (remaining / pairing.ttlMs) * 100))}%` : '0%',
                  }}
                />
              </div>
              <span className="w-12 shrink-0 text-right font-mono text-[10.5px] text-zinc-500">
                {pairing?.expiresAtMs ? formatCountdown(remaining) : '--:--'}
              </span>
            </div>

            <p className="mt-2 font-mono text-[10.5px] leading-relaxed text-zinc-600">
              远程网页 / 小程序打开下方地址并输入此 PIN 即可接管。PIN 每 5 分钟自动轮换，旧码立即失效。
            </p>
          </div>

          <div className="mt-3 rounded border hairline bg-obsidian p-3">
            <div className="mb-1.5 font-mono text-[11px] uppercase tracking-wider text-zinc-400">
              远程访问地址
            </div>
            {pairing?.lanUrls?.length ? (
              <div className="flex flex-col gap-1">
                {pairing.lanUrls.map((url) => (
                  <div key={url} className="flex items-center gap-2">
                    <span className="truncate font-mono text-[11.5px] text-zinc-300">{url}</span>
                    <CopyButton value={url} label={`复制 ${url}`} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="font-mono text-[11px] text-zinc-600">
                未检测到局域网地址（仅本机可访问）。如需远程访问请配置内网穿透或隧道。
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between border-t hairline px-4 py-2 font-mono text-[10.5px] text-zinc-600">
          <span>CrossCode v0.1.0</span>
          <span>PIN 轮换：{pairing?.ttlMs ? `${Math.round(pairing.ttlMs / 60000)} min` : 'off'}</span>
        </div>
      </div>
    </div>
  );
}
