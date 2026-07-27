# User guide

How to use Tidra, screen by screen.

- [Setup](#setup)
- [The island](#the-island)
- [Asking a question](#asking-a-question)
- [Telling Tidra to do something](#telling-tidra-to-do-something)
- [Confirmation — Manual vs Auto](#confirmation--manual-vs-auto)
- [Attachments](#attachments)
- [Voice](#voice)
- [The new tab](#the-new-tab)
- [The Library](#the-library)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Troubleshooting](#troubleshooting)

Deeper dives live in [skills.md](skills.md), [routines.md](routines.md),
[batch-jobs.md](batch-jobs.md) and [settings.md](settings.md).

---

## Setup

1. **Build and load the extension** — see the [README](../README.md#quick-start).
2. **Add a Groq API key.** Open a new tab → **⚙ gear** → paste a key from
   [console.groq.com/keys](https://console.groq.com/keys) → **Save**.
   Nothing works without this. Save is disabled while the field is empty.
3. **Grant the microphone** (optional). Settings → General → **Allow microphone**.
   Do this here and nowhere else — this page is the only one that can ask, and one grant covers
   every website.
4. **Pick a tier** (optional). Settings → General → **Model & cost**. Balanced is the default
   and the right answer for almost everyone.

---

## The island

Press `⌘⇧Space` (macOS) or `Ctrl+Shift+Space` (Windows/Linux) on any page. A small pill appears
at the top of the screen.

| Action | How |
| --- | --- |
| Open the panel | Click the pill |
| Move it | Drag the pill anywhere on screen — it stays there |
| Resize the panel | Drag the grip in the bottom-right corner |
| Close | The ✕ in the header, the shortcut again, or click anywhere outside |
| Stop a run | The ■ on the pill while it's working, or the ■ where the send button was |
| Start over | The ⟳ **New chat** icon in the header — the old chat goes to the Library, not the bin |

**It closes itself when you send.** That's intentional: you watch the page, the pill reports
progress, and the answer comes back as a card you tap to open.

The pill will not appear on `chrome://` pages, the Chrome Web Store, or the built-in PDF
viewer — Chrome forbids content scripts there. Use the new tab instead.

### Reading the pill

| What you see | What it means |
| --- | --- |
| Just the orb | Idle |
| Orb + text + dots | Working; the text is the current step |
| A card with your question | Working — tap to watch it think |
| A card with an answer | Done — tap to read, ✕ to dismiss |
| A card with `12/40` | A batch job is running |
| ✕ / ✓ buttons on the pill | Tidra is waiting for you to confirm something |

---

## Asking a question

Open the island, type, press `Enter`. (`Shift+Enter` gives you a newline.)

Tidra always sees the page you're on — title, URL, and up to 15,000 characters of visible text.
So "summarize this", "what's the refund policy here", "is this claim true" all work with no
extra context.

Answers support **bold**, *italic*, `code` and full tables. Under each answer you get
👍 / 👎 / **Copy**. The thumbs are cosmetic — nothing is stored or sent anywhere.

**Research questions** ("compare the pricing of X and Y") open a hidden tab Tidra owns, so your
current page is never touched. When it finishes it may offer to take you to what it found.

---

## Telling Tidra to do something

Just say it in plain language:

- "open my LinkedIn profile"
- "reply to this email saying I'll be there Thursday"
- "fill this form with my details"
- "download every image on this page"
- "save this article as a PDF"

Tidra reads the page as a tree of interactive elements, each with an ID, and acts on specific
elements rather than guessing from text. After every action it checks what actually changed — a
click that did nothing is reported as doing nothing, not as success.

When a click silently fails (some apps ignore synthetic clicks), Tidra retries once with a
"trusted" click through the DevTools Protocol. Chrome shows a **"Tidra started debugging this
browser"** bar while that's active. It's expected, and it goes away when the run ends.

**Expand the step trail** while it works to see every move it makes.

If a task takes more than 30 steps, Tidra gets one automatic second wind (60 total). Past that
it stops and tells you it ran out of steps rather than looping forever.

---

## Confirmation — Manual vs Auto

The pill next to the input reads **Manual** or **Auto**. Click it to switch.

**Manual (default)** — Tidra does everything up to the irreversible step, then stops:

> Confirm before Tidra sends?  ✕ Cancel  ✓ Send

Confirm and it finishes. Cancel and it stops with "Okay — cancelled. Nothing was sent."
The same buttons appear on the collapsed pill, so you never have to open the panel to approve.

**Auto** — Tidra finishes the whole job including the send, without asking. Batch jobs are
auto-approved too.

**What counts as irreversible:** sending an email, publishing a post or tweet, submitting a
comment, purchasing, transferring money, deleting.
**What doesn't:** saving a file, writing a draft, attaching a file, reading, collecting.

This isn't only a prompt instruction. Submitting a form is blocked in code unless you confirmed
or Auto mode is on — the model cannot argue its way around it. Research runs and routine runs
are never given the tools that could send anything in the first place.

---

## Attachments

Click **+** in the island to attach up to **4** files per message.

| Type | What happens |
| --- | --- |
| Images | Re-encoded to a 1024px JPEG for the model, 96px thumbnail kept in your history |
| Text files | Sent as text — up to 512 KB |
| CSV | Also usable as the item list for a [batch job](batch-jobs.md) |

Accepted: `image/*`, `text/*`, `.md`, `.csv`, `.json`, `.log`, `.ts`, `.tsx`, `.js`, `.py`.
Files that can't be read are skipped silently. Attaching an image switches Tidra to the vision
model for that message.

> The **+** on the new-tab composer is labelled "Attach (coming soon)" and does nothing yet.

---

## Voice

Press the 🎤 in the island or on the new tab and talk.

- **It stops on its own** about 1.2 seconds after you finish speaking. Pressing the button again
  is an override, not the normal way to end.
- If you open it and say nothing, it closes after 6 seconds. Hard cap is 60 seconds.
- Clips under ~1.2 KB (a cough, a click) are thrown away locally and never sent, so you're not
  billed for silence.
- What you said is **appended after anything already typed** and sent immediately.
- Speech always goes to Tidra, never to Google — the one exception is dictating a web address,
  which navigates there.
- Language is auto-detected. Tidra replies in whatever language you used.

**Tidra never speaks back.** There's no audio output anywhere, deliberately.

### Permission

Grant it once on **Settings → General → Allow microphone**. That grant belongs to the extension
itself, so it covers every website. Granting on the new tab works too.

You can't grant it from a website — a content script's microphone belongs to the host page,
which would mean a prompt on every new site, and some sites block it outright.

To revoke: Settings → **Remove access**.

| Message | Meaning |
| --- | --- |
| "Tidra needs permission to use your microphone" | Grant it in Settings |
| "No microphone found" | No input device |
| "Add a Groq API key in settings to use voice" | Transcription needs the key |
| "Didn't catch anything — try again" | The clip was silence |
| "This browser won't let Tidra record here" | Use the Tidra new tab for voice on this browser |

---

## The new tab

Tidra replaces your browser's new-tab page.

### The ask box

One box that is a chat prompt, an address bar and a search bar at once. Tidra guesses which you
meant, and the dropdown always shows both so you can override:

| You type | Default |
| --- | --- |
| `why is the sky blue?` | Chat |
| `summarize the news on AI regulation` | Chat (≥5 words) |
| `github.com` | Opens it |
| `github` | Opens GitHub (matched against your top sites, then a built-in list) |
| `weather berlin` | Google |

| Keys | Effect |
| --- | --- |
| `Enter` | Run the highlighted option |
| `↑` / `↓` | Move the highlight |
| `⌘Enter` | Force **Chat** |
| `⇧⌘Enter` | Force **Google** |
| `Esc` | Clear the box |
| `Shift+Enter` | Newline |
| `/` | Skills menu |

Chat answers **stream** into the page. If Tidra decides it needs the browser to answer
properly, it hands off to the agent in the same tab — the conversation continues, and the island
picks it up on whatever site it opens.

### The chips

| Chip | What it does |
| --- | --- |
| **Start routine** | Runs your routine in the background — see [routines.md](routines.md) |
| **New tab** | Opens a new tab |
| **Library** | Your reports and saved chats |
| **Skills** | Jumps to Settings → Skills |

### Profile chip

Top-left: your name and role, with a popover for email, company, location, languages and notes.
Read-only here — **Edit** takes you to Settings.

### Routine panel

Your routine sites and connected folders. Covered in full in [routines.md](routines.md).

---

## The Library

New tab → **Library**. Two tabs:

**Reports** — every document Tidra wrote: `create_report` results and every routine brief
(badged **routine**). Open one to read it as formatted HTML, or **Download PDF**. Capped at 100.

**Chats** — every conversation you archived by pressing **New chat**, badged **island** or
**new tab**. **Continue in Tidra** restores one as your live conversation — then open the island
on any page to keep going. Capped at 30.

Both live-update: a report finished by a background routine appears without a refresh.

---

## Keyboard shortcuts

### Anywhere

| Keys | Action |
| --- | --- |
| `⌘⇧Space` / `Ctrl+Shift+Space` | Open/close the island |

### In the island

| Keys | Action |
| --- | --- |
| `Enter` | Send |
| `Shift+Enter` | Newline |
| `/` | Open the skills menu |
| `↑` / `↓` | Pick a skill (menu open) |
| `Tab` | Complete the skill name |

> `Esc` does **not** close the island. Use ✕, the shortcut, or click outside.

### On the new tab

| Keys | Action |
| --- | --- |
| `Enter` | Run the highlighted option |
| `↑` / `↓` | Move the highlight |
| `⌘Enter` | Force chat |
| `⇧⌘Enter` | Force Google |
| `Esc` | Clear the box |

---

## Troubleshooting

**"Add a Groq API key"**
Settings → General. Paste the key and press **Save** — the key isn't stored until you do.

**The island doesn't appear**
Content scripts can't run on `chrome://` pages, the Chrome Web Store, or the PDF viewer. On a
normal page, check the extension is enabled at `chrome://extensions`. If the shortcut is taken
by another extension, rebind it at `chrome://extensions/shortcuts`.

**Voice won't start**
Grant the mic in Settings, not on a website. If it says blocked, use the icon in the address
bar on the Settings page to allow it, then reload.

**A folder chip says "Reconnect"**
Chrome drops folder permission on every restart. Click the chip. Tidra can't do it for you —
the browser requires a real click from you.

**"Missing" on a folder chip**
The folder was moved, renamed or deleted. Click to pick it again.

**Tidra clicked but nothing happened**
It'll say so — "no visible change — the action may not have registered" — and retry once with a
trusted click. If it still fails, the element is probably in a cross-origin iframe or behind a
custom widget the tree can't see. Ask it to take a screenshot and click by position.

**A batch job looks frozen**
The service worker sleeps after ~30 seconds idle. An alarm wakes it every minute and picks up
from stored state. Wait 60 seconds before assuming something's wrong. Anything interrupted
mid-action is marked **to check** rather than silently retried.

**A PDF is missing characters**
The PDF writer supports Latin characters only. Emoji, Chinese, Arabic, Greek and similar are
dropped. Tidra warns you when a lot was lost.

**A PDF returned no text**
If it's a scan or a photo of a document, the words are pixels, not characters. There's no OCR.

**Everything is slow / expensive**
Switch to **Economy** in Settings → Model & cost. Long action runs cost the most; chat is cheap.
