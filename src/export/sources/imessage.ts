import { Row, Source } from "../types.js";
import { columns, fromAppleNsOrSeconds, lib, num, openSqliteCopy, pick, str, toAppleSeconds } from "../util.js";
import { decodeAttributedBody } from "../typedstream.js";
import { HandleNames } from "./contacts.js";

const CHAT_DB = lib("Messages", "chat.db");

export const imessage: Source = {
  name: "imessage",
  anyPlatform: false,
  async *read(ctx) {
    const db = openSqliteCopy(CHAT_DB, ctx.tmpDir, "iMessage chat.db");
    try {
      const names = HandleNames.load(ctx.tmpDir);
      const m = columns(db, "message");
      // date is ns since 2001 on modern macOS; compare as REAL to stay inside JS number range.
      const since = ctx.lowerBound ? toAppleSeconds(ctx.lowerBound) * 1e9 : -1e30;
      const attachments = db.prepare(
        `SELECT a.filename, a.mime_type, a.transfer_name, a.total_bytes
         FROM message_attachment_join j JOIN attachment a ON a.ROWID = j.attachment_id WHERE j.message_id = ?`
      );
      const q = db.prepare(
        `SELECT m.ROWID rowid, m.guid, m.text, m.attributedBody body, CAST(m.date AS REAL) date,
                CAST(${pick(m, "m", "date_edited")} AS REAL) edited, m.is_from_me me, m.service,
                ${pick(m, "m", "thread_originator_guid")} reply, ${pick(m, "m", "associated_message_type")} amt,
                ${pick(m, "m", "cache_has_attachments")} has_att, ${pick(m, "m", "is_audio_message")} audio,
                h.id handle, c.guid chat_guid, c.chat_identifier chat_ident, c.display_name chat_name
         FROM message m
         LEFT JOIN handle h ON m.handle_id = h.ROWID
         LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         LEFT JOIN chat c ON c.ROWID = cmj.chat_id
         WHERE CAST(m.date AS REAL) >= ?`
      );
      for (const r of q.iterate(since)) {
        const amt = num(r.amt) ?? 0;
        if (amt >= 2000 && amt < 4000) continue; // tapback reactions: generated text, not his words
        let text = str(r.text);
        if (!text) text = decodeAttributedBody(r.body as Uint8Array | null);
        text = (text ?? "").replace(/￼/g, "").trim();
        const atts = num(r.has_att)
          ? attachments.all(r.rowid as number).map((a) => ({
              path: str(a.filename)?.replace(/^~/, process.env.HOME ?? "~"),
              mime: str(a.mime_type),
              name: str(a.transfer_name),
              bytes: num(a.total_bytes),
            }))
          : [];
        if (!text && !atts.length) continue;
        const isMe = num(r.me) === 1;
        const handle = str(r.handle);
        const chatIdent = str(r.chat_ident);
        const row: Row = {
          id: str(r.guid) ?? `imessage:${r.rowid}`,
          ts: fromAppleNsOrSeconds(r.date),
          author: isMe ? "me" : names.name(handle) ?? handle,
          is_me: isMe,
          thread_id: str(r.chat_guid),
          thread_name: str(r.chat_name) || names.name(chatIdent) || chatIdent,
          reply_to: str(r.reply),
          text,
          meta: {
            service: str(r.service),
            handle,
            chat_identifier: chatIdent,
            attachments: atts.length ? atts : undefined,
            audio: num(r.audio) ? true : undefined,
            edited: fromAppleNsOrSeconds(r.edited)?.toISOString(),
          },
        };
        yield row;
      }
    } finally {
      db.close();
    }
  },
};
