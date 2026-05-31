import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitOps } from './git/GitOps';
import { WorktreeManager } from './git/WorktreeManager';
import { initSettings } from './Settings';
import { normalizePath } from './sessions/path-utils';
import { registerSessionsExplorer } from './sessions/sessions-explorer';
import { registerUsage } from './usage';

const execFileAsync = promisify(execFile);

const STATE_KEY_PINNED = 'vswt.pinnedPaths';
const STATE_KEY_BASES = 'vswt.worktreeBases';
const STATE_KEY_SESSION_NAMES = 'vswt.sessionNames';
const STATE_KEY_BOOKMARKS = 'vswt.sessionBookmarks';

function getSessionNames(context: vscode.ExtensionContext): Record<string, string> {
  return { ...(context.globalState.get<Record<string, string>>(STATE_KEY_SESSION_NAMES) ?? {}) };
}

async function setSessionName(
  context: vscode.ExtensionContext,
  sessionId: string,
  name: string
): Promise<void> {
  const names = getSessionNames(context);
  if (name) names[sessionId] = name;
  else delete names[sessionId];
  await context.globalState.update(STATE_KEY_SESSION_NAMES, names);
}

function getBookmarks(context: vscode.ExtensionContext): Set<string> {
  return new Set(context.globalState.get<string[]>(STATE_KEY_BOOKMARKS) ?? []);
}

async function toggleBookmark(context: vscode.ExtensionContext, sessionId: string): Promise<boolean> {
  const set = getBookmarks(context);
  const next = !set.has(sessionId);
  if (next) set.add(sessionId);
  else set.delete(sessionId);
  await context.globalState.update(STATE_KEY_BOOKMARKS, [...set]);
  return next;
}

function getPinnedPaths(context: vscode.ExtensionContext): Set<string> {
  return new Set(context.workspaceState.get<string[]>(STATE_KEY_PINNED) ?? []);
}

async function setPinned(context: vscode.ExtensionContext, path: string, pinned: boolean): Promise<void> {
  const set = getPinnedPaths(context);
  if (pinned) set.add(path);
  else set.delete(path);
  await context.workspaceState.update(STATE_KEY_PINNED, [...set]);
}

function getBases(context: vscode.ExtensionContext): Record<string, string> {
  return { ...(context.workspaceState.get<Record<string, string>>(STATE_KEY_BASES) ?? {}) };
}

async function setBase(context: vscode.ExtensionContext, worktreePath: string, base: string): Promise<void> {
  const bases = getBases(context);
  bases[worktreePath] = base;
  await context.workspaceState.update(STATE_KEY_BASES, bases);
}

async function deleteBase(context: vscode.ExtensionContext, worktreePath: string): Promise<void> {
  const bases = getBases(context);
  if (worktreePath in bases) {
    delete bases[worktreePath];
    await context.workspaceState.update(STATE_KEY_BASES, bases);
  }
}

async function moveBase(
  context: vscode.ExtensionContext,
  oldPath: string,
  newPath: string
): Promise<void> {
  const bases = getBases(context);
  if (oldPath in bases) {
    bases[newPath] = bases[oldPath]!;
    delete bases[oldPath];
    await context.workspaceState.update(STATE_KEY_BASES, bases);
  }
}

function getRepoScanDepth(): number {
  const n = vscode.workspace.getConfiguration('vswt').get<number>('repoScanDepth');
  return typeof n === 'number' && n >= 0 ? Math.floor(n) : 1;
}

/** Discover git repositories under the workspace folders, down to `depth` levels.
 * Each candidate is resolved to its main repo root via `--git-common-dir`, so
 * linked worktree folders fold into their repo instead of appearing twice. */
async function discoverRepos(depth: number): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return [];

  const candidates: string[] = [];
  await Promise.all(folders.map(f => collectRepoCandidates(f.uri.fsPath, depth, candidates)));

  const mains = new Map<string, string>();
  await Promise.all(
    candidates.map(async dir => {
      const main = await mainRepoRoot(dir);
      if (main) mains.set(normalizePath(main), main);
    })
  );
  return [...mains.values()];
}

