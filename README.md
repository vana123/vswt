# vsWT — Worktrees & Claude Sessions

**One sidebar tree for your git worktrees and the Claude Code sessions in each.**
For every worktree of your repo — or every repo in a folder of projects — vsWT
lists the Claude Code sessions that ran there, flags which are **still running
right now**, and resumes any past one in a single click. The same tree drives the
whole worktree lifecycle: create, inline diff, pull / push / fetch, open a PR, and
finish (merge → remove worktree → delete branch).

If you juggle several Claude Code sessions across branches, this is the one place
to see what's running where and pick any of it back up — without `git stash` or
losing track of which terminal was which.

Cross-platform (Windows / macOS / Linux). Inspired by
[Scape](https://news.ycombinator.com/item?id=47257712), reimagined as a native
VS Code extension that lives where you already work.

> **Status:** Pre-alpha. Daily-driver-ready for the Claude Code workflow, but
> rough edges remain. Bug reports and feature requests are very welcome at
> [github.com/vana123/vswt/issues](https://github.com/vana123/vswt/issues).

## Why vsWT

- **Real parallelism, not tab-switching.** A git worktree is a separate
  checkout of the same repo on a different branch — Claude in worktree A
  cannot break the build in worktree B, and you never have to `git stash`
  to context-switch.
- **One pane of glass.** Status, dirty count, ahead/behind, changed files,
  existing Claude sessions, push, PR, and merge-and-cleanup all hang off one
  worktree row in a single tree.
- **No new tool to learn.** It's a tree in the sidebar. The Claude CLI runs
  in a normal VS Code terminal you can detach, reattach, or kill.

## What it looks like

A single tree: repository → worktrees → the Claude sessions that ran in them.
Worktree actions live in the right-click menu; sessions resume on click.

```
vsWT — Worktrees
└─ my-project
   ├─ ⎇ main          ~/dev/my-project                ●3 ↑1
   │   ├─ ⊟ Changes (3)
   │   │   └─ src/auth.ts
   │   ├─ 💬 Refactor auth                  2h ago
   │   └─ 💬 Fix payments allocation        yesterday
   ├─ ⎇ feature-ksef   ~/dev/my-project-worktrees/feature-ksef
   │   └─ 💬 Plan KSeF integration          3d ago
   └─ ⎇ hotfix-csv     ~/dev/…                          —
```

The worktree matching the open folder is highlighted; pinned worktrees sort to
the top; a worktree with no sessions shows `—`. Worktrees created by
`claude --worktree` (those under `<repo>/.claude/worktrees/`) get a ✦ sparkle
icon to set them apart from regular ones.

**Open a folder of projects.** If the folder you open isn't itself a git repo,
vsWT scans its subfolders for repositories and lists each as its own top-level
node — so a `~/dev` containing many projects shows them all, each expandable into
its worktrees and sessions. Scan depth is configurable (`vswt.repoScanDepth`,
default 1); linked worktree folders fold into their main repo, not duplicated.

## Features

### Worktree lifecycle
- **Create** — pick branch name, base ref (any local/remote), opt-in copy of
  `.env*` and `.claude/**`. Sibling layout `../{repo}-worktrees/{branch}`.
- **Rename** — right-click → *Rename…*. Handles submodules (falls back to
  `fs.rename` + `git worktree repair`).
- **Remove** — confirms with file count if dirty; auto-retries with `--force`
  on submodule errors; cleans orphan dirs via `fs.rm` when git refuses.
- **Pin** — right-click → *Pin to Top* / *Unpin*.

### Claude sessions
- Lists the **existing** Claude sessions found in `~/.claude/projects`, grouped
  under the worktree they ran in — matched by the working directory recorded in
  each transcript, so sessions started *outside* vsWT (a plain terminal, another
  tool) show up too.
- **Click to resume** — opens a terminal in the worktree and runs
  `claude --resume <id>`.
- **Rename** a session to a custom label — stored as an overlay in the
  extension (Claude's transcript is never modified); empty input resets it to
  Claude's title.
- **Reveal transcript** opens the raw `.jsonl`; **Copy session id** copies it.
- **Start in a fresh worktree** — right-click a repository → *New Claude Session
  (new worktree)* runs `claude --worktree`, which creates an isolated git
  worktree for the session; it then shows up in the tree like any other.
- Clicking a session reuses its terminal if one is still open, instead of
  spawning a duplicate.
- Sessions outside the current repo can be shown under an optional *Other* node
  (`vswt.sessions.showUnmatched`).
- **Running vs historical** — a session whose process is actually alive gets a
  green ● and sorts to the top; this reads Claude's live-session registry
  (`~/.claude/sessions/<pid>.json`, created on start and removed on exit), so it
  reflects real running sessions — even ones started outside vsWT — and clears
  the moment you exit, regardless of how long it's been idle. Everything else is
  historical, filtered to the last `vswt.sessions.maxAgeDays` days and capped at
  `vswt.sessions.maxPerWorktree` per worktree, with the rest under a
  *Show N older…* node.
- **Live refresh** — a file watcher on the projects directory updates the tree
  within ~1s as sessions are created or change.

### Per-worktree actions (right-click)
- **New Claude / New Shell / Term here** — open a terminal in the worktree.
  The shell picker offers Git Bash / CMD / PowerShell on Windows, or
  Zsh / Fish on Linux/macOS, detected at activation time.
- On Windows, `Ctrl+V` in a vsWT-opened terminal pastes a clipboard image as a
  PNG `@<path>` reference for Claude.

### Git workflow
- **Status badges** on each worktree row: `●N` dirty count, `↑N` ahead, `↓N`
  behind; full path, HEAD, flags and fork-point in the tooltip.
- **Changes** — expand a worktree's *Changes* node and click a file to open
  VS Code's diff editor against HEAD.
- **Pull / Push / Fetch**. Pull recovers automatically by setting upstream when
  `origin/<branch>` exists; push auto-sets upstream on first push.
- **Create PR** via `gh pr create --web` — auto-pushes the branch first if
  needed.
- **Finish** — full lifecycle close-out: push feature → checkout target → pull
  → merge (`--no-ff` or `--squash`) → push → remove worktree → delete branch.
  Pre-flight check refuses to run if main repo has uncommitted changes.
- **Base branch** tracking — vsWT remembers what you forked from and pre-selects
  it in the Finish merge picker.

## Requirements

- **VS Code** 1.95 or newer.
- **git** on `PATH`.
- **claude** CLI on `PATH` for Claude sessions
  ([install instructions](https://code.claude.com/docs/en/install)).
- **gh** CLI on `PATH` for the *Create PR* button (optional).

## Configuration

| Setting | Default | Description |
|---|---|---|
| `vswt.repoScanDepth` | `1` | Levels below each workspace folder to scan for repos. `0` = the folder itself; `1` = direct subfolders. |
| `vswt.worktree.parentDir` | `""` | Parent dir for worktrees. Empty = sibling `../{repo}-worktrees`. Supports `~`. |
| `vswt.worktree.copyFiles` | `[".env", ".env.*", ".claude/**"]` | Glob patterns copied into a new worktree (opt-in per session). |
| `vswt.worktree.postCreateCommand` | `""` | Shell command run inside a fresh worktree (e.g. `pnpm i`). |
| `vswt.worktree.runPrismaGenerate` | `true` | Run `npx prisma generate` if `prisma/schema.prisma` exists. |
| `vswt.shell.windows` | `""` | Windows shell override for Shell sessions. Empty = auto. |
| `vswt.claude.path` | `"claude"` | Path to the Claude Code CLI. |
| `vswt.extraShells` | `null` | Extra shell options. `null` = platform defaults; `[]` = none. |
| `vswt.sessions.showUnmatched` | `false` | Show sessions outside the current repo under an *Other* node. |
| `vswt.sessions.maxAgeDays` | `30` | Hide historical sessions with no activity in this many days. `0` = no limit. |
| `vswt.sessions.maxPerWorktree` | `15` | Max historical sessions per worktree before a *Show N older…* node. `0` = unlimited. |
| `vswt.sessions.projectsDir` | `""` | Claude transcripts dir. Empty = `~/.claude/projects`. Supports `~`. |
| `vswt.sessions.resumeCommand` | `""` | Resume command; session id is appended. Empty = `<claude.path> --resume`. |
| `vswt.sessions.label` | `"name"` | Session label source: `name` (AI title) or `firstMessage`. |

## License

MIT — see [LICENSE](LICENSE).

Claude logo (CC0) from [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Claude_AI_symbol.svg).
