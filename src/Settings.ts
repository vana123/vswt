import * as vscode from 'vscode';

const SECTION = 'vswt';

export interface VswtConfig {
  /** Override parent dir for worktrees. Empty = sibling `../{repo}-worktrees`. */
  worktreeParentDir: string;
  /** Glob patterns relative to repo root, copied into a new worktree when opt-in. */
  worktreeCopyFiles: string[];
  /** Shell command run in the new worktree after creation. Empty = skip. */
  worktreePostCreateCommand: string;
  /** Run `npx prisma generate` if `prisma/schema.prisma` exists. */
  worktreeRunPrismaGenerate: boolean;
  /** Windows shell override (`pwsh.exe`, `powershell.exe`, `cmd.exe`). Empty = auto. */
  shellWindows: string;
  /** Play OS sound on session state transitions. */
  notificationsSound: boolean;
  /** Path or command name for Claude Code CLI. Default: `claude`. */
  claudePath: string;
}

export function getSettings(): VswtConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    worktreeParentDir: cfg.get<string>('worktree.parentDir') ?? '',
    worktreeCopyFiles: cfg.get<string[]>('worktree.copyFiles') ?? ['.env', '.env.*', '.claude/**'],
    worktreePostCreateCommand: cfg.get<string>('worktree.postCreateCommand') ?? '',
    worktreeRunPrismaGenerate: cfg.get<boolean>('worktree.runPrismaGenerate') ?? true,
    shellWindows: cfg.get<string>('shell.windows') ?? '',
    notificationsSound: cfg.get<boolean>('notifications.sound') ?? true,
    claudePath: cfg.get<string>('claude.path') ?? 'claude'
  };
}

export function onSettingsChange(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(SECTION)) handler();
  });
}
