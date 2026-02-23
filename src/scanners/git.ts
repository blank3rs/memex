import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ora from "ora";
import { v4 as uuidv4 } from "uuid";
import { execFileNoThrow } from "../utils/execFileNoThrow.js";
import { MemexEntry } from "../types.js";

async function findGitRepos(searchDir: string, maxDepth = 3): Promise<string[]> {
  const repos: string[] = [];
  const skip = new Set(["node_modules", ".cache", "Library", "Applications", ".Trash"]);

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, ".git"))) {
        repos.push(full);
      } else {
        walk(full, depth + 1);
      }
    }
  }

  walk(searchDir, 0);
  return repos;
}

async function getRepoLanguages(repoPath: string): Promise<string[]> {
  const result = await execFileNoThrow("git", [
    "-C", repoPath, "ls-files",
  ]);
  if (result.status === "error") return [];

  const extCounts: Record<string, number> = {};
  for (const file of result.stdout.split("\n")) {
    const ext = path.extname(file).toLowerCase().replace(".", "");
    if (ext) extCounts[ext] = (extCounts[ext] ?? 0) + 1;
  }

  const EXT_TO_LANG: Record<string, string> = {
    ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
    py: "Python", go: "Go", rs: "Rust", rb: "Ruby", java: "Java",
    kt: "Kotlin", swift: "Swift", cs: "C#", cpp: "C++", c: "C",
    php: "PHP", ex: "Elixir", exs: "Elixir", scala: "Scala",
    tf: "Terraform", sql: "SQL", sh: "Shell", dockerfile: "Docker",
  };

  return Object.entries(extCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([ext]) => EXT_TO_LANG[ext] ?? ext)
    .filter(Boolean);
}

async function getLastCommitDate(repoPath: string): Promise<string> {
  const result = await execFileNoThrow("git", [
    "-C", repoPath, "log", "-1", "--format=%ci",
  ]);
  return result.stdout.split(" ")[0] ?? "";
}

async function getRepoName(repoPath: string): Promise<string> {
  return path.basename(repoPath);
}

export async function scanGit(): Promise<MemexEntry[]> {
  const spinner = ora("Scanning git repos...").start();

  const home = os.homedir();
  const gitConfig = path.join(home, ".gitconfig");
  const entries: MemexEntry[] = [];
  const now = new Date().toISOString();

  // Read git identity
  if (fs.existsSync(gitConfig)) {
    const config = fs.readFileSync(gitConfig, "utf-8");
    const nameMatch = config.match(/name\s*=\s*(.+)/);
    const emailMatch = config.match(/email\s*=\s*(.+)/);
    if (nameMatch || emailMatch) {
      entries.push({
        id: uuidv4(), timestamp: now, type: "fact",
        content: `Git identity: ${nameMatch?.[1]?.trim() ?? ""} <${emailMatch?.[1]?.trim() ?? ""}>`,
        tags: ["developer", "identity", "git"],
        metadata: { source: "gitconfig" },
      });
    }
  }

  // Find repos
  const repos = await findGitRepos(home);
  if (!repos.length) {
    spinner.succeed("No git repos found");
    return entries;
  }

  // Get activity + languages per repo
  const repoData = await Promise.all(
    repos.map(async (r) => ({
      name: await getRepoName(r),
      languages: await getRepoLanguages(r),
      lastCommit: await getLastCommitDate(r),
      path: r,
    }))
  );

  // Sort by most recently committed
  repoData.sort((a, b) => (b.lastCommit > a.lastCommit ? 1 : -1));
  const active = repoData.filter((r) => r.lastCommit >= new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0]);

  // Aggregate language frequency across all repos
  const langCounts: Record<string, number> = {};
  for (const r of repoData) {
    for (const lang of r.languages) langCounts[lang] = (langCounts[lang] ?? 0) + 1;
  }
  const topLangs = Object.entries(langCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([lang]) => lang);

  if (topLangs.length) {
    entries.push({
      id: uuidv4(), timestamp: now, type: "fact",
      content: `Primary programming languages: ${topLangs.join(", ")} (across ${repos.length} repos)`,
      tags: ["developer", "languages", "git"],
      metadata: { source: "git", totalRepos: repos.length, languages: langCounts },
    });
  }

  if (active.length) {
    const activeNames = active.slice(0, 5).map((r) => `${r.name} (${r.lastCommit})`).join(", ");
    entries.push({
      id: uuidv4(), timestamp: now, type: "fact",
      content: `Recently active projects (last 90 days): ${activeNames}`,
      tags: ["developer", "projects", "git"],
      metadata: { source: "git", activeRepos: active.slice(0, 5).map((r) => r.name) },
    });
  }

  spinner.succeed(`Git scanned — ${repos.length} repos, ${active.length} active recently`);
  return entries;
}
