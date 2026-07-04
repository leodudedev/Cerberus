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

// Most recent *pending* tool_use block — the tool awaiting permission.
// A completed tool_use has a matching tool_result in a later user message;
// if the newest tool_use is already resolved, the pending one hasn't been
// flushed to the transcript yet, so return null rather than a stale tool.
export async function lastToolUse(path: string | undefined): Promise<ToolUse | null> {
  if (!path) return null;
  try {
    const lines = await readLines(path);

    const resolved = new Set<string>();
    for (const j of lines) {
      if (j?.type !== "user" || !Array.isArray(j.message?.content)) continue;
      for (const b of j.message.content)
        if (b?.type === "tool_result" && b.tool_use_id) resolved.add(String(b.tool_use_id));
    }

    for (let i = lines.length - 1; i >= 0; i--) {
      const j = lines[i];
      if (j?.type !== "assistant" || !Array.isArray(j.message?.content)) continue;
      const block = [...j.message.content].reverse().find((b) => b?.type === "tool_use");
      if (block) {
        if (block.id && resolved.has(String(block.id))) return null; // already executed
        return { name: String(block.name ?? ""), command: summarizeInput(block.name, block.input) };
      }
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
