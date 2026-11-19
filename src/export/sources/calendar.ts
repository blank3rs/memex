import * as fs from "fs";
import * as path from "path";
import { Row, SkipSource, Source } from "../types.js";
import { columns, exists, fromAppleSeconds, lib, num, openSqliteCopy, pick, str, toAppleSeconds } from "../util.js";

const CAL_DB = lib("Group Containers", "group.com.apple.calendar", "Calendar.sqlitedb");
const LEGACY_CAL_DB = lib("Calendars", "Calendar.sqlitedb");

/** Events. ts is when the event was last written (so incremental runs catch new and edited events); start/end in meta. */
export const calendar: Source = {
  name: "calendar",
  anyPlatform: false,
  async *read(ctx) {
    const file = exists(CAL_DB) ? CAL_DB : LEGACY_CAL_DB;
    const db = openSqliteCopy(file, ctx.tmpDir, "Calendar.sqlitedb");
    try {
      const e = columns(db, "CalendarItem");
      if (!e.size) throw new SkipSource("Calendar.sqlitedb has no CalendarItem table");
      const p = columns(db, "Participant");
      const org = e.has("organizer_id") && p.has("email");
      const written = `COALESCE(${pick(e, "e", "last_modified")}, ${pick(e, "e", "creation_date")}, e.start_date)`;
      const since = ctx.lowerBound ? toAppleSeconds(ctx.lowerBound) : -1e30;
      const q = db.prepare(
        `SELECT e.ROWID rid, ${pick(e, "e", "unique_identifier", "UUID")} uid, e.summary, ${pick(e, "e", "description")} descr,
                CAST(e.start_date AS REAL) s, CAST(e.end_date AS REAL) en, ${pick(e, "e", "all_day")} allday,
                CAST(${written} AS REAL) w, CAST(${pick(e, "e", "creation_date")} AS REAL) cre,
                l.title loc, c.title cal, ${pick(e, "e", "url")} url,
                ${org ? "p.email" : "NULL"} org_email, ${org ? pick(p, "p", "is_self") : "NULL"} org_self
         FROM CalendarItem e
         LEFT JOIN Calendar c ON e.calendar_id = c.ROWID
         LEFT JOIN Location l ON e.location_id = l.ROWID
         ${org ? "LEFT JOIN Participant p ON e.organizer_id = p.ROWID" : ""}
         WHERE e.summary IS NOT NULL ${e.has("entity_type") ? "AND e.entity_type = 0" : ""}
           AND CAST(${written} AS REAL) >= ?`
      );
      for (const r of q.iterate(since)) {
        const orgEmail = str(r.org_email)?.replace(/^mailto:/i, "") ?? null;
        const mine = !orgEmail || num(r.org_self) === 1;
        const text = [str(r.summary), str(r.descr)].filter(Boolean).join("\n\n");
        const row: Row = {
          id: str(r.uid) ? `${str(r.uid)}:${r.rid}` : `cal:${r.rid}`,
          ts: fromAppleSeconds(r.w),
          author: mine ? "me" : orgEmail,
          is_me: mine,
          thread_id: str(r.cal),
          thread_name: str(r.cal),
          reply_to: null,
          text,
          meta: {
            start: fromAppleSeconds(r.s)?.toISOString(),
            end: fromAppleSeconds(r.en)?.toISOString(),
            all_day: num(r.allday) === 1 || undefined,
            location: str(r.loc),
            url: str(r.url),
            organizer: orgEmail,
            created: fromAppleSeconds(r.cre)?.toISOString(),
          },
        };
        yield row;
      }
    } finally {
      db.close();
    }
  },
};

const REM_STORES = lib("Group Containers", "group.com.apple.reminders", "Container_v1", "Stores");

export const reminders: Source = {
  name: "reminders",
  anyPlatform: false,
  async *read(ctx) {
    if (!exists(REM_STORES)) throw new SkipSource(`Reminders store not found: ${REM_STORES}`);
    let files: string[];
    try {
      files = fs.readdirSync(REM_STORES).filter((f) => /^Data-.*\.sqlite$/.test(f));
    } catch {
      throw new SkipSource(`permission denied: ${REM_STORES} (grant Full Disk Access)`);
    }
    for (const f of files) {
      const db = openSqliteCopy(path.join(REM_STORES, f), ctx.tmpDir, "Reminders store");
      try {
        const c = columns(db, "ZREMCDREMINDER");
        if (!c.size) continue;
        const l = columns(db, "ZREMCDBASELIST");
        const written = `COALESCE(${pick(c, "r", "ZLASTMODIFIEDDATE")}, ${pick(c, "r", "ZCREATIONDATE")})`;
        const since = ctx.lowerBound ? toAppleSeconds(ctx.lowerBound) : -1e30;
        const q = db.prepare(
          `SELECT r.Z_PK pk, ${pick(c, "r", "ZCKIDENTIFIER", "ZDACALENDARITEMUNIQUEIDENTIFIER")} uid, r.ZTITLE title,
                  ${pick(c, "r", "ZNOTES")} notes, ${pick(c, "r", "ZCOMPLETED")} done, CAST(${pick(c, "r", "ZCOMPLETIONDATE")} AS REAL) doneAt,
                  CAST(${pick(c, "r", "ZDUEDATE")} AS REAL) due, CAST(${pick(c, "r", "ZCREATIONDATE")} AS REAL) cre,
                  CAST(${written} AS REAL) w, ${pick(c, "r", "ZFLAGGED")} flagged, ${pick(c, "r", "ZPRIORITY")} prio,
                  ${pick(c, "r", "ZMARKEDFORDELETION")} del,
                  ${l.size && c.has("ZLIST") ? pick(l, "l", "ZNAME") : "NULL"} list,
                  ${l.size && c.has("ZLIST") ? pick(l, "l", "ZCKIDENTIFIER") : "NULL"} list_id
           FROM ZREMCDREMINDER r ${l.size && c.has("ZLIST") ? "LEFT JOIN ZREMCDBASELIST l ON r.ZLIST = l.Z_PK" : ""}
           WHERE r.ZTITLE IS NOT NULL AND (CAST(${written} AS REAL) >= ? OR ${written} IS NULL)`
        );
        for (const r of q.iterate(since)) {
          if (num(r.del) === 1) continue;
          const row: Row = {
            id: str(r.uid) ?? `${f}:${r.pk}`,
            ts: fromAppleSeconds(r.w),
            author: "me",
            is_me: true,
            thread_id: str(r.list_id) ?? str(r.list),
            thread_name: str(r.list),
            reply_to: null,
            text: [str(r.title), str(r.notes)].filter(Boolean).join("\n\n"),
            meta: {
              completed: num(r.done) === 1,
              completed_at: fromAppleSeconds(r.doneAt)?.toISOString(),
              due: fromAppleSeconds(r.due)?.toISOString(),
              created: fromAppleSeconds(r.cre)?.toISOString(),
              flagged: num(r.flagged) === 1 || undefined,
              priority: num(r.prio) || undefined,
              store: f,
            },
          };
          yield row;
        }
      } finally {
        db.close();
      }
    }
  },
};
