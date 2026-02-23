import inquirer from "inquirer";
import chalk from "chalk";
import ora from "ora";
import { v4 as uuidv4 } from "uuid";
import { ensureDataDir, saveState, loadState, getDataDir } from "../store.js";
import { MemexState, MemexEntry } from "../types.js";
import { scanMeCard, buildBioFromCard } from "../scanners/me.js";
import { scanContacts } from "../scanners/contacts.js";
import { scanMessages } from "../scanners/messages.js";
import { scanCalendar } from "../scanners/calendar.js";
import { scanNotes } from "../scanners/notes.js";
import { scanReminders } from "../scanners/reminders.js";
import { scanDevTools } from "../scanners/devtools.js";
import { scanShellHistory } from "../scanners/shell.js";
import { scanGit } from "../scanners/git.js";
import { scanObsidian } from "../scanners/obsidian.js";
import { scanAIContext } from "../scanners/ai_context.js";

type DataSource =
  | "contacts" | "calendar" | "notes" | "reminders"
  | "devtools" | "shell" | "git" | "obsidian" | "ai_context"
  | "messages";

const SOURCES: { value: DataSource; name: string; checked: boolean }[] = [
  { value: "devtools",   name: "Dev tools    — tech stack from Homebrew, VS Code & apps",     checked: true  },
  { value: "git",        name: "Git          — languages & active projects from your repos",   checked: true  },
  { value: "shell",      name: "Shell        — what tools you actually use day-to-day",        checked: true  },
  { value: "obsidian",   name: "Obsidian     — topics & recent notes from your vault",         checked: true  },
  { value: "ai_context", name: "AI files     — CLAUDE.md, .cursorrules, ChatGPT export",       checked: true  },
  { value: "contacts",   name: "Contacts     — people you know",                               checked: true  },
  { value: "calendar",   name: "Calendar     — your events (30 days back, 90 forward)",        checked: true  },
  { value: "notes",      name: "Apple Notes  — your notes",                                    checked: true  },
  { value: "reminders",  name: "Reminders    — your open tasks",                               checked: true  },
  { value: "messages",   name: "iMessages    — conversations (needs Full Disk Access)",         checked: false },
];

async function runScanners(sources: DataSource[], messageLimit: number): Promise<MemexEntry[]> {
  const entries: MemexEntry[] = [];
  for (const source of sources) {
    let results: MemexEntry[] = [];
    if (source === "contacts")   results = await scanContacts();
    if (source === "messages")   results = await scanMessages(messageLimit);
    if (source === "calendar")   results = await scanCalendar();
    if (source === "notes")      results = await scanNotes();
    if (source === "reminders")  results = await scanReminders();
    if (source === "devtools")   results = await scanDevTools();
    if (source === "shell")      results = await scanShellHistory();
    if (source === "git")        results = await scanGit();
    if (source === "obsidian")   results = await scanObsidian();
    if (source === "ai_context") results = await scanAIContext();
    entries.push(...results);
  }
  return entries;
}

export async function initCommand(options: { dir?: string }): Promise<void> {
  const dataDir = options.dir ?? getDataDir();

  if (loadState(dataDir)) {
    const { overwrite } = await inquirer.prompt([{
      type: "confirm",
      name: "overwrite",
      message: chalk.yellow("Memex already initialized. Reinitialize?"),
      default: false,
    }]);
    if (!overwrite) { console.log(chalk.gray("Aborted.")); return; }
  }

  console.log(chalk.bold.cyan("\n  memex — personal memory agent\n"));

  // Step 1: Auto-detect identity from system sources
  const meSpinner = ora("Detecting your identity...").start();
  const meCard = await scanMeCard();

  const name = meCard.name;
  const bio = buildBioFromCard(meCard);
  const tags: string[] = [
    meCard.company ? meCard.company.toLowerCase().replace(/\s+/g, "-") : "",
    meCard.jobTitle ? meCard.jobTitle.toLowerCase().replace(/\s+/g, "-") : "",
  ].filter(Boolean);

  const sourceLabel: Record<string, string> = {
    "contacts-me-card": "Contacts Me card",
    "system": "macOS system name",
    "dscl": "macOS directory",
    "git-config": "git config",
    "username": "system username",
  };
  meSpinner.succeed(`Identity found via ${sourceLabel[meCard.source] ?? meCard.source}: ${chalk.bold(name)}`);

  // Show what we found and let them confirm/tweak
  console.log(chalk.gray("\n  Here's what we found about you:\n"));
  console.log(`  ${chalk.bold("Name:")} ${name}`);
  console.log(`  ${chalk.bold("Bio:")}  ${bio || chalk.gray("(empty)")}`);
  if (meCard?.emails.length) console.log(`  ${chalk.bold("Email:")} ${meCard.emails.join(", ")}`);
  if (meCard?.jobTitle)       console.log(`  ${chalk.bold("Role:")}  ${meCard.jobTitle}`);
  if (meCard?.company)        console.log(`  ${chalk.bold("Org:")}   ${meCard.company}`);
  if (meCard?.socials.length) console.log(`  ${chalk.bold("Social:")} ${meCard.socials.join(", ")}`);
  console.log();

  const { confirmed } = await inquirer.prompt([{
    type: "confirm",
    name: "confirmed",
    message: "Look good? (you can edit ~/.memex/state.json anytime)",
    default: true,
  }]);

  if (!confirmed) {
    console.log(chalk.gray("  You can edit ~/.memex/state.json after init to update your profile."));
  }

  // Step 2: Data source selection
  console.log(chalk.gray("\n  Now choose what to pull into your memory:\n"));

  console.log(
    chalk.dim("  Tip: iMessage needs Full Disk Access for Terminal in\n") +
    chalk.dim("  System Settings > Privacy & Security > Full Disk Access\n")
  );

  const { sources } = await inquirer.prompt([{
    type: "checkbox",
    name: "sources",
    message: "Select data sources  (space = toggle, enter = confirm):",
    choices: SOURCES,
    pageSize: 10,
  }]);

  // Step 3: Ask message limit if iMessages selected
  let messageLimit = 5000;
  if ((sources as DataSource[]).includes("messages")) {
    const { limitInput } = await inquirer.prompt([{
      type: "input",
      name: "limitInput",
      message: "How many messages to import? (enter a number, or 0 for all):",
      default: "5000",
      validate: (v: string) => /^\d+$/.test(v.trim()) || "Enter a valid number",
    }]);
    messageLimit = parseInt(limitInput.trim(), 10);
    if (messageLimit === 0) {
      console.log(chalk.gray("  Importing all messages — this may take a moment and produce a large file.\n"));
      messageLimit = Infinity;
    }
  }

  // Step 4: Run scanners
  let ingested: MemexEntry[] = [];
  if ((sources as DataSource[]).length > 0) {
    console.log(chalk.bold("\n  Scanning your Mac...\n"));
    ingested = await runScanners(sources as DataSource[], messageLimit);
  }

  // Step 4: Save
  const spinner = ora("Saving your memory...").start();

  const state: MemexState = {
    profile: {
      id: uuidv4(),
      name,
      bio,
      tags,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    entries: ingested,
    lastSync: null,
  };

  ensureDataDir(dataDir);
  saveState(dataDir, state);
  spinner.succeed("Memory saved!");

  console.log(chalk.green(`\n  Stored at: ${chalk.bold(dataDir)}`));
  console.log(chalk.bold.white(`  Entries ingested: ${ingested.length}`));
  console.log(chalk.gray("  Run `memex status` to see your memory."));
  console.log(chalk.gray("  Run `memex add` to log something new.\n"));
}
