export type AgentType = 'shell' | 'claude';
export type SessionState = 'running' | 'exited' | 'stopped';

export interface FileChangeDTO {
  status: string;
  path: string;
}

export interface WorktreeStatusDTO {
  modified: number;
  untracked: number;
  ahead: number;
  behind: number;
  files: FileChangeDTO[];
}

export interface WorktreeDTO {
  branch: string;
  path: string;
  pinned: boolean;
  /** Branch this worktree was forked from. `null` if unknown (e.g. created externally). */
  base: string | null;
  status?: WorktreeStatusDTO;
}

export interface SessionDTO {
  id: string;
  worktreePath: string;
  branch: string;
  agentType: AgentType;
  label: string;
  state: SessionState;
  createdAt: number;
  isActive: boolean;
}

export interface ExtraShellDTO {
  name: string;
  command: string;
  args: string[];
}

export interface AppState {
  repoLabel: string;
  worktrees: WorktreeDTO[];
  sessions: SessionDTO[];
  extraShells: ExtraShellDTO[];
}

export type RpcRequest =
  | { type: 'ready' }
  | { type: 'pickRepo' }
  | { type: 'createWorktree' }
  | { type: 'removeWorktree'; path: string }
  | { type: 'renameWorktree'; path: string; newBranch: string }
  | { type: 'pushWorktree'; path: string }
  | { type: 'pullWorktree'; path: string }
  | { type: 'fetchWorktree'; path: string }
  | { type: 'showFileDiff'; worktreePath: string; relativePath: string; statusCode: string }
  | { type: 'createPR'; path: string }
  | { type: 'finishWorktree'; path: string }
  | { type: 'copyFilesToWorktree'; path: string }
  | { type: 'togglePin'; path: string }
  | { type: 'startSession'; worktreePath: string; agentType: AgentType; shellName?: string }
  | { type: 'stopSession'; sessionId: string }
  | { type: 'showSession'; sessionId: string }
  | { type: 'resumeSession'; sessionId: string }
  | { type: 'openWorktree'; path: string; newWindow: boolean }
  | { type: 'openTerminal'; path: string };

export interface OutgoingRequest extends Object {
  rid: string;
}

export interface RpcResponse {
  rid: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export type Notification =
  | ({ kind: 'state' } & AppState);

export type FromWebview = RpcRequest & { rid: string };
export type ToWebview = RpcResponse | Notification;
