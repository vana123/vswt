import * as vscode from 'vscode';
import { getSettings } from './Settings';

export type AgentType = 'shell' | 'claude';
export type AgentState = 'running' | 'exited';

export interface SessionInfo {
  id: string;
  worktreePath: string;
  branch: string;
  agentType: AgentType;
  state: AgentState;
  createdAt: number;
}

interface SessionEntry {
  info: SessionInfo;
  terminal: vscode.Terminal;
}

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly _onChange = new vscode.EventEmitter<void>();
  public readonly onChange = this._onChange.event;
  private terminalListener: vscode.Disposable | null = null;

  init(): vscode.Disposable {
    this.terminalListener = vscode.window.onDidCloseTerminal(t => this.handleTerminalClose(t));
    return new vscode.Disposable(() => {
      this.terminalListener?.dispose();
      this.terminalListener = null;
      for (const { terminal } of this.sessions.values()) {
        terminal.dispose();
      }
      this.sessions.clear();
      this._onChange.fire();
    });
  }

  start(worktree: { branch: string; path: string }, agentType: AgentType): SessionInfo {
    const id = `${agentType}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const label = agentType === 'claude' ? 'Claude' : 'Shell';

    const terminal = vscode.window.createTerminal({
      name: `vsWT · ${worktree.branch} · ${label}`,
      cwd: vscode.Uri.file(worktree.path),
      iconPath: new vscode.ThemeIcon(agentType === 'claude' ? 'sparkle' : 'terminal')
    });

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
      state: 'running',
      createdAt: Date.now()
    };

    this.sessions.set(id, { info, terminal });
    this._onChange.fire();
    return info;
  }

  show(id: string): void {
    this.sessions.get(id)?.terminal.show();
  }

  stop(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    entry.terminal.dispose();
    // handleTerminalClose finalises the map entry.
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
    for (const { info } of this.sessions.values()) {
      if (info.worktreePath === worktreePath) n++;
    }
    return n;
  }

  count(): number {
    return this.sessions.size;
  }

  private handleTerminalClose(terminal: vscode.Terminal): void {
    for (const [id, entry] of this.sessions) {
      if (entry.terminal === terminal) {
        this.sessions.delete(id);
        this._onChange.fire();
        return;
      }
    }
  }
}
