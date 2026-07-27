# Architecture

How Tidra is built, and why. Read this before changing `background.ts` or `actions.ts` — both
encode decisions that are easy to break without noticing.

- [The shape of it](#the-shape-of-it)
- [Routing](#routing)
- [The agent loop](#the-agent-loop)
- [The model cascade](#the-model-cascade)
- [Context management](#context-management)
- [How actions work](#how-actions-work)
- [Trusted clicks](#trusted-clicks)
- [The island's UI isolation](#the-islands-ui-isolation)
- [Confirmation, in five layers](#confirmation-in-five-layers)
- [Durable jobs](#durable-jobs)
- [Voice and the offscreen document](#voice-and-the-offscreen-document)
- [Files](#files)
- [Design rules worth preserving](#design-rules-worth-preserving)

---

## The shape of it

```
┌─────────────────────────────────────────────────────────────────┐
│  entrypoints/background.ts — the brain (MV3 service worker)     │
│  routing · agent loop · jobs · routines · downloads · voice relay│
└────┬───────────────┬──────────────┬──────────────┬──────────────┘
     │               │              │              │
     │ tidra-action  │ storage.local│              │ HTTPS
     ▼               ▼              ▼              ▼
┌──────────┐  ┌────────────┐  ┌──────────┐  ┌───────────────┐
│ content/ │  │  newtab/   │  │offscreen/│  │ api.groq.com  │
│ Island   │  │  options/  │  │   mic    │  └───────────────┘
│ actions  │  │  report/   │  └──────────┘
└──────────┘  └────────────┘
```

**Nothing talks to Groq except the background** (and the new tab, for its own streaming answers,
and the offscreen document, for Whisper). Content scripts can't — the host page's CSP applies to
them.

**`browser.storage.local` is the state bus.** The background writes `tidraChat`, `tidraStatus`,
`tidraSteps`, `tidraJob`; every UI surface subscribes to `storage.onChanged` and re-renders. The
island doesn't await a response from a request — it fires and lets storage carry the result
back. That's what makes a run survivable when the service worker dies mid-way, and what lets a
conversation started on the new tab continue on whatever site the agent opens.

---

## Routing

Every request is classified into one of three routes before anything else happens.

| Route | Where it runs | Tools | Used for |
| --- | --- | --- | --- |
| `chat` | Nowhere — answers from context | `create_pdf`, `create_report`, `get_page` | "summarize this", "what does this mean" |
| `look` | A hidden tab Tidra owns | Everything except `screenshot`, `click_at`, `confirm_action`, `focus_background` | "compare X and Y", research |
| `act` | The tab you're looking at | Everything | "reply to this", "fill the form" |

The classifier is `llama-3.1-8b-instant` with `max_tokens: 5` — it emits one word. The last 4
messages of history are included, truncated to 200 chars each. Anything that throws falls back
to `act`.

**Order of precedence:**

1. A **skill** with an explicit mode wins outright.
2. A **batch request** is intercepted before routing (see [batch-jobs.md](batch-jobs.md)).
3. A **bare follow-up inherits the previous turn's route** (`ChatState.route`).
4. Otherwise the classifier decides.

### Why follow-ups inherit

`inheritRoute()` returns the last route when the message is short (<= 80 chars), reads like a
continuation (a pronoun, or an opening "no"/"ok"/"and"), and does **not** name a browser action.

This is not an optimisation. Re-classifying "make it shorter" on its own could come back `look` —
and a look runs on a hidden tab *and* strips the current page out of the prompt. A follow-up to an
act-run would then wake up somewhere else, with no page and no idea what it had been doing. From
the outside that is indistinguishable from amnesia.

The `ACTION_VERB` escape hatch matters as much as the rule: "now reply to it" after a chat answer
is a genuinely new request, and must be routed on its merits rather than inherited as `chat`.

`look` runs on a dedicated hidden tab (`tidraAgentTab`, session storage) so your current page
is never disturbed. Where it finished is remembered for 20 minutes in `tidraBg`; within that
window the agent is offered a `focus_background` tool to bring you there.

---

## The agent loop

```
build system prompt + tools for this route
  ↓
loop (max 30 rounds):
  call model
  ├─ stop_reason ≠ tool_use  → push the text, done
  ├─ confirm_action block    → raise the Confirm bar, done
  └─ tool_use blocks         → execute, feed results back, repeat
  ↓
out of steps? one "second wind" with a compacted transcript (30 more) → 60 max
```

`max_tokens: 2048`. `reasoning_effort: 'low'` only when browsing on the small model.

Other loops in the codebase, with their own budgets: routine site agent **24** steps, batch item
collector **16**, per-job-item worker **12** (configurable per job).

There are ~23 tools; the exact list with parameters is in
[reference.md](reference.md#agent-tools).

---

## The model cascade

The Balanced tier exists to avoid paying 120B prices for work the 20B model handles fine.

An act-run **starts** on `gpt-oss-20b`. Two counters watch it:

- `badStreak` — rounds where every tool result was an error or said "no visible change" / "stale"
- `guard` — total rounds so far

When `badStreak >= 2` **or** `guard >= 12`, the model switches to `gpt-oss-120b`,
`reasoning_effort` is dropped, and the island shows **"Thinking harder"**.

It never escalates off the vision model — if you attached an image, that run stays on vision.

---

## Context management

### Between turns — what the next turn remembers

A turn used to leave behind exactly one thing: the final sentence it said. Everything else — the
snapshot, the clicks, the text it drafted — lived in the run's local `messages` array and died when
the run returned. So "make it shorter" arrived with nothing to shorten, and the honest description
of what the user experienced is that Tidra had forgotten the conversation.

Three things now survive a turn, all on `tidraChat`:

| | What | Why |
| --- | --- | --- |
| `ChatMsg.trace` | up to 12 tool calls, abbreviated (600 chars for `fill`/`type_text`/`create_report`, 100 for the rest) | So a follow-up can resolve "it", and so the draft itself is still there. Replayed into history as `[What I did that turn: ...]` |
| `ChatMsg.page` | `{title, url}` of where the user was standing | The full page text only ever rides on the newest turn — without this breadcrumb a page referred to two turns later left no trace at all, not even its URL |
| `ChatState.summary` | `{text, covers}` | Everything past the **12-message window**, folded into one paragraph by the small model. `covers` is how much is already in it, so each overflow extends the summary instead of re-reading the whole thread. Folding waits for **6** messages to accumulate — done eagerly it put a blocking network call in front of every turn of a long thread |

`ChatState.route` is kept too — see [Routing](#routing).

> A trace is written once and never rewritten, which is what keeps it cache-safe. A recap that slid
> along with the conversation would rewrite history every turn and cost the prefix cache.

### Within a run

Two mechanisms keep long runs from filling the window with dead weight:

**Snapshot pruning.** Every snapshot-producing tool result except the newest one is replaced
with `[superseded snapshot removed — take a fresh one if you need refs]`. A 400-line page tree
from step 3 is worthless at step 20, and it's the single biggest consumer of context.

**Compaction.** After 20 messages, everything but the last 8 is summarized by the small model
(`max_tokens: 600`), with the cut advanced to the next assistant turn so a tool call is never
separated from its result.

> ⚠️ Compaction rewrites history, which **costs the Groq prefix cache from that point on**.
> It's a deliberate trade, not free.

### Why site memory goes in the user message

Groq gives a 50% discount on cached prompt prefixes, automatically, with no flag. That only
works while the prefix is byte-identical.

So site memory — the notes Tidra learned about how a given site works — is appended to the
**newest user message**, never to the system prompt. Moving it into the system prompt would look
tidier and would silently double the input cost of every run.

**If you add anything per-run to the system prompt, you break this.**

---

## How actions work

The model never matches text against the page. `snapshot()` walks the DOM and gives every
interactive element a stable ref:

```
# Inbox
button "Compose" [ref_0-4]
textbox "To" value:"" [ref_0-9]
textbox "Message Body" [ref_0-11]
```

The model then acts on refs — `click(ref_0-4)`. Ambiguity is resolved once, in code, rather than
on every call by a substring match.

**What the walker does:**

- Descends into **open shadow roots** and **same-origin iframes**.
- Cross-origin frames are unreachable from here, so the content script runs in *every* frame
  (`allFrames: true`) and the background stitches up to **12** frames together, namespacing refs
  as `ref_<frameId>-<n>`.
- Resolves an accessible name through 12 fallbacks: `aria-labelledby` → `aria-label` → `<label>`
  → `placeholder` → `title` → `alt` → button value → SVG `<title>` → nested `img[alt]` → visible
  text → `name` → `data-testid`.
- Emits state bits: `disabled`, `checked`, `expanded`, `selected`, current `value:"…"`, a
  `<select>`'s options, and `offscreen` when the element isn't in the viewport.
- Skips unnamed elements — **except** inputs, selects, textareas and contenteditables, which are
  always listed because an unnamed text field is exactly the thing you need to fill.
- Caps at **400 nodes**, and says so when it truncates.

**Refs are never reused.** Each snapshot clears the registry, but the counter keeps climbing, so a
number is handed out once per page lifetime.

It used to reset to 0. A ref the model was still carrying from an older tree then resolved against
the *new* tree's element at that index — the click succeeded, on the wrong thing, and nothing
anywhere reported a problem. Monotonic numbering turns that silent misfire into an honest
"stale — take a new snapshot".

Superseded snapshots are still pruned from context, for the token cost.

### Settling and change detection

After every action, the content script waits for the DOM to go quiet — a `MutationObserver` that
resolves after **300ms of no mutations**, capped at 2.5s (6s for file attachment, because
previews are slow).

Then it compares a **fingerprint** taken before the action with one taken after, and reports in
plain language. The loud signals first:

- `navigated to https://…`
- `title is now "…"`
- `new on screen: "Send", "Discard"`
- `3 element(s) disappeared`

If none of those fired, the quiet ones are consulted — a control's `aria-checked` /
`aria-expanded` / `aria-selected` / `aria-pressed` / `aria-current` or field length changing, the
interactive-element count changing, the visible text growing or shrinking by more than 20
characters, focus landing somewhere unexpected, the page scrolling more than 40px. Failing all of
that:

- `no visible change — the action may not have registered`

That last string is what drives both the [trusted-click retry](#trusted-clicks) and the
[model cascade](#the-model-cascade). A click that did nothing must never look like success.

### Why the quiet signals exist

Labels alone were not enough, and the gap was doing real damage. Clicking Like leaves a button
still labelled "Like"; ticking a checkbox, opening a menu whose items are named the same,
incrementing a counter — none of them move a label. Every one of those came back "no visible
change", so the trusted-click retry fired and **performed the action a second time**: liked then
unliked, sent twice. It also fed `badStreak` and escalated the run to the expensive model for
nothing. `aria-pressed` in particular is how most toggles on a social site report themselves.

The reverse error is worse, so two things are deliberately excluded from counting as change:

- **The action's own scroll.** `click` brings the element into view *before* the "before"
  fingerprint is taken. Scrolling after the mark made every click report "the page scrolled".
- **The action's own focus.** `describeChange` takes the name of the element the action focused on
  purpose and ignores focus landing there.

Without those two exclusions every click reported `changed: true`, which would have switched the
trusted-click retry off entirely — the exact opposite of the rule above.

### Typing into modern editors

`writeInto()` handles three cases, because none of them work the same way:

- **React-controlled inputs** — sets the value through the prototype setter so React's value
  tracker actually sees the change, then fires `input` + `change`.
- **Lexical / ProseMirror / Draft.js** — selects all and uses `document.execCommand('insertText')`,
  which is the only thing those editors reliably listen to.
- **Plain contenteditable** — falls back to `textContent` + a synthetic `InputEvent`.

`pressEnter()` has a double-send guard: it returns early for composers (where Enter means
newline), and if the page called `preventDefault()` on the keydown it does **not** fall through
to `form.requestSubmit()`.

**Every write is read back.** `fill` and `type_text` re-read the field after settling and fail with
a real error if what came back isn't what went in — "the field did not take the text", or "it is
still empty". They used to report `Typed into "X".` unconditionally, which was a lie roughly as
often as a React-controlled input silently discards a programmatic write. A read-back is skipped
only when `submit` was set, because a sent field is legitimately empty afterwards.

### Reaching what a click can't

`click`/`fill`/`select`/`scroll` cannot express three common page behaviours, and when the model
had no verb for something it did not fail cleanly — it looped taking snapshots of a page whose menu
it could not open:

- **`hover(ref)`** — menus and action rows that only exist under the cursor. If a control isn't in
  the tree at all, this is usually why.
- **`press_key(key, ref?)`** — `Escape` to dismiss a modal or cookie layer that is in the way,
  `ArrowDown` + `Enter` to choose in an autocomplete or combobox (which is how those are picked,
  not by clicking the option), `Tab` to move on. A closed list of keys, not free text.
- **`clear(ref)`** — select-all + delete, then verify. Setting `value = ''` skips the events rich
  editors need and leaves React's tracker believing the old text is still there.

---

## Trusted clicks

Synthetic clicks from a content script are `isTrusted: false`, and some applications check.

When a click reports `changed: false` and it happened in the top frame, the background retries
once through the **Chrome DevTools Protocol** — a real `Input.dispatchMouseEvent` sequence that
is indistinguishable from a mouse.

- Attachment is **lazy**: only `cdpClick` attaches, never startup. Chrome shows a "Tidra started
  debugging this browser" bar the whole time it's attached, so it's dropped (`cdpDetachAll()`)
  in the `finally` of every run, routine and job pump.
- Sub-frames are excluded from the retry because their coordinates are frame-relative.
- `click_at(x, y)` is CDP-only, and divides by the screenshot scale factor so vision-model
  coordinates land in the right place.

**The click point is hit-tested first.** `hitPoint()` tries the element's centre, then points inset
from each edge, and takes the first one where `elementFromPoint` actually returns the element (or a
descendant, or a containing shadow host). If none of them do *and* something else was found on top,
the report names it — "a cookie banner is on top of it" sends the model to close the banner, where
"no visible change" only sent it back to click the same covered pixel again. When every candidate
comes back empty the element simply has no layout, and nothing is claimed: an unmeasurable element
must not be reported as an obstructed one.

---

## The island's UI isolation

Three layers of defence against hostile page CSS:

1. **Shadow DOM** — WXT's `createShadowRootUi`, so page styles can't reach in and Tidra's
   styles can't leak out.
2. **Top layer** — the container is a `popover="manual"` element that's shown immediately, which
   puts it above everything including other `z-index: 2147483647` overlays. Falls back to plain
   stacking on older browsers.
3. **Pointer pass-through** — the full-viewport layer is `pointer-events: none`, and only its
   children re-enable them, so the page stays fully clickable around the island.

Plus: the panel calls `stopPropagation()` on every wheel event, because smooth-scroll libraries
(Lenis, Locomotive, ScrollSmoother) bind window-level handlers that would otherwise scroll the
page while you're scrolling the chat.

---

## Confirmation, in five layers

Prompt instructions alone are not a safety mechanism. Confirmation is enforced five ways:

1. **The system prompt** names what's irreversible: send, publish, submit, purchase, transfer,
   delete.
2. **A code gate.** `fill`/`type_text` with `submit: true`, and `press_key` with `Enter`, return a
   hard refusal unless the user confirmed or Auto mode is on. `allowSubmit` is computed in the
   background, not by the model. The gate is about the *effect*, not the tool: `press_key` was very
   nearly a hole straight through it, because Enter in a composer sends and a key press is not a
   fill.
3. **The `confirm_action` tool** ends the turn and raises the Confirm bar. Approving sends a new
   request prefixed `Confirmed — `, which is the *only* thing that sets `userConfirmed`.
4. **Auto mode** answers a `confirm_action` in-loop with a synthetic approval instead of
   removing the mechanism, so the model's flow is unchanged.
5. **Structural absence.** `look` runs, routine runs and research jobs are never handed the
   tools that could send anything. There is nothing to argue with.

> ⚠️ Layer 3 has a fallback (`lib/confirm.ts`, for when the model *prints* a confirmation
> instead of calling the tool) whose call site is currently unreachable. See
> [features.md → Known issues](features.md#15-known-issues).

---

## Durable jobs

An MV3 service worker dies after ~30 seconds idle. A 200-item job has to survive that.

- Job state lives in `tidraJob`; items are chunked 50 per key.
- `claimNext` writes `doing` to storage **before** doing the work, so a crash is always visible
  afterwards.
- An **alarm** (`tidra-job-tick`, every minute) wakes the worker. If the job's heartbeat is more
  than 90 seconds stale, `reconcile()` runs and the pump restarts.
- The worker also checks for a `running` job on every cold start.
- `reconcile()` treats an interrupted item differently by risk: an irreversible job's item goes
  to **review** ("check whether this one went through"); a reversible one goes back to pending.

Full behaviour in [batch-jobs.md](batch-jobs.md).

---

## Voice and the offscreen document

`getUserMedia` in a content script belongs to the **host page's** origin — a permission prompt
on every new site, and a hard block wherever `Permissions-Policy` forbids it.

So recording happens at the extension's own origin, in an invisible **offscreen document**.
Granted once (on the Settings page, the only page that can show a prompt), it works everywhere.

The offscreen document calls Whisper itself and pushes back only the **text**, rather than
base64-ing audio across the message boundary. Results are pushed, not returned, because when
voice-activity detection fires nobody is awaiting.

**VAD, not push-to-talk.** The mic closes ~1.2s after you stop speaking; the button is an
override. It calibrates the noise floor for 400ms first, then thresholds at
`max(floor × 2.5, 0.012)`. Silence only counts after speech has started. Clips under 1.2 KB are
dropped locally — Groq bills a ten-second minimum, so silence would cost real money.

The level meter uses a `ScriptProcessorNode` rather than `requestAnimationFrame`, because an
offscreen document never paints and its timers are throttled.

---

## Files

**PDF writing** (`lib/pdf.ts`) is a hand-written PDF 1.4 writer — no library. A service worker
has no DOM, and every PDF library assumes one. It uses the 14 built-in Type1 fonts (nothing
embedded), one content stream per page, and a hand-built xref.
**Cost of that choice:** WinAnsi encoding only. Emoji and non-Latin scripts are dropped. The
background counts what was lost and warns the user when it's more than 25%.

**PDF reading** (`lib/pdftext.ts`) scans for objects with a regex rather than following the
xref, so damaged and incrementally-updated files still parse. Handles Flate, ASCII85, ASCIIHex,
PNG predictors, and PDF 1.5+ object streams. Resolves text through `/ToUnicode` CMaps first,
then `/Differences` glyph names, then base encodings. Image codecs are recognised and skipped —
which is how it can tell you honestly that a scan has no text, rather than returning nothing.

**Downloads** (`lib/download.ts`) solve two problems that aren't the download: a worker has no
`URL.createObjectURL`, so generated bytes travel as `data:` URLs; and a `blob:` URL belongs to
the document that made it, so those are fetched *by the content script* and only the bytes come
back. Every download waits for `downloads.onChanged` to report completion, so a failure is never
reported as a win.

**Folders** (`lib/folders.ts`) live in IndexedDB because a `FileSystemDirectoryHandle` is
structured-cloneable but not JSON-serialisable — put one through `chrome.storage` and it comes
back as `{}`.

---

## Design rules worth preserving

If you change one of these, know that you're changing it.

| Rule | Why |
| --- | --- |
| The system prompt stays byte-identical across runs | Groq's automatic prefix cache = 50% off input |
| Per-run context goes in the newest user message | Same reason |
| Fire-and-forget requests, results via storage | Survives the worker dying; lets a thread move between surfaces |
| Every action reports what actually changed | A no-op click must never look like success |
| An action's own scroll and focus don't count as change | Otherwise every click looks successful and the retry never fires |
| `fill` reads the value back | React and Lexical accept a write and discard it often enough that "typed" without looking is a coin flip |
| Refs are never reused | A reused number is a silent click on the wrong element |
| A turn's trace outlives the turn | One sentence of history is not enough to resolve "make it shorter" |
| `allowSubmit` is computed in the background | The model must not be able to talk its way into sending |
| Read-only modes omit tools rather than forbidding them | Structural safety beats prompt safety |
| Superseded snapshots are pruned | Page trees are the biggest context consumer |
| CDP attaches lazily, detaches in `finally` | The "debugging this browser" bar is user-visible |
| Legacy credential keys are purged at startup | Old keys can never be sent to the wrong place |
| Clips under 1.2 KB are never transcribed | Groq bills a ten-second minimum |
| The extension never makes a sound | Deliberate product decision, not an omission |
