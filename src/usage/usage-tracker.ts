import * as vscode from 'vscode';
import { ModelFamily, UsageRecord, UsageScanner } from './usage-scanner';

export type Plan = 'pro' | 'max5' | 'max20' | 'custom';

export interface PlanLimits {
  /** Cost-tokens budget for a single 5h block. */
  blockTokens: number;
  /** Cost-tokens budget for a rolling 7-day window. */
  weekTokens: number;
}

/**
 * Conservative defaults. Anthropic publishes message-count limits per tier,
 * not token budgets — these values are community-derived best guesses that
 * approximate the typical "you hit your 5h limit" mark.
 * Users override via vswt.usage.customBlockTokens / customWeekTokens.
 */
const PLAN_LIMITS: Record<Exclude<Plan, 'custom'>, PlanLimits> = {
  pro:    { blockTokens:    200_000, weekTokens:   7_000_000 },
  max5:   { blockTokens:  1_000_000, weekTokens:  35_000_000 },
  max20:  { blockTokens:  4_000_000, weekTokens: 140_000_000 }
};

const BLOCK_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface FamilyBreakdown {
  family: ModelFamily;
  tokens: number;
}

export interface UsageSnapshot {
  /** 5h block usage. blockStart is null when no recent activity. */
  block: {
    usedTokens: number;
    limitTokens: number;
    pct: number;
    start: number | null;
    /** start + 5h, when usedTokens > 0; null when idle. */
    resetAt: number | null;
    breakdown: FamilyBreakdown[];
  };
  week: {
    usedTokens: number;
    limitTokens: number;
    pct: number;
    breakdown: FamilyBreakdown[];
  };
  plan: Plan;
  /** Time the snapshot was computed. */
  computedAt: number;
}

export interface UsageConfig {
  plan: Plan;
  customBlockTokens: number;
  customWeekTokens: number;
}

/**
 * Aggregates UsageScanner output into the snapshot shape consumed by the
 * status bar / activity-bar badge. Fires onDidChange after every refresh so
 * UI surfaces re-render reactively.
 */
export class UsageTracker {
  private readonly _onDidChange = new vscode.EventEmitter<UsageSnapshot>();
  readonly onDidChange = this._onDidChange.event;

  private latest: UsageSnapshot | null = null;
  private inflight: Promise<UsageSnapshot> | null = null;

  constructor(
    private readonly scanner: UsageScanner,
    private readonly getConfig: () => UsageConfig
  ) {}

  current(): UsageSnapshot | null {
    return this.latest;
  }

  /** Recompute against the projects dir; idempotent if called concurrently. */
  async refresh(): Promise<UsageSnapshot> {
    if (this.inflight) return this.inflight;
    this.inflight = this.computeSnapshot()
      .then(snap => {
        this.latest = snap;
        this._onDidChange.fire(snap);
        return snap;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  private async computeSnapshot(): Promise<UsageSnapshot> {
    const now = Date.now();
    const cfg = this.getConfig();
    const limits = effectiveLimits(cfg);

    // One scan covers both windows; week is the wider one.
    const records = await this.scanner.recordsSince(now - WEEK_MS);

    const weekTotals = aggregate(records);
    const blockRecords = pickCurrentBlock(records, now);
    const blockTotals = aggregate(blockRecords);
    const blockStart =
      blockRecords.length > 0
        ? (blockRecords[0]!.ts)
        : null;

    return {
      block: {
        usedTokens: blockTotals.total,
        limitTokens: limits.blockTokens,
        pct: pct(blockTotals.total, limits.blockTokens),
        start: blockStart,
        resetAt: blockStart !== null ? blockStart + BLOCK_MS : null,
        breakdown: breakdownArray(blockTotals.byFamily)
      },
      week: {
        usedTokens: weekTotals.total,
        limitTokens: limits.weekTokens,
        pct: pct(weekTotals.total, limits.weekTokens),
        breakdown: breakdownArray(weekTotals.byFamily)
      },
      plan: cfg.plan,
      computedAt: now
    };
  }
}

function effectiveLimits(cfg: UsageConfig): PlanLimits {
  if (cfg.plan === 'custom') {
    return {
      blockTokens: cfg.customBlockTokens > 0 ? cfg.customBlockTokens : PLAN_LIMITS.max5.blockTokens,
      weekTokens: cfg.customWeekTokens > 0 ? cfg.customWeekTokens : PLAN_LIMITS.max5.weekTokens
    };
  }
  return PLAN_LIMITS[cfg.plan];
}

/**
 * Cost-tokens for limit accounting: input + output + cache creation.
 * Cache reads are excluded — they're effectively discounted (~10×) and the
 * Claude Code limit-meter does not attribute them to the same pool.
 */
function costTokens(r: UsageRecord): number {
  return r.inputTokens + r.outputTokens + r.cacheCreationTokens;
}

interface Totals {
  total: number;
  byFamily: Map<ModelFamily, number>;
}

function aggregate(records: UsageRecord[]): Totals {
  let total = 0;
  const byFamily = new Map<ModelFamily, number>();
  for (const r of records) {
    const c = costTokens(r);
    total += c;
    byFamily.set(r.family, (byFamily.get(r.family) ?? 0) + c);
  }
  return { total, byFamily };
}

function breakdownArray(byFamily: Map<ModelFamily, number>): FamilyBreakdown[] {
  return [...byFamily.entries()]
    .map(([family, tokens]) => ({ family, tokens }))
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * Selects records belonging to the current 5h "session block": the run of
 * records whose chronological gaps are < 5h, ending at the latest record.
 * Returns [] when the latest activity is older than 5h.
 */
function pickCurrentBlock(records: UsageRecord[], now: number): UsageRecord[] {
  if (records.length === 0) return [];
  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  const last = sorted[sorted.length - 1]!;
  if (now - last.ts > BLOCK_MS) return [];

  // Walk backwards from the most recent until we find a 5h+ gap.
  let startIdx = sorted.length - 1;
  for (let i = sorted.length - 1; i > 0; i--) {
    const cur = sorted[i]!;
    const prev = sorted[i - 1]!;
    if (cur.ts - prev.ts > BLOCK_MS) {
      startIdx = i;
      break;
    }
    startIdx = i - 1;
  }

  // Cap block length at 5h from its first record (matches Anthropic's
  // "5h since first message" mechanic).
  const blockStart = sorted[startIdx]!.ts;
  return sorted.slice(startIdx).filter(r => r.ts - blockStart <= BLOCK_MS);
}

function pct(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(999, Math.round((used / limit) * 100));
}
