import * as vscode from 'vscode';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitOps } from './git/GitOps';
import { WorktreeManager } from './git/WorktreeManager';
import { SessionRegistry, AgentType } from './SessionRegistry';
import { SidebarHost } from './webview/SidebarHost';
import { getSettings, initSettings } from './Settings';
import { readClipboardImage, formatImageReference } from './clipboard';
import type { AppState, RpcRequest, WorktreeDTO, SessionDTO, ExtraShellDTO } from './webview/protocol';

const execFileAsync = promisify(execFile);
const MAX_FILES_PER_WORKTREE = 50;

const STATE_KEY_REPO = 'vswt.selectedRepo';
const STATE_KEY_PINNED = 'vswt.pinnedPaths';
const STATE_KEY_BASES = 'vswt.worktreeBases';

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

async function getCurrentRepo(context: vscode.ExtensionContext): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;

  const cached = context.workspaceState.get<string>(STATE_KEY_REPO);
  if (cached && folders.some(f => f.uri.fsPath === cached)) {
    if (await new GitOps(cached).isGitRepo()) return cached;
  }

  if (folders.length === 1) {
    const single = folders[0]!.uri.fsPath;
    if (await new GitOps(single).isGitRepo()) {
      const root = (await new GitOps(single).getRepoRoot()).trim();
      await context.workspaceState.update(STATE_KEY_REPO, root);
      return root;
    }
  }
  return null;
}

async function pickRepo(context: vscode.ExtensionContext): Promise<string | null> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    void vscode.window.showErrorMessage('vsWT: open a folder in VS Code first.');
    return null;
  }

  const probed = await Promise.all(
    folders.map(async f => ({
      label: f.name,
      description: f.uri.fsPath,
      fsPath: f.uri.fsPath,
      isGit: await new GitOps(f.uri.fsPath).isGitRepo()
    }))
  );

  const candidates = probed.filter(i => i.isGit);
  if (candidates.length === 0) {
    void vscode.window.showErrorMessage('vsWT: no git repository found in the workspace.');
    return null;
  }

  const pick = candidates.length === 1
    ? candidates[0]!
    : await vscode.window.showQuickPick(
        candidates.map(i => ({ label: i.label, description: i.description, fsPath: i.fsPath })),
        { placeHolder: 'Pick the main repo for vsWT' }
      );
  if (!pick) return null;

  const root = (await new GitOps(pick.fsPath).getRepoRoot()).trim();
  await context.workspaceState.update(STATE_KEY_REPO, root);
  return root;
}

async function ensureRepo(context: vscode.ExtensionContext): Promise<string | null> {
  return (await getCurrentRepo(context)) ?? (await pickRepo(context));
}

async function buildState(
  context: vscode.ExtensionContext,
  registry: SessionRegistry
): Promise<AppState> {
  const repoRoot = await getCurrentRepo(context);
  if (!repoRoot) {
    return { repoLabel: '', worktrees: [], sessions: [], extraShells: [] };
  }

  const repoLabel = path.basename(repoRoot);
  const pinned = getPinnedPaths(context);
  const bases = getBases(context);
  let worktrees: WorktreeDTO[] = [];
  try {
    const list = await new WorktreeManager(repoRoot).list();
    worktrees = await Promise.all(
      list.map(async w => {
        const base = bases[w.path] ?? null;
        try {
          const wgit = new GitOps(w.path);
          const [status, files] = await Promise.all([
            wgit.statusInfo(),
            wgit.statusFiles()
          ]);
          return {
            branch: w.branch,
            path: w.path,
            pinned: pinned.has(w.path),
            base,
            status: {
              modified: status.modified,
              untracked: status.untracked,
              ahead: status.ahead,
              behind: status.behind,
              files: files.slice(0, MAX_FILES_PER_WORKTREE)
            }
          } satisfies WorktreeDTO;
        } catch {
          return {
            branch: w.branch,
            path: w.path,
            pinned: pinned.has(w.path),
            base
          } satisfies WorktreeDTO;
        }
      })
    );
    worktrees.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.branch.localeCompare(b.branch);
    });
  } catch {
    worktrees = [];
  }

  const sessions: SessionDTO[] = [];
  for (const w of worktrees) {
    for (const s of registry.forWorktree(w.path)) {
      sessions.push({
        id: s.id,
        worktreePath: s.worktreePath,
        branch: s.branch,
        agentType: s.agentType,
        label: s.label,
        state: s.state,
        createdAt: s.createdAt
      });
    }
  }

  const extraShells: ExtraShellDTO[] = getSettings().extraShells.map(s => ({
    name: s.name,
    command: s.command,
    args: s.args ?? []
  }));

  return { repoLabel, worktrees, sessions, extraShells };
}

