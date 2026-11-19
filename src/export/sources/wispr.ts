import { Row, SkipSource, Source } from "../types.js";
import { columns, lib, num, openSqliteCopy, sha1, str, validDate } from "../util.js";

const FLOW_DB = lib("Application Support", "Wispr Flow", "flow.sqlite");

/** Sequelize dates come as "2026-01-02 03:04:05.678 +00:00", ISO strings, or epoch s/ms numbers. */
function seqDate(v: unknown): Date | null {
  const n = num(v);
  if (n != null) return validDate(n < 1e11 ? n * 1000 : n);
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d(?:\.\d+)?)\s*(Z|[+-]\d\d:?\d\d)?$/.exec(s.trim());
  return m ? validDate(`${m[1]}T${m[2]}${m[3] ?? "Z"}`) : validDate(s);
}

const TS_COLS = ["timestamp", "createdAt", "created_at", "startTime", "start_time", "date", "updatedAt", "updated_at"];
const ID_COLS = ["id", "uuid", "transcriptEntityId", "messageId", "noteId", "meetingId"];
const THREAD_RE = /^(meeting|chat|thread|conversation|note|session)_?id$/i;
const TEXTY = /text|transcript|content|body|note|message|summary|title|correction|instruction|prompt|response|original|corrected/i;
const NOT_TEXT = /(^id$|id$|Id$|At$|_at$|time|date|lang|count|num|duration|status|type|url|app$|hash)/i;

/** Per table: which columns hold his polished text and the raw recognition, in preference order. */
const TABLES: Record<string, { polished: string[]; raw: string[] }> = {
  History: { polished: ["editedText", "formattedText", "finalText", "text"], raw: ["asrText", "rawText", "originalText", "transcript"] },
  Notes: { polished: ["content", "text", "body", "markdown"], raw: ["rawContent", "transcript"] },
  Meetings: { polished: ["summary", "notes", "title"], raw: ["transcript", "rawTranscript"] },
  NotetakerChatMessages: { polished: ["content", "text", "message"], raw: [] },
  InstructHistory: { polished: ["instruction", "prompt", "input", "text"], raw: ["asrText", "rawText"] },
  TranscriptCorrections: { polished: ["corrected", "correctedText", "after", "replacement"], raw: ["original", "originalText", "before"] },
};

const first = (r: Record<string, unknown>, cols: string[]) => {
  for (const c of cols) {
    const v = str(r[c])?.trim();
    if (v) return { col: c, v };
  }
  return null;
};

export const wispr: Source = {
  name: "wispr",
  anyPlatform: false,
  async *read(ctx) {
    const db = openSqliteCopy(FLOW_DB, ctx.tmpDir, "Wispr Flow flow.sqlite");
    try {
      let tables = 0;
      for (const [table, pref] of Object.entries(TABLES)) {
        const cols = columns(db, table);
        if (!cols.size) continue;
        tables++;
        const tsCol = TS_COLS.find((c) => cols.has(c));
        const idCol = ID_COLS.find((c) => cols.has(c));
        const threadCol = [...cols].find((c) => THREAD_RE.test(c) && c !== idCol);
        const roleCol = ["role", "sender", "author", "speaker", "from"].find((c) => cols.has(c));
        for (const r of db.prepare(`SELECT rowid AS _rowid, * FROM "${table}"`).iterate()) {
          const polished = first(r, pref.polished);
          const raw = first(r, pref.raw);
          let text = polished?.v ?? raw?.v ?? "";
          const used = new Set([polished?.col, raw?.col]);
          if (!text) {
            // Unknown schema: every text-like column, labelled.
            const parts = [...cols]
              .filter((c) => TEXTY.test(c) && !NOT_TEXT.test(c) && str(r[c])?.trim())
              .map((c) => (used.add(c), `${c}: ${str(r[c])!.trim()}`));
            text = parts.join("\n");
          }
          if (!text) continue;
          const meta: Record<string, unknown> = { table };
          if (raw && raw.v !== text) meta.raw_text = raw.v;
          if (polished && raw && raw.v === text) meta.polished_text = polished.v;
          for (const c of cols) {
            if (used.has(c) || c === "_rowid") continue;
            const v = r[c];
            if (v instanceof Uint8Array) continue;
            if (typeof v === "string" && v.length > 20000) continue;
            if (v != null && v !== "") meta[c] = typeof v === "bigint" ? Number(v) : v;
          }
          const role = roleCol ? str(r[roleCol]) : null;
          const isMe = !role || /^(user|me|human|self)$/i.test(role);
          const row: Row = {
            id: `${table}:${idCol ? str(r[idCol]) : sha1(r._rowid as number, text)}`,
            ts: tsCol ? seqDate(r[tsCol]) : null,
            author: isMe ? "me" : role,
            is_me: isMe,
            thread_id: threadCol ? str(r[threadCol]) : table === "History" ? str(r.app) : table,
            thread_name: table === "History" ? str(r.app) ?? str(r.url) : table,
            reply_to: null,
            text,
            meta,
          };
          yield row;
        }
      }
      if (!tables) throw new SkipSource(`flow.sqlite has none of the known tables (${Object.keys(TABLES).join(", ")})`);
    } finally {
      db.close();
    }
  },
};
