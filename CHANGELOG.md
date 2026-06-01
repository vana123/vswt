# Changelog

All notable changes to Worktree Sessions for Claude Code will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.0] — 2026-06-02

### Added
- **Open PRs section per repo.** A new collapsible `Open PRs · N` node
  appears under each repo, listing GitHub pull requests that don't yet
  have a local worktree (PRs whose branch *is* checked out keep their
  badge on the worktree row — no duplicates). Powered by `gh pr list`
  with a 120s cache and background refresh.
- **Checkout PR into Worktree.** Right-click an open PR →
  *Checkout into Worktree* creates `<repo>/.claude/worktrees/pr-<n>`
  tracking `origin/<branch>`, with a `gh pr checkout` fallback for
  fork PRs. After checkout the PR moves out of the list and into the
  normal worktree tree (and a toast offers *Open in New Window*).
  Companion actions: *Open in Browser*, *Copy URL*.
- **Sync with Base Branch.** New worktree action (icon `$(git-merge)`)
  next to Pull/Push/Fetch. Picks the base from the saved value, then
  `origin/HEAD`, then a branch QuickPick; fetches; runs
  `git merge --no-ff origin/<base>`. On conflict, a warning toast
  offers *Abort Merge*. The standard *Pull* still does `--ff-only` on
  the current branch — *Sync with Base* is the "merge main into my
  feature" path that used to live in the terminal.
- **Merge-conflict indication in Changes.** Conflicting files
  (`UU/AA/DD/AU/UA/DU/UD`) now render with a warning icon
  (`gitDecoration.conflictingResourceForeground`) and a `conflict`
  description, distinct from regular modified/added/deleted files. The
  worktree badge prefixes `⚠N` before the dirty/ahead/behind counters
  and the tooltip lists the unresolved count, so a conflicted state is
  visible at a glance without expanding the tree.

### Fixed
- **Claude shell terminal no longer doubles up with its session row.**
  Opening *New Claude Session Here* used to show `claude:<branch> · terminal`
  immediately, and then a second row when the session's transcript file
  appeared — two nodes for one running Claude. The shell is now
  auto-attached to the next running session in that worktree: the
  terminal row hides, the session row stands in for it, and *Resume*
  reuses the same terminal.

## [0.3.0] — 2026-05-31

### Added
- **Claude Code usage indicator.** A status-bar item shows the share of your
  5-hour block and weekly token budget consumed (`Claude  47% · wk 31%`), turns
  yellow at the alert threshold (`vswt.usage.alertThreshold`, default 80%) and
  red past 100%. Hovering reveals a per-model breakdown and the time the 5-hour
  block resets. When usage crosses the threshold the sidebar's activity-bar
  icon also gets a numeric badge.
