import { EventEmitter } from 'vscode';
import * as nodePty from 'node-pty';

export interface PtySpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

const MAX_BUFFER_BYTES = 256 * 1024;

/** Thin wrapper around node-pty with a ring buffer for terminal re-attach. */
export class PtyHost {
  private process: nodePty.IPty | null = null;
  private readonly buffer: string[] = [];
  private bufferBytes = 0;

  private readonly _onData = new EventEmitter<string>();
  public readonly onData = this._onData.event;
  private readonly _onExit = new EventEmitter<number | null>();
  public readonly onExit = this._onExit.event;

  spawn(opts: PtySpawnOptions): void {
    if (this.process) throw new Error('PtyHost already spawned');
    try {
      this.process = nodePty.spawn(opts.command, opts.args, {
        name: 'xterm-256color',
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env, TERM: 'xterm-256color' },
        cols: opts.cols,
        rows: opts.rows
      });
    } catch (err) {
      const msg = (err as Error).message;
      // Surface spawn failures as a visible error in the terminal and fail the session.
      setImmediate(() => {
        this.append(`\r\n\x1b[31m[vsWT] failed to spawn ${opts.command}: ${msg}\x1b[0m\r\n`);
        this._onData.fire(`\r\n\x1b[31m[vsWT] failed to spawn ${opts.command}: ${msg}\x1b[0m\r\n`);
        this._onExit.fire(127);
      });
      return;
    }
    this.process.onData(d => {
      this.append(d);
      this._onData.fire(d);
    });
    this.process.onExit(({ exitCode }) => {
      this._onExit.fire(exitCode ?? null);
      this.process = null;
    });
  }

  write(data: string): void {
    this.process?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.process) return;
    try {
      this.process.resize(Math.max(1, cols), Math.max(1, rows));
    } catch {
      // Resize on a dead pty throws on some platforms; safe to ignore.
    }
  }

  kill(signal?: string): void {
    if (!this.process) return;
    try {
      this.process.kill(signal);
    } catch {
      // Already dead.
    }
  }

  replay(): string {
    return this.buffer.join('');
  }

  private append(data: string): void {
    this.buffer.push(data);
    this.bufferBytes += data.length;
    while (this.bufferBytes > MAX_BUFFER_BYTES && this.buffer.length > 1) {
      const dropped = this.buffer.shift()!;
      this.bufferBytes -= dropped.length;
    }
  }
}
