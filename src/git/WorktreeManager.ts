import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { GitOps } from './GitOps';
import { getSettings } from '../Settings';

const execFileAsync = promisify(execFile);

export interface CreateWorktreeOptions {
  branch: string;
  fromRef?: string;
  /** Opt-in per session: copy `vswt.worktree.copyFiles` patterns from the main repo. */
  copyEnv: boolean;
  output: vscode.OutputChannel;
}

export interface WorktreeRecord {
  branch: string;
  path: string;
}

export class WorktreeManager {
  constructor(private readonly repoRoot: string) {}

  async create(opts: CreateWorktreeOptions): Promise<WorktreeRecord> {
    const { output } = opts;
    const settings = getSettings();
    const targetPath = this.resolveTargetPath(opts.branch, settings.worktreeParentDir);
    output.appendLine(`[vsWT] creating worktree '${opts.branch}' at ${targetPath}`);

    const git = new GitOps(this.repoRoot);
    const addOpts: Parameters<GitOps['addWorktree']>[0] = { path: targetPath, branch: opts.branch };
    if (opts.fromRef) addOpts.fromRef = opts.fromRef;
    await git.addWorktree(addOpts);

    if (opts.copyEnv) {
      output.appendLine(`[vsWT] copying configured files from main repo (opt-in)...`);
      await this.copyConfiguredFiles(settings.worktreeCopyFiles, targetPath, output);
    }

    if (await this.hasSubmodules()) {
      output.appendLine(`[vsWT] initializing submodules...`);
      await git.initSubmodulesIn(targetPath);
    }

    if (settings.worktreePostCreateCommand.trim()) {
      output.appendLine(`[vsWT] running post-create: ${settings.worktreePostCreateCommand}`);
      await this.runShellCommand(settings.worktreePostCreateCommand, targetPath, output);
    }

    if (settings.worktreeRunPrismaGenerate && (await this.fileExists(path.join(targetPath, 'prisma', 'schema.prisma')))) {
      output.appendLine(`[vsWT] running prisma generate...`);
      try {
        await this.runShellCommand('npx prisma generate', targetPath, output);
      } catch (err) {
        output.appendLine(`[vsWT] prisma generate failed (non-fatal): ${(err as Error).message}`);
      }
    }

    output.appendLine(`[vsWT] ✓ worktree ready at ${targetPath}`);
    return { branch: opts.branch, path: targetPath };
  }