async function collectRepoCandidates(dir: string, depth: number, out: string[]): Promise<void> {
  if (await new GitOps(dir).isGitRepo()) {
    out.push(dir);
    return;
  }
  if (depth <= 0) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async e => {
      if (!e.isDirectory() || e.name === 'node_modules' || e.name.startsWith('.')) return;
      await collectRepoCandidates(path.join(dir, e.name), depth - 1, out);
    })
  );
}

async function mainRepoRoot(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--git-common-dir'], {
      maxBuffer: 1024 * 1024
    });
    const common = stdout.trim();
    if (!common) return null;
    const abs = path.isAbsolute(common) ? common : path.resolve(dir, common);
    return path.dirname(abs);
  } catch {
    return null;
  }
}

async function pickRepoForCreate(): Promise<string | null> {
  const repos = await discoverRepos(getRepoScanDepth());
  if (repos.length === 0) {
    void vscode.window.showErrorMessage('vsWT: no git repository found in the workspace.');
    return null;
  }
  if (repos.length === 1) return repos[0]!;
  const pick = await vscode.window.showQuickPick(
    repos.map(r => ({ label: path.basename(r), description: r, root: r })),
    { placeHolder: 'Pick repository for the new worktree' }
  );
  return pick ? pick.root : null;
}

async function createWorktreeFlow(
  repoRoot: string,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  refresh: () => Promise<void>
): Promise<void> {
  const branch = await vscode.window.showInputBox({
    prompt: 'Branch name for the new worktree',
    placeHolder: 'feat/my-feature',
    validateInput: v => (v.trim() ? null : 'Branch name is required')
  });
  if (!branch) return;

  // Pick base ref to branch off from.
  let fromRef: string | undefined;
  try {
    const branches = await new GitOps(repoRoot).listBranches();
    const current = branches.find(b => b.isCurrent);
    type RefItem = { label: string; description?: string; ref?: string };
    const items: RefItem[] = [];
    items.push({
      label: '$(git-branch) Current HEAD',
      description: current ? current.name : '(detached)'
    });
    for (const b of branches) {
      if (b.isCurrent || b.isRemote) continue;
      items.push({ label: b.name, description: 'local' });
    }
    for (const b of branches) {
      if (!b.isRemote) continue;
      items.push({ label: b.name, description: 'remote' });
    }
    const baseChoice = await vscode.window.showQuickPick(items, {
      placeHolder: 'Branch off from…'
    });
    if (!baseChoice) return;
    fromRef = baseChoice.label.startsWith('$(git-branch)') ? undefined : baseChoice.label;
  } catch {
    // Listing branches failed — fall back to current HEAD silently.
  }

  const copyChoice = await vscode.window.showQuickPick(
    [
      { label: 'No', value: false, description: 'Skip secrets/config copy' },
      { label: 'Yes — copy .env*, .claude/**', value: true, description: 'From vswt.worktree.copyFiles' }
    ],
    { placeHolder: 'Copy local config files into the new worktree?' }
  );
  if (!copyChoice) return;

  output.show(true);
  try {
    const opts: Parameters<WorktreeManager['create']>[0] = {
      branch: branch.trim(),
      copyEnv: copyChoice.value,
      output
    };
    if (fromRef) opts.fromRef = fromRef;
    const result = await new WorktreeManager(repoRoot).create(opts);

    // Record the base we forked from. If user kept "Current HEAD", capture it now
    // so the Finish flow can pre-select the right merge target later.
    let baseToRecord = fromRef;
    if (!baseToRecord) {
      try {
        baseToRecord = (await new GitOps(repoRoot).currentBranch()) ?? undefined;
      } catch {
        // ignore
      }
    }
    if (baseToRecord) {
      await setBase(context, result.path, baseToRecord);
    }

    await refresh();
    void vscode.window.showInformationMessage(
      `vsWT: worktree '${result.branch}' created${baseToRecord ? ` from ${baseToRecord}` : ''}.`
    );
  } catch (err) {
    output.appendLine(`[vsWT] ERROR: ${(err as Error).message}`);
    void vscode.window.showErrorMessage(`vsWT: ${(err as Error).message}`);
  }
}

