// Central config loaded from environment (see .env.example)

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Keystrokes sent for each button action. Isolated here because Claude Code's
// permission-prompt UI (numbered options) can change between versions.
// Each entry is a sequence of tmux send-keys tokens (literal digits or key names).
export const actionKeys: Record<string, string[]> = {
  approve: ["1", "Enter"], // first option = yes
  // deny defaults to Escape (safe cancel). The "No" option number varies by
  // Claude version and picking the wrong digit could hit "yes, don't ask again".
  // Set to e.g. ["3", "Enter"] once verified on the live prompt.
  deny: ["Escape"],
  esc: ["Escape"],
};

export const config = {
  port: Number(process.env.PORT ?? 8787),
  telegram: {
    // Read lazily in the bot layer so the daemon can boot without a token during scaffolding
    token: () => required("TELEGRAM_BOT_TOKEN"),
    chatId: () => required("TELEGRAM_CHAT_ID"),
  },
} as const;
