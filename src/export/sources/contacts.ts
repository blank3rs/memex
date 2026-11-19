import * as fs from "fs";
import * as path from "path";
import { DatabaseSync } from "node:sqlite";
import { Row, SkipSource, Source } from "../types.js";
import { columns, exists, fromAppleSeconds, lib, openSqliteCopy, pick, str } from "../util.js";

const AB = lib("Application Support", "AddressBook");

/** Every AddressBook DB: the local one plus each account under Sources/ (iCloud, Google, ...). */
export function addressBooks(): string[] {
  const out: string[] = [];
  const root = path.join(AB, "AddressBook-v22.abcddb");
  if (exists(root)) out.push(root);
  try {
    for (const s of fs.readdirSync(path.join(AB, "Sources"))) {
      const p = path.join(AB, "Sources", s, "AddressBook-v22.abcddb");
      if (exists(p)) out.push(p);
    }
  } catch {
    /* no Sources dir */
  }
  return out;
}

export interface Contact {
  pk: number;
  uid: string;
  name: string;
  org: string | null;
  title: string | null;
  emails: string[];
  phones: string[];
  urls: string[];
  note: string | null;
  birthday: Date | null;
  created: Date | null;
  modified: Date | null;
  book: string;
}

function group<T>(db: DatabaseSync, sql: string, key: string, val: string): Map<number, T[]> {
  const m = new Map<number, T[]>();
  try {
    for (const r of db.prepare(sql).iterate()) {
      const k = Number(r[key]);
      const v = r[val] as T;
      if (v == null) continue;
      (m.get(k) ?? m.set(k, []).get(k)!).push(v);
    }
  } catch {
    /* table absent in this book */
  }
  return m;
}

export function readContacts(file: string, tmpDir: string): Contact[] {
  const db = openSqliteCopy(file, tmpDir, "AddressBook");
  try {
    const c = columns(db, "ZABCDRECORD");
    if (!c.size) return [];
    const emails = group<string>(db, "SELECT ZOWNER o, ZADDRESS v FROM ZABCDEMAILADDRESS", "o", "v");
    const phones = group<string>(db, "SELECT ZOWNER o, ZFULLNUMBER v FROM ZABCDPHONENUMBER", "o", "v");
    const urls = group<string>(db, "SELECT ZOWNER o, ZURL v FROM ZABCDURLADDRESS", "o", "v");
    const notes = group<string>(db, "SELECT ZCONTACT o, ZTEXT v FROM ZABCDNOTE", "o", "v");
    const rows = db
      .prepare(
        `SELECT r.Z_PK pk, ${pick(c, "r", "ZUNIQUEID")} uid, r.ZFIRSTNAME first, r.ZLASTNAME last,
                ${pick(c, "r", "ZNICKNAME")} nick, ${pick(c, "r", "ZORGANIZATION")} org, ${pick(c, "r", "ZJOBTITLE")} title,
                CAST(${pick(c, "r", "ZBIRTHDAY")} AS REAL) bday, CAST(${pick(c, "r", "ZCREATIONDATE")} AS REAL) cre,
                CAST(${pick(c, "r", "ZMODIFICATIONDATE")} AS REAL) mod
         FROM ZABCDRECORD r
         WHERE r.ZFIRSTNAME IS NOT NULL OR r.ZLASTNAME IS NOT NULL OR ${pick(c, "r", "ZORGANIZATION")} IS NOT NULL`
      )
      .all();
    return rows.map((r) => {
      const pk = Number(r.pk);
      const name = [str(r.first), str(r.last)].filter(Boolean).join(" ").trim() || str(r.nick) || str(r.org) || "";
      return {
        pk,
        uid: str(r.uid) ?? `${path.basename(path.dirname(file))}:${pk}`,
        name,
        org: str(r.org),
        title: str(r.title),
        emails: emails.get(pk) ?? [],
        phones: phones.get(pk) ?? [],
        urls: urls.get(pk) ?? [],
        note: (notes.get(pk) ?? [])[0] ?? null,
        birthday: fromAppleSeconds(r.bday),
        created: fromAppleSeconds(r.cre),
        modified: fromAppleSeconds(r.mod),
        book: file,
      };
    });
  } finally {
    db.close();
  }
}

const digits = (s: string) => s.replace(/\D/g, "").slice(-10);

/** Resolves an iMessage/WhatsApp handle (email, phone, or JID) to a contact name. */
export class HandleNames {
  private byKey = new Map<string, string>();
  constructor(contacts: Contact[]) {
    for (const c of contacts) {
      if (!c.name) continue;
      for (const e of c.emails) this.byKey.set(e.toLowerCase(), c.name);
      for (const p of c.phones) if (digits(p).length >= 7) this.byKey.set(digits(p), c.name);
    }
  }
  static load(tmpDir: string): HandleNames {
    const all: Contact[] = [];
    for (const f of addressBooks()) {
      try {
        all.push(...readContacts(f, tmpDir));
      } catch {
        /* unreadable book: names stay as raw handles */
      }
    }
    return new HandleNames(all);
  }
  name(handle: string | null | undefined): string | null {
    if (!handle) return null;
    const h = handle.split("@s.whatsapp.net")[0];
    return this.byKey.get(h.toLowerCase()) ?? (digits(h).length >= 7 ? this.byKey.get(digits(h)) : undefined) ?? null;
  }
}

export const contacts: Source = {
  name: "contacts",
  anyPlatform: false,
  async *read(ctx) {
    const books = addressBooks();
    if (!books.length) throw new SkipSource(`no AddressBook found under ${AB} (grant Full Disk Access)`);
    for (const book of books) {
      let list: Contact[];
      try {
        list = readContacts(book, ctx.tmpDir);
      } catch (e) {
        if (books.length === 1) throw e;
        ctx.warn(`${book}: ${(e as Error).message}`);
        continue;
      }
      for (const c of list) {
        const lines = [
          c.name,
          [c.title, c.org].filter(Boolean).join(", "),
          ...c.emails.map((e) => `email: ${e}`),
          ...c.phones.map((p) => `phone: ${p}`),
          ...c.urls.map((u) => `url: ${u}`),
          c.birthday ? `birthday: ${c.birthday.toISOString().slice(0, 10)}` : "",
          c.note ? `note: ${c.note}` : "",
        ].filter(Boolean);
        const row: Row = {
          id: c.uid,
          ts: c.modified ?? c.created,
          author: c.name || null,
          is_me: false,
          thread_id: "contacts",
          thread_name: path.basename(path.dirname(book)),
          reply_to: null,
          text: lines.join("\n"),
          meta: { name: c.name, org: c.org, title: c.title, emails: c.emails, phones: c.phones, urls: c.urls, created: c.created?.toISOString(), book },
        };
        yield row;
      }
    }
  },
};
