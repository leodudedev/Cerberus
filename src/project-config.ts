import { readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { Risk } from "./classify.ts";

// Per-project overrides read by the daemon before pushing a notification.
// Lives in `.mycli.json` at (or above) the session cwd. Best-effort: any
// problem yields empty overrides and never blocks a notification.

export interface ProjectConfig {
  mute?: boolean;
  chatId?: string;
  minRisk?: Risk;
}

const FILENAME = ".mycli.json";
const cache = new Map<string, { mtimeMs: number; cfg: ProjectConfig }>();

// Walk up from cwd to $HOME looking for the nearest config file.
function findConfigFile(startDir: string): string | null {
  const stop = homedir();
  let dir = startDir;
  while (true) {
    const p = join(dir, FILENAME);
    try {
      if (statSync(p).isFile()) return p;
    } catch {
      // not here, keep walking
    }
    const parent = dirname(dir);
    if (dir === stop || parent === dir) break; // reached home boundary or fs root
    dir = parent;
  }
  return null;
}

export function readProjectConfig(cwd: string): ProjectConfig {
  if (!cwd) return {};
  const file = findConfigFile(cwd);
  if (!file) return {};

  try {
    const { mtimeMs } = statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.cfg;

    const parsed = JSON.parse(readFileSync(file, "utf8")) as ProjectConfig;
    const cfg: ProjectConfig = {
      mute: parsed.mute === true,
      chatId: typeof parsed.chatId === "string" ? parsed.chatId : undefined,
      minRisk: ["safe", "caution", "danger"].includes(parsed.minRisk as string)
        ? parsed.minRisk
        : undefined,
    };
    cache.set(file, { mtimeMs, cfg });
    return cfg;
  } catch (e) {
    console.error(`[project-config] ${file} illeggibile:`, (e as Error).message);
    return {};
  }
}
