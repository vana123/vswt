import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;

export class GitError extends Error {
  public override readonly name = 'GitError';
  constructor(message: string, public readonly stderr: string, public readonly exitCode: number | null) {
    super(message);
  }
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
  bare: boolean;
  detached: boolean;
}

export interface AddWorktreeOptions {
  path: string;
  branch: string;
  fromRef?: string;
  /** When true, pass `-b` to create a new branch. Auto-detected when omitted. */
  createBranch?: boolean;
}

/** Thin promisified wrapper around the `git` CLI in a fixed working directory. */
export class GitOps {
  constructor(private readonly cwd: string) {}

  async isGitRepo(): Promise<boolean> {
    try {
      await this.git('rev-parse', '--is-inside-work-tree');
      return true;
    } catch {
      return false;
    }
  }

  async getRepoRoot(): Promise<string> {
    return (await this.git('rev-parse', '--show-toplevel')).trim();
  }

  async currentBranch(): Promise<string | null> {
    const out = (await this.git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
    return out === 'HEAD' ? null : out;
  }

  async branchExists(name: string): Promise<boolean> {
    try {
      await this.git('rev-parse', '--verify', `refs/heads/${name}`);
      return true;
    } catch {
      return false;
    }
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    const out = await this.git('worktree', 'list', '--porcelain');
    return parseWorktreePorcelain(out);
  }

  async addWorktree(opts: AddWorktreeOptions): Promise<void> {
    const args = ['worktree', 'add'];
    const shouldCreate = opts.createBranch ?? !(await this.branchExists(opts.branch));
    if (shouldCreate) {
      args.push('-b', opts.branch);
    }
    args.push(opts.path);
    if (opts.fromRef) args.push(opts.fromRef);
    else if (!shouldCreate) args.push(opts.branch);
    await this.git(...args);
  }

  async removeWorktree(path: string, force = false): Promise<void> {
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(path);
    await this.git(...args);
  }

  async pruneWorktrees(): Promise<void> {
    await this.git('worktree', 'prune', '-v');
  }

  /** Run `git submodule update --init --recursive` in a target directory (e.g., a fresh worktree). */
  async initSubmodulesIn(cwd: string): Promise<void> {
    try {
      await execFileAsync('git', ['submodule', 'update', '--init', '--recursive'], { cwd, maxBuffer: MAX_BUFFER });
    } catch (err) {
      throw toGitError('git submodule update --init failed', err);
    }
  }

  private async git(...args: string[]): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', args, { cwd: this.cwd, maxBuffer: MAX_BUFFER });
      return stdout;
    } catch (err) {
      throw toGitError(`git ${args.join(' ')} failed`, err);
    }
  }
}

function toGitError(message: string, err: unknown): GitError {
  const e = err as { stderr?: string | Buffer; code?: number };
  const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '';
  return new GitError(`${message}\n${stderr}`.trim(), stderr, e.code ?? null);
}

function parseWorktreePorcelain(text: string): WorktreeInfo[] {
  const blocks = text.trim().split(/\n\n+/);
  const out: WorktreeInfo[] = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    let path = '';
    let head = '';
    let branch: string | null = null;
    let bare = false;
    let detached = false;
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      else if (line === 'bare') bare = true;
      else if (line === 'detached') detached = true;
    }
    if (path) out.push({ path, head, branch, bare, detached });
  }
  return out;
}
