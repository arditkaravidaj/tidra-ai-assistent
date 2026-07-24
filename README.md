# Tidra

An AI assistant that lives in your browser. A floating "island" reads the page you're on,
answers questions about it, and takes real actions — opening sites, filling forms, drafting
replies — stopping before anything irreversible. Built with [WXT](https://wxt.dev) + React +
[Groq](https://groq.com) (GPT-OSS 120B).

## Features

- **Island** — a draggable pill on every page (`⌘⇧Space` / `Ctrl+Shift+Space`). Ask it
  anything about the page, or tell it to do something. It collapses while it works and
  reports each step ("Opening mail.google.com", "Writing the draft").
- **New tab** — replaces the browser home page with an ask box that answers inline,
  navigates to sites, or searches Google.
- **Actions** — the agent reads the page as an accessibility tree where every interactive
  element has a ref, then clicks and types by ref. Reaches into shadow DOM and iframes.
- **Never sends** — before any irreversible step (send, post, publish, buy, delete) it stops
  and asks for confirmation.
- **Routine** — learns the sites you open at the start of a session, and lets you describe
  what Tidra should do on each. "Start routine" runs them in the background, drafting only.
- **Profile** — optional details you type in yourself, stored locally, used to sign drafts
  and match your voice.

## Development

```bash
npm install
npm run dev        # opens Chrome with the extension loaded + hot reload
```

## Build for manual install

```bash
npm run build      # → .output/chrome-mv3
```

Then in Chrome/Brave/Edge:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `.output/chrome-mv3` folder

## Setup

1. Click the extension icon → **Options** (or the ⚙ inside the island)
2. Paste a Groq API key (get one at [console.groq.com/keys](https://console.groq.com/keys))
3. Open any page → click the pill, or press `⌘⇧Space` / `Ctrl+Shift+Space`

## Architecture

| Path | Role |
| --- | --- |
| `entrypoints/content/Island.tsx` | Island UI — React in a Shadow DOM, isolated from page CSS |
| `entrypoints/content/actions.ts` | The DOM engine: page snapshots, ref registry, clicking and typing |
| `entrypoints/background.ts` | The brain — routes chat vs. action, runs the tool loop, executes routines |
| `entrypoints/newtab/` | The new-tab home page |
| `entrypoints/options/` | Settings — API key, model tier, profile, routine |

### How actions work

The model never matches text against the page. `snapshot()` walks the DOM (into open shadow
roots and same-origin iframes), gives every interactive element a stable `ref`, and returns
an indented tree:

```
# Inbox
button "Compose" [ref_0-4]
textbox "To" value:"" [ref_0-9]
textbox "Message Body" [ref_0-11]
```

The model then acts on refs — `click(ref_0-4)` — so ambiguity is resolved once, in code,
rather than on every call by a substring match. Every action waits for the page to settle
and reports what actually changed, so a click that did nothing says so instead of being
mistaken for success.

## Privacy

Everything is stored in `browser.storage.local` — your API key, chat history, the domains
used for routine learning, and your profile. Nothing is uploaded or synced; there is no
server. Page content and your profile go to the Groq API only as part of a request you
trigger.

## Models

All inference runs on Groq. Which model does what, per cost tier:

| Job | Model | Price / 1M tokens |
| --- | --- | --- |
| Actions (the agent) | `openai/gpt-oss-120b` | $0.15 in / $0.60 out |
| Chat & summaries | `openai/gpt-oss-20b` | $0.075 in / $0.30 out |
| Routing (chat vs. action) | `llama-3.1-8b-instant` | $0.05 in / $0.08 out |

Groq caches matching prompt prefixes automatically — no flag, no fee, 50% off the
cached portion.

## Roadmap

- Push-to-talk voice input (`whisper-large-v3-turbo`)
- Wire the vision fallback to `qwen/qwen3.6-27b` for pages the tree can't describe
