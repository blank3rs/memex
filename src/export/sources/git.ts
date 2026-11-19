import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { Row, SkipSource, Source } from "../types.js";
import { HOME, SKIP_DIRS, myEmails, run, validDate } from "../util.js";

const MAX_DEPTH = 5;

/** Every git work tree under ~ (up to MAX_DEPTH, skipping hidden and build dirs). */
async function findRepos(): Promise<string[]> {
  const repos: string[] = [];
  const stack: [string, number][] = [[HOME, 0]];
  while (stack.length) {
    const [dir, depth] = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Keep descending past a repo: ~ itself is often one (dotfiles), and clones nest inside folders that are repos.
    if (entries.some((e) => e.name === ".git")) repos.push(dir);
    if (depth >= MAX_DEPTH) continue;
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) stack.push([path.join(dir, e.name), depth + 1]);
    }
  }
  return repos;
}

const FMT = ["%H", "%aI", "%an", "%ae", "%cI", "%P", "%B"].join("%x00") + "%x1e";
const COAUTHOR = /^co-authored-by:\s*(.+)$/gim;

async function* commits(repo: string, emails: string[], since: Date | null): AsyncGenerator<string[]> {
  const args = ["-C", repo, "log", "--branches", "--tags", "--remotes", "--no-merges", "--fixed-strings", "--regexp-ignore-case", `--format=${FMT}`];
  for (const e of emails) args.push(`--author=<${e}>`); // literal match: addresses carry regex chars like "+"
  if (since) args.push(`--since=${since.toISOString()}`);
  const child = spawn("git", args, { stdio: ["ignore", "pipe", "ignore"] });
  let buf = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout as AsyncIterable<string>) {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\x1e")) >= 0) {
      const rec = buf.slice(0, i).replace(/^\n/, "");
      buf = buf.slice(i + 1);
      if (rec) yield rec.split("\x00");
    }
  }
}

export const git: Source = {
  name: "git",
  anyPlatform: true,
  async *read(ctx) {
    const global = await myEmails();
    const repos = await findRepos();
    if (!repos.length) throw new SkipSource("no git repositories found under ~");
    let any = global.size > 0;
    for (const repo of repos) {
      const local = (await run("git", ["-C", repo, "config", "--local", "--get-all", "user.email"])) ?? "";
      const emails = new Set(global);
      for (const e of local.split("\n")) if (e.trim()) emails.add(e.trim().toLowerCase());
      if (!emails.size) continue;
      any = true;
      const remote = (await run("git", ["-C", repo, "config", "--get", "remote.origin.url"]))?.trim() || null;
      for await (const [sha, aDate, aName, aEmail, cDate, parents, body] of commits(repo, [...emails], ctx.lowerBound)) {
        const text = (body ?? "").trim();
        if (!sha || !text) continue;
        const coAuthors = [...text.matchAll(COAUTHOR)].map((m) => m[1].trim());
        const row: Row = {
          id: sha,
          ts: validDate(aDate),
          author: aName || aEmail,
          is_me: true,
          thread_id: remote ?? repo,
          thread_name: path.basename(repo),
          reply_to: parents?.split(" ")[0] || null,
          text,
          meta: {
            repo,
            remote,
            author_email: aEmail,
            committer_date: cDate,
            co_authors: coAuthors.length ? coAuthors : undefined,
            // Commits an agent wrote under his name; keep, but let training filter them.
            agent_coauthored: coAuthors.some((c) => /anthropic|claude|openai|codex|copilot|cursor/i.test(c)) || undefined,
          },
        };
        yield row;
      }
    }
    if (!any) throw new SkipSource("no identity: set git config --global user.email or MYMEMEX_EMAILS");
  },
};
