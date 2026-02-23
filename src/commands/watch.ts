import chokidar from "chokidar";
import chalk from "chalk";
import * as path from "path";
import { addEntry, loadState, getDataDir } from "../store.js";

export function watchCommand(options: { dir?: string; watch?: string }): void {
  const dataDir = options.dir ?? getDataDir();
  const watchDir = options.watch ?? dataDir;

  const state = loadState(dataDir);
  if (!state) {
    console.log(chalk.red("Memex not initialized. Run `memex init` first."));
    return;
  }

  console.log(chalk.bold.cyan("\n  memex — watching for changes\n"));
  console.log(chalk.gray(`  Watching: ${watchDir}`));
  console.log(chalk.gray("  Press Ctrl+C to stop.\n"));

  const watcher = chokidar.watch(watchDir, {
    ignored: /(^|[/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true,
  });

  watcher
    .on("add", (filePath: string) => {
      const rel = path.relative(watchDir, filePath);
      const entry = addEntry(dataDir, {
        type: "event",
        content: `File added: ${rel}`,
        tags: ["file", "auto"],
        metadata: { filePath, event: "add" },
      });
      console.log(chalk.green(`  [auto] File added: ${rel}`));
    })
    .on("change", (filePath: string) => {
      const rel = path.relative(watchDir, filePath);
      addEntry(dataDir, {
        type: "update",
        content: `File changed: ${rel}`,
        tags: ["file", "auto"],
        metadata: { filePath, event: "change" },
      });
      console.log(chalk.yellow(`  [auto] File changed: ${rel}`));
    })
    .on("unlink", (filePath: string) => {
      const rel = path.relative(watchDir, filePath);
      addEntry(dataDir, {
        type: "event",
        content: `File removed: ${rel}`,
        tags: ["file", "auto"],
        metadata: { filePath, event: "unlink" },
      });
      console.log(chalk.red(`  [auto] File removed: ${rel}`));
    });

  process.on("SIGINT", () => {
    console.log(chalk.gray("\n  Stopped watching. Memory saved.\n"));
    watcher.close();
    process.exit(0);
  });
}
