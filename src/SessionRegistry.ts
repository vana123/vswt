import * as vscode from 'vscode';
import { getSettings } from './Settings';

export type AgentType = 'shell' | 'claude';
export type AgentState = 'running' | 'exited' | 'stopped';

export interface ShellOverride {
  name: string;
  command: string;
  args?: string[];
}

export interface SessionInfo {
  id: string;
  worktreePath: string;
  branch: string;
  agentType: AgentType;
  /** Display label: 'Claude', 'Shell', or a configured shell name like 'Git Bash'. */
  label: string;
  state: AgentState;
  createdAt: number;
}

interface SessionEntry {
  info: SessionInfo;
  terminal: vscode.Terminal | null;
  shellName?: string;
  shellCommand?: string;
  shellArgs?: string[];
}

interface PersistedSession {
  worktreePath: string;
  branch: string;
  agentType: AgentType;
  label: string;
  shellName?: string;
  shellCommand?: string;
  shellArgs?: string[];
  lastUsedAt: number;
}

const STORAGE_KEY = 'vswt.persistedSessions';

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly _onChange = new vscode.EventEmitter<void>();
  public readonly onChange = this._onChange.event;
  private terminalListener: vscode.Disposable | null = null;
  private context: vscode.ExtensionContext | null = null;
  private readonly userStopRequested = new Set<string>();

  init(context?: vscode.ExtensionContext): vscode.Disposable {
    if (context) {
      this.context = context;
      this.restoreFromStorage();
    }
    this.terminalListener = vscode.window.onDidCloseTerminal(t => this.handleTerminalClose(t));
    return new vscode.Disposable(() => {
      // Snapshot active sessions for restore-on-next-activate, then tear down.
      const snapshot: PersistedSession[] = [];
      const terminalsToDispose: vscode.Terminal[] = [];
      for (const entry of this.sessions.values()) {
        if (entry.terminal !== null) {
          const item: PersistedSession = {
            worktreePath: entry.info.worktreePath,
            branch: entry.info.branch,
            agentType: entry.info.agentType,
            label: entry.info.label,
            lastUsedAt: entry.info.createdAt
          };
          if (entry.shellName) item.shellName = entry.shellName;
          if (entry.shellCommand) item.shellCommand = entry.shellCommand;
          if (entry.shellArgs) item.shellArgs = entry.shellArgs;
          snapshot.push(item);
          terminalsToDispose.push(entry.terminal);
        }
      }
      if (this.context) {
        void this.context.workspaceState.update(STORAGE_KEY, snapshot);
      }
      // Clear state first so cascading close events become no-ops.
      this.sessions.clear();
      this.terminalListener?.dispose();
      this.terminalListener = null;
      for (const t of terminalsToDispose) {
        try { t.dispose(); } catch { /* ignore */ }
      }
      this._onChange.fire();
    });
  }

  start(
    worktree: { branch: string; path: string },
    agentType: AgentType,
    shellOverride?: ShellOverride
  ): SessionInfo {
    const id = `${agentType}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const baseLabel = agentType === 'claude' ? 'Claude' : (shellOverride?.name ?? 'Shell');
    const fullLabel =
      agentType === 'claude' && shellOverride
        ? `${baseLabel} · ${shellOverride.name}`
        : baseLabel;

    const opts: vscode.TerminalOptions = {
      name: `vsWT · ${worktree.branch} · ${fullLabel}`,
      cwd: vscode.Uri.file(worktree.path),
      iconPath: new vscode.ThemeIcon(agentType === 'claude' ? 'sparkle' : 'terminal')
    };
    if (shellOverride) {
      opts.shellPath = shellOverride.command;
      if (shellOverride.args && shellOverride.args.length > 0) {
        opts.shellArgs = shellOverride.args;
      }
    }

    const terminal = vscode.window.createTerminal(opts);

    if (agentType === 'claude') {
      const claudePath = getSettings().claudePath || 'claude';
      terminal.sendText(claudePath, true);
    }

    terminal.show();

    const info: SessionInfo = {
      id,
      worktreePath: worktree.path,
      branch: worktree.branch,
      agentType,
      label: fullLabel,
      state: 'running',
      createdAt: Date.now()
    };

    const entry: SessionEntry = { info, terminal };
    if (shellOverride) {
      entry.shellName = shellOverride.name;
      entry.shellCommand = shellOverride.command;
      if (shellOverride.args) entry.shellArgs = shellOverride.args;
    }
    this.sessions.set(id, entry);
    void this.persist();
    this._onChange.fire();
    return info;
  }

  resume(stoppedId: string): SessionInfo | null {
    const entry = this.sessions.get(stoppedId);
    if (!entry || entry.terminal !== null) return null;
    const { worktreePath, branch, agentType } = entry.info;
    const override: ShellOverride | undefined = entry.shellCommand && entry.shellName
      ? {
          name: entry.shellName,
          command: entry.shellCommand,
          ...(entry.shellArgs ? { args: entry.shellArgs } : {})
        }
      : undefined;
    this.sessions.delete(stoppedId);
    this._onChange.fire();
    return this.start({ branch, path: worktreePath }, agentType, override);
  }

  show(id: string): void {
    this.sessions.get(id)?.terminal?.show();
  }

  stop(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    if (entry.terminal === null) {
      // Stopped (post-reload) session — just dismiss it.
      this.sessions.delete(id);
      void this.persist();
      this._onChange.fire();
      return;
    }
    // Mark this id as user-initiated so handleTerminalClose drops fully.
    this.userStopRequested.add(id);
    entry.terminal.dispose();
  }

  /** Look up the session info for a terminal we own (or null if we don't own it). */
  getSessionForTerminal(terminal: vscode.Terminal): SessionInfo | null {
    for (const entry of this.sessions.values()) {
      if (entry.terminal === terminal) return entry.info;
    }
    return null;
  }

  forWorktree(worktreePath: string): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const { info } of this.sessions.values()) {
      if (info.worktreePath === worktreePath) out.push(info);
    }
    return out;
  }

  countForWorktree(worktreePath: string): number {
    let n = 0;
    for (const { info, terminal } of this.sessions.values()) {
      if (info.worktreePath === worktreePath && terminal !== null) n++;
    }
    return n;
  }

  count(): number {
    let n = 0;
    for (const { terminal } of this.sessions.values()) {
      if (terminal !== null) n++;
    }
    return n;
  }

  private restoreFromStorage(): void {
    if (!this.context) return;
    const persisted = this.context.workspaceState.get<PersistedSession[]>(STORAGE_KEY) ?? [];
    for (const p of persisted) {
      const id = `stopped-${p.agentType}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const info: SessionInfo = {
        id,
        worktreePath: p.worktreePath,
        branch: p.branch,
        agentType: p.agentType,
        label: p.label ?? (p.agentType === 'claude' ? 'Claude' : 'Shell'),
        state: 'stopped',
        createdAt: p.lastUsedAt
      };
      const entry: SessionEntry = { info, terminal: null };
      if (p.shellName) entry.shellName = p.shellName;
      if (p.shellCommand) entry.shellCommand = p.shellCommand;
      if (p.shellArgs) entry.shellArgs = p.shellArgs;
      this.sessions.set(id, entry);
    }
    if (persisted.length > 0) this._onChange.fire();
  }

  private async persist(): Promise<void> {
    if (!this.context) return;
    const items: PersistedSession[] = [];
    for (const entry of this.sessions.values()) {
      const item: PersistedSession = {
        worktreePath: entry.info.worktreePath,
        branch: entry.info.branch,
        agentType: entry.info.agentType,
        label: entry.info.label,
        lastUsedAt: entry.info.createdAt
      };
      if (entry.shellName) item.shellName = entry.shellName;
      if (entry.shellCommand) item.shellCommand = entry.shellCommand;
      if (entry.shellArgs) item.shellArgs = entry.shellArgs;
      items.push(item);
    }
    await this.context.workspaceState.update(STORAGE_KEY, items);
  }

  private handleTerminalClose(terminal: vscode.Terminal): void {
    for (const [id, entry] of this.sessions) {
      if (entry.terminal === terminal) {
        const wasUserStop = this.userStopRequested.has(id);
        this.userStopRequested.delete(id);
        if (wasUserStop) {
          // User pressed × in the sidebar → drop the session entirely.
          this.sessions.delete(id);
        } else {
          // Terminal was closed externally (e.g. user clicked the X on the
          // terminal tab) → keep the entry as `stopped` so it can be resumed.
          entry.terminal = null;
          entry.info.state = 'stopped';
        }
        void this.persist();
        this._onChange.fire();
        return;
      }
    }
  }
}
