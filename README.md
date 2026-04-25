# vsWT — Worktree Orchestrator

Run parallel Claude Code sessions in VS Code, each in its own git worktree.

> **Status:** Pre-alpha (M0 — scaffold). Not yet usable.

## Roadmap

- [x] **M0** — scaffold, Activity Bar, empty webview
- [ ] **M1** — git worktree management, settings
- [ ] **M2** — `AgentProvider` interface, Shell sessions
- [ ] **M3** — Claude Code provider, ANSI state detection
- [ ] **M4** — sidebar UI (Preact), session tree, new-session form
- [ ] **M5** — terminal panel integration
- [ ] **M6** — notifications, badge, status bar, persistence
- [ ] **M7** — marketplace publish (per-platform VSIX)

## Development

```bash
npm install
npm run compile
# Then F5 in VS Code → "Run Extension"
```

## License

MIT
