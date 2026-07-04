import { readFileSync, writeFileSync } from "node:fs";

// Tiny JSON snapshot so mute-set and session registry survive a daemon
// restart. Best-effort: a missing/corrupt file yields empty state, a failed
// write only logs. Lives at the repo root (gitignored).

const FILE = new URL("../state.json", import.meta.url);

export interface PersistedState {
  muted?: Record<string, number | null>; // cwd -> expiry epoch ms, null = forever
  sessions?: Record<string, unknown>; // sessionId -> SessionInfo
}

export function loadState(): PersistedState {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as PersistedState;
  } catch {
    return {};
  }
}

// Read-modify-write so the two writers (mute, registry) don't clobber each
// other's slice of the state.
export function saveState(patch: Partial<PersistedState>): void {
  const cur = loadState();
  Object.assign(cur, patch);
  try {
    writeFileSync(FILE, JSON.stringify(cur));
  } catch (e) {
    console.error("[persist] write failed:", (e as Error).message);
  }
}