async function removeWorktreeFlow(
  worktreePath: string,
  repoRoot: string,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  refresh: () => Promise<void>
): Promise<void> {
  const list = await new WorktreeManager(repoRoot).list();
  const target = list.find(w => w.path === worktreePath);
  if (!target) {
    void vscode.window.showWarningMessage(`vsWT: worktree not found: ${worktreePath}`);
    return;
  }

  let dirtyNote = '';
  try {
    const status = await new GitOps(target.path).statusInfo();
    const lostParts: string[] = [];
    if (status.modified > 0) lostParts.push(`${status.modified} modified`);
    if (status.untracked > 0) lostParts.push(`${status.untracked} untracked`);
    if (lostParts.length > 0) {
      dirtyNote = ` ⚠ ${lostParts.join(', ')} file${status.modified + status.untracked > 1 ? 's' : ''} will be lost.`;
    }
  } catch {
    // Status unreadable — silently skip the dirty note.
  }

  const confirm = await vscode.window.showWarningMessage(
    `Remove worktree '${target.branch}' at ${target.path}?${dirtyNote}`,
    { modal: true },
    'Remove',
    'Force remove'
  );
  if (!confirm) return;

  const manager = new WorktreeManager(repoRoot);
  output.show(true);
  const initialForce = confirm === 'Force remove';
  try {
    await manager.remove(target.path, initialForce, output);
    await deleteBase(context, target.path);
    await refresh();
  } catch (err) {
    const msg = (err as Error).message;
    output.appendLine(`[vsWT] ERROR: ${msg}`);

    if (!initialForce && /modified|untracked|submodule|--force|locked/i.test(msg)) {
      const retry = await vscode.window.showWarningMessage(
        `Remove failed: ${msg.split('\n')[0]}\n\nForce remove?`,
        { modal: true },
        'Force remove'
      );
      if (retry === 'Force remove') {
        try {
          await manager.remove(target.path, true, output);
          await deleteBase(context, target.path);
          await refresh();
          return;
        } catch (err2) {
          output.appendLine(`[vsWT] ERROR (retry): ${(err2 as Error).message}`);
          void vscode.window.showErrorMessage(`vsWT: ${(err2 as Error).message}`);
          return;
        }
      }
    }
    void vscode.window.showErrorMessage(`vsWT: ${msg}`);
  }
}

async function renameWorktreeFlow(
  worktreePath: string,
  repoRoot: string,
  newBranchInput: string,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  refresh: () => Promise<void>
): Promise<void> {
  const list = await new WorktreeManager(repoRoot).list();
  const target = list.find(w => w.path === worktreePath);
  if (!target) {
    void vscode.window.showWarningMessage(`vsWT: worktree not found: ${worktreePath}`);
    return;
  }

  const newBranch = newBranchInput.trim();
  if (!newBranch || newBranch === target.branch) return;

  output.show(true);
  try {
    const result = await new WorktreeManager(repoRoot).rename(
      target.path,
      target.branch,
      newBranch,
      output
    );
    await moveBase(context, target.path, result.path);
    await refresh();
    void vscode.window.showInformationMessage(`vsWT: renamed to '${result.branch}'.`);
  } catch (err) {
    output.appendLine(`[vsWT] ERROR: ${(err as Error).message}`);
    void vscode.window.showErrorMessage(`vsWT: ${(err as Error).message}`);
  }
}