- Usage is computed entirely locally from `~/.claude/projects/**/*.jsonl`
  transcripts (input + output + cache-creation tokens; cache reads excluded as
  they don't count against the limit pool). Block boundaries follow Anthropic's
  "5 hours since first message in window" mechanic; the weekly figure is a
  rolling 7-day total.
- Settings: `vswt.usage.enabled`, `vswt.usage.plan` (`pro` / `max5` / `max20` /
  `custom`), `vswt.usage.alertThreshold`, `vswt.usage.customBlockTokens`,
  `vswt.usage.customWeekTokens`. Tier defaults are best-guess token budgets;
  switch to `custom` to dial them in.
- **Bookmark sessions** (star icon on the row, right-click → *Bookmark
  Session*). Bookmarked sessions float to the top of their worktree and are
  exempt from the age/cap filters, so a sessions you care about stays visible
  no matter how old it gets.
- **Expand ↑/↓ into commit lists.** The ahead/behind counts in a worktree
  badge are now their own collapsible nodes; opening one reveals the actual
  commits (subject · short SHA · relative time). Click copies the full SHA.
- **PR status badge per worktree.** A `PR #123 ✓ / ✗ / ⏳ / draft / merged`
  pill next to each worktree, fetched via `gh pr view` with a 120s cache and
  background refresh. Hover for state + checks summary + link.
- **Finish notification** (opt-in `vswt.sessions.notifyOnFinish`, default
  off). When a running session writes an assistant message with
  `stop_reason=end_turn`, the OS shows a desktop notification — handy for
  long turns where you've tabbed away.
- **Full-text search across transcripts.** A search button in the view title
  (and `vswt.sessions.search` command) opens a QuickPick that searches every
  `.jsonl` transcript for a substring, with contextual snippets. Selecting a
  result resumes that session in a terminal. The index is in-memory, keyed
  by mtime, and only reparses files that actually changed.
- **Worktree terminals appear in the tree.** When you open a terminal via
  *New Claude / Shell / Term here*, it shows up as a leaf under that
  worktree. Clicking it reveals the existing terminal (no duplicates).

### Changed
- **Worktree row description is tighter.** The full path is no longer shown
  inline (it's still in the tooltip) — only `●N ↑N ↓N` and any PR badge.
- **Past sessions collapse.** Older sessions are folded under a single
  *Past sessions (N)* node so the running and bookmarked ones aren't lost
  in a long list. Open the group to see them with the existing cap and
  *Show N older…* overflow.

### Fixed
- **Resume into a stale shell.** If a session's terminal is still open but
  Claude itself exited (Ctrl+C), clicking the session now re-runs
  `claude --resume <id>` in that same shell instead of leaving you at a
  bare prompt.

## [0.2.2] — 2026-05-31

### Changed
- **Session row icons.** Each Claude session in the tree now shows the Claude
  Code mark instead of a generic chat bubble — a static PNG when idle, and an
  animated pulse GIF when the session is running (replacing the green dot).
  Bookmarked sessions still show the star.

## [0.2.1] — 2026-05-31

### Changed
- **Rebranded.** Descriptive Marketplace title — **Worktree Sessions for Claude
  Code** — an original logo (a branching worktree with a green "running" node)
  replacing the Anthropic Claude symbol, and the old "vsWT" name removed from the
  UI (panel and settings titles, command palette) and docs. An independent tool,
  not an official Anthropic extension; the extension id (`vana123.vswt`) is
  unchanged.

## [0.2.0] — 2026-05-31

### Added
- **Running vs historical sessions.** Sessions whose process is actually alive
  are marked with a green ● and sorted to the top, read from Claude's
  live-session registry (`~/.claude/sessions/<pid>.json`, created on start /
  removed on exit) — so it tracks real running sessions (including ones started
  elsewhere) and clears the moment you exit, no matter how long it sat idle.
  A watcher on the registry flips the dot promptly.
- **Trim the session pile.** Historical sessions are filtered to the last
  `vswt.sessions.maxAgeDays` days (default 30) and capped per worktree at
  `vswt.sessions.maxPerWorktree` (default 15), with the rest under a
  *Show N older…* node.

## [0.1.0] — 2026-05-30

### Changed
- **Unified into a single tree view.** The Preact webview is gone; everything
  now lives in one native VS Code tree: repository → worktrees → the Claude
  sessions that ran in them. Worktree actions (create, rename, remove, pin,
  pull/push/fetch, PR, finish, open-in-window, new Claude/Shell/terminal) moved
  to the view title and right-click menus; changed files expand under each
  worktree and open a diff against HEAD on click.

### Added
- **Claude session explorer.** Reads existing transcripts from
  `~/.claude/projects` and groups each session under its worktree by the working
  directory recorded in the transcript — so sessions started outside vsWT are
  visible too. Click to `claude --resume`, or reveal the transcript / copy the
  id. Optional *Other* node for sessions outside the current repo
  (`vswt.sessions.showUnmatched`). A file watcher refreshes the tree live.
- **Multi-repo discovery.** Open a folder that contains several projects and
  vsWT scans its subfolders for git repositories, listing each as its own
  top-level node. Linked worktree folders fold into their main repo (resolved
  via `git rev-parse --git-common-dir`) instead of appearing twice. Scan depth
  is configurable.
- **Claude-created worktrees are marked** with a ✦ sparkle icon (those under
  `<repo>/.claude/worktrees/`, where `claude --worktree` puts them); regular
  worktrees keep the branch icon. `claude-created` also shows in the tooltip.
- **Rename a session** to a custom label (stored as an overlay in extension
  state; Claude's transcript is never touched). Empty input resets to the title.
- **Start a session in a fresh worktree** — a repository's right-click menu has
  *New Claude Session (new worktree)*, which runs `claude --worktree` so Claude
  creates an isolated git worktree for the session; it then appears in the tree.
- Settings: `vswt.sessions.showUnmatched`, `vswt.sessions.projectsDir`,
  `vswt.sessions.resumeCommand`, `vswt.sessions.label`, `vswt.repoScanDepth`.

### Fixed
- Clicking a session now reuses its open terminal instead of spawning a new one
  on every click.

### Removed
- The webview UI and its managed-session registry. "Active session" tracking and
  the activity-bar / status-bar session badge are gone — sessions are now sourced
  from on-disk transcripts (resume), not live in-window terminals. The
  `vswt.notifications.sound` setting (reserved, unused) was dropped.
- Unused `node-pty` / Preact dependencies.

## [0.0.2] — 2026-04-26

### Added
- **Image paste in Claude sessions on Windows**. `Ctrl+V` inside a vsWT
  terminal now detects images on the clipboard, saves them as PNG to the
  system temp directory, and inserts `@<path>` so Claude Code can read the
  attachment. Text paste keeps its default fast path; the image branch only
  kicks in when the clipboard has no text. Linux and macOS already handle
  image paste natively and are unchanged.

## [0.0.1] — 2026-04-26

Initial pre-alpha release.

### Added
- Activity Bar sidebar with Preact webview UI, one card per git worktree.
- Worktree lifecycle: create (with base-branch picker), rename (inline edit),
  remove (with submodule + Windows file-lock recovery), pin, filter.
- Per-worktree Claude / Shell sessions with terminal tracking, persistence,
  and `▶ Resume` after window reload.
- Shell dropdown for picking the host shell (Default / Git Bash / CMD on
  Windows; Bash / Zsh / Fish on Linux/macOS — detected at activation).
- Same shell picker available for Claude sessions.
- Git toolbar on each card: Pull (`--ff-only` with auto-set-upstream
  recovery), Push (auto `--set-upstream` on first push), Fetch (`--all`).
- File-level diff: click the dirty badge to expand changed-files, click a file
  to open VS Code's diff editor against HEAD.
- `Create PR` via `gh pr create --web` (auto-pushes branch if needed).
- `Finish` flow: push → checkout target → pull → merge (no-ff/squash) → push
  → remove worktree → delete branch.
- Activity Bar badge and status bar item with active session count.
- Pixel-art aesthetic: Pixelify Sans font, hard borders, drop shadows.
- Anthropic Claude symbol from Wikimedia Commons (CC0); Lucide icons (ISC).
- Settings schema for parent dir, copy patterns, post-create command, claude
  path, and extra shells.
