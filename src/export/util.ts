import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import * as readline from "readline";
import { execFile } from "child_process";
import { DatabaseSync } from "node:sqlite";
import { SkipSource } from "./types.js";

export const HOME = os.homedir();
export const IS_MAC = process.platform === "darwin";
export const lib = (...p: string[]) => path.join(HOME, "Library", ...p);

// ---- time ------------------------------------------------------------------------------------

/** Apple Core Data epoch (2001-01-01) in Unix ms. */
export const APPLE_EPOCH_MS = 978307200000;

export function fromAppleSeconds(v: unknown): Date | null {
  const n = num(v);
  return n == null || n === 0 ? null : validDate(APPLE_EPOCH_MS + n * 1000);
}
/** iMessage stores ns since 2001 on modern macOS, seconds on very old ones. */
export function fromAppleNsOrSeconds(v: unknown): Date | null {
  const n = num(v);
  if (n == null || n === 0) return null;
  return n > 1e12 ? validDate(APPLE_EPOCH_MS + n / 1e6) : fromAppleSeconds(n);
}
export const toAppleSeconds = (d: Date) => (d.getTime() - APPLE_EPOCH_MS) / 1000;

export function validDate(ms: number | string | Date | null | undefined): Date | null {
  if (ms == null) return null;
  const d = ms instanceof Date ? ms : new Date(ms);
  return Number.isFinite(d.getTime()) ? d : null;
}

// ---- values ----------------------------------------------------------------------------------

export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
export function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  return String(v);
}
export const sha1 = (...parts: (string | number | null | undefined)[]) =>
  crypto.createHash("sha1").update(parts.map((p) => String(p ?? "")).join("\u0001")).digest("hex");

// ---- access ----------------------------------------------------------------------------------

/** Throws SkipSource with a plain reason when `p` is missing or unreadable. */
export function requireReadable(p: string, what: string): void {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    if (fs.statSync(p).isDirectory()) fs.readdirSync(p);
  } catch (e) {
    throw skipFor(e, p, what);
  }
}

export function skipFor(e: unknown, p: string, what: string): SkipSource {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return new SkipSource(`${what} not found: ${p}`);
  if (code === "EACCES" || code === "EPERM")
    return new SkipSource(`permission denied: ${p} (grant your terminal Full Disk Access)`);
  return new SkipSource(`${what} unreadable: ${(e as Error)?.message ?? e}`);
}

export const exists = (p: string) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};

// ---- sqlite ----------------------------------------------------------------------------------

/**
 * Open a SQLite DB from a temp copy (with its -wal/-shm), so a locked live DB is never touched.
 * Uses node's built-in sqlite: no native build on the target machine.
 */
export function openSqliteCopy(src: string, tmpDir: string, what: string): DatabaseSync {
  requireReadable(src, what);
  const dir = fs.mkdtempSync(path.join(tmpDir, "db-"));
  const dst = path.join(dir, path.basename(src));
  try {
    fs.copyFileSync(src, dst);
    for (const sfx of ["-wal", "-shm"]) if (exists(src + sfx)) fs.copyFileSync(src + sfx, dst + sfx);
  } catch (e) {
    throw skipFor(e, src, what);
  }
  return new DatabaseSync(dst);
}

/** Column names of a table (empty when the table does not exist). */
export function columns(db: DatabaseSync, table: string): Set<string> {
  try {
    return new Set(
      db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => String((r as { name: unknown }).name))
    );
  } catch {
    return new Set();
  }
}

/** First of `cands` present in `cols`, as `alias.col`; else SQL NULL. Schemas drift across OS versions. */
export function pick(cols: Set<string>, alias: string, ...cands: string[]): string {
  const c = cands.find((x) => cols.has(x));
  return c ? `${alias}.${c}` : "NULL";
}

// ---- files -----------------------------------------------------------------------------------

export const SKIP_DIRS = new Set([
  "node_modules", ".git", "build", "dist", "out", "target", "vendor", "venv", ".venv", "__pycache__",
  ".next", ".cache", "coverage", "Library", ".Trash", "bower_components", ".gradle", ".idea",
]);

export interface WalkOpts {
  exts?: Set<string>;
  maxBytes?: number;
  newerThan?: Date | null;
  /** Return true to skip a directory. Hidden dirs are always skipped. */
  skipDir?: (name: string, full: string) => boolean;
}

/** Depth-first file walk; never follows symlinks; unreadable dirs are skipped silently. */
export async function* walkFiles(root: string, opts: WalkOpts = {}): AsyncGenerator<{ path: string; stat: fs.Stats }> {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name) || opts.skipDir?.(e.name, full)) continue;
        stack.push(full);
      } else if (e.isFile()) {
        if (opts.exts && !opts.exts.has(path.extname(e.name).toLowerCase())) continue;
        let st: fs.Stats;
        try {
          st = await fs.promises.stat(full);
        } catch {
          continue;
        }
        if (opts.maxBytes && st.size > opts.maxBytes) continue;
        if (opts.newerThan && st.mtimeMs < opts.newerThan.getTime()) continue;
        yield { path: full, stat: st };
      }
    }
  }
}

/** Stream a text file line by line (never whole in memory). */
export async function* readLines(p: string): AsyncGenerator<string> {
  const rl = readline.createInterface({ input: fs.createReadStream(p, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
  }
}

export function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout))
  );
}

// ---- identity --------------------------------------------------------------------------------

/** His email addresses: MYMEMEX_EMAILS (comma list) plus every global git user.email. Lowercased. */
export async function myEmails(): Promise<Set<string>> {
  const set = new Set<string>();
  for (const e of (process.env.MYMEMEX_EMAILS ?? "").split(",")) if (e.trim()) set.add(e.trim().toLowerCase());
  const out = await run("git", ["config", "--global", "--get-all", "user.email"]);
  for (const e of (out ?? "").split("\n")) if (e.trim()) set.add(e.trim().toLowerCase());
  return set;
}

export function truncateTail(s: string, max: number): { text: string; truncated: boolean } {
  return s.length > max ? { text: s.slice(s.length - max), truncated: true } : { text: s, truncated: false };
}