async function createWorktreeFlow(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  refresh: () => Promise<void>
): Promise<void> {
  const repoRoot = await ensureRepo(context);
  if (!repoRoot) return;

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
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  registry: SessionRegistry,
  refresh: () => Promise<void>
): Promise<void> {
  const repoRoot = await ensureRepo(context);
  if (!repoRoot) return;

  const list = await new WorktreeManager(repoRoot).list();
  const target = list.find(w => w.path === worktreePath);
  if (!target) {
    void vscode.window.showWarningMessage(`vsWT: worktree not found: ${worktreePath}`);
    return;
  }

  const sessionsHere = registry.forWorktree(target.path);
  const sessionNote = sessionsHere.length > 0
    ? ` Will also stop ${sessionsHere.length} active session${sessionsHere.length > 1 ? 's' : ''}.`
    : '';

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
    `Remove worktree '${target.branch}' at ${target.path}?${sessionNote}${dirtyNote}`,
    { modal: true },
    'Remove',
    'Force remove'
  );
  if (!confirm) return;

  for (const s of sessionsHere) registry.stop(s.id);
  if (sessionsHere.length > 0) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }

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
  newBranchInput: string,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  registry: SessionRegistry,
  refresh: () => Promise<void>
): Promise<void> {
  const repoRoot = await ensureRepo(context);
  if (!repoRoot) return;

  const list = await new WorktreeManager(repoRoot).list();
  const target = list.find(w => w.path === worktreePath);
  if (!target) {
    void vscode.window.showWarningMessage(`vsWT: worktree not found: ${worktreePath}`);
    return;
  }

  const newBranch = newBranchInput.trim();
  if (!newBranch || newBranch === target.branch) return;

  const sessionsHere = registry.forWorktree(target.path);
  if (sessionsHere.length > 0) {
    const proceed = await vscode.window.showWarningMessage(
      `Renaming will close ${sessionsHere.length} active session${sessionsHere.length > 1 ? 's' : ''}. Continue?`,
      { modal: true },
      'Continue'
    );
    if (!proceed) return;
    for (const s of sessionsHere) registry.stop(s.id);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

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
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  registry: SessionRegistry,
  refresh: () => Promise<void>
): Promise<void> {
  const repoRoot = await ensureRepo(context);
  if (!repoRoot) return;

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

        const sessionsHere = registry.forWorktree(target.path);
        for (const s of sessionsHere) registry.stop(s.id);
        if (sessionsHere.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
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

async function startSessionByPath(
  worktreePath: string,
  agentType: AgentType,
  shellName: string | undefined,
  context: vscode.ExtensionContext,
  registry: SessionRegistry,
  refresh: () => Promise<void>
): Promise<void> {
  const repoRoot = await ensureRepo(context);
  if (!repoRoot) return;
  const list = await new WorktreeManager(repoRoot).list();
  const target = list.find(w => w.path === worktreePath);
  if (!target) {
    void vscode.window.showWarningMessage(`vsWT: worktree not found: ${worktreePath}`);
    return;
  }
  let shellOverride: { name: string; command: string; args?: string[] } | undefined;
  if (agentType === 'shell' && shellName) {
    const found = getSettings().extraShells.find(s => s.name === shellName);
    if (found) {
      shellOverride = { name: found.name, command: found.command };
      if (found.args && found.args.length > 0) shellOverride.args = found.args;
    }
  }
  registry.start({ branch: target.branch, path: target.path }, agentType, shellOverride);
  await refresh();
}

async function startSessionInteractive(
  agentType: AgentType,
  context: vscode.ExtensionContext,
  registry: SessionRegistry,
  refresh: () => Promise<void>
): Promise<void> {
  const repoRoot = await ensureRepo(context);
  if (!repoRoot) return;
  const list = await new WorktreeManager(repoRoot).list();
  if (list.length === 0) {
    void vscode.window.showInformationMessage('vsWT: create a worktree first.');
    return;
  }
  const pick = await vscode.window.showQuickPick(
    list.map(w => ({ label: w.branch, description: w.path, w })),
    { placeHolder: `Pick worktree to start ${agentType} session in` }
  );
  if (!pick) return;
  registry.start(pick.w, agentType);
  await refresh();
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('vsWT');
  const registry = new SessionRegistry();

  let host: SidebarHost; // assigned below

  const refreshState = async (): Promise<void> => {
    if (host) await host.pushState();
  };

  const handleRequest = async (req: RpcRequest): Promise<unknown> => {
    switch (req.type) {
      case 'ready':
        await refreshState();
        return undefined;

      case 'pickRepo':
        await pickRepo(context);
        await refreshState();
        return undefined;

      case 'createWorktree':
        await createWorktreeFlow(context, output, refreshState);
        return undefined;

      case 'removeWorktree':
        await removeWorktreeFlow(req.path, context, output, registry, refreshState);
        return undefined;

      case 'renameWorktree':
        await renameWorktreeFlow(req.path, req.newBranch, context, output, registry, refreshState);
        return undefined;

      case 'pushWorktree':
        await syncWorktreeFlow(req.path, 'push', output, refreshState);
        return undefined;

      case 'pullWorktree':
        await syncWorktreeFlow(req.path, 'pull', output, refreshState);
        return undefined;

      case 'fetchWorktree':
        await syncWorktreeFlow(req.path, 'fetch', output, refreshState);
        return undefined;

      case 'showFileDiff':
        await showFileDiffFlow(req.worktreePath, req.relativePath, req.statusCode);
        return undefined;

      case 'createPR':
        await createPRFlow(req.path, output, refreshState);
        return undefined;

      case 'finishWorktree':
        await finishWorktreeFlow(req.path, context, output, registry, refreshState);
        return undefined;

      case 'togglePin': {
        const pinned = getPinnedPaths(context);
        await setPinned(context, req.path, !pinned.has(req.path));
        await refreshState();
        return undefined;
      }

      case 'startSession':
        await startSessionByPath(req.worktreePath, req.agentType, req.shellName, context, registry, refreshState);
        return undefined;

      case 'stopSession':
        registry.stop(req.sessionId);
        return undefined;

      case 'showSession':
        registry.show(req.sessionId);
        return undefined;

      case 'resumeSession':
        registry.resume(req.sessionId);
        return undefined;

      case 'openWorktree':
        await vscode.commands.executeCommand(
          'vscode.openFolder',
          vscode.Uri.file(req.path),
          { forceNewWindow: req.newWindow }
        );
        return undefined;

      case 'openTerminal': {
        const term = vscode.window.createTerminal({
          name: `${path.basename(req.path)} · terminal`,
          cwd: vscode.Uri.file(req.path)
        });
        term.show();
        return undefined;
      }

      default:
        throw new Error(`Unknown request: ${(req as { type: string }).type}`);
    }
  };

  host = new SidebarHost(
    context.extensionUri,
    handleRequest,
    () => buildState(context, registry)
  );

  // Probe for installed shells in the background; refresh sidebar once done.
  void initSettings().then(() => void refreshState());

  // Track when the active terminal belongs to vsWT so the Ctrl+V keybinding
  // only fires inside our sessions.
  const updateTerminalContext = (term: vscode.Terminal | undefined): void => {
    const isOurs = term !== undefined && registry.getSessionForTerminal(term) !== null;
    void vscode.commands.executeCommand('setContext', 'vswt.terminalActive', isOurs);
  };
  updateTerminalContext(vscode.window.activeTerminal);

  const pasteImageHandler = async (): Promise<void> => {
    const term = vscode.window.activeTerminal;
    if (!term) return;

    // Fast path: if there's any text on the clipboard, use the standard paste.
    const text = await vscode.env.clipboard.readText();
    if (text.length > 0) {
      await vscode.commands.executeCommand('workbench.action.terminal.paste');
      return;
    }

    // No text — try to extract an image (Windows only for now).
    try {
      const imgPath = await readClipboardImage();
      if (imgPath) {
        term.sendText(formatImageReference(imgPath), false);
        output.appendLine(`[vsWT] image pasted: ${imgPath}`);
      } else {
        // Nothing on the clipboard, or unsupported platform.
        await vscode.commands.executeCommand('workbench.action.terminal.paste');
      }
    } catch (err) {
      output.appendLine(`[vsWT] paste image failed: ${(err as Error).message}`);
      await vscode.commands.executeCommand('workbench.action.terminal.paste');
    }
  };

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'vswt.openSidebar';
  statusBar.name = 'vsWT';

  const refreshIndicators = (): void => {
    const count = registry.count();
    if (count === 0) {
      host.setBadge(0);
      statusBar.hide();
      return;
    }
    host.setBadge(count);
    const word = count === 1 ? 'session' : 'sessions';
    statusBar.text = `$(sparkle) ${count} ${word}`;
    statusBar.tooltip = `vsWT: ${count} active ${word}`;
    statusBar.show();
  };

  context.subscriptions.push(
    output,
    statusBar,
    registry.init(context),
    registry.onChange(() => {
      refreshIndicators();
      void refreshState();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshState()),
    vscode.window.registerWebviewViewProvider(SidebarHost.viewType, host),
    vscode.commands.registerCommand('vswt.openSidebar', () => {
      void vscode.commands.executeCommand('workbench.view.extension.vswt');
    }),
    vscode.commands.registerCommand('vswt.refreshWorktrees', () => void refreshState()),
    vscode.commands.registerCommand('vswt.pickRepo', async () => {
      await pickRepo(context);
      await refreshState();
    }),
    vscode.commands.registerCommand('vswt.createWorktree', () =>
      createWorktreeFlow(context, output, refreshState)
    ),
    vscode.commands.registerCommand('vswt.startClaudeSession', () =>
      startSessionInteractive('claude', context, registry, refreshState)
    ),
    vscode.commands.registerCommand('vswt.startShellSession', () =>
      startSessionInteractive('shell', context, registry, refreshState)
    ),
    vscode.commands.registerCommand('vswt.pasteImage', pasteImageHandler),
    vscode.window.onDidChangeActiveTerminal(updateTerminalContext),
    registry.onChange(() => updateTerminalContext(vscode.window.activeTerminal))
  );
}

export function deactivate(): void {
  // disposables handled by context.subscriptions
}
