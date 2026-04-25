import { useEffect, useState } from 'preact/hooks';
import { worktrees, sessions, extraShells, repoLabel, tick } from './state';
import { send, onNotification } from './rpc';
import { Card } from './Card';
import { FolderIcon, SearchIcon } from './icons';

const FILTER_THRESHOLD = 3;

export function App() {
  const [filter, setFilter] = useState('');

  useEffect(() => {
    const unsub = onNotification(n => {
      if (n.kind === 'state') {
        worktrees.value = n.worktrees;
        sessions.value = n.sessions;
        extraShells.value = n.extraShells;
        repoLabel.value = n.repoLabel;
      }
    });
    void send({ type: 'ready' });
    const interval = window.setInterval(() => {
      tick.value = tick.value + 1;
    }, 30_000);
    return () => {
      unsub();
      window.clearInterval(interval);
    };
  }, []);

  const hasRepo = repoLabel.value.length > 0;
  const trees = worktrees.value;
  const showFilter = trees.length >= FILTER_THRESHOLD;
  const filterLower = filter.trim().toLowerCase();
  const filteredTrees = filterLower
    ? trees.filter(w => w.branch.toLowerCase().includes(filterLower))
    : trees;

  return (
    <div class="app">
      <header class="repo-header">
        {hasRepo ? (
          <>
            <FolderIcon size={12} className="repo-icon" />
            <span class="repo-name">{repoLabel.value}</span>
            <button
              class="link"
              onClick={() => void send({ type: 'pickRepo' })}
              title="Switch repository"
            >
              change
            </button>
          </>
        ) : (
          <button class="link" onClick={() => void send({ type: 'pickRepo' })}>
            Pick repository…
          </button>
        )}
      </header>

      {showFilter && (
        <div class="filter-row">
          <SearchIcon size={11} className="filter-icon" />
          <input
            type="search"
            class="filter"
            placeholder={`Filter ${trees.length} branches…`}
            value={filter}
            onInput={e => setFilter((e.target as HTMLInputElement).value)}
          />
        </div>
      )}

      {hasRepo && trees.length === 0 ? (
        <div class="empty">
          <p>No worktrees yet.</p>
          <button class="primary" onClick={() => void send({ type: 'createWorktree' })}>
            + Create your first worktree
          </button>
        </div>
      ) : filterLower && filteredTrees.length === 0 ? (
        <div class="empty">
          <p>No matches for "{filter}".</p>
          <button class="link" onClick={() => setFilter('')}>Clear filter</button>
        </div>
      ) : (
        <div class="cards">
          {filteredTrees.map(w => (
            <Card
              key={w.path}
              worktree={w}
              sessions={sessions.value.filter(s => s.worktreePath === w.path)}
              extraShells={extraShells.value}
            />
          ))}
        </div>
      )}

      {hasRepo && trees.length > 0 && (
        <button class="primary new-wt" onClick={() => void send({ type: 'createWorktree' })}>
          + New Worktree
        </button>
      )}
    </div>
  );
}
