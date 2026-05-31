import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export type ModelFamily = 'opus' | 'sonnet' | 'haiku' | 'other';

export interface UsageRecord {
  /** ms since epoch */
  ts: number;
  family: ModelFamily;
  /** Raw model id from the transcript, e.g. `claude-opus-4-8`. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  records: UsageRecord[];
}

/**
 * Scans Claude Code JSONL transcripts for per-assistant-turn `usage` blocks.
 * Aggregates token counts in arbitrary time windows for the usage tracker.
 *
 * Caches parsed records per file keyed on (mtime, size) so a re-scan is
 * effectively free unless the file actually changed.
 */
export class UsageScanner {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private projectsDir: string) {}

  setProjectsDir(dir: string): void {
    if (dir === this.projectsDir) return;
    this.projectsDir = dir;
    this.cache.clear();
  }

  resolveProjectsDir(): string {
    const o = this.projectsDir.trim();
    if (!o) return path.join(os.homedir(), '.claude', 'projects');
    if (o === '~' || o.startsWith('~/') || o.startsWith('~\\')) {
      return path.join(os.homedir(), o.slice(1));
    }
    return path.resolve(o);
  }

  /** Returns all usage records with `ts >= sinceMs`. Newest scans win on dedup. */
  async recordsSince(sinceMs: number): Promise<UsageRecord[]> {
    const root = this.resolveProjectsDir();
    let projectDirs: string[];
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      projectDirs = entries.filter(e => e.isDirectory()).map(e => path.join(root, e.name));
    } catch {
      return [];
    }

    const out: UsageRecord[] = [];
    const seen = new Set<string>();
    await Promise.all(
      projectDirs.map(async dir => {
        let files: string[];
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          files = entries
            .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
            .map(e => path.join(dir, e.name));
        } catch {
          return;
        }
        for (const file of files) {
          const records = await this.readFile(file, sinceMs);
          if (records) {
            for (const r of records) if (r.ts >= sinceMs) out.push(r);
            seen.add(file);
          }
        }
      })
    );

    for (const key of [...this.cache.keys()]) {
      if (!seen.has(key)) this.cache.delete(key);
    }
    return out;
  }

  /**
   * Parses one transcript. Returns the file's full record list (cached); the
   * caller filters by window. We always parse the entire file because the
   * sinceMs window often covers the whole file anyway (5h or 7d).
   */
  private async readFile(filePath: string, _sinceMs: number): Promise<UsageRecord[] | null> {
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return null;
    }
    const cached = this.cache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.records;
    }

    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch {
      return null;
    }

    const records = parseUsageRecords(text);
    this.cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, records });
    return records;
  }
}

function parseUsageRecords(text: string): UsageRecord[] {
  const out: UsageRecord[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Cheap pre-filter: only assistant records carry usage; skip the rest fast.
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;

    let o: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') continue;
      o = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    if (o['type'] !== 'assistant') continue;
    const ts = parseTs(o['timestamp']);
    if (ts === null) continue;

    const msg = o['message'];
    if (!msg || typeof msg !== 'object') continue;
    const m = msg as Record<string, unknown>;
    const usage = m['usage'];
    if (!usage || typeof usage !== 'object') continue;
    const u = usage as Record<string, unknown>;

    const model = typeof m['model'] === 'string' ? (m['model'] as string) : '';
    out.push({
      ts,
      family: familyOf(model),
      model,
      inputTokens: numOr0(u['input_tokens']),
      outputTokens: numOr0(u['output_tokens']),
      cacheCreationTokens: numOr0(u['cache_creation_input_tokens']),
      cacheReadTokens: numOr0(u['cache_read_input_tokens'])
    });
  }
  return out;
}

function parseTs(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function familyOf(model: string): ModelFamily {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return 'other';
}
