import { readFile } from "node:fs/promises";

// Best-effort readers over a Claude Code transcript (JSONL).

export interface ToolUse {
  name: string;
  command: string; // command (Bash) or input summary for other tools
}

async function readLines(path: string): Promise<any[]> {
  const raw = await readFile(path, "utf8");
  return raw
    .trimEnd()
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// Most recent assistant text block — what Claude last "said".
export async function lastAssistantText(path: string | undefined): Promise<string> {
  if (!path) return "";
  try {
    const lines = await readLines(path);
    for (let i = lines.length - 1; i >= 0; i--) {
      const j = lines[i];
      if (j?.type !== "assistant" || !Array.isArray(j.message?.content)) continue;
      const block = [...j.message.content]
        .reverse()
        .find((b) => b?.type === "text" && typeof b.text === "string" && b.text.trim());
      if (block) return String(block.text).trim();
    }
  } catch {
    // ignore
  }
  return "";
}

// Most recent tool_use block — the tool awaiting permission.
export async function lastToolUse(path: string | undefined): Promise<ToolUse | null> {
  if (!path) return null;
  try {
    const lines = await readLines(path);
    for (let i = lines.length - 1; i >= 0; i--) {
      const j = lines[i];
      if (j?.type !== "assistant" || !Array.isArray(j.message?.content)) continue;
      const block = [...j.message.content].reverse().find((b) => b?.type === "tool_use");
      if (block) return { name: String(block.name ?? ""), command: summarizeInput(block.name, block.input) };
    }
  } catch {
    // ignore
  }
  return null;
}

function summarizeInput(tool: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  switch (tool) {
    case "Bash":
      return String(input.command ?? "");
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return String(input.file_path ?? "");
    case "Glob":
    case "Grep":
      return String(input.pattern ?? "");
    case "WebFetch":
      return String(input.url ?? "");
    default:
      return "";
  }
}
