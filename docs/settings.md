# Settings

Open it from the ⚙ gear on the new tab, the ⚙ in the island header, or the extension icon.
Direct URL: `options.html`. Deep-link a tab with `options.html?tab=skills`.

> ⚠️ **General, Profile and the routine toggle only save when you press Save.**
> **Skills** and **per-site routine tasks** save immediately. The **Save** button is disabled
> while the API key field is empty.

Four tabs: [General](#general) · [Profile](#profile) · [Skills](#skills) · [Routine](#routine)

---

## General

### Groq API key

| | |
| --- | --- |
| **Field** | Password input, placeholder `gsk_…` |
| **Default** | Empty |
| **Required** | Yes — nothing works without it |
| **Stored as** | `tidraGroqKey` in `browser.storage.local` |

Get one at [console.groq.com/keys](https://console.groq.com/keys). It is stored only in this
browser and sent only to `api.groq.com`. Whitespace is trimmed on save.

### Microphone

A live status row, not a stored setting — the state comes from the browser's permission API.

| State | What you see |
| --- | --- |
| Not yet asked | **Allow microphone** button |
| Granted | "allowed. You can talk to Tidra on any site." + **Remove access** |
| Blocked | "blocked. Allow it for this page in the address bar, then reload." |

**This page is the only place the grant can be given.** The recorder is an invisible offscreen
document and the island is a content script — neither can show a permission prompt. Because the
grant belongs to the extension's own origin, one click covers every website.

Tidra takes the grant and immediately releases the audio tracks, so no recording light stays on.

**Remove access** opens Chrome's site-details page for the extension. If your browser refuses to
open it from here, use the icon in the address bar on this page and set Microphone to Block.

### Model & cost

Three mutually exclusive tiers. **Default: Balanced.** Stored as `tidraTier`.

| Option | Chat | Actions | Notes |
| --- | --- | --- | --- |
| **Economy** | `gpt-oss-20b` | `gpt-oss-20b` | $0.075 / 1M in. Cheapest, least capable on hard action runs. |
| **Balanced** *(default)* | `gpt-oss-20b` | starts on `20b`, escalates to `120b` | Recommended. You pay the big model's price only when a run actually stalls. |
| **Max quality** | `gpt-oss-120b` | `gpt-oss-120b` | $0.15 / 1M in. Best on complex multi-step tasks. |

Two models are **not** selectable:

- **Routing** always runs on `llama-3.1-8b-instant` — it only ever emits one word.
- **Screenshot reading** always uses `qwen/qwen3.6-27b`, a Groq *preview* model that may be
  withdrawn at short notice.

More on how escalation works: [architecture.md](architecture.md#the-model-cascade).

---

## Profile

Everything here is **optional** and **local only** — it is never uploaded, never synced, and
Tidra never collects any of it on its own. It's used while Tidra is doing something you asked
for: signing a draft, replying in your language.

| Field | Placeholder | Used for |
| --- | --- | --- |
| **Name** | `e.g. Ardit` | Signing drafts, addressing you |
| **Email** | `e.g. you@company.com` | Filling forms, identifying your own messages |
| **Role** | `e.g. Founder` | Tone and context in drafts |
| **Company** | `e.g. Huncher` | Same |
| **Location** | `e.g. Berlin (CET)` | Times, dates, scheduling |
| **Languages** | `e.g. English, German` | Which language to reply in |
| **Anything Tidra should know** | `e.g. Reply briefly and warmly. I write in English and German. Sign off as "Ardit".` | Free-form style instructions |

All fields are free text with no validation. Default: empty. Stored as `tidraProfile`.

### Clear profile

Opens a confirm dialog — *"Every field you filled in will be deleted from this browser. This
cannot be undone."* Takes effect **immediately**; no Save needed.

---

## Skills

Full reference: **[skills.md](skills.md)**.

Each row shows `/name`, its description, its mode badge, and **Edit** / **Delete**.

**Editor fields**

| Field | Rules |
| --- | --- |
| **Name** | Lowercased, non-alphanumerics become dashes. Must be unique. |
| **Description** | One line shown in the menu. Truncated to 120 chars. |
| **Prompt** | Required. Max 4,000 chars. Supports `{input}` and `{history}`. |
| **Mode** | **Auto** (default) / **Chat** / **Act** |

**Toolbar**

| Button | What it does |
| --- | --- |
| **+ Add skill** | New blank skill |
| **Export** | Downloads `tidra-skills.json` |
| **Import** | Merges a JSON file — a skill with the same name replaces the existing one |
| **Restore starter pack** | Puts the 8 built-ins back **without touching your own skills** |

Changes here save immediately. Stored as `tidraSkills`.

---

## Routine

Full reference: **[routines.md](routines.md)**.

### Learn my routine

| | |
| --- | --- |
| **Type** | Checkbox |
| **Default** | **On** (only an explicit off disables it) |
| **Stored as** | `tidraRoutineEnabled` |
| **Saved by** | The **Save** button |

Suggests reopening your usual sites when you start browsing. **Only domains and times are
stored** — no URLs, no page content, capped at 800 entries. Turning it off stops all logging
immediately.

### Clear routine data

Confirm dialog — *"The sites and times Tidra learned will be deleted from this browser, and it
will start learning your routine from scratch."* Immediate, no Save needed.

> ⚠️ It clears `tidraVisits` and the pending routine prompt, but **keeps** your manually added
> sites, your per-site tasks, and your removed-site list. See
> [features.md → Known issues](features.md#15-known-issues).

### Your routine

Lists every site in your routine — learned and manual — with its task.

| Control | What it does |
| --- | --- |
| **+ Add site** | Website (`e.g. gmail.com`) + task. A domain with no dot is rejected. |
| **Edit** | Change that site's task. Saves immediately. |
| **Remove** | Hides the site permanently — a learned site won't come back. |
| **default** badge | You haven't written your own task; the built-in suggestion is being used. |

> The **folder binding** control (attaching a connected folder to a site's routine) exists only
> in the new-tab routine modal, not here.

---

## Everything Settings writes

| Key | Written by | Saved |
| --- | --- | --- |
| `tidraGroqKey` | General | On **Save** |
| `tidraTier` | General | On **Save** |
| `tidraProfile` | Profile | On **Save** |
| `tidraRoutineEnabled` | Routine | On **Save** |
| `tidraSkills` | Skills | Immediately |
| `tidraRoutineTasks` | Routine | Immediately |
| `tidraRoutineManual` | Routine | Immediately |
| `tidraRoutineHidden` | Routine | Immediately |
| `tidraVisits`, `tidraRoutine` | Clear routine data | Immediately |

Full key inventory: [reference.md](reference.md#storage-keys).
