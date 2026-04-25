import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { WorktreeDTO, SessionDTO, WorktreeStatusDTO, FileChangeDTO, ExtraShellDTO } from '../src/webview/protocol';
import { send } from './rpc';
import { tick } from './state';
import {
  ClaudeIcon,
  ShellIcon,
  PinIcon,
  EditIcon,
  CloseIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  RefreshIcon,
  ExternalIcon,
  PRIcon,
  CheckIcon,
  PlayIcon,
  BranchIcon
} from './icons';

function StatusBadge({ status }: { status: WorktreeStatusDTO | undefined }) {
  if (!status) return null;
  const dirty = status.modified + status.untracked;
  const hasAny = dirty > 0 || status.ahead > 0 || status.behind > 0;
  if (!hasAny) return <span class="status-badge clean" title="clean">·</span>;
  return (
    <span class="status-badge">
      {dirty > 0 && (
        <span
          class="dirty"
          title={`${status.modified} modified · ${status.untracked} untracked`}
        >
          ●{dirty}
        </span>
      )}
      {status.ahead > 0 && <span class="ahead" title={`${status.ahead} ahead`}>↑{status.ahead}</span>}
      {status.behind > 0 && <span class="behind" title={`${status.behind} behind`}>↓{status.behind}</span>}
    </span>
  );
}

function classifyFileStatus(code: string): string {
  const t = code.trim();
  if (!t) return 'modified';
  if (t.startsWith('?')) return 'untracked';
  if (t.startsWith('A')) return 'added';
  if (t.startsWith('D') || t.endsWith('D')) return 'deleted';
  if (t.startsWith('R')) return 'renamed';
  return 'modified';
}

function abbreviateStatus(code: string): string {
  const t = code.trim();
  if (!t) return ' ';
  return t.charAt(0);
}

function FileList({ files, worktreePath }: { files: FileChangeDTO[]; worktreePath: string }) {
  return (
    <ul class="files">
      {files.map(f => (
        <li
          key={f.path}
          class="file"
          onClick={() => void send({
            type: 'showFileDiff',
            worktreePath,
            relativePath: f.path,
            statusCode: f.status
          })}
          title="Click to open diff"
        >
          <span class={`file-status ${classifyFileStatus(f.status)}`}>{abbreviateStatus(f.status)}</span>
          <span class="file-name">{f.path}</span>
        </li>
      ))}
    </ul>
  );
}

function SessionRow({ session: s }: { session: SessionDTO }) {
  void tick.value;
  const isStopped = s.state === 'stopped';
  const onClick = isStopped
    ? () => void send({ type: 'resumeSession', sessionId: s.id })
    : () => void send({ type: 'showSession', sessionId: s.id });
  return (
    <li
      class={`session ${s.state} ${s.agentType}`}
      onClick={onClick}
      title={isStopped ? 'Click to resume' : 'Click to focus terminal'}
    >
      <span class="session-icon">
        {isStopped ? <PlayIcon size={12} /> : (s.agentType === 'claude' ? <ClaudeIcon size={12} /> : <ShellIcon size={12} />)}
      </span>
      <span class="session-label">{s.label}{isStopped ? ' · stopped' : ''}</span>
      <span class="session-time">{relativeTime(s.createdAt)}</span>
      <button
        class="ghost icon-btn stop"
        title={isStopped ? 'Dismiss' : 'Stop session'}
        onClick={e => {
          e.stopPropagation();
          void send({ type: 'stopSession', sessionId: s.id });
        }}
      >
        <CloseIcon size={10} />
      </button>
    </li>
  );
}

