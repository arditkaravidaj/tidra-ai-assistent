# Adding a feature

**Every new feature gets documented in the same commit that builds it.** Not "later" — later is
how docs rot until nobody trusts them.

This page is the checklist. It takes about five minutes.

---

## The 30-second version

1. Add an entry to **[features.md](features.md)** ← the master list
2. Add a line to **[../CHANGELOG.md](../CHANGELOG.md)** under `## [Unreleased]`
3. Update whichever detail doc it touches

That's it. Everything below is just the detail.

---

## Step 1 — features.md (always)

Open [features.md](features.md), find the right section, and paste this in:

```markdown
### Feature name ✅
One or two sentences on what it does, in plain language, from the user's point of view.
**Use it:** the exact steps or the exact UI label to click.
**Limits:** caps, unsupported browsers, anything that will surprise someone. Omit if none.
**Code:** `path/to/file.ts` (`functionName`) · **Doc:** [where the detail lives](user-guide.md)
```

**Rules that keep this list useful:**

- **Five lines maximum.** The detail belongs in the topic doc, not here.
- **Write what the user sees**, not what the code does. "Drag the pill anywhere" beats
  "persists position to `tidraIslandPos`".
- **Quote UI labels exactly.** If the button says "Do all 40", write "Do all 40".
- **State the limits.** Every cap, every unsupported browser, every silent truncation. This is
  the section people actually reread.
- **Pick an honest status:** ✅ shipped · 🚧 partial · 🧪 experimental · ❌ broken · 💤 planned.
  Shipping something rough as 🚧 is fine. Shipping it as ✅ is not.

If there's no section that fits, add one — and add it to the contents list at the top.

---

## Step 2 — CHANGELOG.md (always)

Add one line under `## [Unreleased]`, in the right group:

```markdown
### Added
- **Feature name** — one sentence. ([docs](docs/features.md#anchor))
```

Groups: `Added` · `Changed` · `Fixed` · `Removed`.

---

## Step 3 — the detail doc (usually)

Match your feature to its home:

| If it's… | Document it in |
| --- | --- |
| Something the user clicks or types | [user-guide.md](user-guide.md) |
| A new setting or option | [settings.md](settings.md) — **and** the settings table at the bottom |
| A new slash command or skill behavior | [skills.md](skills.md) |
| Routine or connected-folder behavior | [routines.md](routines.md) |
| Batch job behavior | [batch-jobs.md](batch-jobs.md) |
| A design decision or a non-obvious mechanism | [architecture.md](architecture.md) |

Some features touch two. Most touch one.

---

## Step 4 — reference.md (when you added a moving part)

Update it if you added or changed any of these — it's the "exact names, exact values" doc, and
stale values there are worse than no values:

- [ ] A new **agent tool** → [Agent tools](reference.md#agent-tools)
- [ ] A new **content-script action** → [Content-script actions](reference.md#content-script-actions)
- [ ] A new **runtime message** → [Runtime messages](reference.md#runtime-messages)
- [ ] A new **storage key** → [Storage keys](reference.md#storage-keys)
- [ ] A new **permission** → [Permissions](reference.md#permissions) *(and say why)*
- [ ] A new **cap, timeout or budget** → [Limits and constants](reference.md#limits-and-constants)
- [ ] A new **model or price change** → [Models](reference.md#models)
- [ ] A new **file in `lib/` or `entrypoints/`** → [Module map](reference.md#module-map)

---

## Step 5 — the README (rarely)

Only touch [../README.md](../README.md) when the feature is big enough to change the pitch:

- It belongs in the **What Tidra can do** table (one row, one emoji)
- It changes **setup**, **browser support**, or **cost**
- It's a common enough failure to earn a **troubleshooting** row

Most features don't qualify. Resist.

---

## Finished-feature checklist

```
[ ] features.md      — entry added, honest status, limits stated
[ ] CHANGELOG.md     — one line under Unreleased
[ ] topic doc        — user-guide / settings / skills / routines / batch-jobs
[ ] reference.md     — tools, actions, messages, keys, permissions, limits
[ ] README.md        — only if it changes the pitch, setup, or support matrix
[ ] npm run compile  — passes
```

---

## Also worth doing

**Fixed something in [Known issues](features.md#15-known-issues)?** Delete the row. Add a
`### Fixed` line to the changelog. Don't leave a fixed bug documented as broken.

**Built something in [Not built yet](features.md#16-not-built-yet)?** Move it up into the real
section as a proper entry.

**Found a new defect and shipping anyway?** Add it to Known issues. An honest known issue is
worth more than a silent one, and it's the first place anyone looks when something behaves oddly.

**Cut a release?** Rename `## [Unreleased]` to `## [0.2.0] — 2026-01-15` in the changelog, bump
`version` in `extension/package.json`, and open a fresh `Unreleased` block above it.

---

## Writing style

The existing docs follow a few conventions. Matching them costs nothing and keeps the set
readable as one thing.

- **Second person, present tense.** "Press the mic and talk," not "the user may then activate."
- **Tables for anything with more than three parallel facts.** Prose for everything else.
- **Backtick real identifiers** — `tidraGroqKey`, `snapshot()`, `create_pdf`.
- **Bold real UI labels** — **Do all 40**, **Add folder**, **Restore starter pack**.
- **`⚠️` for anything that will bite someone.** Use it sparingly enough that it still means
  something.
- **Never document what you haven't verified.** If you're not sure a cap is 400 or 500, go read
  the constant. A confidently wrong number in these docs is worse than an omission — someone
  will build on it.
