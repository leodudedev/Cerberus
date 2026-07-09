#!/usr/bin/env bash
# cerberus notification hook.
# Claude Code runs this for the `Notification` event, from inside the tmux pane,
# so it inherits $TMUX_PANE and $CLAUDE_CONFIG_DIR. Forwards the raw hook payload
# plus that context to the local daemon.
# Best-effort and non-blocking: it must never fail or stall the Claude session.

# Outside tmux there is no pane to drive remotely (approve/deny/prompt would
# all fail), so skip the notification entirely.
[ -z "${TMUX_PANE:-}" ] && exit 0

payload=$(cat)

# JSON-escape backslashes and quotes in the interpolated env values.
json_escape() {
  local s=${1//\\/\\\\}
  printf '%s' "${s//\"/\\\"}"
}
pane=$(json_escape "${TMUX_PANE:-}")
cfg=$(json_escape "${CLAUDE_CONFIG_DIR:-}")

body=$(cat <<EOF
{"tmux_pane":"${pane}","config_dir":"${cfg}","hook":${payload:-null}}
EOF
)

# Fire-and-forget: background the request, cap it at 3s, swallow all errors.
curl -s -m 3 -X POST "http://127.0.0.1:${CERBERUS_PORT:-8899}/event" \
  -H 'content-type: application/json' \
  -d "$body" >/dev/null 2>&1 &

exit 0
