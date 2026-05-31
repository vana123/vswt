import * as vscode from 'vscode';
import { UsageSnapshot, UsageTracker } from './usage-tracker';

/**
 * Mirrors high-usage state into the sidebar's activity-bar icon badge.
 * Shows the worst percentage when ≥ threshold, clears otherwise.
 */
export class UsageActivityBadge {
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly treeView: vscode.TreeView<unknown>,
    tracker: UsageTracker,
    private readonly alertThresholdPct: () => number
  ) {
    const cur = tracker.current();
    if (cur) this.apply(cur);
    this.sub = tracker.onDidChange(snap => this.apply(snap));
  }

  dispose(): void {
    this.sub.dispose();
    this.treeView.badge = undefined;
  }

  private apply(snap: UsageSnapshot): void {
    const worst = Math.max(snap.block.pct, snap.week.pct);
    if (worst < this.alertThresholdPct()) {
      this.treeView.badge = undefined;
      return;
    }
    this.treeView.badge = {
      value: worst,
      tooltip:
        worst === snap.block.pct
          ? `Claude 5h block at ${worst}%`
          : `Claude weekly usage at ${worst}%`
    };
  }
}
