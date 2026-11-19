import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { Row, SkipSource, Source } from "../types.js";
import { columns, exists, fromAppleSeconds, lib, num, openSqliteCopy, pick, str, toAppleSeconds, walkFiles } from "../util.js";
import { HandleNames } from "./contacts.js";

const ROOTS = [
  lib("Group Containers", "group.net.whatsapp.WhatsApp.shared"),
  lib("Containers", "net.whatsapp.WhatsApp"),
  lib("Containers", "desktop.WhatsApp"),
];

/**
 * The message store has moved between WhatsApp builds, so search the containers for any SQLite
 * file holding ZWAMESSAGE and take the largest. Files SQLite cannot open are counted as encrypted.
 */
async function findStore(tmpDir: string): Promise<{ file: string; db: DatabaseSync } | { reason: string }> {
  const roots = ROOTS.filter(exists);
  if (!roots.length) return { reason: "WhatsApp is not installed (no container under ~/Library)" };
  let best: { file: string; size: number } | null = null;
  const unreadable: string[] = [];
  for (const root of roots) {
    for await (const { path: file, stat } of walkFiles(root, { exts: new Set([".sqlite", ".db", ".sqlite3"]) })) {
      try {
        const db = openSqliteCopy(file, tmpDir, "WhatsApp store");
        const ok = columns(db, "ZWAMESSAGE").size > 0;
        db.close();
        if (ok && (!best || stat.size > best.size)) best = { file, size: stat.size };
      } catch (e) {
        unreadable.push(`${path.basename(file)}: ${(e as Error).message}`);
      }
    }
  }
  if (best) return { file: best.file, db: openSqliteCopy(best.file, tmpDir, "WhatsApp store") };
  return {
    reason: unreadable.length
      ? `no readable message store; ${unreadable.length} DB file(s) could not be opened (likely encrypted): ${unreadable.slice(0, 3).join("; ")}`
      : `no ZWAMESSAGE store found under ${roots.join(", ")}`,
  };
}

export const whatsapp: Source = {
  name: "whatsapp",
  anyPlatform: false,
  async *read(ctx) {
    const found = await findStore(ctx.tmpDir);
    if ("reason" in found) throw new SkipSource(found.reason);
    const { db, file } = found;
    try {
      const names = HandleNames.load(ctx.tmpDir);
      const push = new Map<string, string>();
      try {
        for (const r of db.prepare("SELECT ZJID j, ZPUSHNAME n FROM ZWAPROFILEPUSHNAME").iterate()) {
          if (r.j && r.n) push.set(String(r.j), String(r.n));
        }
      } catch {
        /* older schema */
      }
      const m = columns(db, "ZWAMESSAGE");
      const g = columns(db, "ZWAGROUPMEMBER");
      const mi = columns(db, "ZWAMEDIAITEM");
      const joinG = g.size > 0 && m.has("ZGROUPMEMBER");
      const joinM = mi.size > 0 && m.has("ZMEDIAITEM");
      const since = ctx.lowerBound ? toAppleSeconds(ctx.lowerBound) : -1e30;
      const q = db.prepare(
        `SELECT m.Z_PK pk, ${pick(m, "m", "ZSTANZAID")} sid, m.ZTEXT text, CAST(m.ZMESSAGEDATE AS REAL) d,
                m.ZISFROMME me, ${pick(m, "m", "ZFROMJID")} fromjid, ${pick(m, "m", "ZMESSAGETYPE")} mtype,
                s.ZCONTACTJID chatjid, s.ZPARTNERNAME chatname,
                ${joinG ? pick(g, "gm", "ZMEMBERJID") : "NULL"} memberjid, ${joinG ? pick(g, "gm", "ZCONTACTNAME") : "NULL"} membername,
                ${joinM ? pick(mi, "mi", "ZMEDIALOCALPATH") : "NULL"} mpath, ${joinM ? pick(mi, "mi", "ZTITLE") : "NULL"} mtitle
         FROM ZWAMESSAGE m
         LEFT JOIN ZWACHATSESSION s ON m.ZCHATSESSION = s.Z_PK
         ${joinG ? "LEFT JOIN ZWAGROUPMEMBER gm ON m.ZGROUPMEMBER = gm.Z_PK" : ""}
         ${joinM ? "LEFT JOIN ZWAMEDIAITEM mi ON m.ZMEDIAITEM = mi.Z_PK" : ""}
         WHERE CAST(m.ZMESSAGEDATE AS REAL) >= ?`
      );
      const base = path.dirname(file);
      for (const r of q.iterate(since)) {
        const text = (str(r.text) ?? "").trim();
        const mpath = str(r.mpath);
        if (!text && !mpath) continue; // system events
        const isMe = num(r.me) === 1;
        const jid = str(r.memberjid) ?? str(r.fromjid);
        const chatjid = str(r.chatjid);
        const isGroup = !!chatjid?.endsWith("@g.us");
        const other = str(r.membername) ?? names.name(jid) ?? (jid ? push.get(jid) : undefined) ?? (isGroup ? null : str(r.chatname)) ?? jid;
        const row: Row = {
          id: str(r.sid) ?? `whatsapp:${r.pk}`,
          ts: fromAppleSeconds(r.d),
          author: isMe ? "me" : other,
          is_me: isMe,
          thread_id: chatjid,
          thread_name: str(r.chatname) ?? names.name(chatjid),
          reply_to: null,
          text,
          meta: {
            jid,
            type: num(r.mtype),
            attachments: mpath ? [{ path: path.resolve(base, "Message", mpath), title: str(r.mtitle) }] : undefined,
            store: file,
          },
        };
        yield row;
      }
    } finally {
      db.close();
    }
  },
};
