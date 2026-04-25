import * as vscode from 'vscode';
import { GitOps } from './git/GitOps';
import { WorktreeManager } from './git/WorktreeManager';
import { SessionRegistry, SessionInfo, AgentType, AgentState } from './SessionRegistry';

const SESSION_STATE_META: Record<AgentState, { icon: string; desc: string }> = {
  running: { icon: 'pulse',        desc: '' },
  exited:  { icon: 'circle-slash', desc: 'exited' }
};

const STATE_KEY_REPO = 'vswt.selectedRepo';

type TreeNode =
  | { kind: 'pick-repo' }
  | { kind: 'message'; text: string; icon?: string }
  | { kind: 'worktree'; branch: string; path: string }
  | { kind: 'session'; session: SessionInfo };

class WorktreeTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<TreeNode | void>();
  public readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly registry: SessionRegistry
  ) {
    registry.onChange(() => this._onDidChange.fire());
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'pick-repo') {
      const item = new vscode.TreeItem('Pick repository…', vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('repo');
      item.command = { command: 'vswt.pickRepo', title: 'Pick repository' };
      return item;
    }
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(node.icon ?? 'info');
      return item;
    }
    if (node.kind === 'worktree') {
      const sessions = this.registry.forWorktree(node.path);
      const state = sessions.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
      const item = new vscode.TreeItem(node.branch, state);
      item.id = `wt:${node.path}`;
      item.description = describeWorktreeAggregate(sessions);
      item.tooltip = new vscode.MarkdownString(`**${node.branch}**\n\n\`${node.path}\``);
      item.iconPath = new vscode.ThemeIcon(pickWorktreeIcon(sessions));
      item.contextValue = 'vswt.worktree';
      item.resourceUri = vscode.Uri.file(node.path);
      return item;
    }
    const s = node.session;
    const label = s.agentType === 'claude' ? 'Claude' : 'Shell';
    const meta = SESSION_STATE_META[s.state];
    const description = meta.desc ? `${s.branch} · ${meta.desc}` : s.branch;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = `sess:${s.id}`;
    item.iconPath = new vscode.ThemeIcon(meta.icon);
    item.description = description;
    item.contextValue = 'vswt.session';
    item.tooltip = new vscode.MarkdownString(
      `**${label}** · ${s.branch}\n\nState: \`${s.state}\`\n\nPath: \`${s.worktreePath}\``
    );
    item.command = {
      command: 'vswt.showSession',
      title: 'Show Session',
      arguments: [node]
    };
    return item;
  }

  async getChildren(parent?: TreeNode): Promise<TreeNode[]> {
    if (!parent) {
      const repoRoot = await getCurrentRepo(this.context);
      if (!repoRoot) return [{ kind: 'pick-repo' }];
      try {
        const list = await new WorktreeManager(repoRoot).list();
        if (list.length === 0) {
          return [{ kind: 'message', text: 'No worktrees. Click + to create.', icon: 'info' }];
        }
        return list.map(w => ({ kind: 'worktree' as const, branch: w.branch, path: w.path }));
      } catch (err) {
        return [{ kind: 'message', text: `Error: ${(err as Error).message}`, icon: 'warning' }];
      }
    }
    if (parent.kind === 'worktree') {
      const sessions = this.registry.forWorktree(parent.path);
      if (sessions.length === 0) {
        return [{ kind: 'message', text: '(no sessions — right-click to start)', icon: 'circle-large-outline' }];
      }
      return sessions.map(s => ({ kind: 'session' as const, session: s }));
    }
    return [];
  }
}

function describeWorktreeAggregate(sessions: SessionInfo[]): string {
  if (sessions.length === 0) return '';
  return `${sessions.length}`;
}

