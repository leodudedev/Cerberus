import { createServer, type IncomingMessage } from "node:http";
import { config } from "../config.ts";
import { profileFromConfigDir, type Agent, type Profile } from "../profile.ts";
import { upsertSession } from "../registry.ts";
import { initBot, pushAttention } from "../bot/index.ts";
import { lastAssistantText, lastToolUse, type ToolUse } from "../transcript.ts";
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

    // Enrichment. Claude: read the transcript (tool_use + last assistant text).
    // Copilot: no transcript in the payload — read the preToolUse cache.
    let detail = "";
    let tool: ToolUse | null = null;
    if (agent === "claude") {
      // The pending tool_use may not be flushed to the transcript yet when the
      // hook fires — give it a moment before reading. Only meaningful on
      // permission events; on "waiting for input" it would be a stale tool.
      if (isPermission) await sleep(400);
      [detail, tool] = await Promise.all([
        lastAssistantText(hook.transcript_path),
        lastToolUse(hook.transcript_path),
      ]);
    } else if (isPermission) {
      // preToolUse and notification race on two HTTP requests: retry once.
      tool = peekPendingTool(sessionId);
      if (!tool) {
        await sleep(300);
        tool = peekPendingTool(sessionId);
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
      toolName: isPermission ? tool?.name ?? "" : "",
      command: isPermission ? tool?.command ?? "" : "",
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
