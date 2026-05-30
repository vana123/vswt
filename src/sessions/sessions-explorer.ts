import * as vscode from 'vscode';
import * as path from 'node:path';
import { getSettings } from '../Settings';
import { readClipboardImage, formatImageReference } from '../clipboard';
import { SessionScanner } from './session-scanner';
import { SessionsConfig, SessionsNode, SessionsTreeProvider } from './sessions-tree-provider';

export interface SessionsExplorerDeps {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  getRepos: () => Promise<string[]>;
  getPinned: () => Set<string>;
  getBases: () => Record<string, string>;
  getSessionNames: () => Record<string, string>;
  renameSession: (sessionId: string, currentName: string) => Promise<void>;
  createWorktree: (repoRoot?: string) => Promise<void>;
  rename: (worktreePath: string, repoRoot: string, currentBranch: string) => Promise<void>;
  remove: (worktreePath: string, repoRoot: string) => Promise<void>;
  togglePin: (worktreePath: string) => Promise<void>;
  sync: (worktreePath: string, op: 'push' | 'pull' | 'fetch') => Promise<void>;
  showDiff: (worktreePath: string, relativePath: string, statusCode: string) => Promise<void>;
  createPR: (worktreePath: string) => Promise<void>;
  finish: (worktreePath: string, repoRoot: string) => Promise<void>;
  openWindow: (targetPath: string) => void;
}

const SECTION = 'vswt.sessions';
const DEBOUNCE_MS = 500;

function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && value >= 0 ? Math.floor(value) : fallback;
}

function getConfig(): SessionsConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const sessionLabel = cfg.get<string>('label') === 'firstMessage' ? 'firstMessage' : 'name';
  return {
    sessionLabel,
    showUnmatched: cfg.get<boolean>('showUnmatched') ?? false,
    maxAgeDays: nonNegative(cfg.get<number>('maxAgeDays'), 30),
    maxPerWorktree: nonNegative(cfg.get<number>('maxPerWorktree'), 15)
  };
}

function getProjectsDir(): string {
  return vscode.workspace.getConfiguration(SECTION).get<string>('projectsDir') ?? '';
}

function getResumeCommand(): string {
  const cfg = vscode.workspace.getConfiguration('vswt');
  const explicit = (cfg.get<string>('sessions.resumeCommand') ?? '').trim();
  if (explicit) return explicit;
  return `${getClaudePath()} --resume`;
}

function getClaudePath(): string {
  const cfg = vscode.workspace.getConfiguration('vswt');
  return (cfg.get<string>('claude.path') ?? 'claude').trim() || 'claude';
}