  async remove(worktreePath: string, force: boolean, output: vscode.OutputChannel): Promise<void> {
    output.appendLine(`[vsWT] removing worktree ${worktreePath} (force=${force})`);
    const git = new GitOps(this.repoRoot);
    let gitErr: Error | null = null;

    try {
      await git.removeWorktree(worktreePath, force);
      output.appendLine(`[vsWT] ✓ git worktree remove succeeded`);
    } catch (err) {
      gitErr = err as Error;
      output.appendLine(`[vsWT] git remove failed: ${gitErr.message.split('\n')[0]}`);
    }

    // Recovery path: folder still on disk (Permission denied, partial deletion, etc.).
    if (await this.fileExists(worktreePath)) {
      output.appendLine(`[vsWT] folder still on disk, fs.rm fallback (with retries)...`);
      try {
        await fs.rm(worktreePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        output.appendLine(`[vsWT] ✓ folder removed via fs.rm`);
        gitErr = null;
      } catch (err) {
        output.appendLine(`[vsWT] fs.rm failed: ${(err as Error).message}`);
        if (!gitErr) gitErr = err as Error;
      }
    } else if (gitErr) {
      // Git complained but folder is already gone — treat as success.
      output.appendLine(`[vsWT] folder already gone, treating git error as already-removed`);
      gitErr = null;
    }

    // Always prune to clean stale metadata (e.g. when only the folder existed).
    try {
      await git.pruneWorktrees();
      output.appendLine(`[vsWT] ✓ pruned metadata`);
    } catch (err) {
      output.appendLine(`[vsWT] prune warning: ${(err as Error).message}`);
    }

    if (gitErr) throw gitErr;
    output.appendLine(`[vsWT] ✓ removed`);
  }

  async rename(
    oldPath: string,
    oldBranch: string,
    newBranch: string,
    output: vscode.OutputChannel
  ): Promise<WorktreeRecord> {
    const settings = getSettings();
    const newPath = this.resolveTargetPath(newBranch, settings.worktreeParentDir);
    output.appendLine(`[vsWT] renaming '${oldBranch}' → '${newBranch}'`);
    output.appendLine(`[vsWT]   path: ${oldPath} → ${newPath}`);

    if (oldPath === newPath && oldBranch === newBranch) {
      return { branch: oldBranch, path: oldPath };
    }

    const git = new GitOps(this.repoRoot);

    if (oldBranch !== newBranch && oldBranch !== '(detached)') {
      if (await git.branchExists(newBranch)) {
        throw new Error(`Branch '${newBranch}' already exists`);
      }
      await git.renameBranch(oldBranch, newBranch);
      output.appendLine(`[vsWT]   ✓ branch renamed`);
    }

    if (oldPath !== newPath) {
      try {
        await git.moveWorktree(oldPath, newPath);
        output.appendLine(`[vsWT]   ✓ worktree moved`);
      } catch (err) {
        const msg = (err as Error).message;
        // `git worktree move` blocks worktrees with submodules unconditionally;
        // fall back to fs.rename + `git worktree repair` for those cases.
        if (/submodule/i.test(msg)) {
          output.appendLine(`[vsWT]   git worktree move blocked by submodules; trying manual move`);
          try {
            await fs.mkdir(path.dirname(newPath), { recursive: true });
            await fs.rename(oldPath, newPath);
            await git.repairWorktrees();
            await git.pruneWorktrees();
            output.appendLine(`[vsWT]   ✓ moved manually + repaired metadata`);
            output.appendLine(`[vsWT]   note: re-run 'git submodule update --init' in new path if submodules misbehave`);
          } catch (manualErr) {
            if (oldBranch !== newBranch && oldBranch !== '(detached)') {
              try {
                await git.renameBranch(newBranch, oldBranch);
                output.appendLine(`[vsWT]   reverted branch rename`);
              } catch {
                // ignore revert failure
              }
            }
            throw new Error(`Move failed (manual fallback also): ${(manualErr as Error).message}`);
          }
        } else {
          if (oldBranch !== newBranch && oldBranch !== '(detached)') {
            try {
              await git.renameBranch(newBranch, oldBranch);
              output.appendLine(`[vsWT]   reverted branch rename after move failure`);
            } catch {
              // ignore revert failure
            }
          }
          throw err;
        }
      }
    }

    output.appendLine(`[vsWT] ✓ renamed`);
    return { branch: newBranch, path: newPath };
  }

  async list(): Promise<WorktreeRecord[]> {
    const all = await new GitOps(this.repoRoot).listWorktrees();
    return all
      .filter(w => path.resolve(w.path) !== path.resolve(this.repoRoot) && !w.bare)
      .map(w => ({ path: w.path, branch: w.branch ?? '(detached)' }));
  }

  resolveTargetPath(branch: string, parentDirOverride: string): string {
    const safeBranch = branch.replace(/[\\/]/g, '-');
    const repoName = path.basename(this.repoRoot);
    const parentDir = parentDirOverride
      ? this.expandPath(parentDirOverride)
      : path.resolve(this.repoRoot, '..', `${repoName}-worktrees`);
    return path.join(parentDir, safeBranch);
  }

  private expandPath(p: string): string {
    if (p.startsWith('~')) {
      const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
      return path.join(home, p.slice(1));
    }
    return path.isAbsolute(p) ? p : path.resolve(this.repoRoot, p);
  }

  private async fileExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private async hasSubmodules(): Promise<boolean> {
    return this.fileExists(path.join(this.repoRoot, '.gitmodules'));
  }

  private async copyConfiguredFiles(patterns: string[], targetPath: string, output: vscode.OutputChannel): Promise<void> {
    for (const pattern of patterns) {
      const matches = await this.resolveCopyTargets(pattern);
      if (matches.length === 0) {
        output.appendLine(`[vsWT]   · no match for ${pattern}`);
        continue;
      }
      for (const src of matches) {
        const rel = path.relative(this.repoRoot, src);
        const dest = path.join(targetPath, rel);
        try {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.cp(src, dest, { recursive: true, force: false, errorOnExist: false });
          output.appendLine(`[vsWT]   + ${rel}`);
        } catch (err) {
          output.appendLine(`[vsWT]   ! failed to copy ${rel}: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Minimal pattern resolver: exact path, single-`*` filename glob, or recursive `dir/**`. */
  private async resolveCopyTargets(pattern: string): Promise<string[]> {
    // Recursive: `dir/**` or `dir/**/*`
    const recursive = pattern.match(/^([^*]+)\/\*\*(?:\/\*)?$/);
    if (recursive && recursive[1]) {
      const full = path.join(this.repoRoot, recursive[1]);
      return (await this.fileExists(full)) ? [full] : [];
    }
    // Filename glob: `*.env`, `.env.*` (single `*`, no slashes after)
    if (pattern.includes('*')) {
      const dir = path.join(this.repoRoot, path.dirname(pattern));
      const filename = path.basename(pattern);
      const re = new RegExp('^' + filename.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      try {
        const entries = await fs.readdir(dir);
        return entries.filter(e => re.test(e)).map(e => path.join(dir, e));
      } catch {
        return [];
      }
    }
    // Exact path
    const full = path.join(this.repoRoot, pattern);
    return (await this.fileExists(full)) ? [full] : [];
  }

  private async runShellCommand(cmd: string, cwd: string, output: vscode.OutputChannel): Promise<void> {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : '/bin/sh';
    const flag = isWin ? '/c' : '-c';
    try {
      const { stdout, stderr } = await execFileAsync(shell, [flag, cmd], { cwd, maxBuffer: 50 * 1024 * 1024 });
      if (stdout) output.append(stdout);
      if (stderr) output.append(stderr);
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      if (e.stdout) output.append(e.stdout);
      if (e.stderr) output.append(e.stderr);
      throw new Error(`Command failed (exit ${e.code ?? '?'}): ${cmd}`);
    }
  }
}
