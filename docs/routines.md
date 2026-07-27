# Routines and connected folders

A routine is your morning: the sites you always open, and what you want done on each. Tidra
learns the sites, you write the tasks, and **Start routine** works through them in the
background — drafting only, never sending.

- [How learning works](#how-learning-works)
- [Managing your routine](#managing-your-routine)
- [Running it](#running-it)
- [Connected folders](#connected-folders)
- [Privacy](#privacy)
- [Turning it off](#turning-it-off)

---

## How learning works

Every page you open logs one entry: **the domain and the time**. Nothing else — no URL, no
title, no content.

| Rule | Value |
| --- | --- |
| Entries kept | 800 (oldest dropped) |
| De-duplication | Same domain within 30 seconds counts once |
| A new "session" starts after | A 4-hour gap |
| Domains remembered per session | The first 5 distinct ones |
| Sessions considered | The last 12 (excluding the one you're in) |
| Minimum history | 3 sessions |
| Qualifies for your routine | Appears in **≥50%** of those sessions |
| Sites kept | Top 5, ordered by how early you usually open them |

When a fresh session starts and two or more sites qualify, the new tab offers
**"Continue your routine?"** — one click reopens them all in background tabs.

Learning is on by default and can be switched off in Settings → Routine.

---

## Managing your routine

Two places, slightly different powers:

| | New tab panel | Settings → Routine |
| --- | --- | --- |
| See your sites | ✅ favicon chips | ✅ rows with tasks |
| Add a site | ✅ **Add** | ✅ **+ Add site** |
| Edit a task | ✅ click a chip | ✅ **Edit** |
| Remove a site | ✅ ✕ on the chip | ✅ **Remove** |
| Connect a folder | ✅ **Add folder** | ❌ |
| Bind a folder to a site | ✅ in the modal | ❌ |
| Turn learning off | ❌ | ✅ |

Removing a site remembers the removal — a learned site won't creep back in.

### Tasks

Every site has a task written in plain English. Defaults exist for common sites (Gmail: *"Check
for new important emails and draft replies I can review before sending."*), and anything else
falls back to *"Look at X and tell me what's new or needs my attention."*

Write your own — that's where the value is:

```
Check for emails from customers, draft a reply to each one, and tell me
which ones look urgent. Don't touch anything from recruiters.
```

A **default** badge means you haven't written your own yet. Tasks save immediately.

> ⚠️ **Known issue:** the built-in per-site defaults currently never apply to *learned* sites
> due to a key mismatch — they all fall back to the generic task. Sites you add by hand with
> your own task are unaffected. See [features.md → Known issues](features.md#15-known-issues).

---

## Running it

Press **Start routine** on the new tab.

1. Tidra opens the island so you can watch.
2. For each site: opens it in a **background tab** (reusing one you already have open), runs
   the task, and posts a 1–3 sentence report into the chat.
3. At the end it writes one consolidated **"Your routine brief"** report to the Library and
   opens it in a background tab.

**It cannot send anything.** Routine runs are handed a deliberately reduced tool set — no
confirmations, no submitting, no navigating away, no screenshots, no downloads. This is
structural, not a prompt instruction: the tools simply aren't there. Each site gets up to 24
steps.

You need an API key. If a site's bound folder has lost permission, that site's report tells you
to reconnect rather than failing silently.

---

## Connected folders

Let Tidra read a folder on your computer — to attach a file to a page, read a document, or work
through pictures one per day.

**Chrome, Edge and Brave only.** Firefox and Safari have never shipped the File System Access
API. Brave needs `brave://flags` → **File System Access API** → Enabled → restart.

### Connecting

New tab → routine panel → **Add folder** → pick a folder. It appears as a chip.

Tidra can then, when you ask it to:

- **list** the files (names, sizes, dates — up to 2 levels deep by default)
- **read** a text file or extract the text from a PDF (up to 20,000 characters)
- **attach** a file to whatever page you're on (up to 20 MB)

It never writes to your folder and never uploads the whole thing. A file's contents reach Groq
only when you ask Tidra to read that file.

### Reconnecting

**Chrome forgets folder permission every time it restarts.** The folder is still remembered —
only the permission lapses. The chip turns into **Reconnect**; one click restores it.

Tidra cannot click it for you. The browser requires a genuine user gesture, and a background
service worker doesn't have one.

A chip reading **Missing** means the folder was moved, renamed or deleted — click it to pick
again.

### Binding a folder to a routine

In the new tab, click a site chip to open its routine modal, then pick a folder under
**Folder from your computer**. Now the routine can use it:

> "every day, post the next picture from Photos to LinkedIn"

Tidra tracks which files it already used, so "the next one" means a different file tomorrow.

Folders needing repair show as *"(needs reconnecting)"* in the picker. The default option is
*"None — this routine only uses the website."*

**Where it's stored:** connected folders live in **IndexedDB** (`tidra-fs`), not
`browser.storage.local` — a folder handle put through extension storage comes back empty.

---

## Privacy

- Visit logging stores **domain + timestamp only**. Never URLs, never page content.
- Capped at 800 entries.
- Nothing is uploaded or synced. There is no server.
- A routine run sends the pages it opens to Groq the same way a normal request does — but it
  only ever drafts.
- Routine runs deliberately get your **profile** but **not** access to your other connected
  folders, so an unattended run can't reach beyond what you bound to it.

---

## Turning it off

**Settings → Routine → Learn my routine** (uncheck, then **Save**) stops all logging.

**Clear routine data** deletes the learned sites and times immediately.

> ⚠️ It leaves your manually added sites, your saved tasks, and your removed-site list in place.
> See [features.md → Known issues](features.md#15-known-issues).
