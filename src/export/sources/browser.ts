import * as fs from "fs";
import * as path from "path";
import { ExportContext, Row, SkipSource, Source } from "../types.js";
import { exists, fromAppleSeconds, lib, num, openSqliteCopy, str, toAppleSeconds, validDate } from "../util.js";

/** Chromium visit_time: microseconds since 1601-01-01. */
const CHROME_EPOCH_OFFSET_MS = 11644473600000;

const CHROMIUM: [string, string][] = [
  ["chrome", lib("Application Support", "Google", "Chrome")],
  ["chrome-beta", lib("Application Support", "Google", "Chrome Beta")],
  ["chromium", lib("Application Support", "Chromium")],
  ["brave", lib("Application Support", "BraveSoftware", "Brave-Browser")],
  ["edge", lib("Application Support", "Microsoft Edge")],
  ["arc", lib("Application Support", "Arc", "User Data")],
];
const FIREFOX: [string, string][] = [
  ["zen", lib("Application Support", "zen", "Profiles")],
  ["firefox", lib("Application Support", "Firefox", "Profiles")],
];
const SAFARI = lib("Safari", "History.db");

const host = (url: string | null) => {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
};

function visitRow(o: { browser: string; profile: string; id: string; ts: Date | null; url: string | null; title: string | null; from: string | null; extra?: Record<string, unknown> }): Row | null {
  if (!o.url) return null;
  return {
    id: o.id,
    ts: o.ts,
    author: "me",
    is_me: true,
    thread_id: host(o.url),
    thread_name: o.title || host(o.url),
    reply_to: o.from,
    text: o.title ? `${o.title}\n${o.url}` : o.url,
    meta: { browser: o.browser, profile: o.profile, url: o.url, ...o.extra },
  };
}

function* safari(ctx: ExportContext): Generator<Row> {
  const db = openSqliteCopy(SAFARI, ctx.tmpDir, "Safari History.db");
  try {
    const since = ctx.lowerBound ? toAppleSeconds(ctx.lowerBound) : -1e30;
    const q = db.prepare(
      `SELECT v.id, CAST(v.visit_time AS REAL) t, v.title, i.url, v.redirect_source src
       FROM history_visits v JOIN history_items i ON v.history_item = i.id WHERE v.visit_time >= ?`
    );
    for (const r of q.iterate(since)) {
      const row = visitRow({
        browser: "safari", profile: "default", id: `safari:${r.id}`, ts: fromAppleSeconds(r.t),
        url: str(r.url), title: str(r.title), from: r.src != null ? `safari:${r.src}` : null,
      });
      if (row) yield row;
    }
  } finally {
    db.close();
  }
}

function* chromium(ctx: ExportContext, browser: string, file: string, profile: string): Generator<Row> {
  const db = openSqliteCopy(file, ctx.tmpDir, `${browser} History`);
  try {
    const since = ctx.lowerBound ? (ctx.lowerBound.getTime() + CHROME_EPOCH_OFFSET_MS) * 1000 : -1e30;
    const q = db.prepare(
      `SELECT v.id, CAST(v.visit_time AS REAL) t, u.url, u.title, v.from_visit src, v.transition tr
       FROM visits v JOIN urls u ON v.url = u.id WHERE v.visit_time >= ?`
    );
    for (const r of q.iterate(since)) {
      const t = num(r.t);
      const row = visitRow({
        browser, profile, id: `${browser}:${profile}:${r.id}`,
        ts: t ? validDate(t / 1000 - CHROME_EPOCH_OFFSET_MS) : null,
        url: str(r.url), title: str(r.title),
        from: num(r.src) ? `${browser}:${profile}:${r.src}` : null,
        extra: { transition: num(r.tr) },
      });
      if (row) yield row;
    }
  } finally {
    db.close();
  }
}

function* firefox(ctx: ExportContext, browser: string, file: string, profile: string): Generator<Row> {
  const db = openSqliteCopy(file, ctx.tmpDir, `${browser} places.sqlite`);
  try {
    const since = ctx.lowerBound ? ctx.lowerBound.getTime() * 1000 : -1e30; // visit_date: unix microseconds
    const q = db.prepare(
      `SELECT v.id, CAST(v.visit_date AS REAL) t, p.url, p.title, v.from_visit src, v.visit_type vt
       FROM moz_historyvisits v JOIN moz_places p ON v.place_id = p.id WHERE v.visit_date >= ?`
    );
    for (const r of q.iterate(since)) {
      const t = num(r.t);
      const row = visitRow({
        browser, profile, id: `${browser}:${profile}:${r.id}`,
        ts: t ? validDate(t / 1000) : null,
        url: str(r.url), title: str(r.title),
        from: num(r.src) ? `${browser}:${profile}:${r.src}` : null,
        extra: { visit_type: num(r.vt) },
      });
      if (row) yield row;
    }
  } finally {
    db.close();
  }
}

function listDirs(p: string): string[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

export const browser: Source = {
  name: "browser",
  anyPlatform: false,
  async *read(ctx) {
    const jobs: { label: string; run: () => Generator<Row> }[] = [];
    if (exists(SAFARI)) jobs.push({ label: "safari", run: () => safari(ctx) });
    for (const [name, root] of CHROMIUM) {
      for (const prof of listDirs(root)) {
        const f = path.join(root, prof, "History");
        if ((prof === "Default" || prof.startsWith("Profile ")) && exists(f)) jobs.push({ label: `${name}/${prof}`, run: () => chromium(ctx, name, f, prof) });
      }
    }
    for (const [name, root] of FIREFOX) {
      for (const prof of listDirs(root)) {
        const f = path.join(root, prof, "places.sqlite");
        if (exists(f)) jobs.push({ label: `${name}/${prof}`, run: () => firefox(ctx, name, f, prof) });
      }
    }
    if (!jobs.length) throw new SkipSource("no Safari, Chromium-family or Firefox-family history found");
    let ok = 0;
    for (const j of jobs) {
      try {
        yield* j.run();
        ok++;
      } catch (e) {
        ctx.warn(`${j.label}: ${(e as Error).message}`);
      }
    }
    if (!ok) throw new SkipSource(`no browser history readable (grant Full Disk Access for Safari)`);
  },
};
