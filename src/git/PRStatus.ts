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

interface CacheEntry {
  status: PRStatusInfo | null;
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

  invalidate(): void {
    this.entries.clear();
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