async function finishWorktreeFlow(
  worktreePath: string,
  repoRoot: string,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  refresh: () => Promise<void>
): Promise<void> {
  const list = await new WorktreeManager(repoRoot).list();
  const target = list.find(w => w.path === worktreePath);
  if (!target) {
    void vscode.window.showWarningMessage(`vsWT: worktree not found: ${worktreePath}`);
    return;
  }

  // Pick target branch (where to merge into).
  const branches = await new GitOps(repoRoot).listBranches(false);
  const baseItems = branches
    .filter(b => b.name !== target.branch && !b.isRemote)
    .map(b => ({ label: b.name, description: b.isCurrent ? '(currently checked out in main repo)' : '' }));
  if (baseItems.length === 0) {
    void vscode.window.showErrorMessage('vsWT: no other local branches to merge into.');
    return;
  }

  const recordedBase = getBases(context)[target.path];

  // Sort: recorded base first, then main/master/staging/develop, then everything else.
  baseItems.sort((a, b) => {
    if (recordedBase) {
      if (a.label === recordedBase && b.label !== recordedBase) return -1;
      if (b.label === recordedBase && a.label !== recordedBase) return 1;
    }
    const score = (n: string) => (n === 'main' ? 0 : n === 'master' ? 1 : n === 'staging' || n === 'develop' ? 2 : 3);
    return score(a.label) - score(b.label);
  });

  // Annotate the recorded base so user knows it's the original fork point.
  if (recordedBase) {
    const idx = baseItems.findIndex(i => i.label === recordedBase);
    if (idx >= 0 && baseItems[idx]) {
      const item = baseItems[idx];
      const desc = item.description ? `${item.description} · forked from` : 'forked from';
      baseItems[idx] = { label: item.label, description: desc };
    }
  }

  const baseChoice = await vscode.window.showQuickPick(baseItems, {
    placeHolder: `Merge '${target.branch}' into…${recordedBase ? ` (forked from ${recordedBase})` : ''}`
  });
  if (!baseChoice) return;
  const targetBranch = baseChoice.label;

  const mode = await vscode.window.showWarningMessage(
    `Finish worktree '${target.branch}' → '${targetBranch}'?\n\nWill push, switch main repo, merge, push, and remove the worktree.`,
    { modal: true },
    'Merge (no-ff)',
    'Squash merge'
  );
  if (!mode) return;
  const squash = mode === 'Squash merge';

  // Pre-flight: main repo must be clean to switch branch.
  const mainGit = new GitOps(repoRoot);
  try {
    const mainStatus = await mainGit.statusInfo();
    if (mainStatus.modified > 0 || mainStatus.untracked > 0) {
      void vscode.window.showErrorMessage(
        `vsWT: main repo at ${repoRoot} has uncommitted changes. Commit or stash before finishing.`
      );
      return;
    }
  } catch {
    // status failed — proceed cautiously
  }

  output.show(true);
  output.appendLine(`[vsWT] finishing '${target.branch}' → '${targetBranch}' (${squash ? 'squash' : 'no-ff'})`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `vsWT: finish ${target.branch}`,
      cancellable: false
    },
    async progress => {
      const featureGit = new GitOps(target.path);
      try {
        progress.report({ message: 'pushing feature…' });
        if (!(await featureGit.refExists(`refs/remotes/origin/${target.branch}`))) {
          output.appendLine(`[vsWT] pushing ${target.branch}`);
          await featureGit.push();
        }

        const originalBranch = await mainGit.currentBranch();

        progress.report({ message: `checkout ${targetBranch}…` });
        output.appendLine(`[vsWT] checkout ${targetBranch} (was ${originalBranch ?? '?'})`);
        await mainGit.checkout(targetBranch);

        progress.report({ message: `pulling ${targetBranch}…` });
        try {
          output.appendLine(`[vsWT] pull ${targetBranch}`);
          await mainGit.pull();
        } catch (err) {
          output.appendLine(`[vsWT] pull warning (continuing): ${(err as Error).message.split('\n')[0]}`);
        }

        progress.report({ message: `merging ${target.branch}…` });
        output.appendLine(`[vsWT] merge ${target.branch} ${squash ? '(squash)' : '(--no-ff)'}`);
        try {
          if (squash) {
            await mainGit.mergeSquash(target.branch, `Squash merge of ${target.branch}`);
          } else {
            await mainGit.merge(target.branch, true);
          }
          output.appendLine(`[vsWT] ✓ merged`);
        } catch (err) {
          throw new Error(
            `Merge failed (likely conflict). Main repo is on '${targetBranch}'. Resolve manually, then commit.\n${(err as Error).message.split('\n')[0]}`
          );
        }

        progress.report({ message: `pushing ${targetBranch}…` });
        try {
          output.appendLine(`[vsWT] push ${targetBranch}`);
          await mainGit.push();
        } catch (err) {
          output.appendLine(`[vsWT] push failed (non-fatal): ${(err as Error).message.split('\n')[0]}`);
        }

        progress.report({ message: 'removing worktree…' });
        await new WorktreeManager(repoRoot).remove(target.path, true, output);
        await deleteBase(context, target.path);

        try {
          await mainGit.deleteBranch(target.branch);
          output.appendLine(`[vsWT] ✓ deleted local branch ${target.branch}`);
        } catch {
          // Squash merge leaves branch unmerged from git's POV; user can delete via -D later.
          output.appendLine(`[vsWT] note: local branch ${target.branch} kept (use -D to force-delete)`);
        }

        output.appendLine(`[vsWT] ✓ finish complete`);
        await refresh();
        void vscode.window.showInformationMessage(
          `vsWT: '${target.branch}' merged into '${targetBranch}' and cleaned up.${
            originalBranch && originalBranch !== targetBranch ? ` Main repo is now on '${targetBranch}'.` : ''
          }`
        );
      } catch (err) {
        const msg = (err as Error).message;
        output.appendLine(`[vsWT] ERROR: ${msg}`);
        void vscode.window.showErrorMessage(`vsWT: finish failed — ${msg.split('\n')[0]}`);
        await refresh();
      }
    }
  );
}

