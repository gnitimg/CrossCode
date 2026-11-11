/**
 * Client-side git diff summarization: parses the unified diff text returned by
 * the gateway's `GET /projects/:id/diff` and derives per-file +/− statistics
 * for the inspector's "Changes" tab.
 */

export interface DiffFileRow {
  /** Two-character porcelain status, e.g. `M `, ` A`, `??`. */
  status: string;
  file: string;
  staged: boolean;
  additions: number;
  deletions: number;
}

export interface DiffSummaryView {
  isGitRepo: boolean;
  branch?: string;
  files: DiffFileRow[];
  rawDiff: string;
  totalAdditions: number;
  totalDeletions: number;
}

export interface RawGatewayDiff {
  projectId: string;
  projectPath: string;
  isGitRepo: boolean;
  branch?: string;
  changes?: ReadonlyArray<{ status: string; file: string; staged: boolean }>;
  diff?: string;
}

export function parseDiffStats(rawDiff: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>();
  if (!rawDiff) return stats;

  let current: string | null = null;
  let counters = { additions: 0, deletions: 0 };
  const flush = (): void => {
    if (current) stats.set(current, { ...counters });
  };

  for (const line of rawDiff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flush();
      const match = /diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = match?.[2] ?? match?.[1] ?? null;
      counters = { additions: 0, deletions: 0 };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) counters.additions += 1;
    else if (line.startsWith('-')) counters.deletions += 1;
  }
  flush();
  return stats;
}

export function toDiffSummaryView(raw: RawGatewayDiff): DiffSummaryView {
  const stats = parseDiffStats(raw.diff ?? '');
  const files: DiffFileRow[] = (raw.changes ?? []).map((change) => ({
    status: change.status,
    file: change.file,
    staged: change.staged,
    additions: stats.get(change.file)?.additions ?? 0,
    deletions: stats.get(change.file)?.deletions ?? 0,
  }));
  return {
    isGitRepo: raw.isGitRepo,
    ...(raw.branch ? { branch: raw.branch } : {}),
    files,
    rawDiff: raw.diff ?? '',
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}
