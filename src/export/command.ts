import * as fs from "fs";
import * as path from "path";
import { ExportContext, SkipSource, Source } from "./types.js";
import { ParquetWriter } from "./writer.js";
import { getWatermark, loadState, setWatermark } from "./state.js";
import { IS_MAC } from "./util.js";
import { ai } from "./sources/ai.js";
import { browser } from "./sources/browser.js";
import { calendar, reminders } from "./sources/calendar.js";
import { contacts } from "./sources/contacts.js";
import { documents, obsidian } from "./sources/files.js";
import { git } from "./sources/git.js";
import { github } from "./sources/github.js";
import { granola } from "./sources/granola.js";
import { imessage } from "./sources/imessage.js";
import { mail } from "./sources/mail.js";
import { notes } from "./sources/notes.js";
import { shell } from "./sources/shell.js";
import { voicememos } from "./sources/voicememos.js";
import { whatsapp } from "./sources/whatsapp.js";
import { wispr } from "./sources/wispr.js";

export const SOURCES: Source[] = [
  imessage, whatsapp, notes, mail, calendar, reminders, contacts, obsidian, documents,
  shell, git, github, ai, browser, wispr, granola, voicememos,
];

export interface ExportOptions {
  out: string;
  sources?: string;
  since?: string;
  full?: boolean;
  roots?: string;
}

interface Summary {
  source: string;
  rows: number;
  bytes: number;
  minTs: string | null;
  maxTs: string | null;
  file?: string;
  skipped?: string;
  redactedRows?: number;
  warnings?: string[];
}

function fail(msg: string): never {
  process.stderr.write(`mymemex export: ${msg}\n`);
  process.exit(2);
}

/** `mymemex export --out <dir> [--sources a,b] [--since <iso>] [--full] [--roots a,b]`: one JSON line per source on stdout. */
export async function exportCommand(opts: ExportOptions): Promise<void> {
  if (!opts.out) fail("--out <dir> is required");
  const outDir = path.resolve(opts.out);
  const byName = new Map(SOURCES.map((s) => [s.name, s]));
  const wanted = opts.sources ? opts.sources.split(",").map((s) => s.trim()).filter(Boolean) : SOURCES.map((s) => s.name);
  const unknown = wanted.filter((w) => !byName.has(w));
  if (unknown.length) fail(`unknown source(s): ${unknown.join(", ")}; known: ${[...byName.keys()].join(", ")}`);
  const since = opts.since ? new Date(opts.since) : null;
  if (since && !Number.isFinite(since.getTime())) fail(`--since is not a valid ISO date: ${opts.since}`);
  const roots = (opts.roots ?? "").split(",").map((r) => r.trim()).filter(Boolean).map((r) => path.resolve(r.replace(/^~/, process.env.HOME ?? "~")));

  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(".", "");
  fs.mkdirSync(outDir, { recursive: true });
  const tmpDir = path.join(outDir, `.tmp-${runId}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const state = loadState();
  const writer = await ParquetWriter.open(tmpDir);

  try {
    for (const name of wanted) {
      const src = byName.get(name)!;
      const summary: Summary = { source: name, rows: 0, bytes: 0, minTs: null, maxTs: null };
      const warnings: string[] = [];
      if (!src.anyPlatform && !IS_MAC) {
        summary.skipped = "macOS only";
        process.stdout.write(JSON.stringify(summary) + "\n");
        continue;
      }
      const wm = opts.full ? null : getWatermark(state, outDir, name);
      const wmDate = wm?.maxTs ? new Date(wm.maxTs) : null;
      const lowerBound = since && wmDate ? (since > wmDate ? since : wmDate) : since ?? wmDate;
      const ctx: ExportContext = { lowerBound, roots, tmpDir, warn: (m) => warnings.push(m) };
      process.stderr.write(`[${name}] reading${lowerBound ? ` since ${lowerBound.toISOString()}` : ""}\n`);
      const sink = await writer.begin(name);
      try {
        for await (const row of src.read(ctx)) {
          sink.append(row);
          if (sink.appended % 50000 === 0) process.stderr.write(`[${name}] ${sink.appended} rows\n`);
        }
        const part = await sink.finish({ outDir, runId, since, watermark: wm, full: !!opts.full });
        Object.assign(summary, { rows: part.rows, bytes: part.bytes, minTs: part.minTs, maxTs: part.maxTs });
        if (part.file) summary.file = part.file;
        if (part.redactedRows) summary.redactedRows = part.redactedRows;
        const prevMax = wm?.maxTs ?? null;
        const maxTs = prevMax && part.maxTs ? (prevMax > part.maxTs ? prevMax : part.maxTs) : part.maxTs ?? prevMax;
        setWatermark(state, outDir, name, {
          maxTs,
          count: (wm?.count ?? 0) + part.rows,
          lastRunId: runId,
          updatedAt: new Date().toISOString(),
        });
      } catch (e) {
        await sink.abort().catch(() => undefined);
        summary.skipped = e instanceof SkipSource ? e.message : `error: ${(e as Error)?.message ?? e}`;
      }
      if (warnings.length) summary.warnings = warnings.slice(0, 20);
      process.stdout.write(JSON.stringify(summary) + "\n");
    }
  } finally {
    writer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
