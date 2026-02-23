import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import chalk from "chalk";
import ora from "ora";
import { v4 as uuidv4 } from "uuid";
import { MemexEntry } from "../types.js";

const AB_SOURCES_DIR = path.join(
  os.homedir(), "Library", "Application Support", "AddressBook", "Sources"
);

interface RawContact {
  pk: number;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  jobTitle: string | null;
}
interface RawEmail { owner: number; address: string }
interface RawPhone { owner: number; number: string }

export function findAbcddb(): string | null {
  if (!fs.existsSync(AB_SOURCES_DIR)) return null;
  for (const source of fs.readdirSync(AB_SOURCES_DIR)) {
    const candidate = path.join(AB_SOURCES_DIR, source, "AddressBook-v22.abcddb");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Build a phone/email → contact name map for resolving message handles */
export async function buildContactMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const dbPath = findAbcddb();
  if (!dbPath) return map;

  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });

    const contacts = db.prepare(
      `SELECT Z_PK as pk, ZFIRSTNAME as firstName, ZLASTNAME as lastName, ZORGANIZATION as company
       FROM ZABCDRECORD WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL`
    ).all() as RawContact[];

    const emails = db.prepare(
      `SELECT ZOWNER as owner, ZADDRESS as address FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL`
    ).all() as RawEmail[];

    const phones = db.prepare(
      `SELECT ZOWNER as owner, ZFULLNUMBER as number FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL`
    ).all() as RawPhone[];

    db.close();

    const pkToName = new Map(
      contacts.map((c) => [
        c.pk,
        [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.company || "",
      ])
    );

    for (const e of emails) {
      const name = pkToName.get(e.owner);
      if (name) map.set(e.address.toLowerCase(), name);
    }
    for (const p of phones) {
      const name = pkToName.get(p.owner);
      if (name) {
        map.set(p.number.replace(/\D/g, ""), name); // digits only for fuzzy match
        map.set(p.number, name);
      }
    }
  } catch { /* return empty map */ }
  return map;
}

export async function scanContacts(): Promise<MemexEntry[]> {
  const spinner = ora("Scanning Contacts (direct DB read)...").start();

  const dbPath = findAbcddb();
  if (!dbPath) {
    spinner.fail(chalk.red("AddressBook not found — grant Full Disk Access in System Settings"));
    return [];
  }

  try {
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(dbPath, { readonly: true });

    const contacts = db.prepare(
      `SELECT Z_PK as pk, ZFIRSTNAME as firstName, ZLASTNAME as lastName,
              ZORGANIZATION as company, ZJOBTITLE as jobTitle
       FROM ZABCDRECORD
       WHERE ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL OR ZORGANIZATION IS NOT NULL`
    ).all() as RawContact[];

    const emailRows = db.prepare(
      `SELECT ZOWNER as owner, ZADDRESS as address FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL`
    ).all() as RawEmail[];

    const phoneRows = db.prepare(
      `SELECT ZOWNER as owner, ZFULLNUMBER as number FROM ZABCDPHONENUMBER WHERE ZFULLNUMBER IS NOT NULL`
    ).all() as RawPhone[];

    db.close();

    const emailsByPk = new Map<number, string[]>();
    for (const e of emailRows) {
      const list = emailsByPk.get(e.owner) ?? [];
      list.push(e.address);
      emailsByPk.set(e.owner, list);
    }
    const phonesByPk = new Map<number, string[]>();
    for (const p of phoneRows) {
      const list = phonesByPk.get(p.owner) ?? [];
      list.push(p.number);
      phonesByPk.set(p.owner, list);
    }

    spinner.succeed(`Found ${contacts.length} contacts`);
    const now = new Date().toISOString();

    return contacts.map((c) => {
      const name = [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.company || "Unknown";
      const emails = emailsByPk.get(c.pk) ?? [];
      const phones = phonesByPk.get(c.pk) ?? [];

      return {
        id: uuidv4(), timestamp: now, type: "fact" as const,
        content: [
          `Contact: ${name}`,
          c.company ? `Company: ${c.company}` : "",
          c.jobTitle ? `Role: ${c.jobTitle}` : "",
          emails.length ? `Email: ${emails.join(", ")}` : "",
          phones.length ? `Phone: ${phones[0]}` : "",
        ].filter(Boolean).join(" | "),
        tags: ["contact", "people"],
        metadata: { source: "addressbook-sqlite", name, emails, phones, company: c.company },
      };
    });
  } catch (err) {
    spinner.fail(chalk.red(`Contacts DB read failed: ${(err as Error).message}`));
    return [];
  }
}
