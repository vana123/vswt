import * as vscode from 'vscode';
import * as path from 'node:path';
import { FileChange, GitOps, WorktreeInfo, WorktreeStatus } from '../git/GitOps';
import { ClaudeSession, SessionScanner } from './session-scanner';
import { normalizePath, realpathSafe } from './path-utils';
import { escapeMarkdown, formatRelativeTime, shortenHomePath, truncate } from './format-utils';

export interface SessionsConfig {
  sessionLabel: 'name' | 'firstMessage';
  showUnmatched: boolean;
  /** Hide historical sessions with no activity in this many days. 0 = no age limit. */
  maxAgeDays: number;
  /** Cap historical sessions shown per worktree before an overflow node. 0 = unlimited. */
  maxPerWorktree: number;
}

interface WorktreeGroup {
  repoRoot: string;
  info: WorktreeInfo;
  isCurrent: boolean;
  /** Created by `claude --worktree` — lives under `<repo>/.claude/worktrees/`. */
  isClaude: boolean;
  pinned: boolean;
  base: string | null;
  status: WorktreeStatus | null;
  files: FileChange[];
  sessions: ClaudeSession[];
  /** Recently-active sessions (always shown). */
  active: ClaudeSession[];
  /** Older sessions, after the age filter (capped at render time). */
  historical: ClaudeSession[];
}

interface RepoModel {
  repoRoot: string;
  label: string;
  groups: WorktreeGroup[];
}

interface TreeModel {
  repos: RepoModel[];
  unmatched: ClaudeSession[];
  /** Session ids currently running (Claude's live-process registry). */
  running: Set<string>;
}

export type SessionsNode =
  | { kind: 'message'; text: string; icon: string }
  | { kind: 'repo'; repoRoot: string; label: string; expanded: boolean }
  | { kind: 'worktree'; group: WorktreeGroup }
  | { kind: 'changes'; worktreePath: string; count: number }
  | { kind: 'file'; worktreePath: string; file: FileChange }
  | { kind: 'session'; session: ClaudeSession; cwd: string | null; branch: string | null; active: boolean }
  | { kind: 'sessionsMore'; worktreePath: string; count: number }
  | { kind: 'unmatched'; count: number };

const { Collapsed, Expanded, None } = vscode.TreeItemCollapsibleState;
const MAX_FILES = 50;

