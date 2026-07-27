# Changelog

All notable changes to Tidra. Newest first.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) ·
Versioning: [SemVer](https://semver.org/spec/v2.0.0.html)

> 📌 **Adding a feature?** Put a line under `[Unreleased]` below, and an entry in
> [docs/features.md](docs/features.md). Full checklist:
> [docs/adding-a-feature.md](docs/adding-a-feature.md).

---

## [Unreleased]

### Added
- Full documentation set — [`docs/`](docs/), a rewritten [README](README.md), and this changelog.

### Changed
- _nothing yet_

### Fixed
- _nothing yet_

### Removed
- _nothing yet_

---

## [0.1.0] — 2026-07-27

First working version. Everything below shipped together; individual entries are listed so
later changes have something to reference.

### Added

**Core**
- **The island** — a draggable, resizable assistant panel on every page, rendered in a Shadow
  DOM inside the browser's top layer. `⌘⇧Space` / `Ctrl+Shift+Space`.
- **Chat about the page** — answers from the page title, URL and up to 15,000 characters of text.
- **Browser actions** — the agent clicks, types, selects, scrolls, navigates and uploads by
  acting on refs from an accessibility-tree snapshot, reaching into shadow DOM and iframes.
- **Automatic routing** — a 5-token classifier picks between `chat`, `look` (hidden research
  tab) and `act` (the tab in front of you).
- **Model cascade** — act runs start on `gpt-oss-20b` and escalate to `gpt-oss-120b` when they
  stall, so the big model is paid for only when it's needed.
- **Live step trail** — a one-line status on the collapsed pill, and the last 40 steps in the
  panel.
- **Stop** — cancel any run in flight.

**Safety**
- **Manual mode** (default) — Tidra stops before sending, posting, buying or deleting and asks.
- **Auto mode** — completes the whole job including the send.
- **Hard code gate** — form submission is refused in code unless the user confirmed or Auto is
  on; the model can't argue past it.
- **Structurally read-only modes** — research runs, routine runs and research jobs are never
  given the tools that could send anything.

**The new tab**
- Replaces the browser home page: video background, profile chip, and one ask box that is a chat
  prompt, an address bar and a search bar at once.
- Google autocomplete, site shortcuts, streaming chat answers, and a seamless hand-off to the
  browser agent in the same tab.
- Chip row: **Start routine**, **New tab**, **Library**, **Skills**.

**Skills**
- Slash commands with autocomplete, `{input}` and `{history}` placeholders, and per-skill mode
  override.
- Starter pack: `/summarize`, `/fact-check`, `/translate`, `/outline`, `/draft-reply`,
  `/save-pdf`, `/waiting-on`, `/weekly`.
- Export and import as JSON; **Restore starter pack**.

**Routines**
- Learns your usual sites from domain-and-time visits only, and offers to reopen them at the
  start of a browsing session.
- Per-site tasks in plain English; manual sites; permanent removal.
- **Start routine** works through every site in the background — drafting only, never sending —
  and writes one consolidated brief to the Library.

**Connected folders**
- Connect a folder from your computer; Tidra can list files, read text and PDFs, and attach them
  to pages. Chrome/Edge/Brave only.
- Bind a folder to a routine, with used-file tracking so "the next picture" means a new one
  each day.

**Batch jobs**
- Automatic detection of batch-shaped requests; items from an attached CSV, extracted labels, or
  a page-reading collector.
- Approve item 1, then run the rest; progress bar with pause, resume and stop; cost estimate up
  front.
- Survives the service worker being killed — chunked state plus a one-minute alarm; interrupted
  irreversible items are flagged **to check**, never silently retried.
- Research mode with a synthesized final answer.

**Voice**
- `whisper-large-v3-turbo` transcription with voice-activity detection — the mic closes when you
  stop talking. Silence is discarded locally and never billed.
- One microphone grant on the Settings page covers every website, via an offscreen recorder at
  the extension's own origin.

**Files**
- Attachments (4 per message, images re-encoded, text up to 512 KB).
- PDF generation from markdown with a hand-written writer — no library, because a service worker
  has no DOM.
- PDF text extraction, including compressed and PDF 1.5+ object streams, with an honest "this is
  a scan" answer instead of silence.
- Downloads, including `blob:` URLs fetched through the content script.

**Library**
- Reports (100) and archived chats (30), stored locally, live-updating, with PDF export and
  **Continue in Tidra**.

**Memory**
- Optional local profile used to sign drafts and match your voice.
- Per-site memory — notes and step recipes distilled after a successful run, capped at 40
  domains.

**Settings**
- Four tabs: General (API key, microphone, model tier), Profile, Skills, Routine.

**Under the hood**
- Trusted CDP clicks as an automatic retry when a synthetic click changes nothing.
- Transcript compaction and snapshot pruning to keep long runs affordable.
- Groq prefix-cache preservation — per-run context goes in the newest user message, never the
  system prompt.
- Legacy pre-Groq credential keys purged at startup.

### Known issues at this version

Tracked in [docs/features.md → Known issues](docs/features.md#15-known-issues):

- Built-in per-site routine tasks never apply to *learned* sites (display-name vs hostname key
  mismatch).
- The printed-confirmation fallback in `lib/confirm.ts` has an unreachable call site.
- `lib/orb.ts` (`mountOrb`) is dead code.
- `Esc` does not close the island.
- `options/index.html` declares `lang="sq"` on an English page.
- **Clear routine data** leaves manual sites, saved tasks and hidden sites in place.

[Unreleased]: #unreleased
[0.1.0]: #010--2026-07-27
