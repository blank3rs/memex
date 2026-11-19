/** One exported row. Every source emits this shape; the writer adds `source`. */
export interface Row {
  /** Stable per source; re-exports of an edited record reuse it, so downstream dedupes on (source, id). */
  id: string;
  /** When the record was written (UTC). Null only when the source has no time at all. */
  ts: Date | null;
  author: string | null;
  is_me: boolean;
  thread_id: string | null;
  thread_name: string | null;
  reply_to: string | null;
  text: string;
  /** Source-specific extras, serialized to a JSON string. Attachments are listed by path, never copied. */
  meta: Record<string, unknown>;
}

export interface ExportContext {
  /** Rows older than this can be skipped by the reader (it is a prefilter; the writer applies the exact cut). */
  lowerBound: Date | null;
  /** Roots for the documents source. */
  roots: string[];
  /** Scratch dir on the output's disk; deleted after the run. */
  tmpDir: string;
  /** Record a non-fatal problem (shown in the source's summary line). */
  warn(msg: string): void;
}

export interface Source {
  name: string;
  /** false: macOS only, skipped elsewhere. */
  anyPlatform: boolean;
  read(ctx: ExportContext): AsyncIterable<Row>;
}

/** Thrown by a source that cannot run here (missing app, no permission). Never fatal. */
export class SkipSource extends Error {}
