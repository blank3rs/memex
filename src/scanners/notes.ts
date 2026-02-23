import chalk from "chalk";
import ora from "ora";
import { v4 as uuidv4 } from "uuid";
import { runAppleScript } from "../utils/execFileNoThrow.js";
import { requestPermission } from "../utils/permissions.js";
import { MemexEntry } from "../types.js";

const SCRIPT = `
tell application "Notes"
  set output to {}
  repeat with n in every note
    set t to name of n
    set b to plaintext of n
    if length of b > 300 then set b to text 1 thru 300 of b
    set end of output to (t & "|" & b)
  end repeat
  set AppleScript's text item delimiters to "\\n---\\n"
  return output as string
end tell
`;

async function tryFetch() {
  return runAppleScript(SCRIPT);
}

export async function scanNotes(): Promise<MemexEntry[]> {
  const spinner = ora("Scanning Notes...").start();
  let result = await tryFetch();

  if (result.status === "error" || !result.stdout) {
    spinner.stop();
    const retry = await requestPermission("notes");
    if (!retry) return [];
    spinner.start("Scanning Notes...");
    result = await tryFetch();
  }

  if (result.status === "error" || !result.stdout) {
    spinner.fail(chalk.red("Notes access denied — skipping"));
    return [];
  }

  const blocks = result.stdout.split("\n---\n").filter(Boolean);
  spinner.succeed(`Found ${blocks.length} notes`);

  const now = new Date().toISOString();
  return blocks.map((block) => {
    const sep = block.indexOf("|");
    const title = block.slice(0, sep).trim();
    const body = block.slice(sep + 1).trim();
    return {
      id: uuidv4(),
      timestamp: now,
      type: "thought" as const,
      content: `Note: "${title}" — ${body}`,
      tags: ["note", "notes"],
      metadata: { source: "notes", title, preview: body },
    };
  });
}
