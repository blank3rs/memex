import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";
import ora from "ora";
import { v4 as uuidv4 } from "uuid";
import { MemexEntry } from "../types.js";

// macOS Calendar SQLite database (Sequoia+)
const CALENDAR_CACHE = path.join(
  os.homedir(), "Library", "Group Containers", "group.com.apple.calendar", "Calendar.sqlitedb"
);

// Apple epoch: seconds since Jan 1, 2001
const APPLE_EPOCH_OFFSET_S = 978307200;

interface RawEvent {
  summary: string | null;
  startDate: number | null;
  endDate: number | null;
  calendarTitle: string | null;
  location: string | null;
}

function appleSecondsToDate(secs: number): Date {
  return new Date((secs + APPLE_EPOCH_OFFSET_S) * 1000);
}

export async function scanCalendar(): Promise<MemexEntry[]> {
  const spinner = ora("Scanning Calendar (direct DB read)...").start();

  if (!fs.existsSync(CALENDAR_CACHE)) {
    spinner.fail(chalk.red("Calendar cache not found — grant Full Disk Access in System Settings"));
    return [];
  }

  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(CALENDAR_CACHE, { readonly: true });

    const nowSecs = Date.now() / 1000 - APPLE_EPOCH_OFFSET_S;
    const thirtyDaysAgo = nowSecs - 30 * 86400;
    const ninetyDaysAhead = nowSecs + 90 * 86400;

    let rows: RawEvent[] = [];
    rows = db.prepare(`
      SELECT
        e.summary      as summary,
        e.start_date   as startDate,
        e.end_date     as endDate,
        l.title        as location,
        c.title        as calendarTitle
      FROM CalendarItem e
      LEFT JOIN Calendar c ON e.calendar_id = c.ROWID
      LEFT JOIN Location l ON e.location_id = l.ROWID
      WHERE e.start_date >= ? AND e.start_date <= ?
        AND e.summary IS NOT NULL
        AND e.entity_type = 0
      ORDER BY e.start_date ASC
    `).all(thirtyDaysAgo, ninetyDaysAhead) as RawEvent[];

    db.close();
    spinner.succeed(`Found ${rows.length} calendar events`);

    const now = new Date().toISOString();
    return rows.map((row) => {
      const start = row.startDate ? appleSecondsToDate(row.startDate) : null;
      const startStr = start
        ? start.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" })
        : "Unknown date";

      return {
        id: uuidv4(), timestamp: now, type: "event" as const,
        content: [
          `Calendar: "${row.summary?.trim()}"`,
          `Date: ${startStr}`,
          row.calendarTitle ? `Calendar: ${row.calendarTitle}` : "",
          row.location ? `Location: ${row.location}` : "",
        ].filter(Boolean).join(" | "),
        tags: ["calendar", "event"],
        metadata: {
          source: "calendar-sqlite",
          title: row.summary?.trim(),
          startDate: start?.toISOString(),
          calendar: row.calendarTitle,
          location: row.location,
        },
      };
    });
  } catch (err) {
    spinner.fail(chalk.red(`Calendar DB read failed: ${(err as Error).message}`));
    return [];
  }
}
