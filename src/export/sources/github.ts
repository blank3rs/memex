import { execFile } from "child_process";
import { Row, SkipSource, Source } from "../types.js";
import { validDate } from "../util.js";

/** One GraphQL call through the user's `gh` login (no token handling here). */
function gql(query: string, vars: Record<string, string | null>): Promise<any> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) if (v != null) args.push("-f", `${k}=${v}`);
  return new Promise((resolve, reject) =>
    execFile("gh", args, { maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().split("\n")[0]));
      try {
        const j = JSON.parse(stdout);
        if (j.errors?.length) return reject(new Error(j.errors[0].message));
        resolve(j.data);
      } catch (e) {
        reject(e);
      }
    })
  );
}

/** Walk a connection page by page; `pick` returns the connection object from the response. */
async function* pages(query: string, vars: Record<string, string>, pick: (d: any) => any): AsyncGenerator<any> {
  let cursor: string | null = null;
  do {
    const conn = pick(await gql(query, { ...vars, cursor }));
    if (!conn) return;
    for (const n of conn.nodes ?? []) if (n) yield n;
    cursor = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);
}

const AGENT = /generated with \[?claude code|co-authored-by:.*(claude|anthropic|openai|codex|copilot)|🤖 generated/i;
const PAGE = "pageInfo { hasNextPage endCursor }";
const REPO = "repository { nameWithOwner }";

const Q_ISSUES = `query($login:String!,$cursor:String){ user(login:$login){ issues(first:100, after:$cursor){ ${PAGE}
  nodes{ id number title body createdAt updatedAt url state ${REPO} } } } }`;
const Q_PRS = `query($login:String!,$cursor:String){ user(login:$login){ pullRequests(first:100, after:$cursor){ ${PAGE}
  nodes{ id number title body createdAt updatedAt url state merged ${REPO} } } } }`;
const Q_COMMENTS = `query($login:String!,$cursor:String){ user(login:$login){ issueComments(first:100, after:$cursor){ ${PAGE}
  nodes{ id body createdAt updatedAt url issue{ number title url ${REPO} } pullRequest{ number title url } } } } }`;
const Q_REVIEWS = `query($login:String!,$from:DateTime!,$to:DateTime!,$cursor:String){ user(login:$login){
  contributionsCollection(from:$from, to:$to){ pullRequestReviewContributions(first:50, after:$cursor){ ${PAGE}
  nodes{ pullRequestReview{ id body createdAt url state pullRequest{ number title url ${REPO} }
    comments(first:100){ nodes{ id body createdAt url path replyTo{ id } } } } } } } } }`;

function row(o: { id: string; ts: string; text: string; thread: string; threadName: string; replyTo?: string | null; meta: Record<string, unknown> }): Row {
  return {
    id: o.id,
    ts: validDate(o.ts),
    author: "me",
    is_me: true,
    thread_id: o.thread,
    thread_name: o.threadName,
    reply_to: o.replyTo ?? null,
    text: o.text,
    meta: { ...o.meta, agent_generated: AGENT.test(o.text) || undefined },
  };
}

/** Issues, PRs, comments and review comments he authored, via the GitHub GraphQL API. Runs anywhere `gh` is logged in. */
export const github: Source = {
  name: "github",
  anyPlatform: true,
  async *read(ctx) {
    let login = process.env.MYMEMEX_GITHUB_LOGIN ?? "";
    let createdAt: string;
    try {
      const me = await gql(login ? `query($login:String!){ user(login:$login){ login createdAt } }` : `query{ viewer{ login createdAt } }`, login ? { login } : {});
      const u = me.user ?? me.viewer;
      login = u.login;
      createdAt = u.createdAt;
    } catch (e) {
      throw new SkipSource(`gh not available or not logged in: ${(e as Error).message}`);
    }
    const v = { login };

    for await (const n of pages(Q_ISSUES, v, (d) => d.user?.issues)) {
      const repo = n.repository?.nameWithOwner;
      yield row({ id: n.id, ts: n.createdAt, text: [n.title, n.body].filter(Boolean).join("\n\n"), thread: n.url, threadName: `${repo}#${n.number} ${n.title}`,
        meta: { kind: "issue", repo, url: n.url, state: n.state, updated: n.updatedAt } });
    }
    for await (const n of pages(Q_PRS, v, (d) => d.user?.pullRequests)) {
      const repo = n.repository?.nameWithOwner;
      yield row({ id: n.id, ts: n.createdAt, text: [n.title, n.body].filter(Boolean).join("\n\n"), thread: n.url, threadName: `${repo}#${n.number} ${n.title}`,
        meta: { kind: "pull_request", repo, url: n.url, state: n.state, merged: n.merged, updated: n.updatedAt } });
    }
    for await (const n of pages(Q_COMMENTS, v, (d) => d.user?.issueComments)) {
      if (!n.body?.trim()) continue;
      const parent = n.pullRequest ?? n.issue;
      const repo = n.issue?.repository?.nameWithOwner;
      yield row({ id: n.id, ts: n.createdAt, text: n.body, thread: parent?.url ?? n.url, threadName: `${repo}#${parent?.number} ${parent?.title}`,
        meta: { kind: n.pullRequest ? "pr_comment" : "issue_comment", repo, url: n.url, updated: n.updatedAt } });
    }
    // Reviews only come per contribution year.
    const start = new Date(createdAt).getUTCFullYear();
    const fromYear = Math.max(start, ctx.lowerBound ? ctx.lowerBound.getUTCFullYear() : start);
    for (let y = fromYear; y <= new Date().getUTCFullYear(); y++) {
      const vars = { login, from: `${y}-01-01T00:00:00Z`, to: `${y}-12-31T23:59:59Z` };
      for await (const c of pages(Q_REVIEWS, vars, (d) => d.user?.contributionsCollection?.pullRequestReviewContributions)) {
        const r = c.pullRequestReview;
        if (!r) continue;
        const pr = r.pullRequest;
        const repo = pr?.repository?.nameWithOwner;
        const threadName = `${repo}#${pr?.number} ${pr?.title}`;
        if (r.body?.trim())
          yield row({ id: r.id, ts: r.createdAt, text: r.body, thread: pr?.url ?? r.url, threadName, meta: { kind: "review", repo, url: r.url, state: r.state } });
        for (const cm of r.comments?.nodes ?? []) {
          if (!cm?.body?.trim()) continue;
          yield row({ id: cm.id, ts: cm.createdAt, text: cm.body, thread: pr?.url ?? r.url, threadName, replyTo: cm.replyTo?.id ?? r.id,
            meta: { kind: "review_comment", repo, url: cm.url, path: cm.path } });
        }
      }
    }
  },
};
