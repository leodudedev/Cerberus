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

// Send literal text into a pane (no trailing newline).
export async function sendText(pane: string, text: string): Promise<void> {
  await exec("tmux", ["send-keys", "-t", pane, "-l", text]);
}

// Send a named key (e.g. "Enter", "Escape") into a pane.
export async function sendKey(pane: string, key: string): Promise<void> {
  await exec("tmux", ["send-keys", "-t", pane, key]);
}

// Type a prompt and submit it.
export async function sendPrompt(pane: string, text: string): Promise<void> {
  await sendText(pane, text);
  await sendKey(pane, "Enter");
}