async function showFileDiffFlow(
  worktreePath: string,
  relativePath: string,
  statusCode: string
): Promise<void> {
  const filePath = path.join(worktreePath, relativePath);
  const fileUri = vscode.Uri.file(filePath);

  if (statusCode.trim().startsWith('?')) {
    // Untracked file — no HEAD version, just open it.
    await vscode.window.showTextDocument(fileUri, { preview: true });
    return;
  }

  // Use the `git:` URI scheme served by VS Code's built-in git extension.
  const headUri = fileUri.with({
    scheme: 'git',
    query: JSON.stringify({ path: filePath, ref: 'HEAD' })
  });

  await vscode.commands.executeCommand(
    'vscode.diff',
    headUri,
    fileUri,
    `${relativePath} (HEAD ↔ Working)`,
    { preview: true }
  );
}

async function createPRFlow(
  worktreePath: string,
  output: vscode.OutputChannel,
  refresh: () => Promise<void>
): Promise<void> {
  const git = new GitOps(worktreePath);
  const branch = await git.currentBranch();
  if (!branch) {
    void vscode.window.showErrorMessage('vsWT: cannot create PR from detached HEAD');
    return;
  }

  output.show(true);
  output.appendLine(`[vsWT] preparing PR for ${branch}`);

  if (!(await git.refExists(`refs/remotes/origin/${branch}`))) {
    output.appendLine(`[vsWT] branch not on origin, pushing first...`);
    try {
      await git.push();
      output.appendLine(`[vsWT] ✓ pushed`);
    } catch (err) {
      const msg = (err as Error).message;
      output.appendLine(`[vsWT] push failed: ${msg}`);
      void vscode.window.showErrorMessage(`vsWT: push failed — ${msg.split('\n')[0]}`);
      return;
    }
  }

  output.appendLine(`[vsWT] running 'gh pr create --web'`);
  try {
    const { stdout, stderr } = await execFileAsync('gh', ['pr', 'create', '--web'], {
      cwd: worktreePath,
      maxBuffer: 1024 * 1024
    });
    if (stdout) output.append(stdout);
    if (stderr) output.append(stderr);
    output.appendLine(`[vsWT] ✓ PR creation page opened in browser`);
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message?: string };
    if (e.code === 'ENOENT') {
      void vscode.window.showErrorMessage(
        'vsWT: `gh` CLI not installed. Install from https://cli.github.com/'
      );
    } else {
      const msg = e.stderr ?? e.message ?? 'unknown error';
      output.appendLine(`[vsWT] gh failed: ${msg}`);
      void vscode.window.showErrorMessage(`vsWT: gh failed — ${msg.split('\n')[0] ?? 'unknown'}`);
    }
  } finally {
    await refresh();
  }
}

