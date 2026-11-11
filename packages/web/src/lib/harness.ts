import type { HarnessId } from '@crosscode/shared';

/**
 * Harness brand identities — each harness gets a "breathing lamp" color:
 * CrossCode 极光紫 / Claude 琥珀橙 / OpenCode 冰川青 / Codex 翡翠绿 /
 * DeepSeek 深海蓝 / Qoder 玫红 / ZCode 日晖橙.
 */
export interface HarnessMeta {
  id: HarnessId;
  label: string;
  short: string;
  color: string;
}

export const HARNESS_META: Record<HarnessId, HarnessMeta> = {
  'crosscode-native': { id: 'crosscode-native', label: 'CrossCode 原生', short: 'CC', color: '#8b5cf6' },
  'claude-code': { id: 'claude-code', label: 'Claude Code', short: 'CL', color: '#d97757' },
  opencode: { id: 'opencode', label: 'OpenCode', short: 'OC', color: '#22d3ee' },
  codex: { id: 'codex', label: 'Codex', short: 'CX', color: '#10b981' },
  'deepseek-harness': { id: 'deepseek-harness', label: 'DeepSeek', short: 'DS', color: '#3b82f6' },
  qoder: { id: 'qoder', label: 'Qoder', short: 'QD', color: '#e11d48' },
  zcode: { id: 'zcode', label: 'ZCode', short: 'ZC', color: '#f59e0b' },
};

/** Insertion order preserved: matches ALL_HARNESS_IDS order. */
export const HARNESS_LIST: readonly HarnessMeta[] = Object.values(HARNESS_META);

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#d97757',
  openai: '#10b981',
  deepseek: '#3b82f6',
  gemini: '#22d3ee',
  openrouter: '#8b5cf6',
  ollama: '#94a3b8',
};

export function providerColor(providerId: string): string {
  return PROVIDER_COLORS[providerId] ?? '#64748b';
}

/** Compact Chinese relative time for "last active" chips. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '未知';
  const diff = now - time;
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(time).toLocaleDateString('zh-CN');
}
