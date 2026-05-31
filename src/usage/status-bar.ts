import * as vscode from 'vscode';
import { FamilyBreakdown, UsageSnapshot, UsageTracker } from './usage-tracker';

const PLAN_LABEL: Record<UsageSnapshot['plan'], string> = {
  pro: 'Pro',
  max5: 'Max 5×',
  max20: 'Max 20×',
  custom: 'Custom'
};

/**
 * Status-bar indicator wired to the UsageTracker. Sits on the left, after
 * the git branch. Click opens the sidebar; hover shows the full breakdown.
 */
export class UsageStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly sub: vscode.Disposable;

  constructor(private readonly tracker: UsageTracker, private readonly alertThresholdPct: () => number) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.item.command = 'vswt.usage.showDetails';
    this.item.name = 'Claude Code usage';
    this.item.text = '$(loading~spin) Claude';
    this.item.tooltip = 'Computing Claude Code usage…';
    this.item.show();

    const cur = tracker.current();
    if (cur) this.render(cur);
    this.sub = tracker.onDidChange(snap => this.render(snap));
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }

  private render(snap: UsageSnapshot): void {
    const blockPct = snap.block.pct;
    const weekPct = snap.week.pct;

    this.item.text = `$(sparkle) Claude  ${blockPct}% · wk ${weekPct}%`;

    const threshold = this.alertThresholdPct();
    const worst = Math.max(blockPct, weekPct);
    if (worst >= 100) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (worst >= threshold) {
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      this.item.backgroundColor = undefined;
    }

    this.item.tooltip = buildTooltip(snap, threshold);
  }
}

function buildTooltip(snap: UsageSnapshot, threshold: number): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.supportThemeIcons = true;

  md.appendMarkdown(`**Claude Code usage** — plan: ${PLAN_LABEL[snap.plan]}\n\n`);

  md.appendMarkdown(`**5-hour block** · ${snap.block.pct}% of ${formatTokens(snap.block.limitTokens)}\n`);
  md.appendMarkdown(`${bar(snap.block.pct, threshold)}\n`);
  md.appendMarkdown(`Used ${formatTokens(snap.block.usedTokens)}`);
  if (snap.block.resetAt !== null) {
    md.appendMarkdown(` · resets ${formatRelative(snap.block.resetAt, snap.computedAt)}`);
  } else {
    md.appendMarkdown(` · no recent activity`);
  }
  md.appendMarkdown('\n');
  if (snap.block.breakdown.length > 0) {
    md.appendMarkdown(`${formatBreakdown(snap.block.breakdown)}\n\n`);
  } else {
    md.appendMarkdown('\n');
  }

  md.appendMarkdown(`**Last 7 days** · ${snap.week.pct}% of ${formatTokens(snap.week.limitTokens)}\n`);
  md.appendMarkdown(`${bar(snap.week.pct, threshold)}\n`);
  md.appendMarkdown(`Used ${formatTokens(snap.week.usedTokens)}\n`);
  if (snap.week.breakdown.length > 0) {
    md.appendMarkdown(`${formatBreakdown(snap.week.breakdown)}\n\n`);
  } else {
    md.appendMarkdown('\n');
  }

  md.appendMarkdown(`_Tier limits are best-guess; tune via \`vswt.usage.customBlockTokens\` / \`customWeekTokens\`._`);
  return md;
}

function formatBreakdown(b: FamilyBreakdown[]): string {
  return b.map(x => `${capitalize(x.family)} ${formatTokens(x.tokens)}`).join(' · ');
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function bar(pct: number, threshold: number): string {
  const cells = 20;
  const filled = Math.min(cells, Math.round((pct / 100) * cells));
  const mark = pct >= 100 ? '🟥' : pct >= threshold ? '🟧' : '🟩';
  return `${mark} ${'█'.repeat(filled)}${'░'.repeat(cells - filled)} ${pct}%`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return `${n}`;
}

function formatRelative(target: number, now: number): string {
  const deltaMs = target - now;
  if (deltaMs <= 0) return 'now';
  const min = Math.round(deltaMs / 60_000);
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `in ${h}h ${m}m` : `in ${h}h`;
}
