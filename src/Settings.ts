import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';

const SECTION = 'vswt';

export interface ExtraShell {
  name: string;
  command: string;
  args?: string[];
}

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
  /** Additional shell options exposed as session buttons (e.g. Git Bash, CMD). */
  extraShells: ExtraShell[];
}

// Cross-platform candidate shells, probed at activation.
const WINDOWS_CANDIDATES: ExtraShell[] = [
  { name: 'Git Bash', command: 'C:\\Program Files\\Git\\bin\\bash.exe' },
  { name: 'Git Bash', command: 'C:\\Program Files (x86)\\Git\\bin\\bash.exe' },
  { name: 'CMD', command: 'C:\\Windows\\System32\\cmd.exe' },
  { name: 'PowerShell 7', command: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }
];

const MAC_CANDIDATES: ExtraShell[] = [
  { name: 'Bash', command: '/bin/bash' },
  { name: 'Zsh', command: '/bin/zsh' },
  { name: 'Fish', command: '/opt/homebrew/bin/fish' },
  { name: 'Fish', command: '/usr/local/bin/fish' }
];

const LINUX_CANDIDATES: ExtraShell[] = [
  { name: 'Bash', command: '/bin/bash' },
  { name: 'Zsh', command: '/usr/bin/zsh' },
  { name: 'Zsh', command: '/bin/zsh' },
  { name: 'Fish', command: '/usr/bin/fish' },
  { name: 'Fish', command: '/usr/local/bin/fish' }
];

let cachedDefaults: ExtraShell[] | null = null;

async function probeDefaultExtraShells(): Promise<ExtraShell[]> {
  const candidates =
    process.platform === 'win32' ? WINDOWS_CANDIDATES :
    process.platform === 'darwin' ? MAC_CANDIDATES :
    LINUX_CANDIDATES;
  const seen = new Set<string>();
  const available: ExtraShell[] = [];
  for (const c of candidates) {
    if (seen.has(c.name)) continue;
    try {
      await fs.access(c.command);
      available.push(c);
      seen.add(c.name);
    } catch {
      // Path not present; skip.
    }
  }
  // Dedupe against the user's VS Code default shell — no point showing
  // "Bash" if the default already resolves to /bin/bash.
  const defaultShell = (vscode.env.shell ?? '').trim();
  return defaultShell
    ? available.filter(s => s.command !== defaultShell)
    : available;
}

/**
 * Probe filesystem for available shells once at activation. Until this resolves
 * `defaultExtraShells()` returns a synchronous fallback (Windows-only).
 */
export async function initSettings(): Promise<void> {
  cachedDefaults = await probeDefaultExtraShells();
}

function defaultExtraShells(): ExtraShell[] {
  if (cachedDefaults !== null) return cachedDefaults;
  if (process.platform === 'win32') {
    return [
      { name: 'Git Bash', command: 'C:\\Program Files\\Git\\bin\\bash.exe' },
      { name: 'CMD', command: 'cmd.exe' }
    ];
  }
  return [];
}

export function getSettings(): VswtConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION);

  // Respect explicit user/workspace setting (including empty array); fall back
  // to platform defaults only when no value is configured.
  const inspect = cfg.inspect<ExtraShell[]>('extraShells');
  const userExtras = inspect?.workspaceValue ?? inspect?.globalValue;
  const extraShells = userExtras !== undefined ? userExtras : defaultExtraShells();

  return {
    worktreeParentDir: cfg.get<string>('worktree.parentDir') ?? '',
    worktreeCopyFiles: cfg.get<string[]>('worktree.copyFiles') ?? ['.env', '.env.*', '.claude/CLAUDE.md', '.claude/agents/**', '.claude/commands/**'],
    worktreePostCreateCommand: cfg.get<string>('worktree.postCreateCommand') ?? '',
    worktreeRunPrismaGenerate: cfg.get<boolean>('worktree.runPrismaGenerate') ?? true,
    shellWindows: cfg.get<string>('shell.windows') ?? '',
    notificationsSound: cfg.get<boolean>('notifications.sound') ?? true,
    claudePath: cfg.get<string>('claude.path') ?? 'claude',
    extraShells
  };
}

export function onSettingsChange(handler: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(SECTION)) handler();
  });
}
