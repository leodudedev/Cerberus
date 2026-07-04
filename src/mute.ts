// Runtime mute-set, keyed by project cwd. Complements the static .mycli.json
// mute: this one is toggled live (e.g. from Telegram) and supports a TTL.
// In-memory only — cleared on daemon restart.

const muted = new Map<string, number>(); // cwd -> expiry epoch ms (Infinity = forever)

export function mute(cwd: string, ttlMs?: number): void {
  muted.set(cwd, ttlMs && ttlMs > 0 ? Date.now() + ttlMs : Infinity);
}

export function unmute(cwd: string): boolean {
  return muted.delete(cwd);
}

// A cwd is muted if it matches a muted entry or sits under one.
export function isMuted(cwd: string): boolean {
  const now = Date.now();
  for (const [dir, until] of muted) {
    if (until <= now) {
      muted.delete(dir);
      continue;
    }
    if (cwd === dir || cwd.startsWith(dir + "/")) return true;
  }
  return false;
}

export function listMuted(): { cwd: string; until: number }[] {
  const now = Date.now();
  const out: { cwd: string; until: number }[] = [];
  for (const [cwd, until] of muted) {
    if (until <= now) muted.delete(cwd);
    else out.push({ cwd, until });
  }
  return out;
}

// Parse a duration like "90s", "30m", "2h", "1d". Returns ms, or null if invalid.
export function parseDuration(s: string): number | null {
  const m = /^(\d+)\s*([smhd])$/.exec(s.trim().toLowerCase());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as "s" | "m" | "h" | "d"];
  return n * unit;
}
