import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import chalk from "chalk";
import ora from "ora";
import { v4 as uuidv4 } from "uuid";
import { MemexEntry } from "../types.js";

const TOOL_CATEGORIES: Record<string, string[]> = {
  "package managers": ["npm", "yarn", "pnpm", "pip", "pip3", "cargo", "gem", "composer", "go get"],
  "languages/runtimes": ["python", "python3", "node", "go", "ruby", "java", "rust", "swift", "php"],
  "containers/infra": ["docker", "kubectl", "helm", "terraform", "ansible", "vagrant", "k9s"],
  "databases": ["psql", "mysql", "mongo", "redis-cli", "sqlite3"],
  "ai/ml": ["ollama", "python -m transformers", "jupyter", "llamafile"],
  "editors": ["vim", "nvim", "nano", "code", "cursor", "emacs"],
  "cloud": ["aws", "gcloud", "az", "fly", "heroku", "vercel", "netlify"],
};

function parseZshHistory(raw: string): string[] {
  // zsh extended history: ": timestamp:elapsed;command"
  return raw
    .split("\n")
    .map((line) => {
      const match = line.match(/^: \d+:\d+;(.+)$/);
      return match ? match[1].trim() : line.trim();
    })
    .filter(Boolean);
}

function topN<T extends string>(items: T[], n: number): { item: T; count: number }[] {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([item, count]) => ({ item: item as T, count }));
}

export async function scanShellHistory(): Promise<MemexEntry[]> {
  const spinner = ora("Analyzing shell history...").start();

  const candidates = [
    path.join(os.homedir(), ".zsh_history"),
    path.join(os.homedir(), ".bash_history"),
    path.join(os.homedir(), ".history"),
  ];

  const histFile = candidates.find(fs.existsSync);
  if (!histFile) {
    spinner.warn(chalk.yellow("No shell history found"));
    return [];
  }

  const raw = fs.readFileSync(histFile, "utf-8");
  const commands = parseZshHistory(raw);

  // Extract base commands (first word only)
  const baseCommands = commands
    .map((c) => c.split(/\s+/)[0])
    .filter((c) => c && !c.startsWith("#") && c.length > 1);

  const topCommands = topN(baseCommands, 20);

  // Match against categories to understand what they work with
  const detected: Record<string, string[]> = {};
  for (const [cat, keywords] of Object.entries(TOOL_CATEGORIES)) {
    const hits = commands.filter((cmd) =>
      keywords.some((k) => cmd.startsWith(k + " ") || cmd === k)
    );
    if (hits.length > 2) {
      detected[cat] = keywords.filter((k) =>
        commands.some((cmd) => cmd.startsWith(k))
      );
    }
  }

  const entries: MemexEntry[] = [];
  const now = new Date().toISOString();

  // Top tools used
  const topToolStr = topCommands
    .filter(({ item }) => !["cd", "ls", "echo", "cat", "grep", "mkdir", "rm", "cp", "mv", "pwd"].includes(item))
    .slice(0, 10)
    .map(({ item, count }) => `${item} (${count}×)`)
    .join(", ");

  if (topToolStr) {
    entries.push({
      id: uuidv4(), timestamp: now, type: "fact",
      content: `Most used terminal tools: ${topToolStr}`,
      tags: ["developer", "shell", "habits"],
      metadata: { source: "shell-history", totalCommands: commands.length },
    });
  }

  // Tech areas detected
  const detectedStr = Object.entries(detected)
    .map(([cat, tools]) => `${cat}: ${tools.join(", ")}`)
    .join("; ");

  if (detectedStr) {
    entries.push({
      id: uuidv4(), timestamp: now, type: "fact",
      content: `Works with — ${detectedStr}`,
      tags: ["developer", "tech-stack", "shell"],
      metadata: { source: "shell-history", categories: detected },
    });
  }

  spinner.succeed(`Shell history analyzed — ${commands.length.toLocaleString()} commands, ${entries.length} insights`);
  return entries;
}
