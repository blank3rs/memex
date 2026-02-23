import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";
import ora from "ora";
import { v4 as uuidv4 } from "uuid";
import { buildContactMap } from "./contacts.js";
import { MemexEntry } from "../types.js";

const CHAT_DB = path.join(os.homedir(), "Library", "Messages", "chat.db");

// Apple epoch offset in milliseconds (Jan 1 2001 → Unix)
const APPLE_EPOCH_MS = 978307200000;

interface RawMessage {
  text: string | null;
  date: number;
  is_from_me: number;
  handle_id: string | null;
}

function normalizeHandle(handle: string): string {
  // strip country code prefix for matching, e.g. +1 (555) 123-4567 → 5551234567
  const digits = handle.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function resolveHandle(
  handle: string | null,
  contactMap: Map<string, string>
): string {
  if (!handle) return "Unknown";

  // Try exact match (email handles)
  const byEmail = contactMap.get(handle.toLowerCase());
  if (byEmail) return byEmail;

  // Try digits-only match (phone handles)
  const normalized = normalizeHandle(handle);
  const byPhone = contactMap.get(normalized);
  if (byPhone) return byPhone;

  // Try last 10 digits against all map keys
  for (const [key, name] of contactMap) {
    if (key.replace(/\D/g, "").slice(-10) === normalized) return name;
  }

  return handle; // fall back to raw handle
}

export async function scanMessages(limit = 5000): Promise<MemexEntry[]> {
  const spinner = ora("Scanning iMessages...").start();

  if (!fs.existsSync(CHAT_DB)) {
    spinner.fail(
      chalk.red("iMessage DB not accessible — grant Full Disk Access in System Settings > Privacy & Security")
    );
    return [];
  }

  try {
    const { default: Database } = await import("better-sqlite3");

    // Build contact name map in parallel with opening the DB
    const [contactMap] = await Promise.all([buildContactMap()]);

    const db = new Database(CHAT_DB, { readonly: true });

    const query = isFinite(limit)
      ? `SELECT m.text, m.date, m.is_from_me, h.id AS handle_id
         FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID
         WHERE m.text IS NOT NULL AND m.text != ''
         ORDER BY m.date DESC LIMIT ?`
      : `SELECT m.text, m.date, m.is_from_me, h.id AS handle_id
         FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID
         WHERE m.text IS NOT NULL AND m.text != ''
         ORDER BY m.date DESC`;

    const rows = isFinite(limit)
      ? (db.prepare(query).all(limit) as RawMessage[])
      : (db.prepare(query).all() as RawMessage[]);

    db.close();

    spinner.succeed(`Found ${rows.length.toLocaleString()} messages — resolving contact names...`);

    return rows.map((row) => {
      const dateMs = Math.round(Number(row.date) / 1_000_000) + APPLE_EPOCH_MS;
      const contactName = resolveHandle(row.handle_id, contactMap);
      const direction = row.is_from_me ? `to ${contactName}` : `from ${contactName}`;

      return {
        id: uuidv4(),
        timestamp: new Date(dateMs).toISOString(),
        type: "event" as const,
        content: `iMessage ${direction}: ${row.text}`,
        tags: ["message", "imessage", row.is_from_me ? "sent" : "received"],
        metadata: {
          source: "imessage",
          handle: row.handle_id,
          contactName,
          is_from_me: !!row.is_from_me,
        },
      };
    });
  } catch (err) {
    spinner.fail(chalk.red(`iMessage read failed: ${(err as Error).message}`));
    return [];
  }
}
