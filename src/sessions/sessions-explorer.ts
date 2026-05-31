import * as vscode from 'vscode';
import * as path from 'node:path';
import { getSettings } from '../Settings';
import { readClipboardImage, formatImageReference } from '../clipboard';
import { PRStatusCache } from '../git/PRStatus';
import { SessionScanner, SessionSearchMatch } from './session-scanner';
import { formatRelativeTime, truncate } from './format-utils';
import { SessionsConfig, SessionsNode, SessionsTreeProvider, TerminalRef } from './sessions-tree-provider';

export interface SessionsExplorerDeps {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  getRepos: () => Promise<string[]>;
  getPinned: () => Set<string>;
  getBases: () => Record<string, string>;
  getSessionNames: () => Record<string, string>;
  getBookmarks: () => Set<string>;
  toggleBookmark: (sessionId: string) => Promise<void>;
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

function notifyOnFinish(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>('notifyOnFinish') ?? false;
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
  // Worktree-attached terminals shown as tree leaves under their worktree.
  // Resume terminals are NOT here — they already appear as the session node.
  const ownTerminalInfo = new Map<vscode.Terminal, { worktreePath: string; label: string; icon?: string }>();

  const getTerminals = (worktreePath: string): TerminalRef[] => {
    const out: TerminalRef[] = [];
    for (const [term, info] of ownTerminalInfo) {
      if (info.worktreePath !== worktreePath) continue;
      if (term.exitStatus !== undefined) continue;
      const ref: TerminalRef = { terminal: term, label: info.label };
      if (info.icon) ref.icon = info.icon;
      out.push(ref);
    }
    return out;
  };

  const scanner = new SessionScanner(getProjectsDir());
  const prCache = new PRStatusCache();
  const provider = new SessionsTreeProvider(
    scanner,
    deps.getRepos,
    getConfig,
    deps.getPinned,
    deps.getBases,
    deps.getSessionNames,
    getTerminals,
    deps.getBookmarks,
    worktreePath => prCache.get(worktreePath, () => provider.refresh())
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
    attach?: { worktreePath: string; label: string; icon?: string };
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
    if (opts.attach) {
      const info: { worktreePath: string; label: string; icon?: string } = {
        worktreePath: opts.attach.worktreePath,
        label: opts.attach.label
      };
      if (opts.attach.icon) info.icon = opts.attach.icon;
      ownTerminalInfo.set(term, info);
      provider.refresh();
    }
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
      attach: { worktreePath, label: `shell:${branch}`, icon: 'terminal' },
      ...(shellPath ? { shellPath } : {})
    });
  };

  type SearchPick = vscode.QuickPickItem & { match: SessionSearchMatch };

  const searchSessions = (): void => {
    const qp = vscode.window.createQuickPick<SearchPick>();
    qp.placeholder = 'Search session transcripts (substring, case-insensitive)';
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let token = 0;
    qp.onDidChangeValue(value => {
      if (timer) clearTimeout(timer);
      const v = value.trim();
      if (!v) {
        qp.items = [];
        qp.busy = false;
        return;
      }
      qp.busy = true;
      const myToken = ++token;
      timer = setTimeout(async () => {
        try {
          const matches = await scanner.searchSessions(v);
          if (myToken !== token) return;
          qp.items = matches.map(m => {
            const label = m.session.title ?? m.session.firstMessage ?? m.session.id.slice(0, 8);
            return {
              label: truncate(label, 70),
              description: truncate(m.snippet, 120),
              detail: `${m.role} · ${formatRelativeTime(m.session.lastActivity)} · ${m.session.cwd ?? ''}`,
              match: m
            };
          });
        } finally {
          if (myToken === token) qp.busy = false;
        }
      }, 150);
    });
    qp.onDidAccept(() => {
      const pick = qp.selectedItems[0];
      qp.hide();
      if (!pick) return;
      const session = pick.match.session;
      void vscode.commands.executeCommand('vswt.sessions.resume', {
        kind: 'session',
        session,
        cwd: session.cwd,
        branch: session.gitBranch,
        active: false,
        bookmarked: deps.getBookmarks().has(session.id)
      } satisfies SessionsNode);
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
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

  // Tracks the last stop_reason seen per session file, so we only fire a
  // notification on the *transition* into end_turn — not every refresh.
  // `null` means "we've inspected this file at least once but haven't seen an
  // assistant message yet" (suppresses the very first notification when the
  // extension starts on an already-finished transcript).
  const lastStopReason = new Map<string, string | null>();

  const checkFinished = async (uri: vscode.Uri): Promise<void> => {
    if (!notifyOnFinish()) return;
    const tail = await scanner.readTail(uri.fsPath);
    if (!tail) return;
    const prev = lastStopReason.get(uri.fsPath);
    lastStopReason.set(uri.fsPath, tail.stopReason);
    if (prev === undefined) return; // first observation — seed only
    if (tail.stopReason !== 'end_turn' || prev === 'end_turn') return;
    if (!tail.sessionId) return;
    const running = await scanner.runningSessionIds();
    if (!running.has(tail.sessionId)) return;
    const label =
      deps.getSessionNames()[tail.sessionId] ?? path.basename(uri.fsPath, '.jsonl');
    void vscode.window.showInformationMessage(`Claude finished: ${label}`);
  };

  let watcher: vscode.FileSystemWatcher | undefined;
  let registryWatcher: vscode.FileSystemWatcher | undefined;
  const setupWatcher = (): void => {
    watcher?.dispose();
    registryWatcher?.dispose();
    lastStopReason.clear();
    try {
      // Transcripts → reflect new/changed sessions.
      watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(scanner.resolveProjectsDir()), '**/*.jsonl')
      );
      watcher.onDidCreate(scheduleRefresh);
      watcher.onDidChange(uri => {
        scheduleRefresh();
        void checkFinished(uri);
      });
      watcher.onDidDelete(uri => {
        lastStopReason.delete(uri.fsPath);
        scheduleRefresh();
      });
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
      const hadAttached = ownTerminalInfo.delete(t);
      for (const [id, term] of sessionTerminals) {
        if (term === t) sessionTerminals.delete(id);
      }
      if (hadAttached) provider.refresh();
    }),

    // View title
    vscode.commands.registerCommand('vswt.sessions.refresh', () => {
      prCache.invalidate();
      provider.refresh();
    }),
    vscode.commands.registerCommand('vswt.createWorktree', () => deps.createWorktree()),
    vscode.commands.registerCommand('vswt.sessions.toggleUnmatched', async () => {
      const cfg = vscode.workspace.getConfiguration(SECTION);
      const current = cfg.get<boolean>('showUnmatched') ?? false;
      await cfg.update('showUnmatched', !current, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('vswt.pasteImage', pasteImage),
    vscode.commands.registerCommand('vswt.sessions.search', searchSessions),

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
      const branch = branchOf(t);
      openTerminal({
        name: `claude:${branch}`,
        cwd: t.group.info.path,
        icon: 'sparkle',
        send: getClaudePath(),
        attach: { worktreePath: t.group.info.path, label: `claude:${branch}`, icon: 'sparkle' }
      });
    }),
    vscode.commands.registerCommand('vswt.wt.newShell', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (t) void newShellHere(t.group.info.path, branchOf(t));
    }),
    vscode.commands.registerCommand('vswt.wt.term', (node?: SessionsNode) => {
      const t = asWorktree(node);
      if (!t) return;
      const label = `${path.basename(t.group.info.path)} · terminal`;
      openTerminal({
        name: label,
        cwd: t.group.info.path,
        attach: { worktreePath: t.group.info.path, label, icon: 'terminal' }
      });
    }),
    vscode.commands.registerCommand('vswt.terminals.show', (node?: SessionsNode) => {
      if (node?.kind === 'terminal' && node.terminal.exitStatus === undefined) node.terminal.show();
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
    vscode.commands.registerCommand('vswt.sessions.resume', async (node?: SessionsNode) => {
      const t = asSession(node);
      if (!t) return;
      const id = t.session.id;
      const resumeCmd = `${getResumeCommand()} ${id}`;
      const existing = sessionTerminals.get(id);
      if (existing && existing.exitStatus === undefined) {
        existing.show();
        // If Claude itself exited (Ctrl+C) but the shell terminal is still
        // open, the registry no longer lists this session — re-run resume
        // in the same shell instead of leaving the user at a bare prompt.
        const running = await scanner.runningSessionIds();
        if (!running.has(id)) existing.sendText(resumeCmd, true);
        return;
      }
      const branch = t.branch ?? 'session';
      const term = openTerminal({ name: `claude:${branch}`, cwd: t.cwd, send: resumeCmd });
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
    }),
    vscode.commands.registerCommand('vswt.commits.copySha', async (node?: SessionsNode) => {
      if (node?.kind !== 'commit') return;
      await vscode.env.clipboard.writeText(node.commit.sha);
      void vscode.window.showInformationMessage(`vsWT: copied commit ${node.commit.shortSha}`);
    }),
    vscode.commands.registerCommand('vswt.sessions.bookmark', (node?: SessionsNode) => {
      const t = asSession(node);
      if (t) void deps.toggleBookmark(t.session.id);
    }),
    vscode.commands.registerCommand('vswt.sessions.unbookmark', (node?: SessionsNode) => {
      const t = asSession(node);
      if (t) void deps.toggleBookmark(t.session.id);
    })
  );

  return { refresh: () => provider.refresh() };
}
