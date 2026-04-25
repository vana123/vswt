import { signal } from '@preact/signals';
import type { WorktreeDTO, SessionDTO, ExtraShellDTO } from '../src/webview/protocol';

export const worktrees = signal<WorktreeDTO[]>([]);
export const sessions = signal<SessionDTO[]>([]);
export const extraShells = signal<ExtraShellDTO[]>([]);
export const repoLabel = signal<string>('');
export const tick = signal<number>(0); // bumped every second to refresh "x ago" labels
