# Tidra — extension

The browser extension itself. Built with [WXT](https://wxt.dev) + React + TypeScript.

**📖 All documentation lives in [`../docs/`](../docs/).** Start at the
[root README](../README.md).

---

## Commands

```bash
npm install
npm run dev          # launches Chrome with the extension loaded + hot reload
npm run dev:firefox  # same, for Firefox
npm run build        # production build → dist/chrome-mv3
npm run zip          # packaged .zip for store upload
npm run compile      # tsc --noEmit — the only check that exists; run it before committing
```

## Load an unpacked build

1. `npm run build`
2. `chrome://extensions` → **Developer mode** on → **Load unpacked**
3. Select `extension/dist/chrome-mv3`

Then open a new tab → **⚙ gear** → paste a Groq API key from
[console.groq.com/keys](https://console.groq.com/keys) → **Save**.

## Layout

| Path | Role |
| --- | --- |
| `wxt.config.ts` | Manifest, permissions, the keyboard command |
| `entrypoints/background.ts` | The brain — routing, the agent loop, jobs, routines |
| `entrypoints/content/Island.tsx` | The island UI (React in a Shadow DOM) |
| `entrypoints/content/actions.ts` | The DOM engine — snapshots, refs, clicking, typing |
| `entrypoints/newtab/` | The new-tab home page |
| `entrypoints/options/` | Settings |
| `entrypoints/report/` | The Library — reports and archived chats |
| `entrypoints/offscreen/` | The invisible microphone recorder |
| `lib/` | llm · skills · routine · jobs · folders · library · sitemem · pdf · pdftext · voice · download · cdp · confirm |
| `components/` | Wordmark, rich-text renderer |

Full module map: [../docs/reference.md](../docs/reference.md#module-map).

## Before you change things

[`../docs/architecture.md`](../docs/architecture.md) covers the decisions that are easy to break
without noticing — prefix-cache preservation, ref invalidation on every snapshot, settle timing,
and why confirmation is enforced in five separate layers.

Adding a feature? Follow [`../docs/adding-a-feature.md`](../docs/adding-a-feature.md).