function pickWorktreeIcon(_sessions: SessionInfo[]): string {
  return 'git-branch';
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

async function createWorktreeCommand(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  tree: WorktreeTreeProvider
): Promise<void> {
  const repoRoot = await ensureRepo(context);
  if (!repoRoot) return;

  const branch = await vscode.window.showInputBox({
    prompt: 'Branch name for the new worktree',
    placeHolder: 'feat/my-feature',
    validateInput: v => (v.trim() ? null : 'Branch name is required')
  });
  if (!branch) return;

  const copyChoice = await vscode.window.showQuickPick(
    [
      { label: 'No', value: false, description: 'Skip secrets/config copy' },
      { label: 'Yes — copy .env*, .claude/**', value: true, description: 'From vswt.worktree.copyFiles' }
    ],
    { placeHolder: 'Copy local config files into the new worktree?' }
  );
  if (!copyChoice) return;

  output.show(true);
  const manager = new WorktreeManager(repoRoot);
  try {
    const result = await manager.create({ branch: branch.trim(), copyEnv: copyChoice.value, output });
    tree.refresh();
    void vscode.window.showInformationMessage(
      `vsWT: worktree '${result.branch}' created. Right-click it to start a session.`
    );
  } catch (err) {
    output.appendLine(`[vsWT] ERROR: ${(err as Error).message}`);
    void vscode.window.showErrorMessage(`vsWT: ${(err as Error).message}`);
  }
}

async function removeWorktreeCommand(
  node: TreeNode | undefined,
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  tree: WorktreeTreeProvider,
  registry: SessionRegistry
): Promise<void> {
  const repoRoot = await ensureRepo(context);
  if (!repoRoot) return;

  let target: { branch: string; path: string } | null = null;
  if (node && node.kind === 'worktree') {
    target = { branch: node.branch, path: node.path };
  } else {
    const list = await new WorktreeManager(repoRoot).list();
    if (list.length === 0) {
      void vscode.window.showInformationMessage('vsWT: no worktrees to remove.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      list.map(w => ({ label: w.branch, description: w.path, w })),
      { placeHolder: 'Pick a worktree to remove' }
    );
    if (!pick) return;
    target = pick.w;
  }

  const sessionsHere = registry.forWorktree(target.path);
  const note = sessionsHere.length > 0
    ? ` Will also stop ${sessionsHere.length} active session${sessionsHere.length > 1 ? 's' : ''}.`
    : '';

  const confirm = await vscode.window.showWarningMessage(
    `Remove worktree '${target.branch}' at ${target.path}?${note}`,
    { modal: true },
    'Remove',
    'Force remove'
  );
  if (!confirm) return;

  for (const s of sessionsHere) registry.stop(s.id);
  if (sessionsHere.length > 0) {
    // Give Windows a moment to release file handles from disposed terminals.
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  const manager = new WorktreeManager(repoRoot);
  output.show(true);
  const initialForce = confirm === 'Force remove';
  try {
    await manager.remove(target.path, initialForce, output);
    tree.refresh();
  } catch (err) {
    const msg = (err as Error).message;
    output.appendLine(`[vsWT] ERROR: ${msg}`);

    // Auto-retry with --force for git issues that --force can resolve.
    if (!initialForce && /modified|untracked|submodule|--force|locked/i.test(msg)) {
      const retry = await vscode.window.showWarningMessage(
        `Remove failed: ${msg.split('\n')[0]}\n\nForce remove?`,
        { modal: true },
        'Force remove'
      );
      if (retry === 'Force remove') {
        try {
          await manager.remove(target.path, true, output);
          tree.refresh();
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

function openWorktree(node: TreeNode | undefined, newWindow: boolean): void {
  if (!node || node.kind !== 'worktree') return;
  void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.path), { forceNewWindow: newWindow });
}

function openTerminalInWorktree(node: TreeNode | undefined): void {
  if (!node || node.kind !== 'worktree') return;
  const term = vscode.window.createTerminal({
    name: `${node.branch} · terminal`,
    cwd: vscode.Uri.file(node.path)
  });
  term.show();
}

async function startSession(
  arg: TreeNode | undefined,
  agentType: AgentType,
  context: vscode.ExtensionContext,
  registry: SessionRegistry,
  output: vscode.OutputChannel
): Promise<void> {
  let target: { branch: string; path: string } | null = null;
  if (arg && arg.kind === 'worktree') {
    target = { branch: arg.branch, path: arg.path };
  } else {
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
    target = pick.w;
  }
  output.appendLine(`[vsWT] starting ${agentType} session in ${target.path}`);
  try {
    registry.start(target, agentType);
    output.appendLine(`[vsWT] ✓ session created`);
  } catch (err) {
    const msg = (err as Error).message;
    output.appendLine(`[vsWT] ERROR: ${msg}`);
    output.appendLine(`[vsWT] stack: ${(err as Error).stack ?? '(no stack)'}`);
    output.show(true);
    void vscode.window.showErrorMessage(`vsWT: failed to start ${agentType}: ${msg}`);
  }
}

function showSession(arg: TreeNode | undefined, registry: SessionRegistry): void {
  if (!arg || arg.kind !== 'session') return;
  registry.show(arg.session.id);
}

function stopSession(arg: TreeNode | undefined, registry: SessionRegistry): void {
  if (!arg || arg.kind !== 'session') return;
  registry.stop(arg.session.id);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('vsWT');
  const registry = new SessionRegistry();
  const tree = new WorktreeTreeProvider(context, registry);
  const view = vscode.window.createTreeView('vswt.sidebar', {
    treeDataProvider: tree,
    showCollapseAll: false
  });

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'vswt.openSidebar';
  statusBar.name = 'vsWT';

  const refreshIndicators = (): void => {
    const count = registry.count();
    if (count === 0) {
      view.badge = undefined;
      statusBar.hide();
      return;
    }
    const word = count === 1 ? 'session' : 'sessions';
    view.badge = { value: count, tooltip: `${count} active ${word}` };
    statusBar.text = `$(sparkle) ${count} ${word}`;
    statusBar.tooltip = `vsWT: ${count} active ${word}`;
    statusBar.show();
  };

  context.subscriptions.push(
    output,
    view,
    statusBar,
    registry.init(),
    registry.onChange(refreshIndicators),
    vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()),
    vscode.commands.registerCommand('vswt.openSidebar', () => {
      void vscode.commands.executeCommand('workbench.view.extension.vswt');
    }),
    vscode.commands.registerCommand('vswt.refreshWorktrees', () => tree.refresh()),
    vscode.commands.registerCommand('vswt.pickRepo', async () => {
      await pickRepo(context);
      tree.refresh();
    }),
    vscode.commands.registerCommand('vswt.createWorktree', () => createWorktreeCommand(context, output, tree)),
    vscode.commands.registerCommand('vswt.removeWorktree', (node?: TreeNode) =>
      removeWorktreeCommand(node, context, output, tree, registry)
    ),
    vscode.commands.registerCommand('vswt.openWorktree', (node?: TreeNode) => openWorktree(node, true)),
    vscode.commands.registerCommand('vswt.openWorktreeCurrentWindow', (node?: TreeNode) => openWorktree(node, false)),
    vscode.commands.registerCommand('vswt.openTerminalInWorktree', (node?: TreeNode) => openTerminalInWorktree(node)),
    vscode.commands.registerCommand('vswt.startClaudeSession', (node?: TreeNode) =>
      startSession(node, 'claude', context, registry, output)
    ),
    vscode.commands.registerCommand('vswt.startShellSession', (node?: TreeNode) =>
      startSession(node, 'shell', context, registry, output)
    ),
    vscode.commands.registerCommand('vswt.showSession', (node?: TreeNode) => showSession(node, registry)),
    vscode.commands.registerCommand('vswt.stopSession', (node?: TreeNode) => stopSession(node, registry))
  );
}

export function deactivate(): void {
  // nothing to clean up — disposables handled by context.subscriptions
}
