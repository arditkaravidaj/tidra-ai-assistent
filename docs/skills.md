# Skills (slash commands)

A skill is a saved prompt with a name. Type `/` anywhere in Tidra and pick one.

- [Using a skill](#using-a-skill)
- [The starter pack](#the-starter-pack)
- [Writing your own](#writing-your-own)
- [Placeholders](#placeholders)
- [Modes](#modes)
- [Sharing skills](#sharing-skills)
- [Limits](#limits)

---

## Using a skill

Type `/` in the island or the new-tab ask box. A menu appears with every matching skill.

| Keys | Action |
| --- | --- |
| `↑` / `↓` | Move the selection |
| `Tab` | Complete the name |
| `Enter` | Run it (completes first if you're still mid-name) |

Anything you type after the command is passed to the skill:

```
/translate into German
/fact-check the claims about battery life
/summarize
```

A skill only triggers at the **start** of the message — `1/2` and `https://…` never match.

Skills with an **acts** badge use the browser agent: they'll click and type on real pages.

---

## The starter pack

Seeded on first use. You own them after that — edit or delete freely.
**Restore starter pack** in Settings → Skills brings them back without touching your own.

| Command | Mode | What it does |
| --- | --- | --- |
| `/summarize` | Chat | Summarize the current page |
| `/fact-check` | Chat | Fact-check the claims on this page |
| `/translate` | Chat | Translate the page or the given text |
| `/outline` | Chat | Quick essay or post outline for any topic |
| `/draft-reply` | **Act** | Open the reply box and draft a response to what's on screen |
| `/save-pdf` | **Act** | Save the current page as a clean PDF |
| `/waiting-on` | **Act** | Opens Gmail then LinkedIn messages — who is still waiting on you |
| `/weekly` | Chat | A light recap of your browsing week (uses `{history}`) |

---

## Writing your own

Settings → **Skills** → **+ Add skill**.

| Field | Notes |
| --- | --- |
| **Name** | Lowercased automatically; spaces and underscores become dashes; anything else is stripped. Must be unique. |
| **Description** | One line, shown in the menu. Max 120 characters. |
| **Prompt** | What Tidra should actually do. Max 4,000 characters. |
| **Mode** | Auto (default), Chat, or Act |

Changes save immediately — there's no Save button on this tab.

**Example**

```
Name:        standup
Description: Turn my notes into a standup update
Mode:        Chat
Prompt:      Turn the following into a three-line standup update —
             yesterday, today, blockers. Keep it plain and short.

             {input}
```

Then: `/standup shipped the PDF writer, starting on batch jobs, blocked on the Groq rate limit`

---

## Placeholders

| Placeholder | Replaced with |
| --- | --- |
| `{input}` | Whatever you typed after the command |
| `{history}` | A 7-day digest of the domains you visited, grouped by day, top 8 per day, as `domain ×N` |

If your prompt has **no** `{input}` but you typed something anyway, it's appended at the end.

`{history}` contains **domains and times only** — never URLs, never page content. If routine
learning is off or was recently cleared it says so honestly rather than returning nothing.

---

## Modes

A skill's mode **overrides the router** — that's most of the point of having one.

| Mode | Behavior | Use for |
| --- | --- | --- |
| **Auto** *(default)* | The router decides | General-purpose skills |
| **Chat** | Answers from the page text and what the model knows. Never touches the page. | Summarizing, translating, explaining |
| **Act** | Straight to the browser agent — clicking, typing, navigating | Drafting replies, saving PDFs, multi-site tasks |

Picking **Chat** or **Act** also skips a routing call, so the skill starts faster.

---

## Sharing skills

**Export** downloads `tidra-skills.json`:

```json
{
  "tidra": "skills",
  "version": 1,
  "skills": [
    { "id": "standup", "name": "standup", "description": "…", "prompt": "…", "mode": "chat" }
  ]
}
```

**Import** accepts that file, or a bare array of skills. Skills merge by **name** — an imported
skill with the same name replaces yours. You'll see "Imported N skills." or one of:

- "That file is not valid JSON."
- "That file does not look like a Tidra skills export."
- "No usable skills found in that file."

---

## Limits

| | |
| --- | --- |
| Name | `a–z`, `0–9`, `-`; must start with a letter or digit |
| Description | 120 characters |
| Prompt | 4,000 characters |
| Trigger | Leading `/` only |
| Storage | `tidraSkills` in `browser.storage.local` |
| Code | `lib/skills.ts` |
