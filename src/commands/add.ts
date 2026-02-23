import inquirer from "inquirer";
import chalk from "chalk";
import { addEntry, getDataDir, loadState } from "../store.js";
import { MemexEntry } from "../types.js";

export async function addCommand(
  options: { dir?: string; type?: string; message?: string }
): Promise<void> {
  const dataDir = options.dir ?? getDataDir();

  if (!loadState(dataDir)) {
    console.log(chalk.red("Memex not initialized. Run `memex init` first."));
    return;
  }

  let type = options.type as MemexEntry["type"] | undefined;
  let content = options.message;

  if (!type || !content) {
    const answers = await inquirer.prompt([
      !type
        ? {
            type: "list",
            name: "type",
            message: "What kind of entry?",
            choices: [
              { name: "Event  — something that happened", value: "event" },
              { name: "Thought — an idea or reflection", value: "thought" },
              { name: "Fact    — a fact about you", value: "fact" },
              { name: "Update  — general update", value: "update" },
            ],
          }
        : null,
      !content
        ? {
            type: "input",
            name: "content",
            message: "What happened / what do you want to log?",
            validate: (v: string) =>
              v.trim().length > 0 || "Entry cannot be empty",
          }
        : null,
      {
        type: "input",
        name: "tags",
        message: "Tags (optional, comma-separated):",
        default: "",
      },
    ].filter(Boolean) as Parameters<typeof inquirer.prompt>[0]);

    type = type ?? answers.type;
    content = content ?? answers.content;
    const tags: string[] = (answers.tags ?? "")
      .split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);

    const entry = addEntry(dataDir, {
      type: type as MemexEntry["type"],
      content: (content as string).trim(),
      tags,
    });

    console.log(
      chalk.green(`\n  Logged [${chalk.bold(entry.type)}]: ${entry.content}`)
    );
    console.log(chalk.gray(`  ID: ${entry.id}`));
    console.log(chalk.gray(`  At: ${new Date(entry.timestamp).toLocaleString()}\n`));
  } else {
    const entry = addEntry(dataDir, {
      type,
      content,
      tags: [],
    });
    console.log(chalk.green(`Logged: ${entry.content}`));
  }
}
