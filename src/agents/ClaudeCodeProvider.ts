import * as vscode from 'vscode';
import type { AgentProvider, AgentState, AgentStartOptions } from './AgentProvider';
import { PtyHost } from './PtyHost';
import { ClaudeStateDetector } from './StateDetector';
import { getSettings } from '../Settings';
import { getDefaultShell } from './shellHelper';

const SHELL_WARMUP_MS = 600;

export class ClaudeCodeProvider implements AgentProvider {
  public readonly type = 'claude' as const;
  public state: AgentState = 'starting';
  private readonly host = new PtyHost();
  private readonly detector = new ClaudeStateDetector();
  private readonly _onState = new vscode.EventEmitter<AgentState>();
  private launchTimer: NodeJS.Timeout | null = null;

  public readonly onData = this.host.onData;
  public readonly onExit = this.host.onExit;
  public readonly onState = this._onState.event;

  constructor() {
    this.host.onData(d => this.detector.feed(d));
    this.host.onExit(() => this.setState('exited'));
    this.detector.onState(s => this.setState(s));
  }

  start(opts: AgentStartOptions): void {
    const claudePath = getSettings().claudePath || 'claude';
    const shell = getDefaultShell();

    // Spawn user's interactive shell so cross-platform script shims (e.g. claude.cmd
    // on Windows) and PATH from the user's shell profile are honoured.
    this.host.spawn({
      command: shell.command,
      args: shell.args,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows
    });

    // Once the shell has finished loading its profile, type the launch command for
    // the user as if they had run it themselves.
    this.launchTimer = setTimeout(() => {
      this.host.write(`${claudePath}\r`);
      this.launchTimer = null;
    }, SHELL_WARMUP_MS);

    this.setState('starting');
  }

  write(data: string): void {
    this.host.write(data);
  }

  resize(cols: number, rows: number): void {
    this.host.resize(cols, rows);
  }

  stop(): void {
    if (this.launchTimer) {
      clearTimeout(this.launchTimer);
      this.launchTimer = null;
    }
    this.host.kill();
    this.detector.dispose();
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
