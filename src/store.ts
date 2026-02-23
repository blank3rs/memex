import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { MemexState, MemexEntry, MemexConfig } from "./types.js";
import { v4 as uuidv4 } from "uuid";

const DEFAULT_DATA_DIR = path.join(os.homedir(), ".memex");

export function getDataDir(config?: Partial<MemexConfig>): string {
  return config?.dataDir ?? DEFAULT_DATA_DIR;
}

export function ensureDataDir(dataDir: string): void {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

export function getStatePath(dataDir: string): string {
  return path.join(dataDir, "state.json");
}

export function loadState(dataDir: string): MemexState | null {
  const statePath = getStatePath(dataDir);
  if (!fs.existsSync(statePath)) return null;
  const raw = fs.readFileSync(statePath, "utf-8");
  return JSON.parse(raw) as MemexState;
}

export function saveState(dataDir: string, state: MemexState): void {
  ensureDataDir(dataDir);
  const statePath = getStatePath(dataDir);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

export function addEntry(
  dataDir: string,
  entry: Omit<MemexEntry, "id" | "timestamp">
): MemexEntry {
  const state = loadState(dataDir);
  if (!state) throw new Error("Memex not initialized. Run `memex init` first.");

  const newEntry: MemexEntry = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    ...entry,
  };

  state.entries.push(newEntry);
  state.profile.updatedAt = new Date().toISOString();
  saveState(dataDir, state);

  // Also append to daily log file
  const today = new Date().toISOString().split("T")[0];
  const logDir = path.join(dataDir, "logs");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${today}.json`);

  let dailyLog: MemexEntry[] = [];
  if (fs.existsSync(logPath)) {
    dailyLog = JSON.parse(fs.readFileSync(logPath, "utf-8"));
  }
  dailyLog.push(newEntry);
  fs.writeFileSync(logPath, JSON.stringify(dailyLog, null, 2), "utf-8");

  return newEntry;
}
