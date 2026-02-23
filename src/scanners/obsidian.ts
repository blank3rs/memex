import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import chalk from "chalk";
import ora from "ora";
import { v4 as uuidv4 } from "uuid";
import { MemexEntry } from "../types.js";

interface ObsidianConfig {
  vaults: Record<string, { path: string; ts: number }>;
}

function getVaultPaths(): string[] {
  const configPath = path.join(
    os.homedir(), "Library", "Application Support", "obsidian", "obsidian.json"
  );
  if (!fs.existsSync(configPath)) return [];
  try {
    const config: ObsidianConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return Object.values(config.vaults ?? {})
      .map((v) => v.path)
      .filter((p) => fs.existsSync(p));
  } catch {
    return [];
  }
}

function getMdFiles(dir: string): string[] {
  const files: string[] = [];
  const skip = new Set([".obsidian", ".trash", "node_modules"]);

  function walk(d: string) {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  }
  walk(dir);
  return files;
}

function extractTags(content: string): string[] {
  const tags: string[] = [];
  // YAML frontmatter tags
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatter) {
    const tagLine = frontmatter[1].match(/tags:\s*\[?([^\]\n]+)\]?/);
    if (tagLine) tags.push(...tagLine[1].split(",").map((t) => t.trim().replace(/^["']|["']$/g, "")));
  }
  // Inline #tags
  const inlineTags = content.match(/#([a-zA-Z][a-zA-Z0-9_-]+)/g) ?? [];
  tags.push(...inlineTags.map((t) => t.slice(1)));
  return tags.filter(Boolean);
}

export async function scanObsidian(): Promise<MemexEntry[]> {
  const spinner = ora("Scanning Obsidian vault...").start();
  const vaults = getVaultPaths();

  if (!vaults.length) {
    spinner.warn(chalk.yellow("No Obsidian vault found"));
    return [];
  }

  const entries: MemexEntry[] = [];
  const now = new Date().toISOString();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // last 30 days

  for (const vault of vaults) {
    const vaultName = path.basename(vault);
    const files = getMdFiles(vault);

    // Get recently modified notes
    const recent = files
      .map((f) => ({ file: f, mtime: fs.statSync(f).mtimeMs }))
      .filter(({ mtime }) => mtime > cutoff)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 20);

    // Count all tags across vault to find top topics
    const tagCounts: Record<string, number> = {};
    let totalWords = 0;
    for (const f of files) {
      try {
        const content = fs.readFileSync(f, "utf-8");
        totalWords += content.split(/\s+/).length;
        for (const tag of extractTags(content)) {
          tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
        }
      } catch { /* skip unreadable files */ }
    }

    const topTopics = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag]) => tag);

    // Vault summary
    entries.push({
      id: uuidv4(), timestamp: now, type: "fact",
      content: `Obsidian vault "${vaultName}": ${files.length} notes, ~${Math.round(totalWords / 1000)}k words. Top topics: ${topTopics.join(", ")}`,
      tags: ["obsidian", "knowledge", "writing"],
      metadata: { source: "obsidian", vault: vaultName, noteCount: files.length, topTopics },
    });

    // Recent notes (title only — don't copy content)
    if (recent.length) {
      const recentTitles = recent
        .map(({ file }) => path.basename(file, ".md"))
        .slice(0, 10)
        .join(", ");
      entries.push({
        id: uuidv4(), timestamp: now, type: "update",
        content: `Recently edited Obsidian notes: ${recentTitles}`,
        tags: ["obsidian", "recent", "thinking"],
        metadata: { source: "obsidian", vault: vaultName, recentCount: recent.length },
      });
    }
  }

  spinner.succeed(`Obsidian scanned — ${vaults.length} vault(s), ${entries.length} insights`);
  return entries;
}
