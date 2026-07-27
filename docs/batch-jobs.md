# Batch jobs

Running the same task over a list — 40 people, 200 rows, every link on a page — without
babysitting it and without a runaway.

- [Starting one](#starting-one)
- [Where the list comes from](#where-the-list-comes-from)
- [Approve one, then all](#approve-one-then-all)
- [Watching and controlling it](#watching-and-controlling-it)
- [Research mode](#research-mode)
- [What happens when the browser sleeps](#what-happens-when-the-browser-sleeps)
- [Limits](#limits)

---

## Starting one

Just ask. Tidra recognises the shape of a batch request and builds a job instead of trying to
do it all in one long agent turn:

- "email everyone in this CSV about the launch"
- "check every link on this page and tell me which are dead"
- "find the pricing page for each of these 30 companies"
- "unsubscribe from all of these newsletters"

It looks for two things together: **plurality** (all / each / every / bulk, or a number ≥3) and
an **action verb**. A question that only reads ("what do all of these say?") is answered
normally instead.

Before anything runs you get a summary in the chat:

> **40 items ready.** Acme Corp, Beta Ltd, Cirrus GmbH…
> Roughly 12 minutes, about $0.14.

---

## Where the list comes from

Three sources, in order of preference:

**1. A CSV you attached.** Tidra detects the header row and picks the most useful column as the
label — an email column first (anything matching `mail`, or a cell containing an email address),
then a name/person/contact/company column, then the first non-empty cell.

**2. Labels the planner extracted** from your request — if you pasted the list inline.

**3. An agent that reads the page** — scrolls, snapshots and records what it finds. Up to 16
steps. If you're already on the right site, it collects there instead of reloading.

Items are deduplicated on their label. If nothing is found, the job is dropped and your request
runs as an ordinary single task.

---

## Approve one, then all

For anything irreversible, Tidra will not fire 40 emails on your say-so alone.

1. It runs **item 1 only**, with instructions to be careful.
2. It reports what it did in the chat: *"This is item 1 of 40 — …"*
3. You see two buttons: **✕ Cancel** and **✓ Do all 40**.
4. Approving runs the remaining 39 the same way, unattended.

Item 1 goes back in the queue, so nothing is skipped.

If the job is harmless (reading, collecting, research), it starts on **▶ Start N** with no
sample step. In **Auto** mode, everything is approved automatically.

The first successfully completed item becomes an **exemplar** — its first 16 steps are given to
later items as a worked example, which lets Tidra run them on the cheaper model.

---

## Watching and controlling it

The job bar appears in the island, and a compact card sits next to the collapsed pill.

```
████████░░░░░░░░  12/40 · 1 failed · Acme Corp
        [ Stop ]  [ Pause ]
```

| State | What you see | Controls |
| --- | --- | --- |
| Building the list | Animated dots | — |
| Ready | `40 items ready.` | ✕ Cancel · ▶ Start 40 |
| Waiting on your approval | `Approve this one and I'll do the other 39 the same way.` | ✕ Cancel · ✓ Do all 40 |
| Running | progress bar + current item | Stop · Pause |
| Paused | `… · paused` | Stop · Resume |
| Finished | `Finished — 38 of 40 · 1 failed · 1 to check` | Dismiss |

**Pause** and **Cancel** take effect between items, not mid-action — an item in flight finishes
first so nothing is left half-done. **Cancel** also closes the job's working tab.

At the end you get a summary listing up to 8 failures and up to 8 items marked **to check**.

Failed items get one automatic retry sweep at the end (2 attempts total) — but only for
reversible jobs. Something irreversible is never silently retried; it's flagged for you.

---

## Research mode

If the task only reads, Tidra runs the job in research mode:

- The page-changing tools are **not given to it at all** — it physically cannot click submit.
- Each item's finding is collected rather than checked off.
- At the end, one synthesized answer instead of a checklist.

> "find the founding year and headquarters for each of these 30 companies"

Up to 120 items are synthesized, from a digest capped at 60,000 characters.

---

## What happens when the browser sleeps

Chrome kills an extension's service worker after ~30 seconds of idle. A 200-item job would die
mid-way.

Tidra handles that:

- Job state and items are written to storage in chunks of 50 as it goes.
- An **alarm fires every minute** and wakes the worker back up.
- If the job's heartbeat is more than 90 seconds stale, the job is reconciled and restarted from
  where it stopped.
- Items caught mid-action are marked **to check** for irreversible jobs, or requeued for
  reversible ones.

So a job looking frozen for 30–60 seconds is normal. Give it a minute before assuming it died.

If your API key goes missing while a job is running, the job **pauses** rather than looping.

---

## Limits

| | |
| --- | --- |
| Max items | 2,000 |
| Attempts per item | 2 |
| Steps per item | 12 (default) |
| Throttle between items | 2.5s for irreversible jobs, 0.4s otherwise |
| Collection agent | 16 steps |
| Research synthesis | 120 items, 60,000-character digest |
| Storage | `tidraJob` + `tidraJobItems:<id>:<n>` chunks |
| Code | `lib/jobs.ts`, `entrypoints/background.ts` |

Only **one job runs at a time**. Start another and the current one must finish, be cancelled, or
be dismissed first.
