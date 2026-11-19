import * as fs from "fs";
import * as path from "path";
import { HOME } from "./util.js";

/** Per (output dir, source): the newest row time written and how many rows have been written in total. */
export interface Watermark {
  maxTs: string | null;
  count: number;
  lastRunId: string;
  updatedAt: string;
}

interface ExportState {
  version: 1;
  outputs: Record<string, Record<string, Watermark>>;
}

export const STATE_PATH = path.join(HOME, ".mymemex", "export-state.json");

export function loadState(): ExportState {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as ExportState;
    if (s && s.version === 1 && s.outputs) return s;
  } catch {
    /* first run */
  }
  return { version: 1, outputs: {} };
}

export function getWatermark(s: ExportState, outDir: string, source: string): Watermark | null {
  return s.outputs[outDir]?.[source] ?? null;
}

export function setWatermark(s: ExportState, outDir: string, source: string, w: Watermark): void {
  (s.outputs[outDir] ??= {})[source] = w;
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}
