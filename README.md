<p align="center">
  <img src="assets/tidra-logo.svg" alt="Tidra" width="440">
</p>

<h3 align="center">An AI assistant that lives in your browser.</h3>

<p align="center">
  <img alt="Chrome MV3" src="https://img.shields.io/badge/Chrome-MV3-0a0a0a?style=flat-square&logo=googlechrome&logoColor=white">
  <img alt="WXT" src="https://img.shields.io/badge/built%20with-WXT-4c1?style=flat-square">
  <img alt="React + TypeScript" src="https://img.shields.io/badge/React-TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Groq" src="https://img.shields.io/badge/inference-Groq-f55036?style=flat-square">
  <img alt="No server, no telemetry" src="https://img.shields.io/badge/data-100%25%20local-0a0a0a?style=flat-square">
</p>

---

A floating "island" sits on every page. Ask it about what you're reading, or tell it to do
something — open a site, fill a form, draft a reply, save a PDF, work through a list of 200
rows. It reads pages as an accessibility tree and acts on real elements, and it stops before
anything irreversible to ask you first.

Built with [WXT](https://wxt.dev) + React + [Groq](https://groq.com). No server, no account,
no telemetry — your Groq API key and all data stay in `browser.storage.local` on your machine.

---

## Table of contents

- [Quick start](#quick-start)
- [What Tidra can do](#what-tidra-can-do)
- [Documentation](#documentation)
- [Repo layout](#repo-layout)
- [Development](#development)
- [Cost](#cost)
- [Privacy](#privacy)
- [Browser support](#browser-support)
- [Troubleshooting](#troubleshooting)
- [Adding a feature](#adding-a-feature)

---

## Quick start

### 1. Build it

```bash
cd extension && npm install && npm run build
```

Output lands in `extension/dist/chrome-mv3`.

### 2. Load it

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select `extension/dist/chrome-mv3`

### 3. Add a key

1. Open a new tab (Tidra replaces the new-tab page) → click the **⚙ gear**
2. Paste a Groq API key from [console.groq.com/keys](https://console.groq.com/keys)
3. Press **Save**

### 4. Use it

Press `⌘⇧Space` (macOS) or `Ctrl+Shift+Space` (Windows/Linux) on any page to open the island.

> Optional but recommended: on the Settings page, press **Allow microphone** once. That single
> grant unlocks voice input everywhere, because the island and the recorder share the
> extension's own origin.

---

## What Tidra can do

| | Feature | Where |
| --- | --- | --- |
| 💬 | **Chat about the page** — summarize, explain, fact-check, translate | Island, new tab |
| 🤖 | **Act on the page** — click, type, select, scroll, navigate, upload | Island |
| 🛑 | **Confirm before sending** — stops at send/post/buy/delete and asks | Island |
| ⚡ | **Skills** — `/summarize`, `/draft-reply`, and any slash command you write | Island, new tab |
| 🔁 | **Routines** — learns your morning sites, then works through them for you | New tab, Settings |
| 📦 | **Batch jobs** — "email all 200 of these" with progress, pause, resume | Island |
| 📁 | **Connected folders** — let Tidra read a folder on your computer | New tab |
| 🎤 | **Voice input** — talk instead of typing, auto-stops when you finish | Island, new tab |
| 📎 | **Attachments** — drop in images and text files | Island |
| 📄 | **Reports & PDFs** — generate a document and save it to Downloads | Anywhere |
| 📚 | **Library** — every report and archived chat, kept locally | New tab → Library |
| 🧠 | **Site memory** — remembers how a site works so the next run is faster | Automatic |

The full, exhaustive list — every button, every behavior, every limit — is in
**[docs/features.md](docs/features.md)**.

---

## Documentation

| Doc | What's in it |
| --- | --- |
| **[docs/features.md](docs/features.md)** | 📌 **The master feature list.** Every feature, its status, and where it lives in the code. **Add new features here.** |
| [docs/user-guide.md](docs/user-guide.md) | How to use everything, screen by screen |
| [docs/settings.md](docs/settings.md) | Every setting, its default, and what it changes |
| [docs/skills.md](docs/skills.md) | Writing, editing, importing and sharing slash commands |
| [docs/routines.md](docs/routines.md) | Routines, connected folders, and how learning works |
| [docs/batch-jobs.md](docs/batch-jobs.md) | Running the same task over a list, safely |
| [docs/architecture.md](docs/architecture.md) | How it's built — the agent loop, the DOM engine, the models |
| [docs/reference.md](docs/reference.md) | Agent tools, message types, storage keys, models, permissions |
| [docs/adding-a-feature.md](docs/adding-a-feature.md) | 📌 **The checklist to follow when you add something new** |
| [CHANGELOG.md](CHANGELOG.md) | What changed, when |

---

## Repo layout

```
tidra-ai-assistent/
├── README.md                  ← you are here
├── CHANGELOG.md
├── assets/                    ← brand mark + logo lockup (used by this README)
├── docs/                      ← all documentation
└── extension/                 ← the browser extension (WXT + React + TypeScript)
    ├── wxt.config.ts          manifest, permissions, keyboard command
    ├── entrypoints/
    │   ├── background.ts      the brain: routing, the agent loop, jobs, routines
    │   ├── content/           the island (UI) + actions.ts (the DOM engine)
    │   ├── newtab/            the new-tab home page
    │   ├── options/           settings
    │   ├── report/            the Library (reports + archived chats)
    │   └── offscreen/         the invisible microphone recorder
    ├── lib/                   llm, skills, routine, jobs, folders, library,
    │                          sitemem, pdf, pdftext, voice, download, cdp, confirm
    ├── components/            Wordmark, richtext renderer
    └── public/                icons, bg.mp4
```

---

## Development

```bash
cd extension
npm install
npm run dev          # launches Chrome with the extension loaded + hot reload
npm run dev:firefox  # same, for Firefox (folders and trusted clicks won't work there)
npm run build        # production build → dist/chrome-mv3
npm run zip          # packaged .zip for store upload
npm run compile      # tsc --noEmit — type-check only, no emit
```

There are no tests and no linter configured. `npm run compile` is the gate before committing.

Read [docs/architecture.md](docs/architecture.md) before touching `background.ts` or
`actions.ts` — both encode non-obvious decisions (prefix-cache preservation, ref invalidation,
settle timing) that are easy to break silently.

---

## Cost

All inference runs on Groq, billed to your own key. Typical costs:

| Job | Model | Price / 1M tokens |
| --- | --- | --- |
| Actions (the agent) | `openai/gpt-oss-120b` | $0.15 in / $0.60 out |
| Chat & summaries | `openai/gpt-oss-20b` | $0.075 in / $0.30 out |
| Routing (chat vs. act) | `llama-3.1-8b-instant` | $0.05 in / $0.08 out |
| Reading a screenshot | `qwen/qwen3.6-27b` | $0.60 in / $3.00 out |
| Voice transcription | `whisper-large-v3-turbo` | $0.04 / hour of audio |

You pick a **tier**, not a model — see [docs/settings.md](docs/settings.md#model--cost).
Groq applies a 50% discount to cached prompt prefixes automatically; Tidra is deliberately
built to keep the system prompt byte-identical between runs so that cache keeps hitting.

Batch jobs show a cost estimate before they run.

---

## Privacy

- **No server.** There is no Tidra backend. The only network calls are to `api.groq.com`.
- **No telemetry.** Nothing is counted, reported, or phoned home. The 👍/👎 buttons on answers
  are cosmetic — they store nothing and send nothing.
- **Everything is local.** API key, chat history, profile, skills, routines, reports and site
  memory all live in `browser.storage.local`. Connected folders live in IndexedDB. Nothing syncs.
- **Routine learning stores domains and times only** — never URLs, never page content. It is
  capped at 800 entries and can be turned off or wiped in Settings.
- **Page content reaches Groq only inside a request you triggered.**

---

## Browser support

| | Chrome / Edge / Brave | Firefox | Safari |
| --- | --- | --- | --- |
| Island, chat, actions | ✅ | ✅ | ❌ |
| Voice input | ✅ | ✅ | ❌ |
| Connected folders | ✅ (Brave needs a flag) | ❌ | ❌ |
| Trusted clicks (CDP) | ✅ | ❌ | ❌ |

Connected folders need the File System Access API, which Firefox and Safari have never
shipped. Brave requires `brave://flags` → "File System Access API" → **Enabled** → restart.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Add a Groq API key" | Settings → General → paste key → **Save**. Save is disabled while the key field is empty. |
| Island won't open | The shortcut is `⌘⇧Space` / `Ctrl+Shift+Space`. Content scripts don't run on `chrome://` pages, the Chrome Web Store, or PDF viewers. |
| Voice says "permission" | Grant it on the **Settings** page, not on a website. That's the only page that can ask. |
| Folder chip says "Reconnect" | Chrome drops folder permission on every restart. One click restores it; Tidra cannot click it for you. |
| A click does nothing | Tidra retries once with a trusted CDP click, which shows a "Tidra started debugging this browser" bar. That bar is expected and disappears when the run ends. |
| PDF is missing characters | The PDF writer is Latin-only. Emoji and non-Latin scripts are dropped; Tidra tells you when a lot was lost. |
| A scanned PDF returns nothing | There's no OCR. Scanned pages are pictures of text, not text. |
| Job stalled | The service worker sleeps after ~30s idle; an alarm wakes it every minute and resumes from stored state. Give it 60s before assuming it's dead. |

More detail in [docs/user-guide.md](docs/user-guide.md#troubleshooting).

---

## Adding a feature

When you build something new, **update the docs in the same commit**. The short version:

1. Add a row to **[docs/features.md](docs/features.md)** — that's the master list.
2. Add a line to **[CHANGELOG.md](CHANGELOG.md)** under `Unreleased`.
3. Update the specific doc it touches (settings, skills, reference…).

The full checklist, with templates to copy-paste, is in
**[docs/adding-a-feature.md](docs/adding-a-feature.md)**.
