import * as fs from "fs";
import * as path from "path";
import { simpleParser, AddressObject } from "mailparser";
import { Row, SkipSource, Source } from "../types.js";
import { lib, myEmails, requireReadable, sha1, walkFiles } from "../util.js";

const MAIL = lib("Mail");
const EMLX = new Set([".emlx"]);

/** Mail.app keeps one store per format version: ~/Library/Mail/V10, V11, ... */
function stores(): string[] {
  requireReadable(MAIL, "Mail");
  return fs
    .readdirSync(MAIL)
    .filter((d) => /^V\d+$/.test(d))
    .map((d) => path.join(MAIL, d));
}

const isSentBox = (p: string) => p.split(path.sep).some((s) => /^(sent( messages| mail| items)?|gesendet|envoy[ée]s)\.mbox$/i.test(s));

/** .emlx = "<byte count>\n" + RFC 822 message + Apple plist trailer. */
function rfc822(buf: Buffer): Buffer {
  const nl = buf.indexOf(0x0a);
  const n = Number(buf.subarray(0, nl).toString("ascii").trim());
  return Number.isFinite(n) && n > 0 ? buf.subarray(nl + 1, nl + 1 + n) : buf.subarray(nl + 1);
}

const addrs = (a: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value).map((v) => ({ name: v.name || undefined, address: v.address?.toLowerCase() }));

/** His addresses: whatever sent the mail in his Sent mailboxes, plus git/env identities. */
async function myAddresses(roots: string[]): Promise<Set<string>> {
  const me = await myEmails();
  for (const root of roots) {
    for await (const { path: file } of walkFiles(root, { exts: EMLX })) {
      if (!isSentBox(file)) continue;
      try {
        const fd = await fs.promises.open(file, "r");
        const head = Buffer.alloc(16384);
        const { bytesRead } = await fd.read(head, 0, head.length, 0);
        await fd.close();
        const from = /^from:\s*(.+(?:\r?\n[ \t].+)*)/im.exec(head.subarray(0, bytesRead).toString("utf8"))?.[1] ?? "";
        const m = /<([^>]+@[^>]+)>/.exec(from) ?? /([^\s<>"]+@[^\s<>"]+)/.exec(from);
        if (m) me.add(m[1].toLowerCase());
      } catch {
        /* unreadable message */
      }
    }
  }
  return me;
}

const normSubject = (s: string) => s.replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/i, "").trim();

export const mail: Source = {
  name: "mail",
  anyPlatform: false,
  async *read(ctx) {
    const roots = stores();
    if (!roots.length) throw new SkipSource(`no Mail store (V*) under ${MAIL}`);
    const me = await myAddresses(roots);
    for (const root of roots) {
      for await (const { path: file } of walkFiles(root, { exts: EMLX, newerThan: ctx.lowerBound })) {
        let parsed;
        try {
          parsed = await simpleParser(rfc822(await fs.promises.readFile(file)), { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
        } catch (e) {
          ctx.warn(`${path.basename(file)}: ${(e as Error).message}`);
          continue;
        }
        const from = addrs(parsed.from)[0];
        const text = (parsed.text ?? "").trim();
        const refs = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
        const subject = parsed.subject ?? "";
        const mailbox = file.split(path.sep).filter((s) => s.endsWith(".mbox")).join("/");
        const row: Row = {
          id: parsed.messageId ?? sha1("mail", file),
          ts: parsed.date ?? null,
          author: from ? (from.name ? `${from.name} <${from.address}>` : from.address ?? null) : null,
          is_me: !!from?.address && me.has(from.address),
          thread_id: refs[0] ?? parsed.inReplyTo ?? parsed.messageId ?? null,
          thread_name: normSubject(subject) || null,
          reply_to: parsed.inReplyTo ?? null,
          text,
          meta: {
            subject,
            from,
            to: addrs(parsed.to),
            cc: addrs(parsed.cc),
            mailbox,
            path: file,
            attachments: parsed.attachments.length
              ? parsed.attachments.map((a) => ({ filename: a.filename, type: a.contentType, bytes: a.size, in: file }))
              : undefined,
          },
        };
        yield row;
      }
    }
  },
};
