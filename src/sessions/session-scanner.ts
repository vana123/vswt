import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ClaudeSession {
  /** Session id (uuid) — from record content, falls back to the file name. */
  id: string;
  /** Absolute path to the `<session-id>.jsonl` transcript. */
  filePath: string;
  /** Working directory from the transcript content (not the encoded folder name). */
  cwd: string | null;
  gitBranch: string | null;
  /** Claude's generated title (`ai-title` record), if any. */
  title: string | null;
  /** First human-authored user message, for a fallback label. */
  firstMessage: string | null;
  /** First record timestamp (ms), if parseable. */
  createdAt: number | null;
  /** File mtime (ms) — cheap proxy for last activity. */
  lastActivity: number;
}

interface CacheEntry {
  mtimeMs: number;
  session: ClaudeSession;
}

interface IndexEntry {
  mtimeMs: number;
  paragraphs: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export interface SessionSearchMatch {
  session: ClaudeSession;
  snippet: string;
  role: 'user' | 'assistant';
}

/** Only the head of each transcript is read; metadata lives in the first records. */
const MAX_SCAN_BYTES = 256 * 1024;
/** Last-turn lookup reads only the tail. */
const TAIL_SCAN_BYTES = 32 * 1024;

export interface SessionTail {
  sessionId: string | null;
  /** `stop_reason` of the last assistant message, if present. */
  stopReason: string | null;
}

export class SessionScanner {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly searchIndex = new Map<string, IndexEntry>();

  constructor(private projectsDir: string) {}

  setProjectsDir(dir: string): void {
    if (dir === this.projectsDir) return;
    this.projectsDir = dir;
    this.cache.clear();
    this.searchIndex.clear();
  }

  /** Absolute projects directory; empty override resolves to `~/.claude/projects`. */
  resolveProjectsDir(): string {
    const o = this.projectsDir.trim();
    if (!o) return path.join(os.homedir(), '.claude', 'projects');
    if (o === '~' || o.startsWith('~/') || o.startsWith('~\\')) {
      return path.join(os.homedir(), o.slice(1));
    }
    return path.resolve(o);
  }

  /** Claude's live-session registry dir — sibling of the projects dir. */
  resolveSessionsDir(): string {
    return path.join(path.dirname(this.resolveProjectsDir()), 'sessions');
  }

  /**
   * Session ids that are currently running, per Claude's `<pid>.json` registry
   * (one file per live process, removed on exit). Stale files from crashed
   * processes are filtered by checking the pid is actually alive.
   */
  async runningSessionIds(): Promise<Set<string>> {
    const dir = this.resolveSessionsDir();
    const ids = new Set<string>();
    let files: string[];
    try {
      files = (await fs.readdir(dir)).filter(f => f.endsWith('.json'));
    } catch {
      return ids;
    }
    await Promise.all(
      files.map(async f => {
        try {
          const o = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as {
            pid?: unknown;
            sessionId?: unknown;
          };
          const pid = typeof o.pid === 'number' ? o.pid : null;
          const sid = typeof o.sessionId === 'string' ? o.sessionId : null;
          if (sid && pid !== null && isPidAlive(pid)) ids.add(sid);
        } catch {
          // Unreadable/!json registry file — skip.
        }
      })
    );
    return ids;
  }

  async scan(): Promise<ClaudeSession[]> {
    const root = this.resolveProjectsDir();
    let projectDirs: string[];
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      projectDirs = entries.filter(e => e.isDirectory()).map(e => path.join(root, e.name));
    } catch {
      return [];
    }

