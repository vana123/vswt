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

export interface WorktreeStatus {
  branch: string | null;
  modified: number;
  untracked: number;
  ahead: number;
  behind: number;
}

export interface BranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
}

export interface FileChange {
  status: string;
  path: string;
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

  async renameBranch(oldName: string, newName: string): Promise<void> {
    await this.git('branch', '-m', oldName, newName);
  }

  async moveWorktree(oldPath: string, newPath: string): Promise<void> {
    await this.git('worktree', 'move', oldPath, newPath);
  }

  async repairWorktrees(): Promise<void> {
    await this.git('worktree', 'repair');
  }

  async statusInfo(): Promise<WorktreeStatus> {
    const out = await this.git('status', '--porcelain=v1', '--branch');
    return parseStatusInfo(out);
  }

  async statusFiles(): Promise<FileChange[]> {
    const out = await this.git('status', '--porcelain=v1');
    const result: FileChange[] = [];
    for (const raw of out.split(/\r?\n/)) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      const status = line.slice(0, 2);
      const file = line.slice(3);
      if (file) result.push({ status, path: file });
    }
    return result;
  }

  async listBranches(includeRemote = true): Promise<BranchInfo[]> {
    const args = ['branch'];
    if (includeRemote) args.push('--all');
    args.push('--format=%(HEAD)|%(refname:short)');
    const out = await this.git(...args);
    const result: BranchInfo[] = [];
    for (const raw of out.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      const idx = raw.indexOf('|');
      if (idx < 0) continue;
      const head = raw.slice(0, idx).trim();
      let name = raw.slice(idx + 1).trim();
      if (name.includes('HEAD -> ') || name.endsWith('/HEAD')) continue;
      const isRemote = name.startsWith('remotes/');
      if (isRemote) name = name.slice('remotes/'.length);
      result.push({ name, isCurrent: head === '*', isRemote });
    }
    return result;
  }

  async push(): Promise<string> {
    try {
      return await this.git('push');
    } catch (err) {
      const msg = (err as Error).message;
      if (/no upstream|set the remote tracking|--set-upstream/i.test(msg)) {
        const branch = await this.currentBranch();
        if (!branch) throw err;
        return await this.git('push', '--set-upstream', 'origin', branch);
      }
      throw err;
    }
  }

  async pull(): Promise<string> {
    try {
      return await this.git('pull', '--ff-only');
    } catch (err) {
      const msg = (err as Error).message;
      if (/tracking information|no tracking|set the remote tracking|--set-upstream/i.test(msg)) {
        const branch = await this.currentBranch();
        if (branch && (await this.refExists(`refs/remotes/origin/${branch}`))) {
          await this.git('branch', `--set-upstream-to=origin/${branch}`, branch);
          return await this.git('pull', '--ff-only');
        }
        throw new Error(
          `Branch '${branch ?? 'HEAD'}' has no upstream. Push it first to create one on origin.`
        );
      }
      throw err;
    }
  }

  async refExists(ref: string): Promise<boolean> {
    try {
      await this.git('rev-parse', '--verify', '--quiet', ref);
      return true;
    } catch {
      return false;
    }
  }

  async fetch(): Promise<string> {
    return this.git('fetch', '--all', '--prune');
  }

  async checkout(ref: string): Promise<void> {
    await this.git('checkout', ref);
  }

  async merge(branch: string, noFF = true): Promise<string> {
    const args = ['merge'];
    if (noFF) args.push('--no-ff');
    args.push(branch);
    return this.git(...args);
  }

  async mergeSquash(branch: string, message: string): Promise<void> {
    await this.git('merge', '--squash', branch);
    await this.git('commit', '-m', message);
  }

  async deleteBranch(name: string, force = false): Promise<void> {
    await this.git('branch', force ? '-D' : '-d', name);
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

function parseStatusInfo(text: string): WorktreeStatus {
  let branch: string | null = null;
  let modified = 0;
  let untracked = 0;
  let ahead = 0;
  let behind = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (line.startsWith('## ')) {
      const header = line.slice(3);
      const branchMatch = header.match(/^([^.\s]+)/);
      if (branchMatch && branchMatch[1]) branch = branchMatch[1];
      const aheadMatch = header.match(/ahead (\d+)/);
      const behindMatch = header.match(/behind (\d+)/);
      if (aheadMatch && aheadMatch[1]) ahead = parseInt(aheadMatch[1], 10);
      if (behindMatch && behindMatch[1]) behind = parseInt(behindMatch[1], 10);
    } else {
      const code = line.slice(0, 2);
      if (code === '??') untracked++;
      else if (code.trim()) modified++;
    }
  }
  return { branch, modified, untracked, ahead, behind };
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
