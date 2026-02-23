import chalk from "chalk";
import ora from "ora";
import { v4 as uuidv4 } from "uuid";
import { runAppleScript } from "../utils/execFileNoThrow.js";
import { requestPermission } from "../utils/permissions.js";
import { MemexEntry } from "../types.js";

const SCRIPT = `
tell application "Reminders"
  set output to {}
  repeat with lst in every list
    repeat with r in every reminder of lst
      if completed of r is false then
        set t to name of r
        set listName to name of lst
        set due to ""
        try
          set due to due date of r as string
        end try
        set end of output to (t & "|" & listName & "|" & due)
      end if
    end repeat
  end repeat
  set AppleScript's text item delimiters to "\\n"
  return output as string
end tell
`;

async function tryFetch() {
  return runAppleScript(SCRIPT);
}

export async function scanReminders(): Promise<MemexEntry[]> {
  const spinner = ora("Scanning Reminders...").start();
  let result = await tryFetch();

  if (result.status === "error" || !result.stdout) {
    spinner.stop();
    const retry = await requestPermission("reminders");
    if (!retry) return [];
    spinner.start("Scanning Reminders...");
    result = await tryFetch();
  }

  if (result.status === "error" || !result.stdout) {
    spinner.fail(chalk.red("Reminders access denied — skipping"));
    return [];
  }

  const lines = result.stdout.split("\n").filter(Boolean);
  spinner.succeed(`Found ${lines.length} open reminders`);

  const now = new Date().toISOString();
  return lines.map((line) => {
    const [title, list, due] = line.split("|");
    return {
      id: uuidv4(),
      timestamp: now,
      type: "fact" as const,
      content: [
        `Reminder: "${title?.trim()}"`,
        `List: ${list?.trim()}`,
        due?.trim() ? `Due: ${due.trim()}` : "",
      ].filter(Boolean).join(" | "),
      tags: ["reminder", "task"],
      metadata: { source: "reminders", title: title?.trim(), list: list?.trim(), due: due?.trim() },
    };
  });
}
