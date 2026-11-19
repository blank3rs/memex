import * as fs from "fs";
import * as path from "path";
import { Row, SkipSource, Source } from "../types.js";
import { HOME, exists, sha1, validDate } from "../util.js";

interface Cmd {
  ts: Date | null;
  cmd: string;
}

/** zsh writes non-ASCII "metafied": 0x83 then (byte ^ 0x20). */
function unmetafy(b: Buffer): string {
  const out = Buffer.alloc(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) out[j++] = b[i] === 0x83 && i + 1 < b.length ? b[++i] ^ 0x20 : b[i];
  return out.subarray(0, j).toString("utf8");
}

function parseZsh(file: string): Cmd[] {
  const lines = unmetafy(fs.readFileSync(file)).split("\n");
  const out: Cmd[] = [];
  let cur: Cmd | null = null;
  for (const line of lines) {
    const m = /^: (\d+):\d+;(.*)$/.exec(line);
    if (m) {
      if (cur) out.push(cur);
      cur = { ts: validDate(Number(m[1]) * 1000), cmd: m[2] };
    } else if (cur && cur.cmd.endsWith("\\")) {
      cur.cmd = cur.cmd.slice(0, -1) + "\n" + line; // multi-line command continuation
    } else {
      if (cur) out.push(cur);
      cur = line ? { ts: null, cmd: line } : null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function parseBash(file: string): Cmd[] {
  const out: Cmd[] = [];
  let ts: Date | null = null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^#(\d{9,11})$/.exec(line);
    if (m) {
      ts = validDate(Number(m[1]) * 1000);
      continue;
    }
    if (line) out.push({ ts, cmd: line });
    ts = null;
  }
  return out;
}

/** fish_history is YAML-like: `- cmd: ...` then `  when: <unix>`; \n and \\ are escaped. */
function parseFish(file: string): Cmd[] {
  const out: Cmd[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("- cmd: ")) {
      const cmd = line.slice(7).replace(/\\(\\|n)/g, (_, c) => (c === "n" ? "\n" : "\\"));
      out.push({ ts: null, cmd });
    } else if (line.startsWith("  when: ") && out.length) {
      out[out.length - 1].ts = validDate(Number(line.slice(8)) * 1000);
    }
  }
  return out;
}

function historyFiles(): { shell: string; file: string; parse: (f: string) => Cmd[] }[] {
  const xdgData = process.env.XDG_DATA_HOME ?? path.join(HOME, ".local", "share");
  const files: { shell: string; file: string; parse: (f: string) => Cmd[] }[] = [];
  const zsh = new Set([path.join(HOME, ".zsh_history"), path.join(HOME, ".zhistory")]);
  if (process.env.HISTFILE && /zsh/.test(process.env.SHELL ?? "")) zsh.add(process.env.HISTFILE);
  for (const f of zsh) files.push({ shell: "zsh", file: f, parse: parseZsh });
  // macOS Terminal keeps per-session zsh history until it merges; ids dedupe the overlap.
  const sessions = path.join(HOME, ".zsh_sessions");
  try {
    for (const f of fs.readdirSync(sessions)) if (f.endsWith(".history")) files.push({ shell: "zsh", file: path.join(sessions, f), parse: parseZsh });
  } catch {
    /* none */
  }
  files.push({ shell: "bash", file: path.join(HOME, ".bash_history"), parse: parseBash });
  files.push({ shell: "fish", file: path.join(xdgData, "fish", "fish_history"), parse: parseFish });
  return files.filter((f) => exists(f.file));
}

export const shell: Source = {
  name: "shell",
  anyPlatform: true,
  async *read(ctx) {
    const files = historyFiles();
    if (!files.length) throw new SkipSource("no zsh, bash or fish history found");
    for (const { shell, file, parse } of files) {
      let cmds: Cmd[];
      try {
        cmds = parse(file);
      } catch (e) {
        ctx.warn(`${file}: ${(e as Error).message}`);
        continue;
      }
      const seen = new Map<string, number>();
      for (const { ts, cmd } of cmds) {
        if (!cmd.trim()) continue;
        if (ts && ctx.lowerBound && ts < ctx.lowerBound) continue;
        // Timeless lines: identity is the command plus its occurrence number in this file.
        const n = ts ? 0 : (seen.get(cmd) ?? 0) + 1;
        if (!ts) seen.set(cmd, n);
        const row: Row = {
          id: sha1(shell, ts?.getTime() ?? `${path.basename(file)}#${n}`, cmd),
          ts,
          author: "me",
          is_me: true,
          thread_id: shell,
          thread_name: file,
          reply_to: null,
          text: cmd,
          meta: { shell, file },
        };
        yield row;
      }
    }
  },
};