export class SessionsTreeProvider implements vscode.TreeDataProvider<SessionsNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SessionsNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private modelPromise: Promise<TreeModel> | null = null;

  constructor(
    private readonly scanner: SessionScanner,
    private readonly getRepos: () => Promise<string[]>,
    private readonly getConfig: () => SessionsConfig,
    private readonly getPinned: () => Set<string>,
    private readonly getBases: () => Record<string, string>,
    private readonly getSessionNames: () => Record<string, string>
  ) {}

  refresh(): void {
    // The scanner re-reads only files whose mtime changed; no full cache clear here.
    this.modelPromise = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  async getChildren(element?: SessionsNode): Promise<SessionsNode[]> {
    const model = await this.model();

    if (!element) {
      if (model.repos.length === 0) {
        return [{ kind: 'message', text: 'No git repositories found in this folder.', icon: 'info' }];
      }
      const single = model.repos.length === 1;
      const nodes: SessionsNode[] = model.repos.map(r => ({
        kind: 'repo',
        repoRoot: r.repoRoot,
        label: r.label,
        expanded: single || r.groups.some(g => g.isCurrent)
      }));
      if (this.getConfig().showUnmatched && model.unmatched.length > 0) {
        nodes.push({ kind: 'unmatched', count: model.unmatched.length });
      }
      return nodes;
    }

    if (element.kind === 'repo') {
      const repo = model.repos.find(r => r.repoRoot === element.repoRoot);
      return repo ? repo.groups.map(group => ({ kind: 'worktree', group })) : [];
    }

    if (element.kind === 'worktree') {
      const { info, files, active, historical } = element.group;
      const cap = this.getConfig().maxPerWorktree;
      const nodes: SessionsNode[] = [];
      if (files.length > 0) nodes.push({ kind: 'changes', worktreePath: info.path, count: files.length });
      for (const session of active) {
        nodes.push({ kind: 'session', session, cwd: info.path, branch: info.branch, active: true });
      }
      const shown = cap > 0 ? historical.slice(0, cap) : historical;
      for (const session of shown) {
        nodes.push({ kind: 'session', session, cwd: info.path, branch: info.branch, active: false });
      }
      if (cap > 0 && historical.length > cap) {
        nodes.push({ kind: 'sessionsMore', worktreePath: info.path, count: historical.length - cap });
      }
      return nodes;
    }

    if (element.kind === 'sessionsMore') {
      const group = model.repos.flatMap(r => r.groups).find(g => g.info.path === element.worktreePath);
      if (!group) return [];
      const cap = this.getConfig().maxPerWorktree;
      return group.historical.slice(cap).map(session => ({
        kind: 'session',
        session,
        cwd: group.info.path,
        branch: group.info.branch,
        active: false
      }));
    }

    if (element.kind === 'changes') {
      const group = model.repos.flatMap(r => r.groups).find(g => g.info.path === element.worktreePath);
      if (!group) return [];
      return group.files.map(file => ({ kind: 'file', worktreePath: element.worktreePath, file }));
    }

    if (element.kind === 'unmatched') {
      return model.unmatched.map(session => ({
        kind: 'session',
        session,
        cwd: session.cwd,
        branch: session.gitBranch,
        active: model.running.has(session.id)
      }));
    }

    return [];
  }

  getTreeItem(node: SessionsNode): vscode.TreeItem {
    switch (node.kind) {
      case 'message': {
        const item = new vscode.TreeItem(node.text);
        item.iconPath = new vscode.ThemeIcon(node.icon);
        return item;
      }
      case 'repo': {
        const item = new vscode.TreeItem(node.label, node.expanded ? Expanded : Collapsed);
        item.id = 'repo:' + node.repoRoot;
        item.iconPath = new vscode.ThemeIcon('repo');
        item.contextValue = 'vswtSessionsRepo';
        item.description = shortenHomePath(node.repoRoot);
        item.tooltip = node.repoRoot;
        return item;
      }
      case 'worktree':
        return this.worktreeItem(node.group);
      case 'changes': {
        const item = new vscode.TreeItem('Changes', Collapsed);
        item.description = String(node.count);
        item.iconPath = new vscode.ThemeIcon('diff');
        item.contextValue = 'vswtSessionsChanges';
        return item;
      }
      case 'file':
        return this.fileItem(node);
      case 'session':
        return this.sessionItem(node.session, node.branch, node.active);
      case 'sessionsMore': {
        const item = new vscode.TreeItem(`Show ${node.count} older…`, Collapsed);
        item.iconPath = new vscode.ThemeIcon('history');
        item.contextValue = 'vswtSessionsMore';
        return item;
      }
      case 'unmatched': {
        const item = new vscode.TreeItem('Other · outside these repos', Collapsed);
        item.iconPath = new vscode.ThemeIcon('question');
        item.description = String(node.count);
        item.contextValue = 'vswtSessionsUnmatched';
        item.tooltip = 'Sessions whose working directory is not a worktree of any listed repository.';
        return item;
      }
    }
  }

  private worktreeItem(group: WorktreeGroup): vscode.TreeItem {
    const { info, isCurrent, isClaude, pinned, base, status, files, sessions, active, historical } = group;
    const branch = info.branch ?? '(detached)';
    const hasChildren = files.length > 0 || active.length > 0 || historical.length > 0;
    const state = hasChildren ? (isCurrent || active.length > 0 ? Expanded : Collapsed) : None;

    const item = new vscode.TreeItem(branch, state);
    item.id = 'wt:' + info.path;

    const descParts = [shortenHomePath(info.path)];
    const badge = badgeText(status);
    if (badge) descParts.push(badge);
    if (!hasChildren) descParts.push('—');
    item.description = descParts.join('  ·  ');

    // Icon shape marks provenance (✦ = created by `claude --worktree`), colour marks the active one.
    const iconId = isClaude ? 'sparkle' : 'git-branch';
    item.iconPath = isCurrent
      ? new vscode.ThemeIcon(iconId, new vscode.ThemeColor('list.highlightForeground'))
      : new vscode.ThemeIcon(iconId);
    item.contextValue = pinned ? 'vswtSessionsWorktree.pinned' : 'vswtSessionsWorktree.unpinned';

    const flags: string[] = [];
    if (active.length > 0) flags.push(`${active.length} running`);
    if (isClaude) flags.push('claude-created');
    if (isCurrent) flags.push('current');
    if (pinned) flags.push('pinned');
    if (info.detached) flags.push('detached');
    if (info.locked) flags.push('locked');
    if (info.prunable) flags.push('prunable');

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${escapeMarkdown(branch)}**`);
    if (base) md.appendMarkdown(` ← ${escapeMarkdown(base)}`);
    md.appendMarkdown('\n\n');
    md.appendMarkdown(`- path: \`${info.path}\`\n`);
    if (info.head) md.appendMarkdown(`- HEAD: \`${info.head.slice(0, 12)}\`\n`);
    if (status) {
      md.appendMarkdown(
        `- changes: ${status.modified} modified, ${status.untracked} untracked · ↑${status.ahead} ↓${status.behind}\n`
      );
    }
    if (flags.length) md.appendMarkdown(`- flags: ${flags.join(', ')}\n`);
    md.appendMarkdown(`- sessions: ${sessions.length} total · ${active.length} running\n`);
    item.tooltip = md;
    return item;
  }

  private fileItem(node: Extract<SessionsNode, { kind: 'file' }>): vscode.TreeItem {
    const { file, worktreePath } = node;
    const item = new vscode.TreeItem(file.path, None);
    item.iconPath = fileIcon(file.status);
    item.contextValue = 'vswtSessionsFile';
    item.tooltip = `${file.status.trim()} · ${file.path}`;
    item.command = {
      command: 'vswt.wt.showDiff',
      title: 'Open Diff',
      arguments: [{ kind: 'file', worktreePath, file } satisfies SessionsNode]
    };
    return item;
  }

  private sessionItem(session: ClaudeSession, branch: string | null, active: boolean): vscode.TreeItem {
    const cfg = this.getConfig();
    const custom = this.getSessionNames()[session.id];
    const primary =
      custom ??
      (cfg.sessionLabel === 'firstMessage'
        ? session.firstMessage ?? session.title
        : session.title ?? session.firstMessage);
    const item = new vscode.TreeItem(truncate(primary ?? session.id, 60), None);
    item.id = 'sess:' + session.filePath;
    const rel = formatRelativeTime(session.lastActivity);
    item.description = active ? `running · ${rel}` : rel;
    item.iconPath = active
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon('comment-discussion');
    item.contextValue = 'vswtSessionsSession';
    item.command = {
      command: 'vswt.sessions.resume',
      title: 'Resume in Terminal',
      arguments: [{ kind: 'session', session, cwd: session.cwd, branch, active } satisfies SessionsNode]
    };

    const md = new vscode.MarkdownString();
    if (session.title) md.appendMarkdown(`**${escapeMarkdown(session.title)}**\n\n`);
    if (session.firstMessage && session.firstMessage !== session.title) {
      md.appendMarkdown(`${escapeMarkdown(truncate(session.firstMessage, 200))}\n\n`);
    }
    md.appendMarkdown(`- id: \`${session.id}\`\n`);
    if (session.cwd) md.appendMarkdown(`- cwd: \`${session.cwd}\`\n`);
    if (branch) md.appendMarkdown(`- branch: \`${branch}\`\n`);
    if (session.createdAt) md.appendMarkdown(`- created: ${new Date(session.createdAt).toLocaleString()}\n`);
    md.appendMarkdown(`- last activity: ${new Date(session.lastActivity).toLocaleString()}\n`);
    item.tooltip = md;
    return item;
  }

  private model(): Promise<TreeModel> {
    if (!this.modelPromise) this.modelPromise = this.build();
    return this.modelPromise;
  }

  private async build(): Promise<TreeModel> {
    const repoRoots = await this.getRepos();
    if (repoRoots.length === 0) return { repos: [], unmatched: [], running: new Set() };

    const folderKeys = new Set<string>();
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      folderKeys.add(normalizePath(f.uri.fsPath));
      folderKeys.add(normalizePath(await realpathSafe(f.uri.fsPath)));
    }

    const pinned = this.getPinned();
    const bases = this.getBases();
    const keyToGroup = new Map<string, WorktreeGroup>();
    const repos: RepoModel[] = [];

    for (const repoRoot of repoRoots) {
      let infos: WorktreeInfo[];
      try {
        infos = (await new GitOps(repoRoot).listWorktrees()).filter(w => !w.bare);
      } catch {
        continue;
      }
      const claudeBase = normalizePath(path.join(repoRoot, '.claude', 'worktrees'));
      const groups: WorktreeGroup[] = [];
      for (const info of infos) {
        const realKey = normalizePath(await realpathSafe(info.path));
        const plainKey = normalizePath(info.path);
        const group: WorktreeGroup = {
          repoRoot,
          info,
          isCurrent: folderKeys.has(plainKey) || folderKeys.has(realKey),
          isClaude: plainKey === claudeBase || plainKey.startsWith(claudeBase + path.sep),
          pinned: pinned.has(info.path),
          base: bases[info.path] ?? null,
          status: null,
          files: [],
          sessions: [],
          active: [],
          historical: []
        };
        groups.push(group);
        keyToGroup.set(plainKey, group);
        keyToGroup.set(realKey, group);
      }
      groups.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return (a.info.branch ?? '').localeCompare(b.info.branch ?? '');
      });
      repos.push({ repoRoot, label: path.basename(repoRoot), groups });
    }

    const allGroups = repos.flatMap(r => r.groups);
    await Promise.all(
      allGroups.map(async group => {
        try {
          const git = new GitOps(group.info.path);
          const [status, files] = await Promise.all([git.statusInfo(), git.statusFiles()]);
          group.status = status;
          group.files = files.slice(0, MAX_FILES);
        } catch {
          // Status unreadable (e.g. prunable worktree) — leave defaults.
        }
      })
    );

    const sessions = await this.scanner.scan();
    const unmatched: ClaudeSession[] = [];
    for (const session of sessions) {
      const group = await this.match(session, keyToGroup);
      if (group) group.sessions.push(session);
      else unmatched.push(session);
    }

    // Split each worktree's sessions into running (Claude's live-process registry)
    // and age-filtered historical, most-recent first.
    const cfg = this.getConfig();
    const running = await this.scanner.runningSessionIds();
    const now = Date.now();
    const ageCutoff = cfg.maxAgeDays > 0 ? now - cfg.maxAgeDays * 86_400_000 : 0;
    for (const group of allGroups) {
      group.sessions.sort((a, b) => b.lastActivity - a.lastActivity);
      group.active = group.sessions.filter(s => running.has(s.id));
      group.historical = group.sessions.filter(
        s => !running.has(s.id) && s.lastActivity >= ageCutoff
      );
    }
    unmatched.sort((a, b) => b.lastActivity - a.lastActivity);
    repos.sort((a, b) => a.label.localeCompare(b.label));

    return { repos, unmatched, running };
  }

  private async match(
    session: ClaudeSession,
    map: Map<string, WorktreeGroup>
  ): Promise<WorktreeGroup | null> {
    if (!session.cwd) return null;
    const plain = map.get(normalizePath(session.cwd));
    if (plain) return plain;
    return map.get(normalizePath(await realpathSafe(session.cwd))) ?? null;
  }
}

function badgeText(status: WorktreeStatus | null): string {
  if (!status) return '';
  const dirty = status.modified + status.untracked;
  const parts: string[] = [];
  if (dirty > 0) parts.push(`●${dirty}`);
  if (status.ahead > 0) parts.push(`↑${status.ahead}`);
  if (status.behind > 0) parts.push(`↓${status.behind}`);
  return parts.join(' ');
}

function fileIcon(code: string): vscode.ThemeIcon {
  const t = code.trim();
  if (t.startsWith('?') || t.startsWith('A')) return new vscode.ThemeIcon('diff-added');
  if (t.startsWith('D') || t.endsWith('D')) return new vscode.ThemeIcon('diff-removed');
  if (t.startsWith('R')) return new vscode.ThemeIcon('diff-renamed');
  return new vscode.ThemeIcon('diff-modified');
}
