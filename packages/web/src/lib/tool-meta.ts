import {
  FilePen,
  GitBranch,
  Globe,
  Monitor,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export type ToolKind = 'browser' | 'computer' | 'shell' | 'file' | 'git' | 'search' | 'generic';

export interface ToolVisual {
  icon: LucideIcon;
  color: string;
  kind: ToolKind;
}

const RULES: ReadonlyArray<{ pattern: RegExp; visual: ToolVisual }> = [
  { pattern: /browser|web|http|navigate|fetch|page|click/i, visual: { icon: Globe, color: '#22d3ee', kind: 'browser' } },
  { pattern: /computer|desktop|screen|screenshot|mouse|keyboard/i, visual: { icon: Monitor, color: '#d97757', kind: 'computer' } },
  { pattern: /shell|bash|cmd|exec|terminal|command|process/i, visual: { icon: Terminal, color: '#10b981', kind: 'shell' } },
  { pattern: /file|read|write|edit|patch|path|folder/i, visual: { icon: FilePen, color: '#8b5cf6', kind: 'file' } },
  { pattern: /git|commit|branch|diff/i, visual: { icon: GitBranch, color: '#f59e0b', kind: 'git' } },
  { pattern: /search|grep|find|glob|list/i, visual: { icon: Search, color: '#3b82f6', kind: 'search' } },
];

export function toolVisual(toolName: string): ToolVisual {
  for (const rule of RULES) {
    if (rule.pattern.test(toolName)) return rule.visual;
  }
  return { icon: Wrench, color: '#64748b', kind: 'generic' };
}

/** Browser/desktop tools get a picture-in-picture placeholder slot. */
export function isVisualTool(kind: ToolKind): boolean {
  return kind === 'browser' || kind === 'computer';
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
