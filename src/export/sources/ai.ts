import * as fs from "fs";
import * as path from "path";
import { streamArray } from "stream-json/streamers/stream-array.js";
import { ExportContext, Row, SkipSource, Source } from "../types.js";
import { HOME, IS_MAC, exists, lib, openSqliteCopy, readLines, sha1, str, truncateTail, validDate, walkFiles } from "../util.js";

const CONTEXT_MAX = 4000;

/** Text he typed: not empty, not a command/system wrapper, not an interrupt marker. */
function typed(text: string): string | null {
  const t = text.trim();
  if (!t || t.startsWith("<") || t.startsWith("[Request interrupted")) return null;
  return t;
}

function contextMeta(prev: string | null): Record<string, unknown> {
  if (!prev) return {};
  const c = truncateTail(prev, CONTEXT_MAX);
  return { context: c.text, context_truncated: c.truncated };
}

// ---- Claude Code: ~/.claude/projects/**/*.jsonl ----------------------------------------------

type Block = { type?: string; text?: string };

async function* claudeCode(ctx: ExportContext): AsyncGenerator<Row> {
  const root = path.join(HOME, ".claude", "projects");
  // Subagent transcripts hold agent-written prompts, not his.
  const files = walkFiles(root, { exts: new Set([".jsonl"]), newerThan: ctx.lowerBound, skipDir: (n) => n === "subagents" });
  for await (const { path: file } of files) {
    let last: { msgId: string; uuid: string; text: string; model: string | null } | null = null;
    for await (const line of readLines(file)) {
      if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
      let d: any;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d.isSidechain) continue;
      const content = d.message?.content;
      if (d.type === "assistant") {
        const text = Array.isArray(content)
          ? (content as Block[]).filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n")
          : typeof content === "string" ? content : "";
        if (!text) continue;
        const msgId = d.message?.id ?? d.uuid;
        if (last && last.msgId === msgId) last.text = `${last.text}\n${text}`;
        else last = { msgId, uuid: d.uuid, text, model: d.message?.model ?? null };
        continue;
      }
      if (d.type !== "user" || d.isMeta || d.toolUseResult !== undefined || typeof content !== "string") continue;
      const text = typed(content);
      if (!text) continue;
      yield {
        id: d.uuid ?? sha1(file, d.timestamp, text),
        ts: validDate(d.timestamp),
        author: "me",
        is_me: true,
        thread_id: d.sessionId ?? null,
        thread_name: d.cwd ?? null,
        reply_to: last?.uuid ?? null,
        text,
        meta: {
          app: "claude-code",
          cwd: d.cwd,
          git_branch: d.gitBranch,
          version: d.version,
          entrypoint: d.entrypoint,
          user_type: d.userType,
          prompt_source: d.promptSource,
          turn_origin: d.turnOrigin,
          context_model: last?.model ?? undefined,
          ...contextMeta(last?.text ?? null),
          file,
        },
      };
    }
  }
}

// ---- Codex: ~/.codex/sessions/**/rollout-*.jsonl (streamed; can be GBs) -------------------------

function codexText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b: any) => typeof b?.text === "string" && /^(text|Text|input_text|output_text)$/.test(b.type ?? "text"))
    .map((b: any) => b.text)
    .join("\n");
}

async function* codex(ctx: ExportContext): AsyncGenerator<Row> {
  const roots = [path.join(HOME, ".codex", "sessions"), path.join(HOME, ".codex", "archived_sessions")];
  const keep = /user_message|UserMessage|agent_message|AgentMessage|"role":"(user|assistant)"|session_meta/;
  for (const root of roots) {
    for await (const { path: file } of walkFiles(root, { exts: new Set([".jsonl"]), newerThan: ctx.lowerBound })) {
      let session: any = {};
      let last: string | null = null;
      const recent = new Map<string, number>(); // text -> ms, to fold the same turn logged twice
      for await (const line of readLines(file)) {
        if (!keep.test(line)) continue;
        let d: any;
        try {
          d = JSON.parse(line);
        } catch {
          continue;
        }
        const p = d.payload ?? {};
        let user: { id: string | null; text: string } | null = null;

        if (d.type === "session_meta") session = p;
        else if (d.type === "event_msg" && p.type === "user_message") user = { id: null, text: str(p.message) ?? "" };
        else if (d.type === "event_msg" && p.type === "agent_message") last = str(p.message);
        else if (d.type === "event_msg" && p.type === "item_completed" && p.item?.type === "UserMessage")
          user = { id: p.item.id ?? null, text: codexText(p.item.content) };
        else if (d.type === "event_msg" && p.type === "item_completed" && p.item?.type === "AgentMessage")
          last = codexText(p.item.content) || last;
        else if (d.type === "response_item" && p.type === "message" && p.role === "assistant")
          last = codexText(p.content) || last;
        else if (d.type === "message" && d.role === "user") user = { id: d.id ?? null, text: codexText(d.content) }; // pre-2025-05 format
        else if (d.type === "message" && d.role === "assistant") last = codexText(d.content) || last;
        else if (d.record_type === undefined && d.id && d.instructions !== undefined) session = d; // old header line

        if (!user) continue;
        const text = typed(user.text);
        if (!text) continue;
        const ts = validDate(d.timestamp ?? p.timestamp);
        const ms = ts?.getTime() ?? 0;
        const seen = recent.get(text);
        if (seen !== undefined && Math.abs(seen - ms) < 10_000) continue;
        recent.set(text, ms);
        const sid = session.id ?? session.session_id ?? path.basename(file, ".jsonl");
        yield {
          id: user.id ?? sha1("codex", sid, d.timestamp, text),
          ts,
          author: "me",
          is_me: true,
          thread_id: sid,
          thread_name: session.cwd ?? null,
          reply_to: null,
          text,
          meta: { app: "codex", cwd: session.cwd, originator: session.originator, session_source: session.source, ...contextMeta(last), file },
        };
      }
    }
  }
}