export function registerSessionsExplorer(deps: SessionsExplorerDeps): { refresh: () => void } {
  const { context, output } = deps;

  // Track terminals we open so the Ctrl+V paste-image gate (vswt.terminalActive)
  // only fires inside terminals this extension created.
  const ownTerminals = new Set<vscode.Terminal>();
  // Resume terminals keyed by session id, so clicking a session reuses its
  // terminal instead of spawning a duplicate each time.
  const sessionTerminals = new Map<string, vscode.Terminal>();

  const scanner = new SessionScanner(getProjectsDir());
  const provider = new SessionsTreeProvider(
    scanner,
    deps.getRepos,
    getConfig,
    deps.getPinned,
    deps.getBases,
    deps.getSessionNames
  );
  const treeView = vscode.window.createTreeView('vswt.sessions', {
    treeDataProvider: provider,
    showCollapseAll: true
  });

  const updateTerminalContext = (term: vscode.Terminal | undefined): void => {
    void vscode.commands.executeCommand(
      'setContext',
      'vswt.terminalActive',
      term !== undefined && ownTerminals.has(term)
    );
  };
  updateTerminalContext(vscode.window.activeTerminal);

  const openTerminal = (opts: {
    name: string;
    cwd: string | null;
    shellPath?: string;
    icon?: string;
    send?: string;
  }): vscode.Terminal => {
    const tOpts: vscode.TerminalOptions = { name: opts.name };
    if (opts.cwd) tOpts.cwd = vscode.Uri.file(opts.cwd);
    if (opts.shellPath) tOpts.shellPath = opts.shellPath;
    if (opts.icon) tOpts.iconPath = new vscode.ThemeIcon(opts.icon);
    const term = vscode.window.createTerminal(tOpts);
    ownTerminals.add(term);
    term.show();
    if (opts.send) term.sendText(opts.send, true);
    updateTerminalContext(term);
    return term;
  };

  const newShellHere = async (worktreePath: string, branch: string): Promise<void> => {
    const shells = getSettings().extraShells;
    let shellPath: string | undefined;
    if (shells.length > 0) {
      type ShellPick = vscode.QuickPickItem & { command?: string };
      const items: ShellPick[] = [{ label: 'Default', description: 'system shell' }];
      for (const s of shells) items.push({ label: s.name, description: s.command, command: s.command });
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Pick shell' });
      if (!pick) return;
      shellPath = pick.command;
    }
    openTerminal({
      name: `shell:${branch}`,
      cwd: worktreePath,
      icon: 'terminal',
      ...(shellPath ? { shellPath } : {})
    });
  };

  const pasteImage = async (): Promise<void> => {
    const term = vscode.window.activeTerminal;
    if (!term) return;
    const text = await vscode.env.clipboard.readText();
    if (text.length > 0) {
      await vscode.commands.executeCommand('workbench.action.terminal.paste');
      return;
    }
    try {
      const imgPath = await readClipboardImage();
      if (imgPath) {
        term.sendText(formatImageReference(imgPath), false);
        output.appendLine(`[vsWT] image pasted: ${imgPath}`);
      } else {
        await vscode.commands.executeCommand('workbench.action.terminal.paste');
      }
    } catch (err) {
      output.appendLine(`[vsWT] paste image failed: ${(err as Error).message}`);
      await vscode.commands.executeCommand('workbench.action.terminal.paste');
    }
  };

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => provider.refresh(), DEBOUNCE_MS);
  };

  let watcher: vscode.FileSystemWatcher | undefined;
  let registryWatcher: vscode.FileSystemWatcher | undefined;
  const setupWatcher = (): void => {
    watcher?.dispose();
    registryWatcher?.dispose();
    try {
      // Transcripts → reflect new/changed sessions.
      watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(scanner.resolveProjectsDir()), '**/*.jsonl')
      );
      watcher.onDidCreate(scheduleRefresh);
      watcher.onDidChange(scheduleRefresh);
      watcher.onDidDelete(scheduleRefresh);
      context.subscriptions.push(watcher);

      // Live-session registry → a file appears on start and is removed on exit,
      // so create/delete here flips the "running" dot promptly.
      registryWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(scanner.resolveSessionsDir()), '*.json')
      );
      registryWatcher.onDidCreate(scheduleRefresh);
      registryWatcher.onDidDelete(scheduleRefresh);
      context.subscriptions.push(registryWatcher);
    } catch (err) {
      output.appendLine(`[vsWT] sessions watcher failed: ${(err as Error).message}`);
    }
  };
  setupWatcher();

  // While the view is visible, re-evaluate periodically to clear the "running"
  // dot if a session's process died without removing its registry file (crash).
  let activeTimer: ReturnType<typeof setInterval> | undefined;
  const stopActiveTimer = (): void => {
    if (activeTimer) {
      clearInterval(activeTimer);
      activeTimer = undefined;
    }
  };
  const startActiveTimer = (): void => {
    if (!activeTimer) activeTimer = setInterval(() => provider.refresh(), 60_000);
  };
  if (treeView.visible) startActiveTimer();

  const configSub = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(`${SECTION}.projectsDir`)) {
      scanner.setProjectsDir(getProjectsDir());
      setupWatcher();
      provider.refresh();
    } else if (
      e.affectsConfiguration(SECTION) ||
      e.affectsConfiguration('vswt.claude.path') ||
      e.affectsConfiguration('vswt.repoScanDepth')
    ) {
      provider.refresh();
    }
  });

  const asSession = (node?: SessionsNode): Extract<SessionsNode, { kind: 'session' }> | null =>
    node && node.kind === 'session' ? node : null;
  const asWorktree = (node?: SessionsNode): Extract<SessionsNode, { kind: 'worktree' }> | null =>
    node && node.kind === 'worktree' ? node : null;
  const asFile = (node?: SessionsNode): Extract<SessionsNode, { kind: 'file' }> | null =>
    node && node.kind === 'file' ? node : null;
  const asRepo = (node?: SessionsNode): Extract<SessionsNode, { kind: 'repo' }> | null =>
    node && node.kind === 'repo' ? node : null;

  const branchOf = (node: Extract<SessionsNode, { kind: 'worktree' }>): string =>
    node.group.info.branch ?? 'detached';

  context.subscriptions.push(
    treeView,
    configSub,
    treeView.onDidChangeVisibility(e => {
      if (e.visible) {
        provider.refresh();
        startActiveTimer();
      } else {
        stopActiveTimer();
      }
    }),
    new vscode.Disposable(stopActiveTimer),
    vscode.window.onDidChangeActiveTerminal(updateTerminalContext),
    vscode.window.onDidCloseTerminal(t => {
      ownTerminals.delete(t);
      for (const [id, term] of sessionTerminals) {
        if (term === t) sessionTerminals.delete(id);
      }
    }),

    // View title
    vscode.commands.registerCommand('vswt.sessions.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('vswt.createWorktree', () => deps.createWorktree()),
    vscode.commands.registerCommand('vswt.sessions.toggleUnmatched', async () => {
      const cfg = vscode.workspace.getConfiguration(SECTION);
      const current = cfg.get<boolean>('showUnmatched') ?? false;
      await cfg.update('showUnmatched', !current, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('vswt.pasteImage', pasteImage),

    // Repo actions
    vscode.commands.registerCommand('vswt.repo.newWorktree', (node?: SessionsNode) => {
      const r = asRepo(node);
      if (r) void deps.createWorktree(r.repoRoot);
    }),
    vscode.commands.registerCommand('vswt.repo.newClaudeWorktree', async (node?: SessionsNode) => {
      const r = asRepo(node);
      if (!r) return;
      const name = await vscode.window.showInputBox({
        prompt: 'Worktree name (optional) — leave empty to let Claude pick one',
        placeHolder: 'feat/my-feature'
      });
      if (name === undefined) return; // cancelled
      const arg = name.trim() ? ` ${name.trim()}` : '';
      openTerminal({
        name: `claude ⎇ ${name.trim() || 'new'}`,
        cwd: r.repoRoot,
        icon: 'sparkle',
        send: `${getClaudePath()} --worktree${arg}`
      });
    }),
    vscode.commands.registerCommand('vswt.repo.openWindow', (node?: SessionsNode) => {
      const r = asRepo(node);
      if (r) deps.openWindow(r.repoRoot);
    }),

    // Worktree actions
    vscode.commands.registerCommand('vswt.wt.newClaude', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (!t) return;
      openTerminal({ name: `claude:${branchOf(t)}`, cwd: t.group.info.path, icon: 'sparkle', send: getClaudePath() });
    }),
    vscode.commands.registerCommand('vswt.wt.newShell', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (t) void newShellHere(t.group.info.path, branchOf(t));
    }),
    vscode.commands.registerCommand('vswt.wt.term', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (t) openTerminal({ name: `${path.basename(t.group.info.path)} · terminal`, cwd: t.group.info.path });
    }),
    vscode.commands.registerCommand('vswt.wt.pull', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (t) void deps.sync(t.group.info.path, 'pull');
    }),
    vscode.commands.registerCommand('vswt.wt.push', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (t) void deps.sync(t.group.info.path, 'push');
    }),
    vscode.commands.registerCommand('vswt.wt.fetch', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (t) void deps.sync(t.group.info.path, 'fetch');
    }),
    vscode.commands.registerCommand('vswt.wt.openWindow', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (t) deps.openWindow(t.group.info.path);
    }),
    vscode.commands.registerCommand('vswt.wt.pr', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (t) void deps.createPR(t.group.info.path);
    }),
    vscode.commands.registerCommand('vswt.wt.finish', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (t) void deps.finish(t.group.info.path, t.group.repoRoot);
    }),
    vscode.commands.registerCommand('vswt.wt.rename', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (t) void deps.rename(t.group.info.path, t.group.repoRoot, branchOf(t));
    }),
    vscode.commands.registerCommand('vswt.wt.pin', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (t) void deps.togglePin(t.group.info.path);
    }),
    vscode.commands.registerCommand('vswt.wt.unpin', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (t) void deps.togglePin(t.group.info.path);
    }),
    vscode.commands.registerCommand('vswt.wt.remove', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (t) void deps.remove(t.group.info.path, t.group.repoRoot);
    }),
    vscode.commands.registerCommand('vswt.wt.showDiff', (node?: SessionsNode) => {
      const f = asFile(node);
      if (f) void deps.showDiff(f.worktreePath, f.file.path, f.file.status);
    }),

    // Session actions
    vscode.commands.registerCommand('vswt.sessions.resume', (node?: SessionsNode) => {
      const t = asSession(node);
      if (!t) return;
      const id = t.session.id;
      // Reuse an existing live terminal for this session instead of duplicating.
      const existing = sessionTerminals.get(id);
      if (existing && existing.exitStatus === undefined) {
        existing.show();
        return;
      }
      const branch = t.branch ?? 'session';
      const term = openTerminal({ name: `claude:${branch}`, cwd: t.cwd, send: `${getResumeCommand()} ${id}` });
      sessionTerminals.set(id, term);
    }),
    vscode.commands.registerCommand('vswt.sessions.rename', (node?: SessionsNode) => {
      const t = asSession(node);
      if (!t) return;
      const current =
        deps.getSessionNames()[t.session.id] ?? t.session.title ?? t.session.firstMessage ?? '';
      void deps.renameSession(t.session.id, current);
    }),
    vscode.commands.registerCommand('vswt.sessions.revealTranscript', async (node?: SessionsNode) => {
      const t = asSession(node);
      if (!t) return;
      await vscode.window.showTextDocument(vscode.Uri.file(t.session.filePath), { preview: true });
    }),
    vscode.commands.registerCommand('vswt.sessions.copySessionId', async (node?: SessionsNode) => {
      const t = asSession(node);
      if (!t) return;
      await vscode.env.clipboard.writeText(t.session.id);
      void vscode.window.showInformationMessage(`vsWT: copied session id ${t.session.id}`);
    })
  );

  return { refresh: () => provider.refresh() };
}
