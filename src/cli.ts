#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { addCommand } from "./commands/add.js";
import { statusCommand } from "./commands/status.js";
import { watchCommand } from "./commands/watch.js";
import { exportCommand } from "./export/command.js";

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

program
  .command("export")
  .description("Export raw text history as zstd Parquet rows (incremental; one JSON summary line per source)")
  .requiredOption("-o, --out <dir>", "Output directory: <dir>/<source>/part-<runid>.parquet")
  .option("-s, --sources <list>", "Comma-separated sources (default: all)")
  .option("--since <iso>", "Only rows at or after this time")
  .option("--full", "Ignore the watermark and rewrite each source as one fresh part")
  .option("--roots <list>", "Comma-separated roots for the documents source (default: ~/Documents,~/Desktop)")
  .action(exportCommand);

program.parseAsync(process.argv);