// ---- Cursor: state.vscdb (composer chats) ------------------------------------------------------

function cursorDbPath(): string {
  return IS_MAC
    ? lib("Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
    : path.join(process.env.XDG_CONFIG_HOME ?? path.join(HOME, ".config"), "Cursor", "User", "globalStorage", "state.vscdb");
}

async function* cursor(ctx: ExportContext): AsyncGenerator<Row> {
  const file = cursorDbPath();
  if (!exists(file)) return;
  const db = openSqliteCopy(file, ctx.tmpDir, "Cursor state.vscdb");
  try {
    const getBubble = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
    const composers = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'");
    for (const r of composers.iterate()) {
      let c: any;
      try {
        c = JSON.parse(str(r.value) ?? "null");
      } catch {
        continue;
      }
      if (!c) continue;
      const cid = c.composerId ?? String(r.key).slice("composerData:".length);
      const created = validDate(c.createdAt);
      if (ctx.lowerBound && c.lastUpdatedAt && c.lastUpdatedAt < ctx.lowerBound.getTime()) continue;
      const bubbles: any[] = Array.isArray(c.conversation) && c.conversation.length
        ? c.conversation
        : (c.fullConversationHeadersOnly ?? []).map((h: any) => {
            const v = getBubble.get(`bubbleId:${cid}:${h.bubbleId}`) as { value?: unknown } | undefined;
            try {
              return v ? JSON.parse(str(v.value) ?? "null") : null;
            } catch {
              return null;
            }
          });
      let last: string | null = null;
      let lastId: string | null = null;
      for (const b of bubbles) {
        if (!b) continue;
        if (b.type === 2) {
          if (b.text) {
            last = b.text;
            lastId = b.bubbleId ?? null;
          }
          continue;
        }
        if (b.type !== 1) continue;
        const text = typed(b.text ?? "");
        if (!text) continue;
        yield {
          id: b.bubbleId ? `${cid}:${b.bubbleId}` : sha1("cursor", cid, text),
          ts: validDate(b.createdAt) ?? validDate(b.timingInfo?.clientStartTime) ?? created,
          author: "me",
          is_me: true,
          thread_id: cid,
          thread_name: c.name ?? null,
          reply_to: lastId,
          text,
          meta: { app: "cursor", ...contextMeta(last) },
        };
      }
    }
  } catch (e) {
    ctx.warn(`cursor: ${(e as Error).message}`);
  } finally {
    db.close();
  }
}

// ---- ChatGPT export: conversations.json (streamed one conversation at a time) ------------------

function chatgptFiles(): string[] {
  const found = new Set<string>();
  for (const dir of [path.join(HOME, "Downloads"), HOME, path.join(HOME, "Desktop"), path.join(HOME, "Documents")]) {
    const direct = path.join(dir, "conversations.json");
    if (exists(direct)) found.add(direct);
    let subs: fs.Dirent[] = [];
    try {
      subs = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of subs) {
      const p = path.join(dir, s.name, "conversations.json"); // unzipped export folders
      if (s.isDirectory() && exists(p)) found.add(p);
    }
  }
  return [...found];
}

function gptText(m: any): string {
  const parts = m?.content?.parts;
  if (Array.isArray(parts)) return parts.filter((x: unknown) => typeof x === "string").join("\n");
  return typeof m?.content?.text === "string" ? m.content.text : "";
}

async function* chatgpt(ctx: ExportContext): AsyncGenerator<Row> {
  for (const file of chatgptFiles()) {
    const stream = fs.createReadStream(file).pipe(streamArray.withParserAsStream());
    for await (const item of stream as AsyncIterable<{ value: any }>) {
      const conv = item.value;
      const mapping: Record<string, any> = conv?.mapping ?? {};
      if (ctx.lowerBound && (conv.update_time ?? conv.create_time ?? Infinity) * 1000 < ctx.lowerBound.getTime()) continue;
      for (const node of Object.values(mapping)) {
        const m = node?.message;
        if (m?.author?.role !== "user") continue;
        const text = typed(gptText(m));
        if (!text) continue;
        const parent = node.parent ? mapping[node.parent]?.message : null;
        const prev = parent?.author?.role === "assistant" ? gptText(parent) : null;
        const attachments = (m.metadata?.attachments ?? []).map((a: any) => ({ name: a.name, mime: a.mime_type, id: a.id }));
        yield {
          id: m.id ?? node.id,
          ts: validDate((m.create_time ?? conv.create_time) * 1000),
          author: "me",
          is_me: true,
          thread_id: conv.id ?? conv.conversation_id ?? null,
          thread_name: conv.title ?? null,
          reply_to: parent?.id ?? null,
          text,
          meta: { app: "chatgpt", model: parent?.metadata?.model_slug, attachments: attachments.length ? attachments : undefined, ...contextMeta(prev), file },
        };
      }
    }
  }
}

export const ai: Source = {
  name: "ai",
  anyPlatform: true,
  async *read(ctx) {
    const present = [
      path.join(HOME, ".claude", "projects"),
      path.join(HOME, ".codex", "sessions"),
      path.join(HOME, ".codex", "archived_sessions"),
      cursorDbPath(),
    ].some(exists) || chatgptFiles().length > 0;
    if (!present) throw new SkipSource("no Claude Code, Codex, Cursor or ChatGPT export data found");
    yield* claudeCode(ctx);
    yield* codex(ctx);
    yield* cursor(ctx);
    yield* chatgpt(ctx);
  },
};
