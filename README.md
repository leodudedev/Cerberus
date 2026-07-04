# 🐕‍🦺 Cerberus

**Remote control for Claude Code sessions — from your phone.**

Run several Claude Code sessions (across different accounts) inside `tmux`. When a
session needs you — a permission prompt, waiting for input — Cerberus pushes a
Telegram notification. From the phone you **approve / deny**, or **type a prompt**
that lands in the right session. Every pending command is tagged with a risk icon
🟢 🟡 🔴 so you know what you're approving.

```
┌─ tmux ─────────────┐   ┌─ cerberus daemon ─┐   ┌─ Telegram ─┐
│ pane %3  claude    │   │  127.0.0.1:9666   │   │            │
│  └ notify.sh hook ─┼──▶│  enrich + push    ├──▶│  🔔 + 🟢🟡🔴 │
│                    │   │                   │   │  buttons    │
│                    │◀──┤  tmux send-keys   │◀──┤  tap/reply  │
└────────────────────┘   └───────────────────┘   └────────────┘
```

---

## Why

If you juggle multiple Claude Code sessions in a terminal multiplexer, you can't
watch them all. Cerberus lets you step away: it tells you *which* session needs
attention, *what* it's asking, *how risky* it is — and lets you answer remotely.

---

## How it works

1. A Claude Code **`Notification` hook** (`notify.sh`) fires when a session needs
   attention. It runs **inside the tmux pane**, so it inherits `$TMUX_PANE` and
   `$CLAUDE_CONFIG_DIR`.
2. It POSTs the event to the local **daemon** (`127.0.0.1:9666`), which reads the
   session transcript to extract the pending tool + the last thing Claude said.
3. The daemon pushes a **Telegram** message with the project, the command (risk
   tagged), and inline buttons.
4. Your tap / reply comes back through the daemon, which drives the pane with
   **`tmux send-keys`**.

Accounts are distinguished by `CLAUDE_CONFIG_DIR` (each maps to a profile label).

---

## Requirements

