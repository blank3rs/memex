import * as fs from "fs";
import * as path from "path";
import { DuckDBAppender, DuckDBConnection, DuckDBInstance, DuckDBTimestampTZValue } from "@duckdb/node-api";
import { redactRow } from "./redact.js";
import { Row } from "./types.js";
import { Watermark } from "./state.js";

const COLUMNS =
  "source VARCHAR, id VARCHAR, ts TIMESTAMPTZ, author VARCHAR, is_me BOOLEAN, thread_id VARCHAR, " +
  "thread_name VARCHAR, reply_to VARCHAR, text VARCHAR, meta VARCHAR";

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface PartResult {
  rows: number;
  bytes: number;
  minTs: string | null;
  maxTs: string | null;
  file: string | null;
  redactedRows: number;
}

/**
 * Rows stream into a disk-backed DuckDB staging table (spills past the memory cap), then one
 * COPY writes the new rows as a ZSTD Parquet part with ~128MB row groups.
 */
export class ParquetWriter {
  private constructor(private readonly inst: DuckDBInstance, private readonly conn: DuckDBConnection) {}

  static async open(tmpDir: string): Promise<ParquetWriter> {
    const inst = await DuckDBInstance.create(path.join(tmpDir, "staging.duckdb"), {
      memory_limit: "2GB",
      threads: "4",
      preserve_insertion_order: "false", // lets ROW_GROUP_SIZE_BYTES take effect
      temp_directory: path.join(tmpDir, "spill"),
    });
    return new ParquetWriter(inst, await inst.connect());
  }

  async begin(source: string): Promise<SourceSink> {
    const table = `staging_${source.replace(/\W/g, "_")}`;
    await this.conn.run(`CREATE OR REPLACE TABLE ${table} (${COLUMNS})`);
    return new SourceSink(this.conn, source, table, await this.conn.createAppender(table));
  }

  close(): void {
    this.conn.closeSync();
    this.inst.closeSync();
  }
}

export class SourceSink {
  appended = 0;
  redactedRows = 0;

  constructor(
    private readonly conn: DuckDBConnection,
    private readonly source: string,
    private readonly table: string,
    private appender: DuckDBAppender | null
  ) {}

  append(input: Row): void {
    const r = redactRow(input);
    if (!r) {
      this.redactedRows++;
      return;
    }
    const a = this.appender!;
    const vc = (v: string | null) => (v == null ? a.appendNull() : a.appendVarchar(v));
    a.appendVarchar(this.source);
    a.appendVarchar(r.id);
    const ms = r.ts?.getTime();
    if (ms == null || !Number.isFinite(ms)) a.appendNull();
    else a.appendTimestampTZ(new DuckDBTimestampTZValue(BigInt(Math.trunc(ms)) * 1000n));
    vc(r.author);
    a.appendBoolean(!!r.is_me);
    vc(r.thread_id);
    vc(r.thread_name);
    vc(r.reply_to);
    a.appendVarchar(r.text ?? "");
    a.appendVarchar(JSON.stringify(r.meta ?? {}));
    a.endRow();
    this.appended++;
  }

  private closeAppender(): void {
    if (!this.appender) return;
    this.appender.flushSync();
    this.appender.closeSync();
    this.appender = null;
  }

  async abort(): Promise<void> {
    try {
      this.closeAppender();
    } catch {
      /* already broken */
    }
    await this.conn.run(`DROP TABLE IF EXISTS ${this.table}`);
  }

  /**
   * Write rows newer than the watermark (and >= since) as `<out>/<source>/part-<runId>.parquet`.
   * Rows at exactly the watermark time, or with no time, are kept only if their id is not already
   * in an earlier part. Within a run, one row per id (the latest).
   */
  async finish(o: { outDir: string; runId: string; since: Date | null; watermark: Watermark | null; full: boolean }): Promise<PartResult> {
    this.closeAppender();
    const dir = path.join(o.outDir, this.source);
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = path.join(dir, `part-${o.runId}.parquet`);
    const tmpPath = finalPath + ".tmp";
    const existing = fs
      .readdirSync(dir)
      .filter((f) => /^part-.*\.parquet$/.test(f))
      .map((f) => path.join(dir, f))
      .filter((f) => f !== finalPath);
    const prevList = `[${existing.map(q).join(", ")}]`;

    const conds: string[] = [];
    if (o.since) conds.push(`epoch_ms(ts) >= ${o.since.getTime()}`);
    if (!o.full && existing.length) {
      let M = o.watermark?.maxTs ? Date.parse(o.watermark.maxTs) : NaN;
      if (!Number.isFinite(M)) {
        // State lost but parts exist: recover the watermark from the parts themselves.
        const r = await this.conn.runAndReadAll(`SELECT max(epoch_ms(ts))::BIGINT FROM read_parquet(${prevList})`);
        const v = r.getRows()[0]?.[0];
        M = v == null ? NaN : Number(v);
      }
      const notSeen = (cond: string) => `id NOT IN (SELECT id FROM read_parquet(${prevList}) WHERE ${cond})`;
      conds.push(
        Number.isFinite(M)
          ? `(epoch_ms(ts) > ${M} OR ((epoch_ms(ts) = ${M} OR ts IS NULL) AND ${notSeen(`epoch_ms(ts) = ${M} OR ts IS NULL`)}))`
          : `(ts IS NOT NULL OR ${notSeen("ts IS NULL")})`
      );
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

    await this.conn.run(
      `COPY (SELECT * FROM ${this.table} ${where}
             QUALIFY row_number() OVER (PARTITION BY id ORDER BY ts DESC NULLS LAST) = 1)
       TO ${q(tmpPath)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 1000000, ROW_GROUP_SIZE_BYTES '128MB')`
    );
    await this.conn.run(`DROP TABLE IF EXISTS ${this.table}`);

    const stats = await this.conn.runAndReadAll(
      `SELECT count(*)::BIGINT, min(epoch_ms(ts))::BIGINT, max(epoch_ms(ts))::BIGINT FROM read_parquet(${q(tmpPath)})`
    );
    const [n, lo, hi] = stats.getRows()[0] ?? [0n, null, null];
    const rows = Number(n ?? 0);
    const iso = (v: unknown) => (v == null ? null : new Date(Number(v)).toISOString());
    if (rows === 0) {
      fs.rmSync(tmpPath, { force: true });
      return { rows: 0, bytes: 0, minTs: null, maxTs: null, file: null, redactedRows: this.redactedRows };
    }
    fs.renameSync(tmpPath, finalPath);
    if (o.full) for (const f of existing) fs.rmSync(f, { force: true });
    return {
      rows,
      bytes: fs.statSync(finalPath).size,
      minTs: iso(lo),
      maxTs: iso(hi),
      file: finalPath,
      redactedRows: this.redactedRows,
    };
  }
}
