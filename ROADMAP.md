# mycli — Remote control per Claude Code (multi-account)

Scope MVP: **solo Claude Code**, sessioni su account diversi, controllo da cellulare.
Multi-agent (aider, ecc.) rimandato.

Le sessioni si lanciano con gli **alias shrc esistenti** (uno per account, già
funzionanti). mycli non gestisce il lancio. Unico vincolo: lanciare l'alias **dentro
un pane tmux** — serve per `send-keys`.

## Obiettivo

Una sessione Claude Code chiede attenzione (permesso tool, input, idle) →
notifica push sul cellulare → rispondo dal telefono (approva/nega/prompt libero) →
l'input arriva alla sessione tmux giusta.

## Insight architetturale

Gli hook di Claude Code girano **dentro** il pane tmux, quindi ereditano l'ambiente
della shell: `$TMUX_PANE` è disponibile nel processo hook. Il Notification hook conosce
già `session_id` + `cwd`, e aggiungendo `$TMUX_PANE` ha tutto per identificare
il pane a cui rispondere. Nessun registry manuale pane↔sessione.

Account = `CLAUDE_CONFIG_DIR` diverso:
- aziendale → `~/.claude` (default, `CLAUDE_CONFIG_DIR` vuoto)
- personale → `~/Documents/leo/.claude-leo`

Alias shrc: `claude`/`claude-hr` = aziendale, `claude-leo`/`claude-leo-hr` = personale
(le varianti `-hr` sono wrappate in headroom).

Ogni config dir ha il suo `settings.json` → gli hook vanno installati in entrambi.

## Componenti

```
┌─ tmux ─────────────┐     ┌─ daemon (node) ─┐     ┌─ Telegram bot ─┐
│ pane %3  claude    │     │ HTTP :PORT      │     │                │
│  └ Notification ───┼────▶│ registry        ├────▶│  push + button │
│    hook (curl)     │     │ pane↔session    │     │                │
│                    │◀────┤ tmux send-keys  │◀────┤  reply / tap   │
└────────────────────┘     └─────────────────┘     └────────────────┘
```

- **Lancio sessioni**: alias shrc esistenti, dentro un pane tmux. Fuori scope mycli.
- **Hooks** (in entrambi i settings.json): Notification + Stop → POST al daemon
  con `session_id`, `cwd`, `$TMUX_PANE`, `message`, `profile`.
- **Daemon** node: riceve eventi, mantiene mappa pane↔session, dedup, push Telegram.
- **Bot Telegram**: inline keyboard (approva/nega/esc) + reply libera → `tmux send-keys`.

## Perché Telegram

Bidirezionale gratis, no APNs/cert, inline button per Yes/No, reply libera per prompt
arbitrario. Mapping `chat/message → pane`. Alternativa ntfy.sh scartata: reply-back debole.

---

## Fasi

### Fase 0 — Scaffold (mezza giornata)
- [ ] `pnpm init`, TypeScript, struttura `src/` (`daemon/`, `bot/`, `bin/`)
- [ ] `.env` per token bot + chat id + PORT
- [ ] Verifica: lanciare gli alias esistenti in due pane tmux, controllare
      `CLAUDE_CONFIG_DIR` corretto per profilo (`echo $CLAUDE_CONFIG_DIR` nel pane)

### Fase 1 — Detection (il grosso del lavoro)
- [ ] Hook script `notify.sh`: legge JSON stdin, aggiunge `$TMUX_PANE`, curl POST al daemon
- [ ] Registrarlo come `Notification` hook in entrambi i settings.json
- [ ] Daemon: endpoint `POST /event`, logga payload, ricava profilo da `CLAUDE_CONFIG_DIR`/cwd
- [ ] Verifica: trigger permesso reale → payload con pane corretto arriva al daemon

### Fase 2 — Push mobile
- [ ] Bot Telegram (grammY o node-telegram-bot-api), token in `.env`
- [ ] Daemon → messaggio: profilo + cwd + testo + inline keyboard [Approva][Nega][Esc]
- [ ] Dedup: stessa sessione non spamma (debounce su session_id)
- [ ] Verifica: permesso su Mac → notifica su cell in <3s

### Fase 3 — Risposta remota
- [ ] Callback button → daemon → `tmux send-keys -t <pane> <tasto>`
      (Approva=`1`+Enter / Nega=`2`+Enter / Esc=`Escape`)
- [ ] Reply testuale al messaggio → `send-keys` del prompt libero + Enter
- [ ] Guard: valida pane ancora vivo (`tmux list-panes`) prima di inviare
- [ ] Verifica: approvo dal telefono → tool procede sul Mac

### Fase 4 — Usabilità
- [ ] `mycli ls`: lista sessioni attive (da registry) con stato
- [ ] Prompt push arbitrario verso una sessione scelta (non solo risposta a notifica)
- [ ] Stop hook → notifica "sessione finita / attende"
- [ ] Gestione pane morto / sessione riavviata (cleanup registry)

## Rischi

- **Fragilità mapping azione→tasto**: la UI dei prompt Claude Code può cambiare tra
  versioni (numeri opzioni). Isolare i tasti in config, non hardcodare.
- **Sicurezza**: daemon apre porta locale + bot esegue `send-keys`. Bind solo su
  `127.0.0.1`, whitelist `chat_id`, nessuna esposizione pubblica. Se serve accesso
  fuori LAN → tunnel (tailscale/cloudflared), mai porta aperta su internet.
- **Race**: se rispondo tardi e la sessione è già cambiata, `send-keys` va nel posto
  sbagliato. Mitigare con TTL sull'azione + verifica stato pane.

## Stack

Node + TypeScript, pnpm. tmux control mode via `child_process`. Telegram (grammY).
Nessun DB: registry in memoria + snapshot su file JSON.
