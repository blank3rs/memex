import chalk from "chalk";
import { loadState, getDataDir } from "../store.js";
import { format } from "date-fns";

export function statusCommand(options: { dir?: string }): void {
  const dataDir = options.dir ?? getDataDir();
  const state = loadState(dataDir);

  if (!state) {
    console.log(chalk.red("Memex not initialized. Run `memex init` first."));
    return;
  }

  const { profile, entries } = state;
  const updatedAt = format(new Date(profile.updatedAt), "PPpp");
  const recentEntries = [...entries].reverse().slice(0, 5);

  console.log(chalk.bold.cyan("\n  memex — your current state\n"));
  console.log(`  ${chalk.bold("Name:")}     ${profile.name}`);
  console.log(`  ${chalk.bold("Bio:")}      ${profile.bio || chalk.gray("(none)")}`);
  console.log(
    `  ${chalk.bold("Tags:")}     ${
      profile.tags.length ? profile.tags.map((t: string) => chalk.blue(`#${t}`)).join(" ") : chalk.gray("(none)")
    }`
  );
  console.log(`  ${chalk.bold("Updated:")}  ${updatedAt}`);
  console.log(`  ${chalk.bold("Entries:")}  ${entries.length} total\n`);

  if (recentEntries.length > 0) {
    console.log(chalk.bold("  Recent entries:\n"));
    for (const entry of recentEntries) {
      const time = format(new Date(entry.timestamp), "MMM d, h:mm a");
      const typeColor =
        entry.type === "event"
          ? chalk.green
          : entry.type === "thought"
          ? chalk.magenta
          : entry.type === "fact"
          ? chalk.blue
          : chalk.yellow;

      console.log(
        `  ${typeColor(`[${entry.type}]`)} ${chalk.gray(time)}\n  ${entry.content}\n`
      );
    }
  } else {
    console.log(chalk.gray("  No entries yet. Run `memex add` to log something.\n"));
  }
}
