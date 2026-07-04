import { createServer, type IncomingMessage } from "node:http";
import { config } from "../config.ts";
import { profileFromConfigDir } from "../profile.ts";
import { upsertSession } from "../registry.ts";
import { initBot, pushAttention } from "../bot/index.ts";
import { lastAssistantText, lastToolUse } from "../transcript.ts";
import { readProjectConfig } from "../project-config.ts";
import { isMuted } from "../mute.ts";

// Fase 1: HTTP daemon that receives detection events from the notify.sh hook.

interface HookPayload {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  message?: string;
  transcript_path?: string;
  [k: string]: unknown;
}

interface EventBody {
  tmux_pane?: string;
  config_dir?: string;
  hook?: HookPayload | null;
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

    const profile = profileFromConfigDir(body?.config_dir);
    const hook = body?.hook ?? {};
    const [detail, tool] = await Promise.all([
      lastAssistantText(hook.transcript_path),
      lastToolUse(hook.transcript_path),
    ]);
    const session = upsertSession({
      sessionId: hook.session_id ?? "unknown",
      pane: body?.tmux_pane || "",
      profile,
      cwd: hook.cwd ?? "",
      lastMessage: hook.message ?? "",
      detail,
      toolName: tool?.name ?? "",
      command: tool?.command ?? "",
    });
    console.log("[event]", {
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

// Bind only on loopback: the daemon must never be reachable off-host.
server.listen(config.port, "127.0.0.1", () => {
  console.log(`[daemon] listening on http://127.0.0.1:${config.port}`);
  initBot();
});
