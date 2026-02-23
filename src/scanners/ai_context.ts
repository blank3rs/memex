import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ora from "ora";
import { v4 as uuidv4 } from "uuid";
import { MemexEntry } from "../types.js";

const AI_FILE_PATTERNS = [
  { glob: "CLAUDE.md", label: "Claude memory" },
  { glob: "CLAUDE.local.md", label: "Claude local memory" },
  { glob: ".cursorrules", label: "Cursor rules" },
  { glob: ".clinerules", label: "Cline rules" },
];

const MAX_CONTENT_LENGTH = 500;

function findFilesNamed(name: string, searchDir: string, maxDepth = 4): string[] {
  const results: string[] = [];
  const skip = new Set(["node_modules", ".git", ".cache", "Library", "Applications", ".Trash", "dist", "build"]);

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === name) {
        results.push(path.join(dir, entry.name));
      } else if (entry.isDirectory() && !skip.has(entry.name) && !entry.name.startsWith(".")) {
        walk(path.join(dir, entry.name), depth + 1);
      }
    }
  }
  walk(searchDir, 0);
  return results;
}

export async function scanAIContext(): Promise<MemexEntry[]> {
  const spinner = ora("Scanning AI context files...").start();
  const home = os.homedir();
  const entries: MemexEntry[] = [];
  const now = new Date().toISOString();

  for (const { glob: fileName, label } of AI_FILE_PATTERNS) {
    const files = findFilesNamed(fileName, home);
    for (const filePath of files) {
      try {
        const raw = fs.readFileSync(filePath, "utf-8").trim();
        if (!raw) continue;

        const preview = raw.length > MAX_CONTENT_LENGTH
          ? raw.slice(0, MAX_CONTENT_LENGTH) + "…"
          : raw;

        const projectName = path.basename(path.dirname(filePath));

        entries.push({
          id: uuidv4(), timestamp: now, type: "fact",
          content: `${label} for "${projectName}":\n${preview}`,
          tags: ["ai-context", "project", label.toLowerCase().replace(/\s+/g, "-")],
          metadata: { source: "ai-context", file: filePath, label, project: projectName },
        });
      } catch { /* skip unreadable */ }
    }
  }

  // Also check for ChatGPT export file dropped in Downloads or home
  const chatGPTCandidates = [
    path.join(home, "Downloads", "conversations.json"),
    path.join(home, "conversations.json"),
    path.join(home, "Desktop", "conversations.json"),
  ];

  for (const candidate of chatGPTCandidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(candidate, "utf-8")) as Array<{ title?: string; create_time?: number }>;
      if (!Array.isArray(data)) continue;

      const recent = data
        .filter((c) => c.create_time && c.create_time > Date.now() / 1000 - 90 * 86400)
        .sort((a, b) => (b.create_time ?? 0) - (a.create_time ?? 0));

      const titles = recent.slice(0, 15).map((c) => c.title ?? "Untitled").join(", ");

      entries.push({
        id: uuidv4(), timestamp: now, type: "fact",
        content: `ChatGPT export found: ${data.length} conversations total. Recent topics: ${titles}`,
        tags: ["ai-context", "chatgpt", "thinking"],
        metadata: { source: "chatgpt-export", totalConversations: data.length, recentCount: recent.length },
      });
      break;
    } catch { /* skip malformed */ }
  }

  spinner.succeed(`AI context scanned — ${entries.length} context file${entries.length !== 1 ? "s" : ""} found`);
  return entries;
}
