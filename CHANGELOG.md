# Changelog

All notable changes to vsWT will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
