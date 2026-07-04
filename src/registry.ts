import type { Profile } from "./profile.ts";

// In-memory registry of live sessions, keyed by Claude session_id.
// Maps a session to its tmux pane so remote replies (Fase 3) can be routed
// back with `tmux send-keys`. Last-write-wins on pane, since a session_id is
// stable but could be re-attached to a different pane.

export interface SessionInfo {
  sessionId: string;
  pane: string;
  profile: Profile;
  cwd: string;
  lastMessage: string;
  detail: string; // last assistant text from the transcript (the actual question)
  toolName: string; // tool awaiting permission (e.g. "Bash"), "" if none
  command: string; // command / input summary of that tool
  lastSeen: number;
}

const sessions = new Map<string, SessionInfo>();

// Telegram message_id -> sessionId, so a reply to a notification routes back
// to the session that produced it.
const messageToSession = new Map<number, string>();

export function upsertSession(info: Omit<SessionInfo, "lastSeen">): SessionInfo {
  const record: SessionInfo = { ...info, lastSeen: Date.now() };
  sessions.set(info.sessionId, record);
  return record;
}

export function getSession(sessionId: string): SessionInfo | undefined {
  return sessions.get(sessionId);
}

export function listSessions(): SessionInfo[] {
  return [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

export function mostRecentSession(): SessionInfo | undefined {
  return listSessions()[0];
}

export function linkMessage(messageId: number, sessionId: string): void {
  messageToSession.set(messageId, sessionId);
}

export function sessionForMessage(messageId: number): SessionInfo | undefined {
  const id = messageToSession.get(messageId);
  return id ? sessions.get(id) : undefined;
}
