#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { addCommand } from "./commands/add.js";
import { statusCommand } from "./commands/status.js";
import { watchCommand } from "./commands/watch.js";

const program = new Command();

program
  .name("mymemex")
  .description("Personal evolving memory agent — tracks who you are and what's happening")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize your memex memory in a directory")
  .option("-d, --dir <path>", "Directory to store memory (default: ~/.memex)")
  .action(initCommand);

program
  .command("add")
  .description("Log a new entry to your memory")
  .option("-d, --dir <path>", "Memory directory")
  .option("-t, --type <type>", "Entry type: event | thought | fact | update")
  .option("-m, --message <text>", "Entry content (skips interactive prompt)")
  .action(addCommand);

program
  .command("status")
  .description("Show your current memory state and recent entries")
  .option("-d, --dir <path>", "Memory directory")
  .action(statusCommand);

program
  .command("watch")
  .description("Watch a directory and auto-log file changes")
  .option("-d, --dir <path>", "Memory directory")
  .option("-w, --watch <path>", "Directory to watch for changes")
  .action(watchCommand);

program.parse(process.argv);
