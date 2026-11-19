import { Row } from "./types.js";

/** Common credential shapes. A line matching any of these is dropped. */
const SECRET = new RegExp(
  [
    String.raw`(?<![A-Za-z0-9])sk-(?:proj-|ant-|live-)?[A-Za-z0-9_\-]{20,}`,
    String.raw`(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{16,}`,
    String.raw`(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}`,
    String.raw`github_pat_[A-Za-z0-9_]{30,}`,
    String.raw`(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Z0-9])`,
    String.raw`xox[abposr]-[A-Za-z0-9\-]{10,}`,
    String.raw`AIza[0-9A-Za-z_\-]{35}`,
    String.raw`(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}`,
    String.raw`glpat-[A-Za-z0-9_\-]{20,}`,
    String.raw`-----BEGIN [A-Z0-9 ]*-----`,
  ].join("|")
);
const BEGIN = /-----BEGIN [A-Z0-9 ]*-----/;
const END = /-----END [A-Z0-9 ]*-----/;

/** Drop every line that carries a secret; a BEGIN...END block is dropped whole. Also strips NULs. */
export function redactText(s: string): { text: string; dropped: number } {
  if (!s) return { text: s, dropped: 0 };
  s = s.replace(/\u0000/g, "");
  if (!SECRET.test(s)) return { text: s, dropped: 0 };
  const out: string[] = [];
  let dropped = 0;
  let inBlock = false;
  for (const line of s.split("\n")) {
    if (inBlock) {
      dropped++;
      if (END.test(line)) inBlock = false;
      continue;
    }
    if (BEGIN.test(line) && !END.test(line)) {
      inBlock = true;
      dropped++;
      continue;
    }
    if (SECRET.test(line)) {
      dropped++;
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n"), dropped };
}

function redactValue(v: unknown, count: { n: number }): unknown {
  if (typeof v === "string") {
    const r = redactText(v);
    count.n += r.dropped;
    return r.text;
  }
  if (Array.isArray(v)) return v.map((x) => redactValue(x, count));
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = redactValue(x, count);
    return o;
  }
  return v;
}

/**
 * The one redaction pass every row goes through before it is written.
 * Returns null when the row must be dropped (its text was all secret, or a key field holds one).
 */
export function redactRow(row: Row): Row | null {
  for (const f of [row.id, row.author, row.thread_id, row.thread_name, row.reply_to]) {
    if (f && SECRET.test(f)) return null;
  }
  const t = redactText(row.text ?? "");
  if (row.text && row.text.trim() && !t.text.trim()) return null;
  const count = { n: t.dropped };
  const meta = redactValue(row.meta ?? {}, count) as Record<string, unknown>;
  if (count.n) meta.redacted_lines = count.n;
  return { ...row, text: t.text, meta };
}
