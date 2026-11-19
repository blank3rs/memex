# mymemex

A personal memory agent for your Mac. Run `mymemex init` once and it scans your Mac — contacts, calendar, notes, git repos, shell history, dev tools, Obsidian vault, iMessages, and AI context files — and builds a local snapshot of who you are and what you've been doing.

```
npm install -g mymemex
mymemex init
```

> macOS only. Data stays on your machine.

---

## Commands

| Command | What it does |
|---|---|
| `mymemex init` | First-time setup. Scans your Mac and builds your memory. |
| `mymemex add` | Manually log a new entry (thought, event, fact, or update). |
| `mymemex status` | Show your profile and recent entries. |
| `mymemex watch <dir>` | Watch a directory and auto-log file changes. |
| `mymemex export --out <dir> [--sources a,b] [--since <iso>] [--full] [--roots a,b]` | Export your raw text history as zstd Parquet rows, incrementally. See [Raw export](#raw-export). |

---

## Data sources

During `mymemex init` you choose which sources to pull from:

| Source | What it reads |
|---|---|
| **Contacts** | People you know — names, emails, phones |
| **Calendar** | Events from 30 days back to 90 days ahead |
| **Apple Notes** | Your notes |
| **Reminders** | Open tasks |
| **Git** | Languages and active projects from your repos |
| **Shell history** | Tools you actually use day-to-day |
| **Dev tools** | Tech stack from Homebrew, VS Code extensions, installed apps |
| **Obsidian** | Topics and recent notes from your vault |
| **AI context files** | `CLAUDE.md`, `.cursorrules`, `.clinerules`, ChatGPT export |
| **iMessages** | Conversations (opt-in, needs Full Disk Access) |

---

## Raw export

`mymemex export` writes everything you have written or said, as rows, for training or search. It is non-interactive and incremental: each run writes only rows newer than the last run, as a new part file `<out>/<source>/part-<runid>.parquet` (ZSTD, ~128 MB row groups), and prints one JSON line per source (`rows`, `bytes`, `minTs`, `maxTs`, or `skipped` with the reason). A missing app or permission skips that source; it never stops the run.

```
mymemex export --out ~/memex-export                      # all sources, new rows only
mymemex export --out ~/memex-export --sources ai,git     # some sources
mymemex export --out ~/memex-export --full               # rewrite each source as one fresh part
```

Every row: `source, id, ts (UTC), author, is_me, thread_id, thread_name, reply_to, text, meta (JSON)`. `id` is stable per source; an edited record (note, file, event) is written again with the same id, so dedupe on `(source, id)` keeping the latest `ts`. Attachments are listed in `meta` by path, never copied. Lines that look like credentials (`sk-`, `ghp_`, `AKIA`, `xox[bp]-`, `-----BEGIN` blocks and similar) are dropped from every row.

| Source | Reads | Platforms |
|---|---|---|
| `imessage` | `~/Library/Messages/chat.db`, text decoded from `attributedBody` when needed, names from Contacts | macOS |
| `whatsapp` | the `ZWAMESSAGE` store found under the WhatsApp containers | macOS |
| `notes` | Apple Notes `NoteStore.sqlite` (gzipped protobuf bodies) | macOS |
| `mail` | Mail.app `.emlx` files; `is_me` from the addresses in your Sent mailboxes | macOS |
| `calendar`, `reminders`, `contacts` | their local stores | macOS |
| `wispr` | Wispr Flow `flow.sqlite` (dictation history, polished and raw text) | macOS |
| `granola` | plaintext Granola cache if present (newer versions encrypt it: use Granola's CSV export or API) | macOS |
| `voicememos` | one row per recording, audio path in `meta`, empty text | macOS |
| `browser` | Safari, Chrome, Brave, Edge, Arc, Zen and Firefox history (title, URL, visit time) | macOS |
| `obsidian` | Markdown in your Obsidian vaults | any |
| `documents` | `.md`/`.txt` under `--roots` (default `~/Documents`, `~/Desktop`), files up to 5 MB, skipping build and dependency dirs and Obsidian vaults | any |
| `shell` | zsh, bash and fish history, with timestamps where recorded | any |
| `git` | your commit messages across every repo under `~` | any |
| `github` | issues, PRs, comments and review comments you authored (needs `gh auth login`) | any |
| `ai` | your typed turns in Claude Code, Codex, Cursor and ChatGPT exports, each with the preceding assistant reply (last 4k chars) as `meta.context` | any |

Your identity comes from `git config --global user.email`; add more addresses with `MYMEMEX_EMAILS=a@x.com,b@y.com`. `MYMEMEX_GITHUB_LOGIN` overrides the `gh` account. Watermarks live in `~/.mymemex/export-state.json`, per output directory. A `--since` run moves the watermark too, so use `--full` to backfill older rows later. On macOS, grant your terminal Full Disk Access. Requires Node 22.13+.

---

## Permissions

Some sources require macOS permissions:

- **Contacts / Calendar / Notes / Reminders** — macOS will prompt automatically on first access
- **iMessages** — grant Terminal (or your terminal app) **Full Disk Access** in System Settings → Privacy & Security → Full Disk Access

---

## Where data is stored

Everything is stored locally at `~/.mymemex/`:

```
~/.mymemex/
  state.json       ← your profile + all entries
  logs/
    2025-01-15.json  ← daily append logs
```

Nothing is sent anywhere. No accounts, no cloud.

---

## Requirements

- macOS (Sequoia / Sonoma / Ventura)
- Node.js 22.13+

---

## Development

```bash
git clone https://github.com/blank3rs/memex.git
cd memex
npm install
npm run dev -- init
```

Build:

```bash
npm run build
npm start -- status
```
