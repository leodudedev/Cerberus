#!/usr/bin/env bash
# cerberus notification hook.
# Claude Code runs this for the `Notification` event, from inside the tmux pane,
# so it inherits $TMUX_PANE and $CLAUDE_CONFIG_DIR. Forwards the raw hook payload
# plus that context to the local daemon.
# Best-effort and non-blocking: it must never fail or stall the Claude session.

payload=$(cat)

body=$(cat <<EOF
{"tmux_pane":"${TMUX_PANE:-}","config_dir":"${CLAUDE_CONFIG_DIR:-}","hook":${payload:-null}}
EOF
)

# Fire-and-forget: background the request, cap it at 3s, swallow all errors.
curl -s -m 3 -X POST "http://127.0.0.1:${CERBERUS_PORT:-8787}/event" \
  -H 'content-type: application/json' \
  -d "$body" >/dev/null 2>&1 &

exit 0
