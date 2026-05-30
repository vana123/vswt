# Changelog

All notable changes to Worktree Sessions for Claude Code will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

### Changed
- **Rebranded.** Descriptive Marketplace title — **Worktree Sessions for Claude
  Code** — plus rewritten description/README, and an original logo (a branching
  worktree with a green "running" node) replacing the Anthropic Claude symbol.
  It is an independent tool, not an official Anthropic extension. The extension
  id (`vana123.vswt`) is unchanged.

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
