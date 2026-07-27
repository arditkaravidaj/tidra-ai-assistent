# Reference

Exact names, exact values. For the "why", see [architecture.md](architecture.md).

- [Models](#models)
- [Tiers](#tiers)
- [Agent tools](#agent-tools)
- [Content-script actions](#content-script-actions)
- [Runtime messages](#runtime-messages)
- [Storage keys](#storage-keys)
- [Permissions](#permissions)
- [Limits and constants](#limits-and-constants)
- [Module map](#module-map)

---

## Models

All Groq, all hardcoded. Endpoint: `https://api.groq.com/openai/v1/chat/completions`.

| Key | Model ID | Price / 1M | Used for |
| --- | --- | --- | --- |
| `big` | `openai/gpt-oss-120b` | $0.15 / $0.60 | The agent on act runs |
| `small` | `openai/gpt-oss-20b` | $0.075 / $0.30 | Chat, summaries, compaction, distillation |
| `router` | `llama-3.1-8b-instant` | $0.05 / $0.08 | Route classification (5 output tokens) |
| `vision` | `qwen/qwen3.6-27b` | $0.60 / $3.00 | Reading screenshots — **Groq preview model** |
| — | `whisper-large-v3-turbo` | $0.04 / audio hour | Voice transcription (`/audio/transcriptions`) |

Per-call budgets:

| Job | Model | `max_tokens` | `reasoning_effort` |
| --- | --- | --- | --- |
| Main agent loop | tier-dependent | 2048 | `low` when browsing on small |
| Router | `router` | 5 | — |
| Compaction | `small` | 600 | `low` |
| Site-memory distillation | `small` | 500 | `low` |
| Screenshot reading | `vision` | 900 | — |
| Routine site agent | tier `act` | 1500 | `low` |
| Batch planner | tier `act` | 700 | — |
| Batch collector | tier `act` | 2000 | `low` |
| Batch item worker | small or `act` | 1600 | `low` on small |
| Research synthesis | `big` | 1600 | — |
| New-tab streaming answer | tier `chat` | 1024 | — |

Notes: no `temperature` is ever sent on chat completions. `reasoning_effort` is silently dropped
on non-GPT-OSS models. `callModel` retries up to 3 times — immediately on GPT-OSS
`tool_use_failed`, with `700ms × attempt` backoff on 429/5xx. `streamText` does not retry.

---

## Tiers

Stored as `tidraTier`. Default `balanced`; unknown values fall back to it.

| Tier | `chat` | `act` | `actStart` | `router` |
| --- | --- | --- | --- | --- |
| `economy` | small | small | — | llama-3.1-8b-instant |
| `balanced` | small | big | small | llama-3.1-8b-instant |
| `quality` | big | big | — | llama-3.1-8b-instant |

`actStart` means the run begins there and escalates to `act` only when it stalls.

---

## Agent tools

Defined in `entrypoints/background.ts`. `*` = required.

### Navigation and inspection

| Tool | Params | What it does |
| --- | --- | --- |
| `open_url` | `url*`, `new_tab?` | Adds `https://` if missing; reuses an open tab on the same host unless `new_tab`. Waits for load (20s cap), returns a full snapshot. |
| `go_back` | — | Browser back, then snapshot |
| `snapshot` | — | Accessibility tree across up to 12 frames, refs as `ref_<frameId>-<n>` |
| `get_page` | — | Visible text, capped at 15,000 chars |
| `find` | `query*` | Snapshot → small model returns ≤8 matching tree lines, or `NO MATCH` |
| `viewport` | — | Window size and device pixel ratio |
| `focus_background` | — | Activates Tidra's hidden research tab and brings you to it |

### Acting

| Tool | Params | What it does |
| --- | --- | --- |
| `click` | `ref*` | Clicks; retries once as a trusted CDP click if nothing changed |
| `fill` | `ref*`, `text*`, `submit?` | Types into a field. `submit: true` is **refused** unless confirmed or Auto |
| `select` | `ref*`, `option*` | Picks a `<select>` option by value or text |
| `scroll` | `ref?`, `direction?`, `amount?` | Scrolls to an element, or by an amount |
| `click_text` | `text*` | Label-match fallback when there's no ref |
| `type_text` | `text*`, `field?`, `submit?` | Label-match fallback for `fill`; same submit gate |
| `screenshot` | `question?` | Captures the active tab (JPEG q60), asks the vision model |
| `click_at` | `x*`, `y*` | CDP-only trusted click at screenshot coordinates |
| `confirm_action` | `summary*`, `confirm_label?` | Ends the turn and raises the Confirm bar |

### Files

| Tool | Params | What it does |
| --- | --- | --- |
| `create_report` | `title*`, `content*`, `subtitle?` | Saves a markdown report to the Library and opens it |
| `create_pdf` | `content*`, `title?`, `subtitle?`, `filename?` | Builds a PDF and saves it to Downloads |
| `download_file` | `url*`, `filename?` | Downloads a URL, an `img_N` ref, a `data:` or `blob:` URL |
| `list_images` | — | Lists images on the page as `img_1…` with size and alt |
| `list_folder_files` | `folder?`, `path?`, `images_only?`, `depth?`, `sort?` | Lists a connected folder (`depth` 1–5, default 2) |
| `read_folder_file` | `file*`, `folder?` | Reads a text file, or extracts PDF text (20,000-char cap) |
| `attach_file` | `folder?`, `file?`, `ref?` | Attaches a file to the page. ≤20 MB. Picks the next unused file if unnamed. |

### Job-only

| Tool | Params | Where |
| --- | --- | --- |
| `record_items` | `items[]` of `{label*, url?, note?}` | The batch collector |
| `finish_item` | `status*` (`done`/`failed`/`skipped`), `result*` | The batch item worker |

**Excluded per route:** `chat` gets only `create_pdf`, `create_report`, `get_page`. `look` loses
`screenshot`, `click_at`, `confirm_action`, `focus_background`. Routine runs lose all of those
plus `open_url`, `go_back`, `create_pdf`, `create_report`, `download_file`, `list_images`. Job
items lose `screenshot`, `click_at`, `create_report`, `focus_background`; research jobs get only
read-only tools.

---

## Content-script actions

Sent as `{ type: 'tidra-action', action, … }`. Reply is
`{ ok: true, data, coords?, changed? }` or `{ ok: false, error }`.

| Action | Params | Returns |
| --- | --- | --- |
| `ping` | — | `{ url, title }` |
| `get_page` | — | `{ title, url, text }` (16,000-char cap) |
| `snapshot` | — | `{ tree, url, title, truncated }` |
| `click` | `ref` | Report + `coords` + `changed` |
| `fill` | `ref?`, `field?`, `text`, `submit?` | Report + `changed` |
| `select` | `ref`, `option` | Report |
| `scroll` | `ref?`, `amount?`, `direction?` | Report |
| `click_text` | `text` | Report + `coords` + `changed` |
| `type_text` | `field?`, `text`, `submit?` | Report + `changed` |
| `attach_file` | `base64`, `name?`, `mime?`, `ref?`, `append?` | Report + `changed` |
| `list_images` | — | `FoundImage[]` |
| `fetch_asset` | `url` | `{ dataUrl, mime, size }` |
| `save_blob` | `dataUrl`, `filename?` | Report |
| `mark_before` | — | `'ok'` — fingerprints the page before a CDP click |
| `describe_change` | — | Change report + `changed` |
| `viewport` | — | `{ w, h, dpr }` |
| `list_actions` | — | `{ tree }` — legacy alias for `snapshot` |

Delivery retries 10× at 350ms, per frame.

---

## Runtime messages

### To the background

| Type | Payload | Response |
| --- | --- | --- |
| `tidra-ask` | `{ prompt, page: {title,url,text}, intent?, attachments? }` | `{ ok: true }` after the whole run |
| `tidra-route` | `{ prompt, history? }` | `{ route: 'chat'\|'look'\|'act' }` |
| `tidra-stop` | — | — |
| `tidra-job` | `{ action: 'start'\|'approve'\|'pause'\|'resume'\|'cancel'\|'dismiss' }` | `{ ok: true }` |
| `tidra-visit` | `{ domain }` | — |
| `tidra-voice` | `{ action, sid? }` | Relayed from the offscreen document |
| `tidra-voice-result` | `{ state?, text?, error? }` | — (pushed by offscreen) |
| `tidra-transcribe` | `{ audio: base64, mime? }` | `{ ok, text }` or `{ ok: false, error }` |
| `tidra-open-options` | — | — |
| `tidra-open-routine` | — | — |
| `tidra-get-routine` | — | `{ enabled, sites }` |
| `tidra-run-routine` | — | `{ ok: true }` after the routine finishes |

### From the background

| Type | To | Meaning |
| --- | --- | --- |
| `tidra-toggle` | Content script | Open/close the island |
| `tidra-action` | Content script | Run a DOM action |
| `tidra-voice-offscreen` | Offscreen doc | `start` / `stop` / `cancel` recording |

**Attachment shape:** `{ kind: 'image'|'text', name, data, mime }` — base64 without the `data:`
prefix for images, raw text for text.

---

## Storage keys

### `browser.storage.local`

**Configuration**

| Key | Shape | Default |
| --- | --- | --- |
| `tidraGroqKey` | `string` | absent |
| `tidraTier` | `'economy'\|'balanced'\|'quality'` | `balanced` |
| `tidraAuto` | `boolean` | `false` (Manual) |
| `tidraProfile` | `{name,email,role,company,location,languages,about}` | all empty |
| `tidraSkills` | `Skill[]` | the 8 starter skills |

**Conversation**

| Key | Shape |
| --- | --- |
| `tidraChat` | `{ messages: {role:'user'\|'assistant'\|'error', text}[], loading: boolean }` |
| `tidraPending` | `{ label: string } \| null` — drives the Confirm bar |
| `tidraStatus` | `string \| null` — current one-line status |
| `tidraSteps` | `string[]` — last 40 steps |
| `tidraUnread` | `boolean` — an answer arrived while collapsed |
| `tidraOpen` | `boolean` — panel open |

**Island geometry**

`tidraIslandPos` `{x,y}` · `tidraPanelPos` `{x,y}` · `tidraPanelSize` `{w,h}`

**Routine**

| Key | Shape |
| --- | --- |
| `tidraVisits` | `{d: domain, t: epochMs}[]`, max 800 |
| `tidraRoutine` | `{ sites: {domain,url}[], ts } \| null` — the pending "continue?" offer |
| `tidraRoutineEnabled` | `boolean` — only an explicit `false` disables |
| `tidraRoutineHidden` | `string[]` — removed sites |
| `tidraRoutineTasks` | `Record<site, task>` |
| `tidraRoutineManual` | `{domain, url}[]` |
| `tidraRoutineFolders` | `Record<site, folderId>` |
| `tidraRoutineCollapsed` | `boolean` — new-tab panel state |

> ⚠️ These maps are keyed by the **display name** ("Gmail"), not the hostname.

**Jobs**

`tidraJob` (the single job record) · `tidraJobItems:<jobId>:<n>` (item chunks of 50)

**Voice**

`tidraVoiceSid` (`string|null`) · `tidraVoice` (`{sid, state, error?}`) ·
`tidraHeard` (`{sid, text, ts}`)

**Library and memory**

| Key | Shape | Cap |
| --- | --- | --- |
| `tidraReports` | `{id,title,subtitle?,markdown,createdAt,source}[]` | 100 |
| `tidraChatArchive` | `{id,ts,source,title,messages}[]` | 30 |
| `tidraSiteMemory` | `Record<domain, {notes[], recipes[], updated}>` | 40 domains |

**Purged at startup:** `tidraApiKey`, `tidraProvider`, `tidraMcp` — legacy pre-Groq credentials,
deleted so they can never be sent.

### `browser.storage.session`

| Key | Shape |
| --- | --- |
| `tidraAgentTab` | `number` — Tidra's hidden working tab |
| `tidraBg` | `{tabId, url, title, at}` — last research result, fresh for 20 min |

### IndexedDB

`tidra-fs` → store `folders` (keyPath `id`) → `{id, label, name, handle, createdAt, used[]}`.
Connected folders can't go in `storage.local` — a directory handle comes back as `{}`.

---

## Permissions

Declared in `wxt.config.ts`.

| Permission | Why |
| --- | --- |
| `storage` | All state |
| `unlimitedStorage` | Reports, job items, chat archive |
| `activeTab`, `tabs`, `scripting` | Reading and acting on pages |
| `webNavigation` | Enumerating frames for multi-frame snapshots |
| `favicon` | Routine site icons |
| `alarms` | Waking the worker to resume batch jobs |
| `offscreen` | The microphone recorder |
| `downloads` | Saving PDFs and files (a worker has no `<a download>`) |
| `debugger` | Trusted CDP clicks — shows the "Tidra started debugging" bar |
| `host_permissions: <all_urls>` | Content script everywhere, frame enumeration, tab capture, Groq |

**Keyboard command:** `toggle-island` — `Ctrl+Shift+Space`, macOS `Command+Shift+Space`.
**Alarm:** `tidra-job-tick`, every 1 minute.
**No** `contextMenus`, **no** `bookmarks`, **no** `onInstalled` handler.

---

## Limits and constants

| | Value |
| --- | --- |
| Agent steps per pass | 30 (one second wind → 60 max) |
| Routine site agent | 24 steps |
| Batch collector | 16 steps |
| Batch item worker | 12 steps (per-job) |
| Compaction trigger / tail kept | 20 messages / 8 |
| Snapshot node cap | 400 per frame |
| Frames stitched | 12 |
| Page text to the model | 15,000 chars (island) / 16,000 (content script) |
| Attachments per message | 4 |
| Image re-encode | 1024px JPEG q0.75; 96px q0.6 thumbnail |
| Text attachment cap | 512 KB |
| Asset fetch cap | 25 MB |
| File attach cap | 20 MB |
| PDF text extraction cap | 20,000 chars |
| Batch items | 2,000 · 2 attempts · chunks of 50 |
| Research synthesis | 120 items, 60,000-char digest |
| Visits kept | 800 |
| Site memory | 40 domains · 6 notes · 3 recipes |
| Reports / archived chats | 100 / 30 |
| Voice clip | 60s max · 1.2s silence stop · 6s no-speech · 1.2 KB floor |
| Settle | 300ms quiet, 2.5s cap (6s for attach) |
| Job heartbeat staleness | 90s |
| Background context freshness | 20 min |
| Download settle timeout | 20s |

---

## Module map

| File | Role |
| --- | --- |
| `entrypoints/background.ts` | Routing, the agent loop, tool execution, jobs, routines, voice relay |
| `entrypoints/content/index.tsx` | Mounts the island; registers actions in every frame |
| `entrypoints/content/Island.tsx` | The island UI |
| `entrypoints/content/actions.ts` | The DOM engine — snapshots, refs, clicking, typing |
| `entrypoints/content/orb.ts` | ⚠️ WebGL orb — **unused**, see [known issues](features.md#15-known-issues) |
| `entrypoints/newtab/main.tsx` | The new-tab home page |
| `entrypoints/options/main.tsx` | Settings |
| `entrypoints/report/main.tsx` | The Library |
| `entrypoints/offscreen/main.ts` | The invisible microphone recorder |
| `lib/llm.ts` | Groq client, models, tiers |
| `lib/skills.ts` | Slash commands |
| `lib/routine.ts` | Routine helpers, domain names, default tasks |
| `lib/jobs.ts` | Batch job state machine |
| `lib/sitemem.ts` | Per-site learned notes and recipes |
| `lib/folders.ts` | Connected folders (IndexedDB + File System Access) |
| `lib/library.ts` | Reports and archived chats |
| `lib/pdf.ts` | PDF writer |
| `lib/pdftext.ts` | PDF text extractor |
| `lib/voice.ts` | Recording, VAD, Whisper |
| `lib/download.ts` | Getting files onto disk |
| `lib/cdp.ts` | Trusted clicks |
| `lib/confirm.ts` | Parsing printed confirmations (⚠️ call site unreachable) |
| `components/richtext.tsx` | Inline markdown + tables |
| `components/Wordmark.tsx` | The logotype |
