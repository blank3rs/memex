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
- Node.js 20+

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