export function Card({
  worktree,
  sessions,
  extraShells
}: {
  worktree: WorktreeDTO;
  sessions: SessionDTO[];
  extraShells: ExtraShellDTO[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(worktree.branch);
  const [expanded, setExpanded] = useState(false);

  const files = worktree.status?.files ?? [];
  const hasChanges = files.length > 0;

  const startEdit = () => {
    setDraft(worktree.branch);
    setEditing(true);
  };
  const commitEdit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== worktree.branch) {
      void send({ type: 'renameWorktree', path: worktree.path, newBranch: next });
    }
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft(worktree.branch);
  };

  return (
    <div class={`card ${worktree.pinned ? 'pinned' : ''}`}>
      {/* Header: identity + manage */}
      <header class="card-header">
        <button
          class={`pin-btn ${worktree.pinned ? 'is-pinned' : ''}`}
          title={worktree.pinned ? 'Unpin' : 'Pin to top'}
          onClick={() => void send({ type: 'togglePin', path: worktree.path })}
        >
          <PinIcon size={12} />
        </button>
        <span class="branch-icon"><BranchIcon size={14} /></span>
        {editing ? (
          <input
            class="branch-input"
            value={draft}
            onInput={e => setDraft((e.target as HTMLInputElement).value)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitEdit();
              else if (e.key === 'Escape') cancelEdit();
            }}
            onBlur={commitEdit}
            ref={el => { if (el) el.focus(); }}
          />
        ) : (
          <span
            class="branch-name"
            title={`${worktree.path}\n(double-click to rename)`}
            onDblClick={startEdit}
          >
            {worktree.branch}
          </span>
        )}
        {!editing && worktree.base && (
          <span class="branch-base" title={`Forked from ${worktree.base}`}>
            ← {worktree.base}
          </span>
        )}
        {hasChanges ? (
          <button
            class="status-badge-btn"
            title={expanded ? 'Hide changed files' : 'Show changed files'}
            onClick={() => setExpanded(v => !v)}
          >
            <StatusBadge status={worktree.status} />
          </button>
        ) : (
          <StatusBadge status={worktree.status} />
        )}
        <div class="header-actions">
          <button class="ghost icon-btn" title="Rename" onClick={startEdit}>
            <EditIcon size={11} />
          </button>
          <button
            class="ghost icon-btn danger"
            title="Remove worktree"
            onClick={() => void send({ type: 'removeWorktree', path: worktree.path })}
          >
            <CloseIcon size={11} />
          </button>
        </div>
      </header>

      {expanded && hasChanges && <FileList files={files} worktreePath={worktree.path} />}

      {/* Sessions block */}
      {sessions.length > 0 ? (
        <ul class="sessions">
          {sessions.map(s => <SessionRow key={s.id} session={s} />)}
        </ul>
      ) : (
        <div class="empty-sessions">no active sessions</div>
      )}

      {/* Primary actions: start new session */}
      <div class="actions primary-actions">
        <AgentDropdown
          label="Claude"
          icon={<ClaudeIcon size={12} />}
          buttonClass="claude-action"
          extraShells={extraShells}
          onPick={(shellName) => void send(
            shellName !== undefined
              ? { type: 'startSession', worktreePath: worktree.path, agentType: 'claude', shellName }
              : { type: 'startSession', worktreePath: worktree.path, agentType: 'claude' }
          )}
        />
        <AgentDropdown
          label="Shell"
          icon={<ShellIcon size={12} />}
          extraShells={extraShells}
          onPick={(shellName) => void send(
            shellName !== undefined
              ? { type: 'startSession', worktreePath: worktree.path, agentType: 'shell', shellName }
              : { type: 'startSession', worktreePath: worktree.path, agentType: 'shell' }
          )}
        />
        <button
          class="action ghost"
          onClick={() => void send({ type: 'openTerminal', path: worktree.path })}
          title="One-off plain terminal (not tracked)"
        >
          <ShellIcon size={12} />
          <span>Term</span>
        </button>
      </div>

      {/* Git toolbar */}
      <div class="actions git-actions">
        <button
          class="ghost icon-btn"
          title="Pull (--ff-only)"
          onClick={() => void send({ type: 'pullWorktree', path: worktree.path })}
        >
          <ArrowDownIcon size={12} />
        </button>
        <button
          class="ghost icon-btn"
          title="Push"
          onClick={() => void send({ type: 'pushWorktree', path: worktree.path })}
        >
          <ArrowUpIcon size={12} />
        </button>
        <button
          class="ghost icon-btn"
          title="Fetch --all --prune"
          onClick={() => void send({ type: 'fetchWorktree', path: worktree.path })}
        >
          <RefreshIcon size={12} />
        </button>
        <span class="divider" />
        <button
          class="ghost"
          onClick={() => void send({ type: 'openWorktree', path: worktree.path, newWindow: true })}
          title="Open in new VS Code window"
        >
          <ExternalIcon size={11} />
          <span>Open</span>
        </button>
        <button
          class="ghost"
          onClick={() => void send({ type: 'createPR', path: worktree.path })}
          title="Create PR via gh CLI"
        >
          <PRIcon size={11} />
          <span>PR</span>
        </button>
        <button
          class="ghost"
          onClick={() => void send({ type: 'finishWorktree', path: worktree.path })}
          title="Push, merge into base, push, remove worktree"
        >
          <CheckIcon size={11} />
          <span>Finish</span>
        </button>
      </div>
    </div>
  );
}

function AgentDropdown({
  label,
  icon,
  buttonClass,
  extraShells,
  onPick
}: {
  label: string;
  icon: JSX.Element;
  buttonClass?: string;
  extraShells: ExtraShellDTO[];
  onPick: (shellName: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const id = window.setTimeout(() => {
      window.addEventListener('mousedown', onMouseDown);
    }, 0);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const pick = (shellName: string | undefined) => {
    setOpen(false);
    onPick(shellName);
  };

  // No extras configured — render as a plain button without dropdown.
  if (extraShells.length === 0) {
    return (
      <button
        class={`action ${buttonClass ?? ''}`}
        onClick={() => pick(undefined)}
        title={`Start ${label} session`}
      >
        {icon}
        <span>{label}</span>
      </button>
    );
  }

  return (
    <div class="shell-picker" ref={wrapperRef}>
      <button
        class={`action shell-toggle ${buttonClass ?? ''} ${open ? 'open' : ''}`}
        onClick={() => setOpen(v => !v)}
        title={`Start ${label} session — pick shell`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {icon}
        <span>{label}</span>
        <span class="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div class="shell-menu" role="menu">
          <button class="menu-item" onClick={() => pick(undefined)} role="menuitem">
            <ShellIcon size={11} />
            <span class="menu-label">Default</span>
            <span class="menu-hint">system</span>
          </button>
          {extraShells.map(sh => (
            <button
              key={sh.name}
              class="menu-item"
              onClick={() => pick(sh.name)}
              title={sh.command}
              role="menuitem"
            >
              <ShellIcon size={11} />
              <span class="menu-label">{sh.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
