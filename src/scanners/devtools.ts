import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import chalk from "chalk";
import ora from "ora";
import { v4 as uuidv4 } from "uuid";
import { execFileNoThrow } from "../utils/execFileNoThrow.js";
import { MemexEntry } from "../types.js";

// Categorize brew/npm packages into meaningful tech areas
const CATEGORIES: Record<string, string[]> = {
  languages:    ["python", "python3", "node", "go", "rust", "ruby", "java", "kotlin", "swift", "php", "elixir", "scala", "lua", "perl", "r", "julia"],
  databases:    ["postgresql", "mysql", "mongodb", "redis", "sqlite", "cassandra", "elasticsearch", "influxdb", "neo4j", "cockroachdb", "mariadb"],
  infra:        ["docker", "kubernetes", "terraform", "ansible", "vagrant", "helm", "minikube", "kind", "pulumi", "nomad"],
  cloud:        ["awscli", "azure-cli", "google-cloud-sdk", "flyctl", "heroku"],
  webservers:   ["nginx", "caddy", "apache", "traefik", "haproxy"],
  ai_ml:        ["ollama", "pytorch", "tensorflow", "jupyter", "huggingface-cli", "llama.cpp"],
  tools:        ["git", "gh", "jq", "fzf", "ripgrep", "tmux", "neovim", "vim", "bat", "eza", "zoxide", "starship"],
};

function categorize(packages: string[]): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const [cat, keywords] of Object.entries(CATEGORIES)) {
    const matches = packages.filter((p) =>
      keywords.some((k) => p.toLowerCase().includes(k))
    );
    if (matches.length) found[cat] = matches;
  }
  return found;
}

async function getBrewPackages(): Promise<string[]> {
  const result = await execFileNoThrow("brew", ["list", "--formula"]);
  if (result.status === "error") return [];
  return result.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function getNpmGlobals(): Promise<string[]> {
  const result = await execFileNoThrow("npm", ["list", "-g", "--depth=0", "--parseable"]);
  if (result.status === "error") return [];
  return result.stdout
    .split("\n")
    .map((line) => path.basename(line.trim()))
    .filter((p) => p && p !== "lib");
}

function getVSCodeExtensions(): string[] {
  const extDir = path.join(os.homedir(), ".vscode", "extensions");
  if (!fs.existsSync(extDir)) return [];
  return fs.readdirSync(extDir)
    .filter((d) => !d.startsWith("."))
    .map((d) => d.replace(/-\d+\.\d+\.\d+$/, "")); // strip version
}

function getDockApps(): string[] {
  const plist = path.join(os.homedir(), "Library", "Preferences", "com.apple.dock.plist");
  if (!fs.existsSync(plist)) return [];
  // Use defaults read to get plist as text - safe, no user input
  return []; // populated via AppleScript scanner if needed
}

function getInstalledApps(): string[] {
  const appsDir = "/Applications";
  if (!fs.existsSync(appsDir)) return [];
  return fs.readdirSync(appsDir)
    .filter((a) => a.endsWith(".app"))
    .map((a) => a.replace(".app", ""));
}

export async function scanDevTools(): Promise<MemexEntry[]> {
  const spinner = ora("Scanning dev tools & tech stack...").start();
  const entries: MemexEntry[] = [];
  const now = new Date().toISOString();

  const [brew, npm] = await Promise.all([getBrewPackages(), getNpmGlobals()]);
  const vscode = getVSCodeExtensions();
  const apps = getInstalledApps();

  // Synthesize tech stack from brew
  if (brew.length) {
    const cats = categorize(brew);
    const lines: string[] = [];
    if (cats.languages)  lines.push(`Languages: ${cats.languages.join(", ")}`);
    if (cats.databases)  lines.push(`Databases: ${cats.databases.join(", ")}`);
    if (cats.infra)      lines.push(`Infra/DevOps: ${cats.infra.join(", ")}`);
    if (cats.cloud)      lines.push(`Cloud CLIs: ${cats.cloud.join(", ")}`);
    if (cats.webservers) lines.push(`Web servers: ${cats.webservers.join(", ")}`);
    if (cats.ai_ml)      lines.push(`AI/ML tools: ${cats.ai_ml.join(", ")}`);

    if (lines.length) {
      entries.push({
        id: uuidv4(), timestamp: now, type: "fact",
        content: `Tech stack (from Homebrew):\n${lines.join("\n")}`,
        tags: ["tech-stack", "homebrew", "developer"],
        metadata: { source: "homebrew", categories: cats },
      });
    }
  }

  // Synthesize VS Code extensions into tech signals
  if (vscode.length) {
    const interesting = vscode.filter((e) =>
      !["ms-vscode", "vscodevim", "github.copilot"].some((skip) => e.includes(skip))
    );
    const techSignals = interesting.slice(0, 20);
    if (techSignals.length) {
      entries.push({
        id: uuidv4(), timestamp: now, type: "fact",
        content: `VS Code extensions suggest: ${techSignals.join(", ")}`,
        tags: ["tech-stack", "vscode", "developer"],
        metadata: { source: "vscode-extensions", extensions: techSignals },
      });
    }
  }

  // Notable installed apps (filter to meaningful ones)
  const notableApps = apps.filter((a) =>
    ["Slack", "Figma", "Notion", "Linear", "Spotify", "Discord", "Obsidian",
     "Cursor", "Xcode", "Sketch", "Arc", "Raycast", "1Password", "Warp",
     "TablePlus", "Postico", "Insomnia", "Paw", "Docker", "Proxyman"].includes(a)
  );
  if (notableApps.length) {
    entries.push({
      id: uuidv4(), timestamp: now, type: "fact",
      content: `Notable apps installed: ${notableApps.join(", ")}`,
      tags: ["apps", "lifestyle", "tools"],
      metadata: { source: "applications", apps: notableApps },
    });
  }

  spinner.succeed(
    `Tech stack synthesized — ${entries.length} insight${entries.length !== 1 ? "s" : ""} from ${brew.length} brew pkgs, ${vscode.length} extensions, ${apps.length} apps`
  );
  return entries;
}
