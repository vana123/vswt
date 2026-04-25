import type { Event } from 'vscode';

export type AgentType = 'shell' | 'claude';

export type AgentState =
  | 'starting'
  | 'running'
  | 'idle'
  | 'waiting-input'
  | 'needs-approval'
  | 'exited';

export interface AgentStartOptions {
  cwd: string;
  cols: number;
  rows: number;
}

/** Common contract for any agent that runs inside a session's PTY. */
export interface AgentProvider {
  readonly type: AgentType;
  readonly state: AgentState;
  readonly onData: Event<string>;
  readonly onState: Event<AgentState>;
  readonly onExit: Event<number | null>;

  start(opts: AgentStartOptions): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  stop(): void;
  /** Recent buffered output for terminal re-attach. */
  replay(): string;
}