async function syncWorktreeFlow(
  worktreePath: string,
  op: 'push' | 'pull' | 'fetch',
  output: vscode.OutputChannel,
  refresh: () => Promise<void>
): Promise<void> {
  const git = new GitOps(worktreePath);
  let failureMessage: string | null = null;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `vsWT: ${op} ${path.basename(worktreePath)}`,
      cancellable: false
    },
    async () => {
      output.show(true);
      output.appendLine(`[vsWT] ${op} in ${worktreePath}`);
      try {
        const stdout =
          op === 'push' ? await git.push() :
          op === 'pull' ? await git.pull() :
          await git.fetch();
        if (stdout.trim()) output.append(stdout);
        output.appendLine(`[vsWT] ✓ ${op} done`);
      } catch (err) {
        failureMessage = (err as Error).message;
        output.appendLine(`[vsWT] ERROR: ${failureMessage}`);
      }
    }
  );

  await refresh();

  if (!failureMessage) return;

  // Quality-of-life: pull failed because branch has no upstream → offer to push first.
  if (op === 'pull' && /no upstream/i.test(failureMessage)) {
    const action = await vscode.window.showWarningMessage(
      (failureMessage as string).split('\n')[0] ?? 'No upstream branch',
      'Push first then Pull',
      'Cancel'
    );
    if (action === 'Push first then Pull') {
      await syncWorktreeFlow(worktreePath, 'push', output, refresh);
      await syncWorktreeFlow(worktreePath, 'pull', output, refresh);
    }
    return;
  }

  void vscode.window.showErrorMessage(
    `vsWT: ${op} failed — ${(failureMessage as string).split('\n')[0]}`
  );
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('vsWT');

  let treeRefresh: () => void = () => {};
  const refresh = async (): Promise<void> => {
    treeRefresh();
  };

  const explorer = registerSessionsExplorer({
    context,
    output,
    getRepos: () => discoverRepos(getRepoScanDepth()),
    getPinned: () => getPinnedPaths(context),
    getBases: () => getBases(context),
    getSessionNames: () => getSessionNames(context),
    getBookmarks: () => getBookmarks(context),
    toggleBookmark: async sessionId => {
      await toggleBookmark(context, sessionId);
      await refresh();
    },
    renameSession: async (sessionId, currentName) => {
      const name = await vscode.window.showInputBox({
        value: currentName,
        prompt: 'Session name (leave empty to reset to Claude’s title)'
      });
      if (name === undefined) return;
      await setSessionName(context, sessionId, name.trim());
      await refresh();
    },
    createWorktree: async repoRoot => {
      const root = repoRoot ?? (await pickRepoForCreate());
      if (!root) return;
      await createWorktreeFlow(root, context, output, refresh);
    },
    rename: async (worktreePath, repoRoot, currentBranch) => {
      const newBranch = await vscode.window.showInputBox({
        value: currentBranch,
        prompt: 'New branch name for the worktree',
        validateInput: v => (v.trim() ? null : 'Branch name is required')
      });
      if (!newBranch) return;
      await renameWorktreeFlow(worktreePath, repoRoot, newBranch, context, output, refresh);
    },
    remove: (worktreePath, repoRoot) => removeWorktreeFlow(worktreePath, repoRoot, context, output, refresh),
    togglePin: async worktreePath => {
      const pinned = getPinnedPaths(context);
      await setPinned(context, worktreePath, !pinned.has(worktreePath));
      await refresh();
    },
    sync: (worktreePath, op) => syncWorktreeFlow(worktreePath, op, output, refresh),
    showDiff: (worktreePath, relativePath, statusCode) =>
      showFileDiffFlow(worktreePath, relativePath, statusCode),
    createPR: worktreePath => createPRFlow(worktreePath, output, refresh),
    finish: (worktreePath, repoRoot) => finishWorktreeFlow(worktreePath, repoRoot, context, output, refresh),
    openWindow: targetPath => {
      void vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(targetPath),
        { forceNewWindow: true }
      );
    }
  });
  treeRefresh = explorer.refresh;

  registerUsage(context, explorer, output);

  // Probe for installed shells in the background; refresh the tree once done.
  void initSettings().then(() => void refresh());

  context.subscriptions.push(
    output,
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refresh()),
    vscode.commands.registerCommand('vswt.openSidebar', () => {
      void vscode.commands.executeCommand('workbench.view.extension.vswt');
    })
  );
}

export function deactivate(): void {
  // disposables handled by context.subscriptions
}
