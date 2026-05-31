import * as vscode from 'vscode';
import { SessionsExplorerHandle } from '../sessions/sessions-explorer';
import { UsageActivityBadge } from './activity-badge';
import { UsageScanner } from './usage-scanner';
import { UsageStatusBar } from './status-bar';
import { Plan, UsageConfig, UsageTracker } from './usage-tracker';

const SECTION = 'vswt.usage';
const REFRESH_DEBOUNCE_MS = 1_500;
/** Re-scan periodically so the 5h block window naturally slides forward. */
const PERIODIC_REFRESH_MS = 60_000;

export interface UsageHandle {
  refresh: () => Promise<void>;
}

export function registerUsage(
  context: vscode.ExtensionContext,
  explorer: SessionsExplorerHandle,
  output: vscode.OutputChannel
): UsageHandle {
  let enabled = isEnabled();
  let scanner: UsageScanner | undefined;
  let tracker: UsageTracker | undefined;
  let statusBar: UsageStatusBar | undefined;
  let badge: UsageActivityBadge | undefined;
  let watcher: vscode.FileSystemWatcher | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let periodic: ReturnType<typeof setInterval> | undefined;

  const scheduleRefresh = (): void => {
    if (!tracker) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      void tracker?.refresh().catch(err => {
        output.appendLine(`[vsWT] usage refresh failed: ${(err as Error).message}`);
      });
    }, REFRESH_DEBOUNCE_MS);
  };

  const setupWatcher = (projectsDir: string): void => {
    watcher?.dispose();
    try {
      watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(projectsDir), '**/*.jsonl')
      );
      watcher.onDidCreate(scheduleRefresh);
      watcher.onDidChange(scheduleRefresh);
      watcher.onDidDelete(scheduleRefresh);
    } catch (err) {
      output.appendLine(`[vsWT] usage watcher failed: ${(err as Error).message}`);
    }
  };

  const start = (): void => {
    if (scanner) return;
    const projectsDir = explorer.projectsDir();
    scanner = new UsageScanner(projectsDir);
    tracker = new UsageTracker(scanner, getConfig);
    statusBar = new UsageStatusBar(tracker, getAlertThreshold);
    badge = new UsageActivityBadge(explorer.treeView, tracker, getAlertThreshold);
    setupWatcher(projectsDir);
    periodic = setInterval(scheduleRefresh, PERIODIC_REFRESH_MS);
    void tracker.refresh().catch(err => {
      output.appendLine(`[vsWT] initial usage scan failed: ${(err as Error).message}`);
    });
  };

  const stop = (): void => {
    if (debounce) {
      clearTimeout(debounce);
      debounce = undefined;
    }
    if (periodic) {
      clearInterval(periodic);
      periodic = undefined;
    }
    watcher?.dispose();
    watcher = undefined;
    badge?.dispose();
    badge = undefined;
    statusBar?.dispose();
    statusBar = undefined;
    tracker?.dispose();
    tracker = undefined;
    scanner = undefined;
  };

  if (enabled) start();

  context.subscriptions.push(
    new vscode.Disposable(stop),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(`${SECTION}.enabled`)) {
        const now = isEnabled();
        if (now === enabled) return;
        enabled = now;
        if (enabled) start();
        else stop();
        return;
      }
      if (
        e.affectsConfiguration(`${SECTION}.plan`) ||
        e.affectsConfiguration(`${SECTION}.customBlockTokens`) ||
        e.affectsConfiguration(`${SECTION}.customWeekTokens`) ||
        e.affectsConfiguration(`${SECTION}.alertThreshold`)
      ) {
        void tracker?.refresh();
      }
    }),
    explorer.onProjectsDirChange(dir => {
      scanner?.setProjectsDir(dir);
      if (enabled) {
        setupWatcher(dir);
        void tracker?.refresh();
      }
    }),
    vscode.commands.registerCommand('vswt.usage.refresh', () => tracker?.refresh()),
    vscode.commands.registerCommand('vswt.usage.showDetails', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.vswt');
    })
  );

  return {
    refresh: async () => {
      await tracker?.refresh();
    }
  };
}

function isEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(`${SECTION}.enabled`) ?? true;
}

function getAlertThreshold(): number {
  const v = vscode.workspace.getConfiguration().get<number>(`${SECTION}.alertThreshold`);
  if (typeof v !== 'number' || !Number.isFinite(v)) return 80;
  return Math.min(100, Math.max(0, v));
}

function getConfig(): UsageConfig {
  const cfg = vscode.workspace.getConfiguration();
  const planRaw = cfg.get<string>(`${SECTION}.plan`);
  const plan: Plan =
    planRaw === 'pro' || planRaw === 'max5' || planRaw === 'max20' || planRaw === 'custom'
      ? planRaw
      : 'max20';
  return {
    plan,
    customBlockTokens: nonNegativeNumber(cfg.get<number>(`${SECTION}.customBlockTokens`)),
    customWeekTokens: nonNegativeNumber(cfg.get<number>(`${SECTION}.customWeekTokens`))
  };
}

function nonNegativeNumber(v: number | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}
