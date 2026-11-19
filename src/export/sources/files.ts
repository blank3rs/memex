import * as fs from "fs";
import * as path from "path";
import { ExportContext, Row, SkipSource, Source } from "../types.js";
import { HOME, exists, lib, sha1, walkFiles } from "../util.js";

const EXTS = new Set([".md", ".markdown", ".txt"]);
const MAX_BYTES = 5 * 1024 * 1024;

/** Obsidian vaults: the app's registry (macOS or Linux) plus every dir directly under ~/Obsidian. */
function vaults(): string[] {
  const found = new Set<string>();
  const registries = [
    lib("Application Support", "obsidian", "obsidian.json"),
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(HOME, ".config"), "obsidian", "obsidian.json"),
  ];
  for (const reg of registries) {
    try {
      const cfg = JSON.parse(fs.readFileSync(reg, "utf8")) as { vaults?: Record<string, { path?: string }> };
      for (const v of Object.values(cfg.vaults ?? {})) if (v.path && exists(v.path)) found.add(path.resolve(v.path));
    } catch {
      /* no registry */
    }
  }
  const home = path.join(HOME, "Obsidian");
  if (exists(path.join(home, ".obsidian"))) found.add(home);
  else {
    try {
      for (const d of fs.readdirSync(home, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith(".")) found.add(path.join(home, d.name));
    } catch {
      /* none */
    }
  }
  return [...found];
}

async function* readRoot(source: string, root: string, ctx: ExportContext, skipVaults: boolean): AsyncGenerator<Row> {
  const skipDir = skipVaults ? (_: string, full: string) => exists(path.join(full, ".obsidian")) : undefined;
  for await (const { path: file, stat } of walkFiles(root, { exts: EXTS, maxBytes: MAX_BYTES, newerThan: ctx.lowerBound, skipDir })) {
    let text: string;
    try {
      text = await fs.promises.readFile(file, "utf8");
    } catch {
      continue;
    }
    if (!text.trim() || text.includes("\u0000")) continue; // empty or binary
    yield {
      id: sha1(source, file),
      ts: stat.mtime,
      author: "me",
      is_me: true,
      thread_id: root,
      thread_name: path.relative(root, file),
      reply_to: null,
      text,
      meta: { path: file, size: stat.size, created: stat.birthtime.toISOString() },
    };
  }
}

export const documents: Source = {
  name: "documents",
  anyPlatform: true,
  async *read(ctx) {
    const roots = (ctx.roots.length ? ctx.roots : [path.join(HOME, "Documents"), path.join(HOME, "Desktop")]).filter(exists);
    if (!roots.length) throw new SkipSource("no document roots exist");
    // Vaults belong to the obsidian source.
    for (const r of roots) yield* readRoot("documents", r, ctx, true);
  },
};

export const obsidian: Source = {
  name: "obsidian",
  anyPlatform: true,
  async *read(ctx) {
    const vs = vaults();
    if (!vs.length) throw new SkipSource("no Obsidian vaults found");
    for (const v of vs) yield* readRoot("obsidian", v, ctx, false);
  },
};
