import * as vscode from 'vscode';
import type { AgentState } from './AgentProvider';

// CSI sequences (cursor moves, color, etc.)
const ANSI_CSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
// OSC sequences (window title, hyperlinks, etc.)
const ANSI_OSC = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI, '').replace(ANSI_OSC, '');
}

/**
 * Heuristics calibrated against Claude Code's TUI as of 2026-04.
 * Tune these in `claude-tui-patterns.ts` style if Anthropic changes the UI.
 */
const WORKING_RE = /\(\d+s\s*[·•]\s*esc/i;          // "...(12s · esc to interrupt)"
const APPROVAL_RE = /❯\s*1\.\s*Yes/;                // tool-approval menu first option
const PROMPT_RE = /›\s{0,4}$/m;                     // input prompt arrow at end of line
const SILENCE_MS = 1500;

export class ClaudeStateDetector {
  private buffer = '';
  private silenceTimer: NodeJS.Timeout | null = null;
  private current: AgentState = 'starting';
  private readonly _onState = new vscode.EventEmitter<AgentState>();
  public readonly onState = this._onState.event;

  feed(data: string): void {
    this.buffer = (this.buffer + stripAnsi(data)).slice(-8192);

    const tail = this.buffer.slice(-2048);
    if (APPROVAL_RE.test(tail)) {
      this.transition('needs-approval');
    } else if (WORKING_RE.test(tail)) {
      this.transition('running');
    } else {
      // Default to running on activity; silence handler reclassifies.
      this.transition('running');
    }

    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.onSilence(), SILENCE_MS);
  }

  state(): AgentState {
    return this.current;
  }

  reset(): void {
    this.buffer = '';
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this.transition('starting');
  }

  dispose(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    this._onState.dispose();
  }

  private onSilence(): void {
    if (this.current === 'needs-approval') return; // sticky until next chunk
    const tail = this.buffer.slice(-512);
    this.transition(PROMPT_RE.test(tail) ? 'waiting-input' : 'idle');
  }

  private transition(next: AgentState): void {
    if (next === this.current) return;
    this.current = next;
    this._onState.fire(next);
  }
}
