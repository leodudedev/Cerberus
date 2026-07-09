# Cerberus — project guide for Claude

Remote control for Claude Code (multi-account) and GitHub Copilot CLI sessions:
a session asks for attention (permission / input) → Telegram push to the phone →
approve/deny or send a prompt back → keystrokes reach the right tmux pane via
`send-keys`.

## Run / test

```bash
pnpm start          # run daemon (reads .env)
pnpm dev            # daemon in watch mode
pnpm typecheck      # tsc (no emit)
```

Node 25 runs `.ts` natively (type-stripping) — **there is no build step**. `tsc`
is typecheck-only.

## Architecture

```
notify.sh (hook, in pane) --POST /event--> daemon --> Telegram bot --> phone
                                              ^                            |
                                              +---- send-keys <-- reply/buttons
```

- `hooks/notify.sh` — Claude Code Notification hook. Runs inside the pane,
  forwards the hook payload + `$TMUX_PANE` + `$CLAUDE_CONFIG_DIR` to the daemon.
- `hooks/copilot-notify.sh` — Copilot CLI hook (`notification` + `preToolUse`),
  installed via `hooks/copilot-hooks.template.json` → `~/.copilot/hooks/`.
  Must always exit 0 (non-zero on preToolUse = Copilot denies the tool).
- `src/daemon/index.ts` — HTTP intake (`/health`, `/event`), loopback only.
  Per-agent enrichment (Claude: transcript; Copilot: preToolUse cache),
  applies mute, pushes.
- `src/pending-tools.ts` — Copilot pending-tool cache (preToolUse → notification),
  since Copilot's notification payload has no transcript/tool info.
- `src/bot/index.ts` — Telegram: push messages, buttons, reply routing, commands.
- `src/registry.ts` — session↔pane map + message↔session routing.
- `src/tmux.ts` — `send-keys` / pane-alive helpers (execFile, no shell).
- `src/transcript.ts` — last assistant text + pending `tool_use` from the JSONL.
- `src/classify.ts` — 3-level risk classifier (safe/caution/danger).
- `src/profile.ts` — `CLAUDE_CONFIG_DIR` → aziendale / personale.
- `src/project-config.ts` — reads nearest `.cerberus.json` (walk up to `$HOME`).
- `src/mute.ts` — in-memory runtime mute-set with TTL.

## Conventions

- TypeScript, functional where sensible, comments in English.
- Imports use explicit `.ts` extensions (Node native TS + `verbatimModuleSyntax`).
- Fail open: hooks and transcript/config reads must never block a notification.

## Gotchas (important)

- **Do NOT `kill` port 9666 blindly.** A dev daemon runs there; killing it via
  `lsof -ti tcp:9666 | xargs kill` terminates the user's running instance.
  For smoke tests use a different `PORT` (e.g. 8799).
- **Do NOT start a second bot with the same token** while one is running —
  Telegram returns 409 (two `getUpdates` pollers). For smoke tests run the daemon
  with the token unset so the bot stays disabled.
- **Never edit the user-level `settings.json`** (`~/.claude`, `.claude-leo`)
  without explicit permission — those affect every session on the machine.
- The repo folder path is wired into the hook `command` in the user settings.
  Renaming the folder breaks the hook.

## Security

Daemon binds `127.0.0.1` only. Telegram: chat-id whitelist (`TELEGRAM_CHAT_ID` +
`TELEGRAM_ALLOWED_CHATS`). Per-project `chatId` overrides are honored only if
allow-listed. Never expose the daemon port publicly; use a tunnel if remote.
