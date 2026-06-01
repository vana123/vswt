import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TTL_MS = 120_000;
const MAX_BUFFER = 5 * 1024 * 1024;

export type PRChecksState = 'pending' | 'success' | 'failure' | 'none';

export interface PRStatusInfo {
  number: number;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  url: string;
  checks: PRChecksState;
}

export interface OpenPRInfo {
  number: number;
  title: string;
  author: string;
  headRefName: string;
  isDraft: boolean;
  url: string;
}

interface CacheEntry {
  status: PRStatusInfo | null;
  fetchedAt: number;
  inflight?: Promise<void>;
}

interface ListEntry {
  list: OpenPRInfo[];
  fetchedAt: number;
  inflight?: Promise<void>;
}

/**
 * Caches `gh pr view --json …` per worktree with a TTL.
 * Reads are synchronous — if the entry is missing/stale, a background fetch
 * is kicked off and `onUpdated` fires when it lands.
 */
export class PRStatusCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly lists = new Map<string, ListEntry>();
  private ghMissing = false;

  get(worktreePath: string, onUpdated: () => void): PRStatusInfo | null | undefined {
    if (this.ghMissing) return null;
    const entry = this.entries.get(worktreePath);
    const fresh = entry && Date.now() - entry.fetchedAt < TTL_MS;
    if (!fresh && !entry?.inflight) {
      const promise = this.fetchAndStore(worktreePath, onUpdated);
      const seed: CacheEntry = entry ?? { status: null, fetchedAt: 0 };
      seed.inflight = promise;
      this.entries.set(worktreePath, seed);
    }
    return entry ? entry.status : undefined;
  }

  listOpen(repoRoot: string, onUpdated: () => void): OpenPRInfo[] | undefined {
    if (this.ghMissing) return [];
    const entry = this.lists.get(repoRoot);
    const fresh = entry && Date.now() - entry.fetchedAt < TTL_MS;
    if (!fresh && !entry?.inflight) {
      const promise = this.fetchListAndStore(repoRoot, onUpdated);
      const seed: ListEntry = entry ?? { list: [], fetchedAt: 0 };
      seed.inflight = promise;
      this.lists.set(repoRoot, seed);
    }
    return entry ? entry.list : undefined;
  }

  invalidate(scope?: { worktree?: string; repoRoot?: string }): void {
    if (!scope) {
      this.entries.clear();
      this.lists.clear();
      return;
    }
    if (scope.worktree !== undefined) this.entries.delete(scope.worktree);
    if (scope.repoRoot !== undefined) this.lists.delete(scope.repoRoot);
  }

  private async fetchAndStore(worktreePath: string, onUpdated: () => void): Promise<void> {
    let status: PRStatusInfo | null = null;
    try {
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'view', '--json', 'number,state,url,isDraft,statusCheckRollup'],
        { cwd: worktreePath, maxBuffer: MAX_BUFFER }
      );
      const parsed = JSON.parse(stdout) as {
        number: number;
        state: 'OPEN' | 'CLOSED' | 'MERGED';
        isDraft?: boolean;
        url?: string;
        statusCheckRollup?: Array<{ conclusion?: string; state?: string }>;
      };
      status = {
        number: parsed.number,
        state: parsed.state,
        isDraft: parsed.isDraft ?? false,
        url: parsed.url ?? '',
        checks: summarizeChecks(parsed.statusCheckRollup ?? [])
      };
    } catch (err) {
      // ENOENT = `gh` is not installed; cache that and stop trying.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.ghMissing = true;
    }
    this.entries.set(worktreePath, { status, fetchedAt: Date.now() });
    onUpdated();
  }

  private async fetchListAndStore(repoRoot: string, onUpdated: () => void): Promise<void> {
    let list: OpenPRInfo[] = [];
    try {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'pr',
          'list',
          '--state',
          'open',
          '--limit',
          '50',
          '--json',
          'number,title,author,headRefName,isDraft,url'
        ],
        { cwd: repoRoot, maxBuffer: MAX_BUFFER }
      );
      const parsed = JSON.parse(stdout) as Array<{
        number: number;
        title?: string;
        author?: { login?: string };
        headRefName?: string;
        isDraft?: boolean;
        url?: string;
      }>;
      list = parsed.map(p => ({
        number: p.number,
        title: p.title ?? '',
        author: p.author?.login ?? '',
        headRefName: p.headRefName ?? '',
        isDraft: p.isDraft ?? false,
        url: p.url ?? ''
      }));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') this.ghMissing = true;
    }
    this.lists.set(repoRoot, { list, fetchedAt: Date.now() });
    onUpdated();
  }
}

function summarizeChecks(rollup: Array<{ conclusion?: string; state?: string }>): PRChecksState {
  if (rollup.length === 0) return 'none';
  let anyPending = false;
  let anyFail = false;
  for (const c of rollup) {
    const raw = (c.conclusion ?? c.state ?? '').toUpperCase();
    if (raw === '' || raw === 'PENDING' || raw === 'IN_PROGRESS' || raw === 'QUEUED') {
      anyPending = true;
    } else if (
      raw === 'FAILURE' ||
      raw === 'ERROR' ||
      raw === 'CANCELLED' ||
      raw === 'TIMED_OUT' ||
      raw === 'ACTION_REQUIRED'
    ) {
      anyFail = true;
    }
  }
  if (anyFail) return 'failure';
  if (anyPending) return 'pending';
  return 'success';
}

export function formatPRBadge(pr: PRStatusInfo): string {
  if (pr.state === 'MERGED') return `PR #${pr.number} merged`;
  if (pr.state === 'CLOSED') return `PR #${pr.number} closed`;
  if (pr.isDraft) return `PR #${pr.number} draft`;
  if (pr.checks === 'success') return `PR #${pr.number} ✓`;
  if (pr.checks === 'failure') return `PR #${pr.number} ✗`;
  if (pr.checks === 'pending') return `PR #${pr.number} ⏳`;
  return `PR #${pr.number}`;
}
