# vsWT — Worktree Orchestrator

Run parallel **Claude Code** sessions in VS Code, each in its own git worktree.
Inspired by [Scape](https://news.ycombinator.com/item?id=47257712), built as an
inline VS Code extension. Cross-platform (Windows / macOS / Linux).

> **Status:** Pre-alpha. Daily-driver-ready for Claude Code workflow but
> rough edges remain. Feedback welcome at
> [github.com/vana123/vswt/issues](https://github.com/vana123/vswt/issues).

## What it does

vsWT turns the VS Code sidebar into a control panel for parallel Claude Code
sessions. Each branch you're working on lives in its own git worktree, with
its own Claude (or Shell) session, so you can switch context with one click
without disturbing your other in-flight work.

```
📁 my-project                        change
🌿 feat/auth ← main         ●3 ↑1   ↓ ↑ ⟳   ✎ ×
   ✦ Claude       3m ago    ×
   > Shell        1m ago    ×
   [✦ Claude ▾] [> Shell ▾] [Term]
   [Open ↗] [PR] [Finish ✓]
🌿 fix/login ← main          ·       ↓ ↑ ⟳   ✎ ×
   [✦ Claude ▾] [> Shell ▾] [Term]
[ + New Worktree ]
```

## Features

### Worktree lifecycle
- **Create** — pick branch name, base ref (any local/remote), opt-in copy of
  `.env*` and `.claude/**`. Sibling layout `../{repo}-worktrees/{branch}`.
- **Rename** — double-click the branch label or use ✎. Handles submodules
  (falls back to `fs.rename` + `git worktree repair`).
- **Remove** — confirms with file count if dirty; auto-retries with `--force`
  on submodule errors; cleans orphan dirs via `fs.rm` when git refuses.
- **Pin** — favourites pin to top.
- **Filter** — search input appears once you have 3+ worktrees.

### Sessions per worktree
- **Claude** sessions launch the Claude Code CLI inside a tracked terminal.
- **Shell** sessions open your default shell. A dropdown lets you pick
  Git Bash / CMD / PowerShell on Windows, or Zsh / Fish on Linux/macOS,
  detected at activation time.
- **Term** opens a one-off plain terminal in the worktree without tracking.
- Sessions persist across window reload as `▶ stopped` for one-click resume.
- Closing a session via the sidebar `×` also closes the terminal; closing the
  terminal tab keeps the session as resumable.

### Git workflow
- **Status badges** on each card: `●N` dirty count, `↑N` ahead, `↓N` behind.
- **Inline diff** — click the badge to expand the changed-files list, click a
  file to open VS Code's diff editor against HEAD.
- **Pull / Push / Fetch** buttons in the header. Pull recovers automatically
  by setting upstream when `origin/<branch>` exists; push auto-sets upstream
  on first push.
- **Create PR** via `gh pr create --web` — auto-pushes the branch first if
  needed.
- **Finish** — full lifecycle close-out: push feature → checkout target → pull
  → merge (`--no-ff` or `--squash`) → push → remove worktree → delete branch.
  Pre-flight check refuses to run if main repo has uncommitted changes.

### UX
- **Activity Bar badge** + **status bar item** show active session count.
- **Base branch** tracking — vsWT remembers what you forked from and shows
  it as `← main`; pre-selects it in the Finish merge picker.
- **Pixel-art aesthetic** — Pixelify Sans font, hard borders, drop shadows.
- **Real branding** — official Anthropic Claude symbol (CC0 — Wikimedia
  Commons), [Lucide](https://lucide.dev) icons (ISC) for actions.

## Requirements

- **VS Code** 1.95 or newer.
- **git** on `PATH`.
- **claude** CLI on `PATH` for Claude sessions
  ([install instructions](https://code.claude.com/docs/en/install)).
- **gh** CLI on `PATH` for the *Create PR* button (optional).

## Configuration

| Setting | Default | Description |
|---|---|---|
| `vswt.worktree.parentDir` | `""` | Parent dir for worktrees. Empty = sibling `../{repo}-worktrees`. Supports `~`. |
| `vswt.worktree.copyFiles` | `[".env", ".env.*", ".claude/**"]` | Glob patterns copied into a new worktree (opt-in per session). |
| `vswt.worktree.postCreateCommand` | `""` | Shell command run inside a fresh worktree (e.g. `pnpm i`). |
| `vswt.worktree.runPrismaGenerate` | `true` | Run `npx prisma generate` if `prisma/schema.prisma` exists. |
| `vswt.shell.windows` | `""` | Windows shell override for Shell sessions. Empty = auto. |
| `vswt.notifications.sound` | `true` | Reserved for future state-detection. |
| `vswt.claude.path` | `"claude"` | Path to the Claude Code CLI. |
| `vswt.extraShells` | `null` | Extra shell options. `null` = platform defaults; `[]` = none. |

## License

MIT — see [LICENSE](LICENSE).

Claude logo (CC0) from [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Claude_AI_symbol.svg).
Action icons from [Lucide](https://lucide.dev) (ISC).
