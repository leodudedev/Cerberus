import { basename } from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import { actionKeys } from "../config.ts";
import { RISK_ICON, RISK_RANK, riskFor, type Risk } from "../classify.ts";
import {
  linkMessage,
  mostRecentSession,
  sessionForMessage,
  getSession,
  type SessionInfo,
} from "../registry.ts";
import { paneAlive, sendKey, sendPrompt } from "../tmux.ts";

// Telegram layer: push attention events, and route replies/buttons back to the
// originating tmux pane via send-keys.

let bot: Bot | null = null;
let chatId: string | null = null;
// Chats allowed as notification targets and as command sources: the default
// chat plus TELEGRAM_ALLOWED_CHATS (csv). Guards per-project chatId overrides.
const allowedChats = new Set<string>();

export function initBot(): boolean {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  chatId = process.env.TELEGRAM_CHAT_ID ?? null;

  if (!token || !chatId) {
    console.warn("[bot] TELEGRAM_BOT_TOKEN/CHAT_ID mancanti — push disabilitato");
    return false;
  }

  allowedChats.clear();
  allowedChats.add(chatId);
  for (const id of (process.env.TELEGRAM_ALLOWED_CHATS ?? "").split(","))
    if (id.trim()) allowedChats.add(id.trim());

  bot = new Bot(token);

  // Whitelist: ignore anything not from an allowed chat.
  bot.use(async (ctx, next) => {
    if (!allowedChats.has(String(ctx.chat?.id))) return;
    await next();
  });

  // Buttons: approve / deny / esc -> keystrokes into the session's pane.
  bot.on("callback_query:data", async (ctx) => {
    const [action, sessionId] = ctx.callbackQuery.data.split(":");
    const s = sessionId ? getSession(sessionId) : undefined;
    const keys = actionKeys[action];

    if (!s || !keys) {
      await ctx.answerCallbackQuery({ text: "Sessione non trovata" });
      return;
    }
    if (!(await paneAlive(s.pane))) {
      await ctx.answerCallbackQuery({ text: `Pane ${s.pane} non attivo` });
      return;
    }

    for (const k of keys) await sendKey(s.pane, k);
    await ctx.answerCallbackQuery({ text: `${action} → ${s.profile} ${s.pane}` });
  });

  // Free text: a reply to a notification targets that session; a bare message
  // targets the most recent session. Sends the text as a prompt.
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const replyId = ctx.message.reply_to_message?.message_id;
    const target = (replyId && sessionForMessage(replyId)) || mostRecentSession();

    if (!target) {
      await ctx.reply("Nessuna sessione nota");
      return;
    }
    if (!(await paneAlive(target.pane))) {
      await ctx.reply(`Pane ${target.pane} non attivo`);
      return;
    }

    await sendPrompt(target.pane, text);
    await ctx.reply(`→ inviato a *${target.profile}* \`${target.pane}\``, {
      parse_mode: "MarkdownV2",
    });
  });

  bot.start({ onStart: (me) => console.log(`[bot] @${me.username} attivo`) });
  return true;
}

// Dedupe: suppress an identical (session + message) re-notification within this
// window. Claude Code re-fires the Notification hook (~60s idle) with the same
// text; without this the user gets duplicates.
const DEDUPE_MS = 90_000;
const CMD_MAX = 200; // truncate long commands in the message
const lastPush = new Map<string, number>(); // key: sessionId::message

export interface PushOptions {
  chatId?: string; // per-project target override (must be in allowedChats)
  minRisk?: Risk; // skip notifications below this risk level
}

export async function pushAttention(s: SessionInfo, opts: PushOptions = {}): Promise<void> {
  if (!bot || !chatId) return;

  const risk = s.toolName ? riskFor(s.toolName, s.command) : "caution";
  if (opts.minRisk && RISK_RANK[risk] < RISK_RANK[opts.minRisk]) return;

  // Resolve target: honor a per-project override only if allow-listed.
  let target = chatId;
  if (opts.chatId) {
    if (allowedChats.has(opts.chatId)) target = opts.chatId;
    else console.warn(`[bot] chatId ${opts.chatId} non in allowlist — uso default`);
  }

  const key = `${s.sessionId}::${target}::${s.lastMessage}`;
  const now = Date.now();
  const prev = lastPush.get(key) ?? 0;
  if (now - prev < DEDUPE_MS) return;
  lastPush.set(key, now);

  const kb = new InlineKeyboard()
    .text("✅ Approva", `approve:${s.sessionId}`)
    .text("❌ Nega", `deny:${s.sessionId}`)
    .text("⎋ Esc", `esc:${s.sessionId}`);

  const folder = basename(s.cwd) || s.cwd;
  let text = `🔔 *${escapeMd(cap(s.profile))}* · \`${escapeMd(folder)}\`\n${escapeMd(s.lastMessage)}`;

  // Tool awaiting permission, prefixed with its risk icon.
  if (s.toolName) {
    const cmd = s.command ? `: \`${escapeMd(truncate(s.command, CMD_MAX))}\`` : "";
    text += `\n\n${RISK_ICON[risk]} *${escapeMd(s.toolName)}*${cmd}`;
  }
  if (s.detail) text += `\n\n💬 ${escapeMd(truncate(s.detail, 400))}`;

  const sent = await bot.api.sendMessage(target, text, {
    parse_mode: "MarkdownV2",
    reply_markup: kb,
  });
  // Link the message so a reply routes back to this session.
  linkMessage(sent.message_id, s.sessionId);
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Minimal MarkdownV2 escaping for the dynamic fields.
function escapeMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}
