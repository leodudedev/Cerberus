#!/usr/bin/env bash
# cerberus hook for GitHub Copilot CLI.
# Registered for the `preToolUse` and `notification` events (see
# hooks/copilot-hooks.template.json). Runs inside the tmux pane, so it
# inherits $TMUX_PANE. Forwards the raw hook payload + event name + pane to
# the local daemon.
#
# MUST always exit 0: for preToolUse hooks Copilot treats a non-zero exit as
# "deny the tool call" (fail-closed). Best-effort and non-blocking.

event="${1:-unknown}"

# Outside tmux there is no pane to drive remotely, so skip entirely.
[ -z "${TMUX_PANE:-}" ] && exit 0

payload=$(cat)

# JSON-escape backslashes and quotes in the interpolated env values.
json_escape() {
  local s=${1//\\/\\\\}
  printf '%s' "${s//\"/\\\"}"
}
pane=$(json_escape "${TMUX_PANE:-}")
evt=$(json_escape "$event")

body=$(cat <<EOF
{"agent":"copilot","event":"${evt}","tmux_pane":"${pane}","hook":${payload:-null}}
EOF
)

# Fire-and-forget: background the request, cap it at 3s, swallow all errors.
curl -s -m 3 -X POST "http://127.0.0.1:${CERBERUS_PORT:-8899}/event" \
  -H 'content-type: application/json' \
  -d "$body" >/dev/null 2>&1 &

exit 0
