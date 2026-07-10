import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// tmux control helpers. Using execFile with an args array (no shell) avoids
// any quoting/injection issues with prompt text.

export async function paneAlive(pane: string): Promise<boolean> {
  if (!pane) return false;
  try {
    const { stdout } = await exec("tmux", ["list-panes", "-a", "-F", "#{pane_id}"]);
    return stdout.split("\n").includes(pane);
  } catch {
    return false;
  }
}

// Send literal text into a pane (no trailing newline). The `--` guard keeps
// text starting with "-" from being parsed as a tmux flag.
export async function sendText(pane: string, text: string): Promise<void> {
  await exec("tmux", ["send-keys", "-t", pane, "-l", "--", text]);
}

// Send a named key (e.g. "Enter", "Escape") into a pane.
export async function sendKey(pane: string, key: string): Promise<void> {
  await exec("tmux", ["send-keys", "-t", pane, "--", key]);
}

// Type a prompt and submit it.
export async function sendPrompt(pane: string, text: string): Promise<void> {
  await sendText(pane, text);
  await sendKey(pane, "Enter");
}

// Dump the visible contents of a pane as plain text (no escape sequences).
// Used to read the actual permission dialog so the notification buttons match
// exactly what the CLI is showing.
export async function capturePane(pane: string): Promise<string> {
  if (!pane) return "";
  try {
    const { stdout } = await exec("tmux", ["capture-pane", "-p", "-t", pane]);
    return stdout;
  } catch {
    return "";
  }
}
