import type { Agent } from "./profile.ts";

// Central config loaded from environment (see .env.example)

// Keystrokes sent for each button action, per agent. Isolated here because the
// permission-prompt UI (numbered options) of each CLI can change between
// versions. Each entry is a sequence of tmux send-keys tokens (literal digits
// or key names).
export const actionKeys: Record<Agent, Record<string, string[]>> = {
  claude: {
    approve: ["1", "Enter"], // first option = yes
    // deny defaults to Escape (safe cancel). The "No" option number varies by
    // Claude version and picking the wrong digit could hit "yes, don't ask again".
    // Set to e.g. ["3", "Enter"] once verified on the live prompt.
    deny: ["Escape"],
    esc: ["Escape"],
  },
  copilot: {
    // Copilot CLI permission dialog: verify on a live prompt before trusting
    // approve — same caveat as Claude, the option order can change per version.
    approve: ["1", "Enter"],
    deny: ["Escape"],
    esc: ["Escape"],
  },
};

export function actionKeysFor(agent: Agent | undefined): Record<string, string[]> {
  return actionKeys[agent ?? "claude"] ?? actionKeys.claude;
}

// Default port 9666 — away from common dev ranges and from headroom (8787/8788).
export const config = {
  port: Number(process.env.PORT ?? 9666),
} as const;
