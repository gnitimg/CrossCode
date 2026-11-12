import type { HarnessId } from '@crosscode/shared';

export interface HarnessMeta {
  id: HarnessId;
  label: string;
  short: string;
  color: string;
}

export const HARNESS_META: Record<HarnessId, HarnessMeta> = {
  'crosscode-native': { id: 'crosscode-native', label: 'CrossCode', short: 'CC', color: '#e4e4e7' },
  'claude-code': { id: 'claude-code', label: 'Claude Code', short: 'CL', color: '#d97757' },
  opencode: { id: 'opencode', label: 'OpenCode', short: 'OC', color: '#38bdf8' },
  codex: { id: 'codex', label: 'Codex', short: 'CX', color: '#10b981' },
  'deepseek-harness': { id: 'deepseek-harness', label: 'DeepSeek', short: 'DS', color: '#60a5fa' },
  qoder: { id: 'qoder', label: 'Qoder', short: 'QD', color: '#f43f5e' },
  zcode: { id: 'zcode', label: 'ZCode', short: 'ZC', color: '#f59e0b' },
};

export const HARNESS_LIST: readonly HarnessMeta[] = Object.values(HARNESS_META);

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#d97757',
  openai: '#10b981',
  deepseek: '#60a5fa',
  gemini: '#38bdf8',
  openrouter: '#a1a1aa',
  ollama: '#71717a',
};

export function providerColor(providerId: string): string {
  return PROVIDER_COLORS[providerId] ?? '#71717a';
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '—';
  const diff = now - time;
  if (diff < 60_000) return 'now';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(time).toLocaleDateString('zh-CN');
}
