import { createServer, type IncomingMessage } from "node:http";
import { config } from "../config.ts";
import { profileFromConfigDir, type Agent, type Profile } from "../profile.ts";
import { upsertSession } from "../registry.ts";
import { initBot, pushAttention } from "../bot/index.ts";
import { lastAssistantText, type ToolUse } from "../transcript.ts";
import { readProjectConfig } from "../project-config.ts";
import { isMuted } from "../mute.ts";
import { putPendingTool, peekPendingTool, summarizeToolArgs } from "../pending-tools.ts";

// HTTP daemon that receives detection events from the hook scripts.
// Two producers, one endpoint:
//  - Claude Code  `Notification` hook (hooks/notify.sh) — snake_case payload,
//    enriched by reading the session transcript (JSONL).
//  - Copilot CLI  `preToolUse` + `notification` hooks (hooks/copilot-notify.sh)
//    — camelCase payload, no transcript: preToolUse feeds an in-memory cache
//    that the permission notification reads back.

interface HookPayload {
  // Claude Code (snake_case)
  session_id?: string;
  hook_event_name?: string;
  transcript_path?: string;
  // Copilot CLI (camelCase; PascalCase hook variants use snake_case)
  sessionId?: string;
  notification_type?: string;
  title?: string;
  toolName?: string;
  tool_name?: string;
  toolArgs?: unknown;
  tool_input?: unknown;
  // Common
  cwd?: string;
  message?: string;
  [k: string]: unknown;
}

interface EventBody {
  tmux_pane?: string;
  config_dir?: string;
  agent?: string; // "copilot" from copilot-notify.sh; absent = claude
  event?: string; // copilot hook event name ("preToolUse" | "notification")
  hook?: HookPayload | null;
}

// Copilot fires notifications for lots of lifecycle moments; only these need
// the phone. shell_completed & co. would be pure spam.
const COPILOT_NOTIFY_TYPES = new Set([
  "permission_prompt",
  "elicitation_dialog",
  "agent_idle",
  "agent_completed",
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Pull the answer labels out of an AskUserQuestion tool_input so the bot can
// render one button per real option. Only the simple single-question,
// single-select shape is supported; anything else falls back to no options
// (the user can still reply with free text), because multi-select and
// multi-question dialogs need more than a single "digit + Enter" keystroke.
function extractQuestionOptions(toolName: string, input: unknown): string[] | undefined {
  if (toolName !== "AskUserQuestion" || !input || typeof input !== "object") return undefined;
  const qs = (input as { questions?: unknown }).questions;
  if (!Array.isArray(qs) || qs.length !== 1) return undefined;
  const q = qs[0] as { multiSelect?: boolean; options?: unknown };
  if (q?.multiSelect) return undefined;
  if (!Array.isArray(q?.options)) return undefined;
  const labels = q.options
    .map((o) => String((o as { label?: unknown })?.label ?? "").trim())
    .filter(Boolean)
    .slice(0, 8);
  return labels.length ? labels : undefined;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : null;
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }

  if (req.method === "POST" && req.url === "/event") {
    let body: EventBody;
    try {
      body = (await readJson(req)) as EventBody;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad_json" }));
      return;
    }

    const agent: Agent = body?.agent === "copilot" ? "copilot" : "claude";
    const hook = body?.hook ?? {};
    const sessionId = String(hook.session_id ?? hook.sessionId ?? "unknown");

    // Copilot preToolUse: cache the tool about to run and stop here — the
    // permission notification (if any) follows as a separate event.
    if (agent === "copilot" && body?.event === "preToolUse") {
      const name = String(hook.toolName ?? hook.tool_name ?? "");
      const command = summarizeToolArgs(hook.toolArgs ?? hook.tool_input);
      putPendingTool(sessionId, name, command);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Claude Code PreToolUse: same idea as Copilot's preToolUse. The permission
    // Notification carries neither tool_name nor tool_input, so cache the exact
    // tool + input now and read it back when the notification arrives. This
    // replaces the old, racy "guess the pending tool from the transcript",
    // which returned the wrong tool on parallel batches and null when the
    // tool_use had not been flushed yet. PreToolUse also fires inside subagents.
    // Exit-0 with no output leaves the normal permission flow untouched.
    if (agent === "claude" && hook.hook_event_name === "PreToolUse") {
      const name = String(hook.tool_name ?? "");
      const command = summarizeToolArgs(hook.tool_input);
      const options = extractQuestionOptions(name, hook.tool_input);
      putPendingTool(sessionId, name, command, options);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const message = String(hook.message ?? hook.title ?? "");
    const notifyType = String(hook.notification_type ?? "");

    if (agent === "copilot" && notifyType && !COPILOT_NOTIFY_TYPES.has(notifyType)) {
      console.log("[copilot-skip]", notifyType);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const isPermission =
      agent === "copilot" ? notifyType === "permission_prompt" : /permission/i.test(message);

    // Enrichment.
    //  - Claude: last assistant text = the human-readable context ("what Claude
    //    said"); the tool + input come from the PreToolUse cache below.
    //  - Copilot: no transcript — tool + input from the preToolUse cache too.
    let detail = "";
    let tool: ToolUse | null = null;
    let options: string[] = [];
    if (agent === "claude") {
      detail = await lastAssistantText(hook.transcript_path);
    }
    // Attach the pending tool when a permission is being asked, or when a fresh
    // AskUserQuestion is pending (it's an elicitation, not a "permission", but
    // its options still deserve per-option buttons). Freshness guards against
    // showing a stale tool on an idle recap.
    let pend = peekPendingTool(sessionId);
    const freshQuestion =
      !!pend && pend.name === "AskUserQuestion" && Date.now() - pend.ts < 4000;
    if (isPermission || freshQuestion) {
      // PreToolUse and the notification race on two HTTP requests: retry once.
      if (!pend) {
        await sleep(300);
        pend = peekPendingTool(sessionId);
      }
      if (pend) {
        tool = pend;
        options = pend.options ?? [];
      }
    }

    const profile: Profile = agent === "copilot" ? "copilot" : profileFromConfigDir(body?.config_dir);
    const session = upsertSession({
      sessionId,
      agent,
      pane: body?.tmux_pane || "",
      profile,
      cwd: hook.cwd ?? "",
      lastMessage: message,
      detail,
      toolName: tool?.name ?? "",
      command: tool?.command ?? "",
      options,
      isPermission,
    });
    console.log("[event]", {
      agent,
      profile,
      pane: session.pane || "(none)",
      session: session.sessionId,
      cwd: session.cwd,
      message: session.lastMessage,
    });

    // Per-project overrides (.cerberus.json) + runtime mute applied before pushing.
    const pcfg = readProjectConfig(session.cwd);
    if (pcfg.mute || isMuted(session.cwd)) {
      console.log("[mute]", session.cwd);
    } else if (!isPermission && pcfg.notifyIdle === false) {
      console.log("[idle-skip]", session.cwd);
    } else {
      // Fire-and-forget push; never block the hook response.
      void pushAttention(session, { chatId: pcfg.chatId, minRisk: pcfg.minRisk }).catch(
        (e) => console.error("[bot] push failed", e),
      );
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[daemon] porta ${config.port} occupata — daemon già attivo?`);
    process.exit(1);
  }
  console.error("[daemon] server error:", e.message);
  process.exit(1);
});

// Bind only on loopback: the daemon must never be reachable off-host.
server.listen(config.port, "127.0.0.1", () => {
  console.log(`[daemon] listening on http://127.0.0.1:${config.port}`);
  initBot();
});
