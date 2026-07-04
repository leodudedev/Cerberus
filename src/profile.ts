// Map CLAUDE_CONFIG_DIR to a human profile label.
// Empty / ~/.claude => aziendale, .claude-leo => personale.

export type Profile = "aziendale" | "personale" | "unknown";

export function profileFromConfigDir(configDir: string | undefined | null): Profile {
  if (!configDir || configDir.trim() === "") return "aziendale";
  if (configDir.includes(".claude-leo")) return "personale";
  return "unknown";
}