- **Node.js ≥ 22.18** (runs `.ts` files natively — no build step; 23.6+ recommended)
- **pnpm**
- **tmux**
- A **Telegram bot** token ([@BotFather](https://t.me/BotFather)) and your chat id

---

## Install

```bash
git clone <repo> cerberus
cd cerberus
pnpm install
cp .env.example .env      # then fill it in (see below)
```

### Environment (`.env`)

```ini
TELEGRAM_BOT_TOKEN=123456:ABC...     # from @BotFather
TELEGRAM_CHAT_ID=123456789           # your chat id (from @userinfobot)
TELEGRAM_ALLOWED_CHATS=              # optional extra chats/groups (csv), for routing
PORT=9666                            # daemon port (loopback only)
```

Get your chat id: DM your bot `/start`, then call
`https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id`.

---

## Configure the hook (once per account)

Cerberus needs its `Notification` hook registered in **each** Claude Code config
directory you use (one per account). Add this to the `settings.json` of every
`CLAUDE_CONFIG_DIR`:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/cerberus/hooks/notify.sh"
          }
        ]
      }
    ]
  }
}
```

> If the file already has a `hooks` object, add only the `"Notification"` key
> inside it — don't overwrite existing hooks.

The hook is best-effort and non-blocking: if the daemon is down it silently
no-ops, it never stalls your session.

---

## Run

Start the daemon and leave it running (it must stay up to receive button/reply
callbacks):

```bash
pnpm start          # or: pnpm dev  (watch mode)
```

Then launch your sessions **inside tmux panes** with your usual aliases:

```bash
tmux
# Ctrl-b %   split
# left pane:  claude
# Ctrl-b →   right pane:  claude-work   (a different CLAUDE_CONFIG_DIR)
```

That's the only constraint: sessions must run inside tmux, because remote replies
are delivered with `tmux send-keys`.

---

## Daily usage — Telegram controls

When a session needs attention you get a message like:

> 🔔 **Personal** · `my-project`
> Claude needs your permission to use Bash
>
> 🔴 **Bash**: `rm -rf ./dist && pnpm build`
>
> 💬 Cleaning the build folder before recompiling.

| Action | How |
|--------|-----|
| **Approve** | tap ✅ Approva (sends `1`+Enter) |
| **Deny** | tap ❌ Nega (sends Escape — safe cancel) |
| **Escape** | tap ⎋ Esc |
| **Send a prompt to that session** | **reply** to the notification with text |
| **Send a prompt to the last session** | send a plain (non-reply) message |
| **Mute a project** | reply `/mute` (or `/mute 2h`) |
| **Unmute** | reply `/unmute` |
| **List muted** | `/muted` |

`/mute` durations: `90s`, `30m`, `2h`, `1d`. No argument = indefinite. Mute is
per-project (matched by working directory, subfolders included).

> The Approve keystroke assumes option `1` = "Yes" in the permission prompt. If
> your Claude version differs, tune `actionKeys` in `src/config.ts`.

---

## Per-project config — `.cerberus.json`

Drop a `.cerberus.json` in a project (or any parent folder up to `$HOME`) to set
per-project rules. The daemon reads the nearest one before pushing.

```json
{
  "mute": true,
  "chatId": "-1001234567890",
  "minRisk": "caution"
}
```

| Key | Effect |
|-----|--------|
| `mute` | suppress all notifications for this project |
| `chatId` | route this project's notifications to a specific chat/group |
| `minRisk` | only notify at/above this risk (`safe` < `caution` < `danger`) |

`chatId` is honored only if it's in `TELEGRAM_ALLOWED_CHATS` (safety: a cloned
repo can't silently redirect your notifications). A malformed file is ignored.

Commit it for a team-wide rule, or gitignore it for a personal one.

---

## Risk classifier

Every pending command gets an icon, scanned across the whole pipe/`&&` chain
(priority: danger > caution > safe). Rules live in `src/classify.ts`.

| Icon | Level | Examples |
|------|-------|----------|
| 🟢 | safe | `cat`, `ls`, `grep`, `git status/log/diff`, `node -v` |
| 🟡 | caution | `mv`, `cp`, `chmod`, `git commit/push`, `pnpm install`, `curl`, edits |
| 🔴 | danger | `rm`, `sudo`, `dd`, `chmod 777`, `git reset --hard`, `--force`, `curl \| sh`, redirects into system paths |

Non-Bash tools are classified by name (`Read`/`Glob` → safe, `Write`/`Edit` →
caution).

---

## Security

- Daemon binds `127.0.0.1` only — never reachable off-host.
- Telegram commands accepted only from whitelisted chats
  (`TELEGRAM_CHAT_ID` + `TELEGRAM_ALLOWED_CHATS`).
- Never expose the daemon port publicly. For remote access use a private tunnel
  (Tailscale, Cloudflare Tunnel) — not an open port.

---

## Project layout

```
hooks/notify.sh        Notification hook (curls the daemon)
src/daemon/index.ts    HTTP intake + push orchestration
src/bot/index.ts       Telegram push, buttons, replies, /mute
src/registry.ts        session ↔ pane ↔ message maps
src/tmux.ts            send-keys / pane-alive helpers
src/transcript.ts      pull tool_use + last assistant text from JSONL
src/classify.ts        risk classifier
src/profile.ts         CLAUDE_CONFIG_DIR → profile label
src/project-config.ts  .cerberus.json reader
src/mute.ts            runtime mute-set with TTL
src/config.ts          env + action keymap
```

---

## Development

```bash
pnpm dev         # daemon in watch mode
pnpm typecheck   # tsc, no emit
```

No build step — Node runs the TypeScript sources directly.

> Testing tip: don't kill port 9666 if a daemon is already there, and don't run a
> second bot with the same token (Telegram 409). Use a different `PORT` and/or run
> with the token unset when smoke-testing.

---

## Status

MVP: Claude Code only, multi-account, push + remote approve/deny/prompt, risk
classifier, per-project config, runtime mute. Runtime mute is in-memory (cleared
on restart). See `ROADMAP.md`.
