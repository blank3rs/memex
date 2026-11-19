import * as path from "path";
import { Row, SkipSource, Source } from "../types.js";
import { columns, exists, fromAppleSeconds, lib, num, openSqliteCopy, sha1, str, walkFiles } from "../util.js";

const DIRS = [
  lib("Group Containers", "group.com.apple.VoiceMemos.shared", "Recordings"),
  lib("Application Support", "com.apple.voicememos", "Recordings"),
];
const AUDIO = new Set([".m4a", ".qta", ".caf", ".wav"]);

/** One row per recording, empty text; the audio path is in meta for a later transcription stage. */
export const voicememos: Source = {
  name: "voicememos",
  anyPlatform: false,
  async *read(ctx) {
    const dirs = DIRS.filter(exists);
    if (!dirs.length) throw new SkipSource("no Voice Memos recordings folder");
    for (const dir of dirs) {
      // CloudRecordings.db holds titles, dates and durations, keyed by file name.
      const info = new Map<string, Record<string, unknown>>();
      const dbFile = path.join(dir, "CloudRecordings.db");
      if (exists(dbFile)) {
        try {
          const db = openSqliteCopy(dbFile, ctx.tmpDir, "Voice Memos CloudRecordings.db");
          const c = columns(db, "ZCLOUDRECORDING");
          if (c.size) {
            const sel = ["ZPATH", "ZUNIQUEID", "ZCUSTOMLABEL", "ZENCRYPTEDTITLE", "ZDATE", "ZDURATION"].map((x) => (c.has(x) ? x : `NULL AS ${x}`)).join(", ");
            for (const r of db.prepare(`SELECT ${sel} FROM ZCLOUDRECORDING`).iterate()) {
              const p = str(r.ZPATH);
              if (p) info.set(path.basename(p), r);
            }
          }
          db.close();
        } catch (e) {
          ctx.warn(`CloudRecordings.db: ${(e as Error).message}`);
        }
      }
      for await (const { path: file, stat } of walkFiles(dir, { exts: AUDIO })) {
        const r = info.get(path.basename(file));
        const title = str(r?.ZCUSTOMLABEL) ?? str(r?.ZENCRYPTEDTITLE);
        const row: Row = {
          id: str(r?.ZUNIQUEID) ?? sha1("voicememo", file),
          ts: fromAppleSeconds(r?.ZDATE) ?? stat.birthtime,
          author: "me",
          is_me: true,
          thread_id: "voicememos",
          thread_name: title,
          reply_to: null,
          text: "",
          meta: { path: file, title, duration_s: num(r?.ZDURATION), bytes: stat.size, needs_transcription: true },
        };
        yield row;
      }
    }
  },
};