    const sessions: ClaudeSession[] = [];
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
          const s = await this.readSession(file);
          if (s) {
            sessions.push(s);
            seen.add(file);
          }
        }
      })
    );

    for (const key of [...this.cache.keys()]) {
      if (!seen.has(key)) this.cache.delete(key);
    }
    return sessions;
  }

  /**
   * Substring search across all transcripts. Reads the full file the first
   * time, then re-uses the parsed paragraphs unless mtime changed.
   * One match per session at most; capped at `limit`.
   */
  async searchSessions(query: string, limit = 50): Promise<SessionSearchMatch[]> {
    const q = query.trim();
    if (!q) return [];
    const needle = q.toLowerCase();
    const sessions = await this.scan();
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);
    const matches: SessionSearchMatch[] = [];
    for (const session of sessions) {
      const entry = await this.indexEntry(session.filePath);
      if (!entry) continue;
      for (const p of entry.paragraphs) {
        const idx = p.text.toLowerCase().indexOf(needle);
        if (idx < 0) continue;
        const start = Math.max(0, idx - 60);
        const end = Math.min(p.text.length, idx + needle.length + 60);
        const snippet =
          (start > 0 ? '…' : '') +
          p.text.slice(start, end).replace(/\s+/g, ' ').trim() +
          (end < p.text.length ? '…' : '');
        matches.push({ session, snippet, role: p.role });
        break;
      }
      if (matches.length >= limit) break;
    }
    return matches;
  }

  private async indexEntry(filePath: string): Promise<IndexEntry | null> {
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(filePath)).mtimeMs;
    } catch {
      return null;
    }
    const cached = this.searchIndex.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    let text: string;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
    const paragraphs: IndexEntry['paragraphs'] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      let o: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object') continue;
        o = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = o['type'];
      if (type !== 'user' && type !== 'assistant') continue;
      const body = extractMessageText(o['message']);
      if (!body) continue;
      paragraphs.push({ role: type, text: body });
    }
    const entry: IndexEntry = { mtimeMs, paragraphs };
    this.searchIndex.set(filePath, entry);
    return entry;
  }

  /**
   * Read the tail of a transcript and extract enough state to tell whether
   * Claude finished its turn. Cheap — bounded by `TAIL_SCAN_BYTES`.
   */
  async readTail(filePath: string): Promise<SessionTail | null> {
    let text: string;
    try {
      const fh = await fs.open(filePath, 'r');
      try {
        const size = (await fh.stat()).size;
        const readSize = Math.min(size, TAIL_SCAN_BYTES);
        const buf = Buffer.alloc(readSize);
        await fh.read(buf, 0, readSize, size - readSize);
        text = buf.toString('utf8');
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }
    // If we didn't start at byte 0, the first line is likely a fragment.
    const lines = text.split(/\r?\n/);
    if (lines.length > 1) lines.shift();
    let sessionId: string | null = null;
    let stopReason: string | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      let o: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object') continue;
        o = parsed as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!sessionId) sessionId = asString(o['sessionId']);
      if (stopReason === null && o['type'] === 'assistant') {
        const msg = o['message'];
        if (msg && typeof msg === 'object') {
          const sr = asString((msg as Record<string, unknown>)['stop_reason']);
          if (sr) {
            stopReason = sr;
            break;
          }
        }
      }
    }
    return { sessionId, stopReason };
  }

  private async readSession(filePath: string): Promise<ClaudeSession | null> {
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(filePath)).mtimeMs;
    } catch {
      return null;
    }

    const cached = this.cache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs) {
      return cached.session;
    }

    let text: string;
    try {
      const fh = await fs.open(filePath, 'r');
      try {
        const size = Math.min((await fh.stat()).size, MAX_SCAN_BYTES);
        const buf = Buffer.alloc(size);
        await fh.read(buf, 0, size, 0);
        text = buf.toString('utf8');
      } finally {
        await fh.close();
      }
    } catch {
      return null;
    }

    const session = parseSession(text, filePath, path.basename(filePath, '.jsonl'), mtimeMs);
    this.cache.set(filePath, { mtimeMs, session });
    return session;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours to signal (still alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function parseSession(
  text: string,
  filePath: string,
  idFromName: string,
  mtimeMs: number
): ClaudeSession {
  let id: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let title: string | null = null;
  let firstMessage: string | null = null;
  let createdAt: number | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let o: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') continue;
      o = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    if (!id) id = asString(o['sessionId']);
    if (!cwd) {
      const c = asString(o['cwd']);
      if (c) cwd = c;
    }
    if (gitBranch === null) {
      const b = asString(o['gitBranch']);
      if (b !== null) gitBranch = b;
    }
    if (!title && o['type'] === 'ai-title') {
      const t = asString(o['aiTitle']);
      if (t && t.trim()) title = t.trim();
    }
    if (createdAt === null) {
      const ts = asString(o['timestamp']);
      if (ts) {
        const ms = Date.parse(ts);
        if (!Number.isNaN(ms)) createdAt = ms;
      }
    }
    if (!firstMessage && o['type'] === 'user') {
      const msg = extractUserText(o['message']);
      if (msg) firstMessage = msg;
    }
  }

  return {
    id: id ?? idFromName,
    filePath,
    cwd,
    gitBranch: gitBranch && gitBranch.length > 0 ? gitBranch : null,
    title,
    firstMessage,
    createdAt,
    lastActivity: mtimeMs
  };
}

function extractUserText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return cleanMessage(content);
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part === 'object') {
        const p = part as { type?: unknown; text?: unknown };
        if (p.type === 'text' && typeof p.text === 'string') {
          const c = cleanMessage(p.text);
          if (c) return c;
        }
      }
    }
  }
  return null;
}

/** Skip tool/command/system-wrapped messages so the label is a real user prompt. */
function cleanMessage(s: string): string | null {
  const t = s.replace(/\s+/g, ' ').trim();
  if (!t || t.startsWith('<')) return null;
  return t;
}

/** All text payload of a message (user or assistant), incl. content/thinking blocks. */
function extractMessageText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    const t = content.trim();
    return t && !t.startsWith('<') ? t : null;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as { type?: unknown; text?: unknown; thinking?: unknown };
      if (p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
      else if (p.type === 'thinking' && typeof p.thinking === 'string') parts.push(p.thinking);
    }
    const joined = parts.join('\n').trim();
    return joined && !joined.startsWith('<') ? joined : null;
  }
  return null;
}
