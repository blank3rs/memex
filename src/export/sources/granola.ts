import * as fs from "fs";
import * as path from "path";
import { Row, SkipSource, Source } from "../types.js";
import { exists, lib, sha1, str, validDate } from "../util.js";

const DIR = lib("Application Support", "Granola");

/** Plain text out of Granola's ProseMirror note JSON. */
function prosemirror(node: any): string {
  if (!node || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  const inner = (node.content ?? []).map(prosemirror).join(node.type === "doc" ? "\n" : "");
  return /paragraph|heading|listItem|bulletList|orderedList|blockquote/.test(node.type ?? "") ? `${inner}\n` : inner;
}

/**
 * Granola's local cache was plain JSON (cache-v3/v4/v5.json) until 2026, then became encrypted
 * (cache-v6.json.enc; no plaintext cache since app 7.290). Read a plaintext cache when present;
 * otherwise skip and say how to get the data (in-app CSV export or the paid API).
 */
export const granola: Source = {
  name: "granola",
  anyPlatform: false,
  async *read() {
    if (!exists(DIR)) throw new SkipSource("Granola is not installed");
    const files = fs.readdirSync(DIR);
    const plain = files.filter((f) => /^cache-v\d+\.json$/.test(f)).sort((a, b) => Number(/\d+/.exec(b)![0]) - Number(/\d+/.exec(a)![0]));
    if (!plain.length) {
      const enc = files.filter((f) => f.endsWith(".enc"));
      throw new SkipSource(
        enc.length
          ? `local cache is encrypted (${enc.join(", ")}); use Granola's CSV export or its API instead`
          : `no readable cache in ${DIR}`
      );
    }
    const file = path.join(DIR, plain[0]);
    const outer = JSON.parse(await fs.promises.readFile(file, "utf8"));
    const cache = typeof outer.cache === "string" ? JSON.parse(outer.cache) : outer.cache ?? outer;
    const state = cache.state ?? cache;
    const docs: Record<string, any> = state.documents ?? {};
    const transcripts: Record<string, any[]> = state.transcripts ?? {};

    for (const [id, d] of Object.entries(docs)) {
      if (!d || d.deleted_at) continue;
      const title = str(d.title);
      const notes = str(d.notes_markdown)?.trim() || str(d.notes_plain)?.trim() || prosemirror(d.notes).trim();
      const attendees = (d.people?.attendees ?? []).map((a: any) => a?.email ?? a?.name).filter(Boolean);
      if (notes) {
        yield {
          id: `note:${id}`,
          ts: validDate(d.updated_at) ?? validDate(d.created_at),
          author: "me",
          is_me: true,
          thread_id: id,
          thread_name: title,
          reply_to: null,
          text: notes,
          meta: { kind: "notes", created: d.created_at, attendees: attendees.length ? attendees : undefined, cache: file },
        } satisfies Row;
      }
      // Transcript segments: "microphone" is him, "system" is the other side of the call.
      for (const s of transcripts[id] ?? []) {
        const text = str(s?.text)?.trim();
        if (!text || s.is_final === false) continue;
        const mine = s.source === "microphone";
        yield {
          id: `seg:${s.id ?? sha1(id, s.start_timestamp, text)}`,
          ts: validDate(s.start_timestamp),
          author: mine ? "me" : s.speaker ?? "other",
          is_me: mine,
          thread_id: id,
          thread_name: title,
          reply_to: null,
          text,
          meta: { kind: "transcript", source: s.source, end: s.end_timestamp },
        } satisfies Row;
      }
    }
  },
};
