# Feature list

**This is the master list. Every feature Tidra has, in one place.**

> 📌 **When you add a feature, add it here first.** Copy the template at the bottom, drop it
> into the right section, then follow [adding-a-feature.md](adding-a-feature.md) for the rest
> of the checklist.

**Status legend:** ✅ shipped · 🚧 partial / rough edges · 🧪 experimental · ❌ known broken · 💤 planned

---

## Contents

1. [Core — asking and acting](#1-core--asking-and-acting)
2. [The island](#2-the-island)
3. [The new tab](#3-the-new-tab)
4. [Safety and confirmation](#4-safety-and-confirmation)
5. [Skills (slash commands)](#5-skills-slash-commands)
6. [Routines](#6-routines)
7. [Connected folders](#7-connected-folders)
8. [Batch jobs](#8-batch-jobs)
9. [Voice](#9-voice)
10. [Files — attachments, PDFs, downloads](#10-files--attachments-pdfs-downloads)
11. [Library — reports and archived chats](#11-library--reports-and-archived-chats)
12. [Memory and personalization](#12-memory-and-personalization)
13. [Settings](#13-settings)
14. [Under the hood](#14-under-the-hood)
15. [Known issues](#15-known-issues)
16. [Not built yet](#16-not-built-yet)
17. [Template for a new feature](#17-template-for-a-new-feature)

---

## 1. Core — asking and acting

### Chat about the page ✅
Ask a question and get an answer from the page you're on. The island attaches the page title,
URL, and up to **15,000 characters** of visible text to every request.
**Use it:** open the island, type, `Enter`.
**Code:** `entrypoints/background.ts` (`handleAsk`, route `chat`) · **Doc:** [user-guide.md](user-guide.md#asking-a-question)

### Act on the page ✅
Tell Tidra to do something and it drives the browser — clicks, types, selects, scrolls,
navigates, uploads. It works from an accessibility tree with a `ref` on every interactive
element, so it acts on a specific element rather than guessing from text.
**Use it:** "open my LinkedIn profile", "fill this form with my details", "reply to this email".
**Code:** `entrypoints/content/actions.ts` + the tool loop in `background.ts` · **Doc:** [architecture.md](architecture.md#how-actions-work)

### Automatic routing ✅
A tiny model (`llama-3.1-8b-instant`, 5 output tokens) decides between three routes on every
request: `chat` (answer from what's already here), `look` (research in a hidden background tab),
`act` (drive the tab in front of you). You can override it with a skill's mode.
**Code:** `background.ts` (`classify`) · **Doc:** [architecture.md](architecture.md#routing)

### Conversation memory ✅
A follow-up knows what came before it. Each turn stores the tool calls it made — including any text
it drafted — so "make it shorter", "no, more formal" or "use the other one" resolve against what
actually happened rather than against the one sentence Tidra said last. Past 12 messages the older
turns are folded into a rolling summary instead of being re-sent in full, and each turn remembers
which page it was asked on.

A bare follow-up also keeps the previous turn's route, so it can't be re-classified onto a hidden
tab halfway through a task. An attached image stays available for 30 minutes.
**Use it:** "reply to this post" → "make it shorter" → "actually make it funnier".
**Code:** `background.ts` (`ChatMsg.trace`, `summariseOverflow`, `inheritRoute`) ·
**Doc:** [architecture.md](architecture.md#between-turns--what-the-next-turn-remembers)

### Reaching hover menus, dropdowns and modals ✅
`hover` opens a menu that only exists under the cursor. `press_key` sends `Escape` to dismiss an
overlay in the way, `ArrowDown`+`Enter` to choose in an autocomplete or combobox, `Tab` to move on.
`clear` empties a field properly. Without these the agent had no verb for a whole class of page, and
looped rather than failing.
**Code:** `entrypoints/content/actions.ts` · **Doc:** [architecture.md](architecture.md#reaching-what-a-click-cant)

### Honest action reports ✅
Every action says what actually changed, and is believed only when it can prove it. `fill` reads the
field back and fails if a React or Lexical editor discarded the write. A click detects the cookie
banner covering it and names it, waits out any navigation it started, and notices a toggle whose
label never moved (Like, Follow, Bookmark) instead of reporting "no visible change" and being
clicked a second time.
**Code:** `actions.ts` (`fingerprint`, `describeChange`, `hitPoint`, `readBack`) ·
**Doc:** [architecture.md](architecture.md#settling-and-change-detection)

### Background research (`look`) ✅
Research-y questions open a **hidden tab** Tidra owns, so your current page is never disturbed.
When it's done it can offer to bring you to what it found (`focus_background`, valid for 20 min).
**Code:** `background.ts` (`ensureAgentTab`, `tidraBg` session key)

### Live step trail ✅
While Tidra works, the collapsed island shows a one-line status ("Opening mail.google.com"),
and the open panel has an expandable list of the last 40 steps.
**Code:** `tidraStatus` + `tidraSteps` storage keys

### Stop ✅
Cancel any in-flight run — the ■ on the collapsed island, or the send button while it's working.
**Code:** `tidra-stop` message → `AbortController`

### Model escalation ✅
On the Balanced tier, act-runs *start* on the 20B model and switch to 120B automatically after
two useless rounds, or after 12 steps. The island says "Thinking harder" when it does.
**Code:** `background.ts` (`badStreak`, `canEscalate`) · **Doc:** [architecture.md](architecture.md#the-model-cascade)

### Screenshot fallback 🧪
When the accessibility tree can't describe something (a canvas, an image-only UI), Tidra can
capture the tab and ask a vision model about it, then click by coordinates.
**Caveat:** the vision model `qwen/qwen3.6-27b` is a Groq **preview** model that may be
withdrawn at short notice. Active tab only.
**Code:** `background.ts` tools `screenshot` + `click_at`

### Trusted clicks ✅
Content-script clicks are `isTrusted: false` and some apps ignore them. When a click visibly
changes nothing, Tidra retries once through the Chrome DevTools Protocol, which is
indistinguishable from a real mouse. Chrome shows a "Tidra started debugging this browser" bar
while attached; it detaches at the end of every run.
**Code:** `lib/cdp.ts`

---

## 2. The island

### Floating pill on every page ✅
Rendered into a Shadow DOM inside the browser's top layer, so page CSS can't touch it and
nothing can cover it. The rest of the page stays clickable around it.
**Open/close:** `⌘⇧Space` / `Ctrl+Shift+Space`, or click the pill.
**Code:** `entrypoints/content/index.tsx`, `Island.tsx`

### Drag to move, drag to resize ✅
Drag the pill anywhere (4px threshold, clamped to the viewport). Drag the panel by its header.
Drag the bottom-right grip to resize — 400×540 default, aspect locked, text scales down below
400px wide. All three positions persist.
**Storage:** `tidraIslandPos`, `tidraPanelPos`, `tidraPanelSize`

### Auto-collapse on send ✅
The panel closes itself when you send, so you can watch the page while Tidra works. The answer
comes back as a tap-to-open card next to the pill. This is deliberate, not a bug.

### Answer cards ✅
Three card types appear beside the collapsed pill: **working** (your request + live status),
**answer** (the reply, with ✕ to dismiss), and **job** (batch progress). Cards clamp to the
viewport so they never clip off-screen.

### Message actions ✅
Every answer gets 👍 **Good response**, 👎 **Bad response**, and **Copy**.
**Caveat:** the thumbs are local-only UI state. They store nothing and send nothing.

### New chat ✅
The ⟳ icon in the header archives the current conversation to the Library, then clears it.
Nothing is destroyed.

### Rich text rendering ✅
Assistant replies render `**bold**`, `*italic*`, `` `code` `` and full markdown **tables**
(horizontally scrollable). Everything else stays plain.
**Code:** `components/richtext.tsx`

### Scroll containment ✅
The panel swallows wheel events so smooth-scroll libraries (Lenis, Locomotive, ScrollSmoother)
on the host page can't hijack scrolling inside Tidra.

---

## 3. The new tab

### Replaces the browser home page ✅
A video background, the Tidra wordmark, and one big ask box.
**Code:** `entrypoints/newtab/main.tsx`

### Smart ask box ✅
One box that is a chat prompt, an address bar, and a search bar. It guesses which you meant —
questions and anything ≥5 words go to chat; a bare domain opens it; everything else goes to
Google. The dropdown always shows both options so you can pick.
**Shortcuts:** `⌘Enter` forces chat · `⇧⌘Enter` forces Google · `↑`/`↓` picks · `Esc` clears.

### Google autocomplete ✅
Up to 4 live suggestions, debounced 130ms, silently skipped when offline or blocked.

### Site shortcuts ✅
A single word matches against your most-visited domains first, then a built-in list (Facebook,
YouTube, Gmail, LinkedIn, GitHub, Notion, Reddit, Instagram, WhatsApp, Amazon, Wikipedia,
ChatGPT, X).

### Streaming answers ✅
Chat answers stream token-by-token into the page. If the model decides it needs the browser,
the conversation hands off to the agent **in the same tab** without flashing a wrong answer
first, and the island picks the thread up on whatever site it opens.

### Profile chip ✅
Shows your name and role, with a popover for the rest. Read-only here — edit it in Settings.

### Chip row ✅
**Start routine** · **New tab** · **Library** · **Skills**.

### Routine panel ✅
Your learned + manual sites as favicon chips, connected folders as folder chips, "Continue your
routine?" when a fresh browsing session is detected. Collapsible; state persists.

---

## 4. Safety and confirmation

### Manual mode (default) ✅
Tidra drafts everything, then stops and asks before it sends, posts, buys or deletes. The
Confirm bar appears both in the open panel and on the collapsed pill, so you never have to open
anything to approve.
**What counts as irreversible:** sending an email, publishing a post, submitting a comment,
purchasing, transferring money, deleting.
**What doesn't:** saving a file, drafting, attaching, reading, collecting.

### Auto mode ✅
Toggle the **Manual / Auto** pill next to the input. In Auto, Tidra completes the job including
the send, without asking. Batch jobs are auto-approved too.
**Storage:** `tidraAuto`

### Hard code gate ✅
Beyond the prompt, submitting is blocked in code. Any `fill`/`type_text` with `submit: true`
is refused outright unless the user explicitly confirmed or Auto mode is on — the model cannot
talk its way past it.
**Code:** `background.ts` (`allowSubmit`)

### Structurally read-only modes ✅
Research runs (`look`), routine runs, and research-mode batch jobs are never handed the tools
that could send anything. It's enforced by which tools exist for that run, not by instructions.

---

## 5. Skills (slash commands)

### Slash menu ✅
Type `/` in the island or the new tab for an autocomplete list. `Tab` completes, `Enter` runs,
`↑`/`↓` picks. Skills with `act` mode show an **acts** badge.

### Starter pack ✅
Seeded on first use: `/summarize`, `/fact-check`, `/translate`, `/outline`, `/draft-reply`,
`/save-pdf`, `/waiting-on`, `/weekly`. **Restore starter pack** in Settings puts them back
without touching your own.

### Custom skills ✅
Name + description + prompt + mode. `{input}` is replaced by whatever you type after the
command; `{history}` by a 7-day digest of domains and times. Saves immediately.
**Limits:** description 120 chars, prompt 4,000 chars.

### Mode override ✅
A skill's mode (**Auto** / **Chat** / **Act**) skips the router entirely.

### Export / import ✅
Skills export to `tidra-skills.json` and import back, merging by name.
**Doc:** [skills.md](skills.md)

---

## 6. Routines

### Automatic learning ✅
Tidra logs the domains you visit (domain + timestamp only, max 800 entries, 30s de-dup).
A new "session" starts after a 4-hour gap. A domain qualifies for your routine when it appears
in **≥50%** of your last 12 sessions, with ≥3 sessions of history. Top 5 kept.
**Off switch:** Settings → Routine → **Learn my routine**.

### "Continue your routine?" ✅
When a fresh session starts and ≥2 sites qualify, the new tab offers to reopen them.

### Start routine ✅
Opens every routine site in a background tab, runs its task, and reports back into the Tidra
chat. **Drafts only — it can never send.** At the end it writes one consolidated
"Your routine brief" report to the Library.

### Per-site tasks ✅
Every site gets a task in plain English. There are built-in suggestions per site; you can
overwrite any of them. Editable from the new-tab panel or Settings → Routine.

### Manual sites ✅
Add any site by hand. Removing a learned site keeps it removed permanently.
**Doc:** [routines.md](routines.md)

---

## 7. Connected folders

### Connect a folder ✅
**Add folder** on the new tab opens the native directory picker. Tidra can then list and read
files in it — names, sizes, text, PDF text — and attach them to pages.
**Chrome / Edge / Brave only.** Brave needs `brave://flags` → File System Access API → Enabled.

### Reconnect after restart ✅
Chrome forgets folder permission on every restart. The chip turns into **Reconnect**; one click
restores it. Tidra cannot do that click for you — it needs a real user gesture.

### Bind a folder to a routine ✅
In the new-tab routine modal, pick a folder for a site. "Every day, post the next picture from
Photos to LinkedIn" then works, because Tidra remembers which files it already used.
**Note:** this control exists only in the new-tab modal, not in Settings.

### Agent tools ✅
`list_folder_files`, `read_folder_file` (PDFs included, up to 20,000 chars), `attach_file`
(≤20 MB, picks the next unused file when you don't name one).
**Storage:** IndexedDB `tidra-fs` — **not** `browser.storage.local`.
**Doc:** [routines.md](routines.md#connected-folders)

---

## 8. Batch jobs

### Automatic detection ✅
"Email all 40 of these", "check every link on this page" — a planner recognises the shape and
builds a job instead of running one long agent turn.

### Item collection ✅
From a **CSV you attach**, from labels the planner extracted, or by an agent that scrolls the
page and records them. Max 2,000 items, deduplicated.

### Approve one, then all ✅
For anything irreversible, Tidra does **item 1 only**, shows you the result, and waits.
"Do all N" runs the rest the same way.

### Progress, pause, resume, stop ✅
A live bar in the island: `12/40 · 1 failed · Acme Corp`. Pause and resume any time.

### Survives the service worker dying ✅
Job state is chunked into storage; an alarm ticks every minute and resumes from where it
stopped. Items interrupted mid-action are flagged **to check**, never silently retried.

### Cost estimate ✅
Shown before the job starts.

### Research mode ✅
"Find the pricing for each of these 30 companies" runs read-only and ends with one synthesized
answer instead of a checklist.
**Doc:** [batch-jobs.md](batch-jobs.md)

---

## 9. Voice

### Talk instead of typing ✅
Press the mic in the island or the new tab. Transcribed with `whisper-large-v3-turbo`
($0.04/hour), language auto-detected.

### Stops when you stop ✅
Voice-activity detection ends the recording ~1.2s after you finish speaking. Pressing the
button again is an override, not the main path. Auto-closes after 6s of nothing, hard cap 60s.

### Silence is never billed ✅
Clips under ~1.2 KB are discarded locally without being sent.

### Auto-send ✅
Transcribed text is appended after anything already typed and sent immediately. Speech always
goes to Tidra, never to Google — unless you dictate a web address, which navigates.

### One permission, everywhere ✅
Grant the mic once on the Settings page. Because the recorder runs at the extension's own
origin (in an invisible offscreen document), that grant covers every website.
**Doc:** [user-guide.md](user-guide.md#voice)

---

## 10. Files — attachments, PDFs, downloads

### Attachments ✅
Up to **4** files per message in the island. Images are re-encoded to a 1024px JPEG for the
model plus a 96px thumbnail for history. Text files up to 512 KB.
**Accepted:** `image/*`, `text/*`, `.md .csv .json .log .ts .tsx .js .py`
**Note:** the new-tab composer's **+** button is labelled "Attach (coming soon)" and is inert.

### PDF generation ✅
`create_pdf` writes a real PDF from markdown — headings, lists, tables, code blocks,
blockquotes, rules, inline formatting — and saves it to Downloads. A4, Helvetica/Courier,
page numbers. No library; hand-written writer, because a service worker has no DOM.
**Limit:** Latin-only. Emoji and non-Latin scripts are silently dropped, and Tidra warns you
when a significant amount was lost.

### PDF reading ✅
`read_folder_file` extracts text from PDFs, including compressed and PDF 1.5+ object streams.
**Limits:** no OCR (a scanned PDF says so instead of returning nothing), no encrypted files,
no LZW-compressed streams.

### Downloads ✅
`download_file` saves anything already on a page — images, attachments, export links —
including `blob:` URLs, which it fetches through the content script because they only exist
inside the page. `list_images` gives the agent real sources (≥32×32, deduped, on-screen first,
max 30).

### Report → PDF ✅
Any report in the Library exports to PDF with one click.

---

## 11. Library — reports and archived chats

### Reports ✅
Anything Tidra writes as a document lands here — `create_report`, and every routine brief.
Markdown renders as real HTML: headings, lists, tables, blockquotes, code fences, links.
**Cap:** 100, newest first.

### Archived chats ✅
Every time you press **New chat**, the old conversation is archived rather than deleted.
Badged **island** or **new tab**. **Continue in Tidra** restores one as the live conversation.
**Cap:** 30, newest first.

### Live updating ✅
A report finished by a background routine appears in an open Library tab without a refresh.

**Open it:** new tab → **Library** chip. **Code:** `entrypoints/report/`, `lib/library.ts`

---

## 12. Memory and personalization

### Profile ✅
Name, email, role, company, location, languages, and free-form notes. Optional, local-only,
used to sign drafts and match your voice. Editable in Settings → Profile, viewable from the
new-tab profile chip. **Clear profile** wipes it immediately.

### Site memory ✅
After a successful action run, a small model distills what it learned about that site into
short notes and a step recipe. The next run on that domain gets them as a hint.
**Caps:** 40 domains (LRU), 6 notes and 3 recipes per domain.
**Seeded knowledge:** Supabase, Firebase Console, Metabase, Google Admin.
**Where it goes:** appended to the newest user message, never the system prompt — that's what
keeps Groq's prefix cache hitting.
**Storage:** `tidraSiteMemory`

### Visit history ✅
Domains and times only, capped at 800. Powers routine learning, new-tab site matching, and the
`{history}` placeholder in skills. Wipeable in Settings → Routine → **Clear routine data**.

---

## 13. Settings

Four tabs — **General**, **Profile**, **Skills**, **Routine**. Deep-linkable
(`options.html?tab=skills`).

- **Groq API key** — the only required setting
- **Microphone** — grant / revoke, with live permission status
- **Model & cost** — Economy / Balanced (default) / Max quality
- **Profile** — 7 optional fields + Clear profile
- **Skills** — full CRUD, export, import, restore starter pack
- **Routine** — learn on/off, per-site tasks, add/remove sites, clear routine data

⚠️ **General, Profile and Routine-toggle changes only apply when you press Save.** Skills and
per-site routine tasks save immediately. Save is disabled while the API key field is empty.

**Doc:** [settings.md](settings.md)

---

## 14. Under the hood

| | |
| --- | --- |
| **Accessibility-tree snapshots** ✅ | Every interactive element gets a stable `ref`; the model acts on refs, not text matches. Max 400 nodes per frame. |
| **Shadow DOM + iframes** ✅ | Walks open shadow roots and same-origin iframes; cross-origin frames are reached through their own content-script instance (up to 12 frames). |
| **Change detection** ✅ | Every action waits for the DOM to go quiet (300ms, 2.5s cap) and reports what actually changed. A click that did nothing says so. |
| **Transcript compaction** ✅ | Long runs are summarized after 20 messages, keeping the last 8. |
| **Snapshot pruning** ✅ | Superseded snapshots are replaced with a one-line placeholder so old page dumps don't fill the context. |
| **Step budget** ✅ | 30 model rounds per pass, with one automatic "second wind" → 60 max. Then it says it ran out of steps. |
| **Prefix-cache preservation** ✅ | The system prompt is deliberately byte-identical across runs so Groq's automatic 50% cache discount keeps applying. |
| **Retry on GPT-OSS tool errors** ✅ | Up to 3 attempts on malformed tool calls; linear backoff on 429/5xx. |
| **Legacy key purge** ✅ | Pre-Groq credentials (`tidraApiKey`, `tidraProvider`, `tidraMcp`) are deleted at startup so they can never be sent. |

**Doc:** [architecture.md](architecture.md) · [reference.md](reference.md)

---

## 15. Known issues

Real defects found in the code, documented honestly rather than papered over.

| | Issue | Effect |
| --- | --- | --- |
| ❌ | **Routine default tasks never apply.** `detectRoutine` returns display names ("Gmail") but `ROUTINE_TASK_DEFAULTS` is keyed by hostname (`mail.google.com`). | Every learned site falls back to the generic "Look at X and tell me what's new" instead of its tailored default. Sites you add manually and give a task to are unaffected. |
| ❌ | **Printed-confirmation recovery is unreachable.** `parsePrintedConfirm` in `lib/confirm.ts` is guarded by a condition that an earlier `return` already covers. | If the model *prints* a confirmation instead of calling the tool, no Confirm bar appears — it shows up as plain text. The parser itself is correct; only the call site is dead. |
| ❌ | **`lib/orb.ts` is dead code.** `mountOrb` (a WebGL shader orb) has no importers. | The visible orb is a plain SVG in `Island.tsx`. Either wire `mountOrb` up or delete the file. |
| 🚧 | **No `Esc` to close the island.** | Only the ✕, the shortcut, or a click outside closes the panel. Users will reach for `Esc` first. |
| 🚧 | **`options/index.html` declares `lang="sq"`** while the page is in English. | Screen readers and translation tools get the wrong language. |
| 🚧 | **`NO_PARALLEL_TOOLS` is exported but unused** in `lib/llm.ts`. | Informational only — either wire it up or mark it as a note. |
| 🚧 | **`statusFor` has a duplicate `case 'list_actions'`** in `background.ts`. | The second one is unreachable. Harmless, but confusing. |
| 🚧 | **"Clear routine data" is partial.** It wipes `tidraVisits` and `tidraRoutine` but leaves `tidraRoutineManual`, `tidraRoutineTasks`, `tidraRoutineHidden`, `tidraRoutineFolders`. | Manual sites and saved tasks survive a "clear". Arguably intended — but it isn't what the dialog says. |

---

## 16. Not built yet

Things that sound like they exist but don't. Listed so nobody documents or promises them.

- **Bookmarks / speed-dial tiles** on the new tab — the top-sites data exists but is only used
  for one-word query matching, never rendered.
- **Widgets** on the new tab.
- **Drag & drop or right-click menus** on the new tab (the manifest has no `contextMenus`).
- **Attachments on the new tab** — the **+** button is labelled "coming soon" and is inert.
- **Speech output.** Deliberate: Tidra never makes a sound.
- **OCR** for scanned PDFs.
- **Tests or linting.** `npm run compile` is the only gate.
- **The `website/` folder** referenced by earlier docs — it does not exist in this repo.

---

## 17. Template for a new feature

Copy this block into the right section above. Keep it to five lines.

```markdown
### Feature name ✅
One or two sentences on what it does, in plain language, from the user's point of view.
**Use it:** the exact steps or the exact UI label to click.
**Limits:** caps, unsupported browsers, anything that will surprise someone. Omit if none.
**Code:** `path/to/file.ts` (`functionName`) · **Doc:** [where the detail lives](user-guide.md)
```

Then finish the rest of [adding-a-feature.md](adding-a-feature.md).
