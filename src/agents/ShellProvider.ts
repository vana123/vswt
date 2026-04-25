import * as vscode from 'vscode';
import type { AgentProvider, AgentState, AgentStartOptions } from './AgentProvider';
import { PtyHost } from './PtyHost';
import { getDefaultShell } from './shellHelper';

export class ShellProvider implements AgentProvider {
  public readonly type = 'shell' as const;
  public state: AgentState = 'starting';
  private readonly host = new PtyHost();
  private readonly _onState = new vscode.EventEmitter<AgentState>();

  public readonly onData = this.host.onData;
  public readonly onExit = this.host.onExit;
  public readonly onState = this._onState.event;

  constructor() {
    this.host.onExit(() => this.setState('exited'));
    this.host.onData(() => {
      if (this.state === 'starting') this.setState('running');
    });
  }

  start(opts: AgentStartOptions): void {
    const shell = getDefaultShell();
    this.host.spawn({
      command: shell.command,
      args: shell.args,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows
    });
  }

  write(data: string): void {
    this.host.write(data);
  }

  resize(cols: number, rows: number): void {
    this.host.resize(cols, rows);
  }

  stop(): void {
    this.host.kill();
  }

  replay(): string {
    return this.host.replay();
  }

  private setState(next: AgentState): void {
    if (next === this.state) return;
    this.state = next;
    this._onState.fire(next);
  }
}
