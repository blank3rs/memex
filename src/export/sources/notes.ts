import * as zlib from "zlib";
import protobuf from "protobufjs";
import { Row, SkipSource, Source } from "../types.js";
import { columns, fromAppleSeconds, lib, num, openSqliteCopy, pick, str, toAppleSeconds } from "../util.js";

const STORE = lib("Group Containers", "group.com.apple.notes", "NoteStore.sqlite");

/**
 * Note body schema, the subset of threeplanetssoftware/apple_cloud_notes_parser's notestore.proto
 * we need: NoteStoreProto.document(2).note(3) -> note_text(2), attribute_run(5) with link(9) and
 * attachment_info(12). protobufjs skips every other field.
 */
const root = protobuf.Root.fromJSON({
  nested: {
    NoteStoreProto: { fields: { document: { type: "Document", id: 2 } } },
    Document: { fields: { version: { type: "int32", id: 2 }, note: { type: "Note", id: 3 } } },
    Note: { fields: { note_text: { type: "string", id: 2 }, attribute_run: { rule: "repeated", type: "AttributeRun", id: 5 } } },
    AttributeRun: {
      fields: { length: { type: "int32", id: 1 }, link: { type: "string", id: 9 }, attachment_info: { type: "AttachmentInfo", id: 12 } },
    },
    AttachmentInfo: { fields: { attachment_identifier: { type: "string", id: 1 }, type_uti: { type: "string", id: 2 } } },
  },
});
const NoteStoreProto = root.lookupType("NoteStoreProto");

interface Decoded {
  text: string;
  links: string[];
  attachments: { id: string; uti: string | null }[];
}

function decodeBody(data: Uint8Array): Decoded | null {
  const buf = Buffer.from(data);
  let raw: Buffer;
  try {
    raw = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : zlib.inflateSync(buf);
  } catch {
    return null;
  }
  const msg = NoteStoreProto.toObject(NoteStoreProto.decode(raw), { defaults: false }) as {
    document?: { note?: { note_text?: string; attribute_run?: { link?: string; attachment_info?: { attachment_identifier?: string; type_uti?: string } }[] } };
  };
  const note = msg.document?.note;
  if (!note) return null;
  const runs = note.attribute_run ?? [];
  return {
    text: (note.note_text ?? "").replace(/￼/g, "").trim(),
    links: [...new Set(runs.map((r) => r.link).filter((x): x is string => !!x))],
    attachments: runs
      .map((r) => r.attachment_info)
      .filter((a): a is { attachment_identifier: string; type_uti?: string } => !!a?.attachment_identifier)
      .map((a) => ({ id: a.attachment_identifier, uti: a.type_uti ?? null })),
  };
}

export const notes: Source = {
  name: "notes",
  anyPlatform: false,
  async *read(ctx) {
    const db = openSqliteCopy(STORE, ctx.tmpDir, "Apple Notes NoteStore.sqlite");
    try {
      const c = columns(db, "ZICCLOUDSYNCINGOBJECT");
      if (!c.size) throw new SkipSource("NoteStore.sqlite has no ZICCLOUDSYNCINGOBJECT table (unsupported Notes version)");
      const title = pick(c, "n", "ZTITLE1", "ZTITLE");
      const mod = pick(c, "n", "ZMODIFICATIONDATE1", "ZMODIFICATIONDATE");
      const cre = pick(c, "n", "ZCREATIONDATE3", "ZCREATIONDATE1", "ZCREATIONDATE");
      const folders = new Map<number, { id: string | null; title: string | null }>();
      if (c.has("ZTITLE2")) {
        for (const f of db.prepare("SELECT Z_PK pk, ZIDENTIFIER id, ZTITLE2 t FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE2 IS NOT NULL").iterate()) {
          folders.set(Number(f.pk), { id: str(f.id), title: str(f.t) });
        }
      }
      // Attachment identifier -> its file name (and media object id), when this schema has them.
      const attLookup =
        c.has("ZMEDIA") && c.has("ZFILENAME")
          ? db.prepare(
              `SELECT a.ZTYPEUTI uti, m.ZIDENTIFIER media, m.ZFILENAME fname
               FROM ZICCLOUDSYNCINGOBJECT a LEFT JOIN ZICCLOUDSYNCINGOBJECT m ON a.ZMEDIA = m.Z_PK
               WHERE a.ZIDENTIFIER = ?`
            )
          : null;
      const since = ctx.lowerBound ? toAppleSeconds(ctx.lowerBound) : -1e30;
      const q = db.prepare(
        `SELECT n.Z_PK pk, n.ZIDENTIFIER ident, ${title} title, CAST(${mod} AS REAL) mod, CAST(${cre} AS REAL) cre,
                ${pick(c, "n", "ZFOLDER")} folder, ${pick(c, "n", "ZISPASSWORDPROTECTED")} locked,
                ${pick(c, "n", "ZMARKEDFORDELETION")} deleted, d.ZDATA data
         FROM ZICNOTEDATA d JOIN ZICCLOUDSYNCINGOBJECT n ON d.ZNOTE = n.Z_PK
         WHERE d.ZDATA IS NOT NULL AND (CAST(${mod} AS REAL) >= ? OR ${mod} IS NULL)`
      );
      let locked = 0;
      for (const r of q.iterate(since)) {
        if (num(r.deleted) === 1) continue;
        if (num(r.locked) === 1) {
          locked++;
          continue;
        }
        const body = decodeBody(r.data as Uint8Array);
        if (!body) {
          ctx.warn(`note ${str(r.ident)}: body did not decode`);
          continue;
        }
        if (!body.text) continue;
        const folder = folders.get(num(r.folder) ?? -1);
        const attachments = body.attachments.map((a) => {
          const x = attLookup?.get(a.id) as { uti?: unknown; media?: unknown; fname?: unknown } | undefined;
          return { id: a.id, uti: a.uti ?? str(x?.uti), media_id: str(x?.media), filename: str(x?.fname) };
        });
        const row: Row = {
          id: str(r.ident) ?? `note:${r.pk}`,
          ts: fromAppleSeconds(r.mod) ?? fromAppleSeconds(r.cre),
          author: "me",
          is_me: true,
          thread_id: folder?.id ?? null,
          thread_name: folder?.title ?? null,
          reply_to: null,
          text: body.text,
          meta: {
            title: str(r.title),
            created: fromAppleSeconds(r.cre)?.toISOString(),
            links: body.links.length ? body.links : undefined,
            attachments: attachments.length ? attachments : undefined,
            media_root: attachments.length ? lib("Group Containers", "group.com.apple.notes", "Accounts") : undefined,
          },
        };
        yield row;
      }
      if (locked) ctx.warn(`${locked} password-protected notes skipped`);
    } finally {
      db.close();
    }
  },
};
