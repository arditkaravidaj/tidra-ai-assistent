import {
  GROQ_MODELS,
  callModel,
  supportsVision,
  tierFor,
  type ContentBlock,
  type Message,
  type ImageBlock,
  type TextBlock,
  type Tier,
  type Tool,
  type ToolResultBlock,
} from '../lib/llm';
import { domainOf, getSiteMemory, rememberSite, siteHint } from '../lib/sitemem';
import {
  MAX_ITEMS,
  allItems,
  claimNext,
  clearJob,
  estimate,
  humanDuration,
  itemsFromCsv,
  loadJob,
  newJob,
  reconcile,
  requeue,
  retrySweep,
  saveJob,
  setItems,
  settle,
  type Job,
  type JobItem,
} from '../lib/jobs';
import { cdpAvailable, cdpClick, cdpDetachAll } from '../lib/cdp';
import { parsePrintedConfirm } from '../lib/confirm';
import { expandSkill, loadSkills, matchSkill } from '../lib/skills';
import { defaultTaskFor, prettyDomain } from '../lib/routine';
import { reportUrl, saveReport } from '../lib/library';
import { base64ToBlob, transcribe } from '../lib/voice';
import { buildPdf, bytesToBase64, safeFilename, toWinAnsiText } from '../lib/pdf';
import { extFromUrl, nameFromUrl, saveData, saveUrl } from '../lib/download';
import { extractPdfText } from '../lib/pdftext';
import {
  findFolder,
  folderAccess,
  isText,
  listFolders,
  listTree,
  markUsed,
  nextUnused,
  readBytes,
  readFile,
  readText,
  statFile,
  type FileBytes,
  type FolderRecord,
} from '../lib/folders';

interface PageContext {
  title: string;
  url: string;
  text: string;
}

/** A file the user attached to their message. */
export interface Attachment {
  kind: 'image' | 'text';
  name: string;
  /** Images: base64 (no data: prefix). Text files: the text itself. */
  data: string;
  mime: string;
}

interface AskRequest {
  type: 'tidra-ask';
  prompt: string;
  page: PageContext;
  intent?: 'chat' | 'look' | 'act';
  attachments?: Attachment[];
}

// Key + models. Read fresh on every request so a settings change takes effect
// without reloading the extension.
async function modelSetup(): Promise<{
  apiKey: string;
  tier: Tier;
} | null> {
  const store = await browser.storage.local.get(['tidraGroqKey', 'tidraTier']);
  const apiKey = store.tidraGroqKey as string | undefined;
  if (!apiKey) return null;
  return { apiKey, tier: tierFor(store.tidraTier as string) };
}

interface TabState {
  tabId: number | undefined;
}

const SYSTEM_PROMPT = `You are Tidra, a highly capable AI assistant that lives in the user's browser as a floating "island". You don't just chat — you get things done by taking real actions on the page.

If the current page is Tidra's own new tab, there is no web page to read yet — your first move is open_url to the site the task is about. Never tell the user you can't access a site: open it.

By default, actions happen on the user's CURRENT tab. Respect their wording: if they say "in a new tab" / "keep this page", open a new tab instead.

How you see and touch a page:
- snapshot() returns every interactive element as a tree, each with a ref like ref_0-12:
    # Inbox
    button "Compose" [ref_0-4]
    textbox "To" value:"" [ref_0-9]
    textbox "Message Body" [ref_0-11]
  Act on refs — click(ref_0-4), fill(ref_0-11, "…") — never guess at labels.
- Refs go stale the moment the page changes. After any click that opens, navigates or re-renders, take a fresh snapshot before acting again. If a tool says a ref is stale, snapshot and retry.
- Every action tells you what changed ("new on screen: …", "a control changed state", "page text grew by …"). Read it. A click that changes nothing is automatically retried as a trusted OS-level click; if the result still says "no visible change", it didn't work — try a different element rather than continuing as if it succeeded.
- If a click reports that something is "on top of it", that overlay took the click — a cookie banner, a modal, a sticky bar. Close it (press_key("Escape"), or click its own dismiss button) and then click the thing you actually wanted. Repeating the same click will not get past it.
- fill() verifies itself: on success it says the field now contains the text. If it reports the field is still empty or reads something else, the write did not land — click the field first, or clear(ref) and try again. Never carry on as though a failed fill succeeded.
- Elements marked "offscreen" need scroll() first. Lists that load more as you scroll need scroll(direction:"down") then a fresh snapshot.
- Sub-frames appear as FRAME sections with their own refs; use them exactly like the main page's.
- go_back() returns to the previous page — use it to get back to a list of results after opening one item, instead of re-navigating from scratch.
- You have plenty of steps. Work through a task item by item: do the first one completely, go_back, then the next. Don't abandon a task half-done, and don't try to shortcut by guessing URLs for things you found in a list.

If a task can't actually be done on the site — the feature doesn't exist, or it needs something only the user has — say so in one line instead of clicking around hoping. Don't fake completion.

Tools:
- open_url(url, new_tab): open a website; returns its snapshot. Full https URLs. Current tab by default; new_tab=true only if asked. Go directly to well-known sites (https://www.linkedin.com, https://mail.google.com, https://www.facebook.com, https://x.com). To search, go to https://www.google.com/search?q=... .
- snapshot(): the interactive tree described above. Your default way of looking at a page.
- click(ref) / fill(ref, text, submit) / select(ref, option) / scroll(ref | direction, amount) / clear(ref).
- hover(ref): open a menu or row of actions that only appears under the mouse. If the thing you need isn't in the snapshot, the usual reason is that it is hidden behind a hover — hover the likely parent, then snapshot again.
- press_key(key, ref): Escape closes a dialog, dropdown or cookie layer that is in your way. ArrowDown then Enter picks an item in an autocomplete or combobox — that is how those are chosen, not by clicking the option. Tab moves to the next field.
- get_page(): the page's visible TEXT — for reading and understanding content (an email thread, an article), not for finding things to click.
- find(query): cheap semantic lookup — describe what you need ("the reply button under the second post") and get back just the matching elements with FRESH refs. Prefer it over a second full snapshot when you know what you're looking for. Refs from earlier snapshots go stale when you call it.
- screenshot(question): a picture of the page, answered in text — what it shows, plus pixel coordinates for anything worth clicking. Expensive — only when the snapshot genuinely isn't enough (canvas, custom widgets, layout questions) or an action failed twice and you need to see why.
- click_at(x, y): trusted click at pixel coordinates from the latest screenshot — the way to press things that have no ref (canvas apps, custom widgets). Always screenshot first; never guess coordinates.
- click_text(text) / type_text(text, field, submit): label-matching fallbacks for when a full snapshot isn't worth it.
- focus_background(): offered only when you checked something for the user out of sight a moment ago (their inbox, their messages). If they now want you to ACT on what you found there — "reply to the first one", "open that one" — call this first: it brings that tab into view and continues there, so they watch the draft appear instead of wondering where it went.

Documents — reports and files:
- create_report(title, content, subtitle): write a styled report into Tidra's library and open it in a tab. Reach for it when the user asks for a report, a comparison, research, a plan, a briefing — anything better read as a document than a chat bubble. content is markdown (# headings, - bullets, tables, **bold**) and it IS the whole document, so write it in full. For a quick question, just answer in chat.
- create_pdf(title, content, subtitle, filename): writes a real PDF into their Downloads. content is markdown, and it is the whole document, so write it in full. Use it when they explicitly want a file on disk; otherwise prefer create_report.
- download_file(url, filename): saves anything that already has a URL — an image, an attachment, an export link.
- list_images(): the page's images, biggest first, each with a ref like img_1. "Download this image" → list_images, pick the one they mean (usually the first), download_file("img_1").
- "Make a PDF of this page" → get_page() to read it properly, THEN create_pdf with the real content — the article, the thread, the table, laid out with headings. Not three bullet points. If they ask for a PDF of something you wrote in this conversation, use what you wrote.
- Saving a file is not irreversible: just do it, then say where it went. No confirm_action.

How to behave — be decisive and intelligent:
- Reply in the language the user writes in.
- "THIS" MEANS WHAT'S ON THEIR SCREEN: when the user says "this post", "reply to this", "answer this email", they are looking at it RIGHT NOW. The target is the content currently in view — in the snapshot, the elements NOT marked "offscreen". Act on that visible item directly. Never scroll around hunting for a different post, and never pick an offscreen item over a visible one that matches.
- YOU HAVE THE HISTORY. Earlier turns may carry "[What I did that turn: …]" — the actual tool calls, including any text you drafted — and "[Earlier in this conversation: …]" for anything older. A follow-up like "make it shorter", "use the other one" or "no, more formal" refers to what is in there. Read it and continue from it. Do not ask the user to repeat themselves, and do not start the task over from the beginning.
- EXECUTE multi-step tasks yourself. "Reply to this email" → open the reply, understand the thread from the page, write a fitting reply into the body. "Write a new post about X" → open the composer, write a genuinely good post, fill it in. Don't narrate a plan and stop — do the steps.
- Draft real, high-quality content that fits the context and the user's voice.
- AI cannot know everything: when the outcome hangs on something only the user knows — audience, tone, goal, scope ("write a project update for my manager") — ask ONE short, pointed question BEFORE doing the work, then finish in one go with the answer. Never more than one round of questions; when a sensible assumption is available, make it and say you did, instead of asking.
- Don't over-ask or over-confirm. Take reasonable actions (navigating, opening composers, writing drafts, filling fields) without asking permission.

THE ONE HARD RULE — confirm before the irreversible send:
- After you've drafted/filled everything, STOP right before the final irreversible action — sending an email, publishing a post/tweet, submitting a comment, purchasing, transferring money, or deleting. Do NOT click Send/Post/Publish/Submit/Buy/Delete yet.
- This includes submit=true on fill/type_text, and press_key("Enter"). In a message or post composer, Enter IS the send button. Write the draft with submit omitted, then call confirm_action.
- Instead, call the confirm_action tool with a short summary (quote the key content briefly) and a confirm_label like "Send" or "Post". This shows the user a Confirm/Cancel bar.
- When the user then confirms (their next message will say something like "Confirmed — send it"), immediately click the Send/Post button on the page to complete it. Do NOT call confirm_action again — the user already approved.

- Be concise. After acting, say in one or two lines what you did.
- Never invent facts about the page or the email/thread — base drafts on what's actually there.`;

const TOOLS: Tool[] = [
  {
    name: 'open_url',
    description:
      'Open a website and return its interactive snapshot. Use full https URLs. By default navigates the CURRENT tab; set new_tab=true to open a new tab instead.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full https URL to open' },
        new_tab: {
          type: 'boolean',
          description:
            'Open in a NEW tab (true) only if the user asked for a new tab / to keep the current page; otherwise navigate the current tab (false).',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'go_back',
    description:
      'Go back to the previous page — e.g. to return to a list of search results after opening one of them. Returns the snapshot of where you land.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'snapshot',
    description:
      "Read the page's interactive elements as an indented tree. Every element gets a ref like ref_0-12; use those refs with click/fill/select/scroll. Take a fresh snapshot after anything changes the page — refs from an old snapshot go stale.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'click',
    description: 'Click the element with this ref. Returns what changed on the page afterwards.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'A ref from the latest snapshot, e.g. ref_0-12' } },
      required: ['ref'],
    },
  },
  {
    name: 'fill',
    description:
      'Type into the field with this ref (replacing what is there). Works with plain inputs and rich editors. submit=true presses Enter — in a search box that runs the search, but in a MESSAGE OR POST COMPOSER Enter SENDS IT. Leave submit out when writing a message, comment or post; draft it and call confirm_action instead.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from the latest snapshot' },
        text: { type: 'string', description: 'The text to type' },
        submit: {
          type: 'boolean',
          description:
            'Press Enter after typing. Only for search boxes and similar. Never for a message/post/comment composer — Enter sends there, and sending needs confirm_action first.',
        },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'select',
    description: 'Choose an option in a dropdown (a <select>) by its visible text or value.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from the latest snapshot' },
        option: { type: 'string', description: 'Visible text (or value) of the option to choose' },
      },
      required: ['ref', 'option'],
    },
  },
  {
    name: 'hover',
    description:
      'Move the mouse onto an element without clicking. Use when a menu, submenu or row of actions only appears on hover — snapshot afterwards to get refs for whatever it revealed.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'A ref from the latest snapshot' } },
      required: ['ref'],
    },
  },
  {
    name: 'press_key',
    description:
      'Press one key. Escape closes a dialog or dropdown, ArrowDown/Enter picks an item in an autocomplete or combobox, Tab moves to the next field. Omit "ref" to send it to whatever has focus. Enter here can submit — in a message or post composer, draft it and use confirm_action instead.',
    input_schema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          enum: [
            'Enter', 'Escape', 'Tab', 'Backspace', 'Delete',
            'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
            'Home', 'End', 'PageUp', 'PageDown', 'Space',
          ],
          description: 'Which key to press',
        },
        ref: { type: 'string', description: 'Send the key to this element (optional — defaults to whatever is focused)' },
      },
      required: ['key'],
    },
  },
  {
    name: 'clear',
    description:
      'Empty a text field. fill() already replaces what is there, so use this only when you need a field left blank, or when a fill did not take and you want a clean start.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'A ref from the latest snapshot' },
        field: { type: 'string', description: 'Label hint instead of a ref (e.g. "search")' },
      },
    },
  },
  {
    name: 'scroll',
    description:
      'Scroll the page, or bring one element into view. Use this when a snapshot says elements are offscreen, or when a list loads more as you scroll.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Scroll this element into view (optional)' },
        direction: { type: 'string', enum: ['down', 'up'], description: 'Which way to scroll the page' },
        amount: { type: 'number', description: 'Pixels to scroll; defaults to about one screen' },
      },
    },
  },
  {
    name: 'screenshot',
    description:
      "Look at the visible part of the page as an image and get a text answer: what it shows, with pixel coordinates for anything clickable, usable with click_at. Use ONLY when the snapshot isn't enough — canvas apps, custom drop-downs, layout questions, or when an action failed twice and you need to see why. Costs far more than a snapshot. Only works on the tab in front.",
    input_schema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'What you need to know from the image, e.g. "where is the Send button?" or "what does the chart show?"',
        },
      },
    },
  },
  {
    name: 'find',
    description:
      'Find elements on the current page by meaning — "the reply button under the second post", "the search box". Returns only the matching elements, with fresh refs for click/fill. Far cheaper than a full snapshot when you know what you need. Refs from earlier snapshots become stale.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What you are looking for, in plain words' } },
      required: ['query'],
    },
  },
  {
    name: 'click_at',
    description:
      'Trusted click at exact pixel coordinates from the LATEST screenshot — for things the snapshot has no ref for (canvas apps, custom widgets). Take a screenshot first and use the coordinates it reports; never guess.',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Horizontal position in screenshot pixels' },
        y: { type: 'number', description: 'Vertical position in screenshot pixels' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'get_page',
    description: "Read the page's visible text (title, url, text). Use for reading and understanding content, not for finding things to click.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'click_text',
    description:
      'Fallback: click a link/button whose visible text contains this string. Prefer snapshot + click(ref) — use this only for something obvious when a snapshot is not worth the tokens.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Visible text of the element to click' } },
      required: ['text'],
    },
  },
  {
    name: 'type_text',
    description:
      'Fallback: type into a field picked by a label hint. Prefer snapshot + fill(ref). Omit "field" to target the main/largest editable area.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text to type' },
        field: {
          type: 'string',
          description: 'Optional hint to pick the right field (e.g. "subject", "message body", "to", "search").',
        },
        submit: { type: 'boolean', description: 'Press Enter / submit after typing' },
      },
      required: ['text'],
    },
  },
  {
    name: 'create_report',
    description:
      "Create a styled report document in Tidra's library and open it in a new tab. Use for anything the user will want to read as a document, keep, or share: reports, comparisons, plans, research, briefings. The body is markdown: # headings, - bullets, 1. lists, **bold**, tables and ```code```. Write the WHOLE document — this content IS the report. For a quick answer reply in chat instead; use create_pdf only when they want a file on disk.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The report title, shown large at the top.' },
        subtitle: {
          type: 'string',
          description: 'Optional line under the title — the source, a date, a one-line scope.',
        },
        content: {
          type: 'string',
          description: 'The full document as markdown. Include everything that belongs in it.',
        },
      },
      required: ['title', 'content'],
    },
  },
  {
    name: 'create_pdf',
    description:
      "Write a PDF and save it to the user's Downloads. Use it whenever they ask for a PDF — of the page, of an article or email you have read, or of something you have written. Read the source first (get_page) so the PDF holds the real content, never a summary of a summary. The body is markdown: # headings, - bullets, 1. lists, **bold**, tables and ```code```.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Shown large at the top of page one.' },
        subtitle: {
          type: 'string',
          description: 'Optional line under the title — the source URL, a date, a byline.',
        },
        content: {
          type: 'string',
          description:
            'The full body as markdown. Include everything that belongs in the document — this text IS the PDF.',
        },
        filename: { type: 'string', description: 'File name without the extension. Defaults to the title.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'download_file',
    description:
      "Save a file that already exists at a URL to the user's Downloads — an image, a PDF, an attachment, an export link. For an image on the current page, call list_images first and pass the src it gives you; do not guess a URL.",
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Direct URL of the file (an image src, a link href).' },
        filename: {
          type: 'string',
          description: 'File name to save it as, with extension. Optional — the URL supplies one.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_images',
    description:
      'List the images on the page — src, alt text and displayed size, biggest and most visible first. Use this to find the right image before download_file. "This image" is usually the first entry.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_folder_files',
    description:
      "List what is in a folder the user connected from their computer — names, sizes and subfolders only, never the contents of the files. Use this to find the file you need before attach_file or read_folder_file. Pass `path` to look inside one subfolder rather than listing everything. If nothing is connected, tell the user to connect a folder from Tidra's new tab — you cannot do it for them.",
    input_schema: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description:
            'Which connected folder, by the name the user gave it. Omit when only one is connected.',
        },
        path: {
          type: 'string',
          description: 'A subfolder to look inside, e.g. "june". Omit for the top level.',
        },
        images_only: {
          type: 'boolean',
          description:
            'Narrow the listing to pictures and videos only. Default false — list everything, because the user asking "what is in this folder" means everything in it.',
        },
        depth: {
          type: 'number',
          description: 'How many levels of subfolder to descend. Default 2, max 5.',
        },
        sort: {
          type: 'string',
          enum: ['name', 'newest'],
          description:
            'Order of the listing. Use "newest" for "the last file", "the latest one", "what was just added" — it sorts by when each file was last changed, most recent first. Default "name".',
        },
      },
    },
  },
  {
    name: 'read_folder_file',
    description:
      "Read ONE file out of a connected folder and get its text back — a PDF (letters, statements, invoices), a caption, a script, a CSV, some notes. Call it once per file you actually need: the contents come into the conversation, so working through a whole folder this way is expensive. If the user asks what several documents say, read them one at a time and summarise as you go. A scanned PDF has no text in it, only a picture of one, and will say so. Pictures and videos cannot be read — to put one on a page, use attach_file.",
    input_schema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Which connected folder. Omit when only one is connected.' },
        file: {
          type: 'string',
          description: 'Path from list_folder_files, e.g. "captions.txt" or "june/notes.md".',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'attach_file',
    description:
      "Upload a file from a connected folder into the page's file input — a post composer's photo attachment, an email attachment, an avatar. This replaces clicking the page's \"Add photo\" button, which would open an OS dialog you cannot use: open the composer first, then call this. Omit `file` to take the next one the user hasn't used yet, which is what a daily \"post a picture from this folder\" routine wants. Attaching is not posting — you still stop and call confirm_action before publishing.",
    input_schema: {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: 'Which connected folder. Omit when only one is connected.',
        },
        file: {
          type: 'string',
          description:
            "Path from list_folder_files, e.g. \"monday.png\" or \"june/monday.png\". Omit to take the next file the user hasn't used yet.",
        },
        ref: {
          type: 'string',
          description:
            'Optional ref of the attach button or upload area, to disambiguate when the page has several uploads (avatar vs post). The real file input is usually hidden, so leaving this out is normal.',
        },
      },
    },
  },
  {
    name: 'focus_background',
    description:
      "Bring the tab Tidra last checked in the background to the front, and continue working there. Use it when the user follows up on something you looked up for them out of sight — “reply to the first one”, “open that email”, “connect with him” — so the work happens on the page they found, and they can watch you do it. Returns that page's snapshot; refs from any earlier snapshot go stale.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'confirm_action',
    description:
      'Call this AFTER drafting/filling everything, right before an irreversible action (send email, publish post, submit, buy, delete). It pauses and shows the user a Confirm/Cancel bar. Do not click the Send/Post button yourself — call this instead and wait.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'Short message telling the user what you drafted and what will happen, ending by asking them to confirm.',
        },
        confirm_label: {
          type: 'string',
          description: 'Label for the confirm button, e.g. "Send", "Post", "Publish", "Submit".',
        },
      },
      required: ['summary'],
    },
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One-time cleanup of keys from the previous provider, so a stale credential
// isn't left sitting in storage — and can never be sent to Groq.
browser.storage.local.remove(['tidraApiKey', 'tidraProvider', 'tidraMcp']).catch(() => {});

// ─── The user's profile ─────────────────────────────────────────────────────
// Lives only in browser.storage.local — never uploaded, never synced. Every
// field is typed by the user in settings; Tidra never collects any of it on
// its own. It leaves the device only as part of a prompt the user triggered.

interface Profile {
  name?: string;
  email?: string;
  role?: string;
  company?: string;
  location?: string;
  languages?: string;
  about?: string;
}

async function getProfile(): Promise<Profile> {
  const { tidraProfile } = await browser.storage.local.get('tidraProfile');
  return (tidraProfile as Profile | undefined) ?? {};
}

// Appended to the system prompt so drafts are signed and toned correctly.
async function profilePreamble(): Promise<string> {
  const p = await getProfile();
  const bits: string[] = [];
  const add = (label: string, v?: string) => {
    if (v?.trim()) bits.push(`${label}: ${v.trim()}`);
  };
  add('Name', p.name);
  add('Email', p.email);
  add('Role', p.role);
  add('Company', p.company);
  add('Location', p.location);
  add('Languages', p.languages);
  add('Notes', p.about);
  if (!bits.length) return '';
  return `\n\nAbout the user (from their own profile — use it for their voice, sign-offs and tone):\n${bits.join('\n')}`;
}

/**
 * The folders the user has connected, named in the system prompt.
 *
 * Without this the model has the folder tools but no idea any folder exists, so
 * "read all files in kindezuschlag" reads as a word it doesn't recognise rather
 * than a folder it can open — and the honest-looking move becomes asking the
 * user what's in it. Naming them costs a line and removes the guess.
 */
async function foldersPreamble(): Promise<string> {
  const all = await listFolders().catch(() => []);
  if (!all.length) return '';
  const rows = await Promise.all(
    all.map(async (f) => {
      const ok = (await folderAccess(f)) === 'granted';
      return `- "${f.label}"${ok ? '' : ' (currently unreadable — the user must click Reconnect on it in the Tidra new tab)'}`;
    }),
  );
  return [
    '',
    '',
    "Folders on the user's computer they have connected to Tidra:",
    ...rows,
    'When they mention one of these by name — or say "my folder", "that folder", "my files" — it is one of these. Use list_folder_files / read_folder_file / attach_file. Never ask the user what is inside one; look.',
  ].join('\n');
}

function extractText(content: ContentBlock[]): string {
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

interface ChatMsg {
  role: 'user' | 'assistant' | 'error';
  text: string;
  /**
   * What the agent actually DID on this turn — the tool calls, abbreviated.
   *
   * Without this a turn leaves behind one sentence ("Done — I replied.") and
   * everything else evaporates when `runAgent` returns: which post, which
   * button, and above all the text that was drafted. The next turn then met
   * "make it shorter" with nothing to shorten, and the user quite reasonably
   * concluded Tidra had forgotten the conversation. It had.
   */
  trace?: string[];
  /** Where the user was standing when they said this. One line, so a later
   *  "that page" still resolves after the full page text has been dropped. */
  page?: { title: string; url: string };
}
interface ChatState {
  messages: ChatMsg[];
  loading: boolean;
  /**
   * Turns older than the window we still send verbatim, folded into prose.
   * `covers` is how many messages are already in it, so each overflow extends
   * the summary instead of re-reading (and re-paying for) the whole thread.
   */
  summary?: { text: string; covers: number };
  /** The route the last turn took, for follow-ups that carry no route of their
   *  own. See `inheritRoute`. */
  route?: 'chat' | 'look' | 'act';
}

// ─── Routine learning ──────────────────────────────────────────────────────
// Log which domains the user visits (domain + time only — no page content, no
// full URLs), group them into sessions, and when a new session starts (browser
// reopened / long gap) offer to reopen the recurring routine.
const SESSION_GAP = 4 * 60 * 60 * 1000; // a new "session" after 4h of no activity
const MAX_VISITS = 800;
const ROUTINE_FIRST = 5; // first N distinct domains of each session
const ROUTINE_MIN_SESSIONS = 3; // need at least this much history to suggest
const ROUTINE_FREQ = 0.5; // domain must appear in ≥50% of past sessions

interface Visit {
  d: string;
  t: number;
}

// Split the visit log into sessions and reduce each to its first distinct domains.
function sessionStarts(visits: Visit[]): string[][] {
  const sorted = [...visits].sort((a, b) => a.t - b.t);
  const sessions: string[][] = [];
  let cur: Visit[] = [];
  let lastT = 0;
  const flush = () => {
    if (!cur.length) return;
    const seen = new Set<string>();
    const first: string[] = [];
    for (const v of cur) {
      if (!seen.has(v.d)) {
        seen.add(v.d);
        first.push(v.d);
        if (first.length >= ROUTINE_FIRST) break;
      }
    }
    sessions.push(first);
    cur = [];
  };
  for (const v of sorted) {
    if (lastT && v.t - lastT > SESSION_GAP) flush();
    cur.push(v);
    lastT = v.t;
  }
  flush();
  return sessions;
}

// From history, find the recurring start-of-session routine (ordered domains).
function detectRoutine(visits: Visit[]): { domain: string; url: string }[] {
  const sessions = sessionStarts(visits);
  const past = sessions.slice(0, -1).slice(-12); // exclude the current session
  if (past.length < ROUTINE_MIN_SESSIONS) return [];
  const count: Record<string, number> = {};
  const posSum: Record<string, number> = {};
  for (const s of past) {
    s.forEach((d, i) => {
      count[d] = (count[d] || 0) + 1;
      posSum[d] = (posSum[d] || 0) + i;
    });
  }
  return Object.keys(count)
    .filter((d) => count[d] / past.length >= ROUTINE_FREQ)
    .sort((a, b) => posSum[a] / count[a] - posSum[b] / count[b])
    .slice(0, 5)
    .map((d) => ({ domain: prettyDomain(d), url: 'https://' + d }));
}

async function handleVisit(domain: string) {
  const store = await browser.storage.local.get(['tidraVisits', 'tidraRoutineEnabled']);
  if (store.tidraRoutineEnabled === false) return; // routine learning is opt-out
  const visits = (store.tidraVisits as Visit[]) || [];
  const now = Date.now();
  const last = visits.length ? visits[visits.length - 1] : null;
  if (last && last.d === domain && now - last.t < 30000) return; // dedup SPA reloads
  const gap = last ? now - last.t : Infinity;

  visits.push({ d: domain, t: now });
  if (visits.length > MAX_VISITS) visits.splice(0, visits.length - MAX_VISITS);

  const data: Record<string, unknown> = { tidraVisits: visits };
  // A fresh session just began — offer the learned routine (once per session).
  if (gap > SESSION_GAP) {
    const routine = detectRoutine(visits);
    if (routine.length >= 2) data.tidraRoutine = { sites: routine, ts: now };
  }
  await browser.storage.local.set(data);
}

// The in-flight request's abort controller, so the UI's Stop button can cancel it.
let currentAbort: AbortController | null = null;

// Clear the loading flag (used when the user stops, or a request is aborted).
async function clearLoading() {
  const { tidraChat } = await browser.storage.local.get('tidraChat');
  const chat = (tidraChat as ChatState) || { messages: [], loading: false };
  chat.loading = false;
  await browser.storage.local.set({ tidraChat: chat, tidraPending: null });
}

// Append a message to the persisted chat and clear the loading flag.
// The island renders from storage, so this survives page navigation.
// A short "what I'm doing right now" line for the collapsed island, so the
// user sees progress without keeping the panel open. Cleared when the turn
// ends. Every status also lands in a step log the island can expand — the
// "watch Tidra think" trail.
let stepLog: string[] = [];
function setStatus(text: string | null) {
  if (text) {
    if (stepLog[stepLog.length - 1] !== text) stepLog.push(text);
    return browser.storage.local.set({ tidraStatus: text, tidraSteps: stepLog.slice(-40) });
  }
  return browser.storage.local.set({ tidraStatus: text });
}

// Snapshots are big (thousands of tokens) and go stale the moment the page
// changes. Keeping every past one in history costs a fortune AND actively hurts:
// the model can see refs from old trees and cite one that no longer exists. So
// once a newer snapshot exists, blank out the older ones.
//
// Which results were snapshots is tracked in a Set of tool_use ids, NOT as a
// field on the block — anything added to a block is sent to the API verbatim,
// and an unknown field is a 400.
// find is here because it takes a fresh snapshot internally — its result is
// small, but every ref issued before it is stale afterwards.
const SNAPSHOT_TOOLS = new Set(['snapshot', 'list_actions', 'open_url', 'go_back', 'screenshot', 'find']);

function pruneOldSnapshots(messages: Message[], snapshotIds: Set<string>) {
  let seenNewest = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i].content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_result' || !snapshotIds.has(block.tool_use_id)) continue;
      if (!seenNewest) {
        seenNewest = true; // keep the most recent one intact
        continue;
      }
      block.content = '[superseded snapshot removed — take a fresh one if you need refs]';
    }
  }
}

// ─── Long-run compaction ────────────────────────────────────────────────────
// Every turn re-sends the whole transcript, so a 30-step run pays for step 1's
// output twenty-nine more times. Past this many messages, everything between
// the opening request and the recent turns is folded into one small-model
// summary. (This rewrites history, which costs Groq's prefix cache from that
// point — but dropping the tokens outright beats a 50% discount on them.)
const COMPACT_AFTER = 20;
const COMPACT_KEEP_TAIL = 8;

function resultText(content: string | (TextBlock | ImageBlock)[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
}

const COMPACT_SYSTEM = `You compress a browser agent's transcript so it can keep working with less context. In one tight paragraph, state: what the task is, what has been DONE so far (pages opened, fields filled, content drafted — quote any drafted text that must not be lost), what failed, and what remains. No preamble.`;

async function compactMessages(
  apiKey: string,
  messages: Message[],
  signal?: AbortSignal,
): Promise<void> {
  if (messages.length <= COMPACT_AFTER) return;
  // The kept tail must start at an assistant turn, so no tool_result in it is
  // ever separated from the tool_use call it answers.
  let cut = messages.length - COMPACT_KEEP_TAIL;
  while (cut < messages.length && messages[cut].role !== 'assistant') cut++;
  if (cut <= 2 || cut >= messages.length) return;

  const digest = messages
    .slice(1, cut)
    .map((m) => {
      if (typeof m.content === 'string') return `${m.role}: ${m.content.slice(0, 300)}`;
      const parts: string[] = [];
      for (const b of m.content as any[]) {
        if (b.type === 'text' && b.text?.trim()) parts.push(b.text.slice(0, 250));
        if (b.type === 'tool_use') parts.push(`${b.name}(${JSON.stringify(b.input ?? {}).slice(0, 120)})`);
        if (b.type === 'tool_result') parts.push(`→ ${resultText(b.content).slice(0, 200)}`);
      }
      return `${m.role}: ${parts.join(' | ')}`;
    })
    .join('\n');

  try {
    const res = await callModel(
      apiKey,
      {
        model: GROQ_MODELS.small,
        max_tokens: 600,
        reasoning_effort: 'low',
        system: COMPACT_SYSTEM,
        messages: [{ role: 'user', content: digest.slice(0, 24000) }],
      },
      signal,
    );
    const summary = extractText(res.content);
    if (!summary) return;
    messages.splice(1, cut - 1, {
      role: 'user',
      content: `[Earlier steps, summarized to save space: ${summary}]\nContinue from the CURRENT page state — take a fresh snapshot if you need refs.`,
    });
  } catch {
    // Compaction is an optimisation — a failed summary must never sink the run.
  }
}

// ─── Learning from a finished run ───────────────────────────────────────────
// After a successful act-run, one cheap fire-and-forget call distills what the
// run learned about the site (notes) and the path that worked (a recipe). Both
// are injected into the next act-run on that domain — see lib/sitemem.ts.

const DISTILL_SYSTEM = `You extract reusable knowledge from a browser agent's completed run on a website. Reply with JSON only — no prose, no code fence:

{"notes": ["<up to 2 short site-specific facts that would save a future run time — element labels, layout quirks, flows. Only non-obvious facts about THIS site; [] if none>"],
 "steps": ["<the path that worked, as short imperative steps: 'click the Compose button', 'fill the To field'. Skip failed attempts and dead ends>"]}`;

async function learnFromRun(
  apiKey: string,
  domain: string | null,
  task: string,
  trace: string[],
): Promise<void> {
  if (!domain || trace.length < 3) return;
  try {
    const res = await callModel(apiKey, {
      model: GROQ_MODELS.small,
      max_tokens: 500,
      reasoning_effort: 'low',
      system: DISTILL_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Task: ${task}\nSite: ${domain}\nActions taken (→ ok, ✗ failed):\n${trace.join('\n')}`.slice(0, 12000),
        },
      ],
    });
    const parsed = extractJson<{ notes?: string[]; steps?: string[] }>(extractText(res.content));
    if (!parsed) return;
    await rememberSite(
      domain,
      Array.isArray(parsed.notes) ? parsed.notes : [],
      Array.isArray(parsed.steps) && parsed.steps.length ? { task, steps: parsed.steps } : null,
    );
  } catch {
    // Learning is an optimisation — never surface a failure to the user.
  }
}

function statusFor(tool: string, input: any): string {
  switch (tool) {
    case 'snapshot':
    case 'list_actions':
      return 'Looking at the page';
    case 'click':
    case 'click_at':
      return 'Clicking';
    case 'find':
      return 'Finding the right element';
    case 'fill':
      return 'Writing the draft';
    case 'select':
      return 'Choosing an option';
    case 'scroll':
      return 'Scrolling';
    case 'hover':
      return 'Opening the menu';
    case 'press_key':
      return `Pressing ${String(input?.key ?? 'a key')}`;
    case 'clear':
      return 'Clearing the field';
    case 'screenshot':
      return 'Taking a look';
    case 'open_url': {
      let host = String(input?.url ?? '');
      try {
        host = new URL(host).hostname.replace(/^www\./, '');
      } catch {
        /* keep the raw string */
      }
      return `Opening ${host}`;
    }
    case 'get_page':
      return 'Reading the page';
    case 'focus_background':
      return 'Bringing it up for you';
    case 'create_report':
      return 'Writing the report';
    case 'create_pdf':
      return 'Making the PDF';
    case 'download_file':
      return 'Downloading';
    case 'list_images':
      return 'Looking at the images';
    case 'list_actions':
      return 'Looking at what\'s on the page';
    case 'click_text':
      return `Clicking “${String(input?.text ?? '').slice(0, 30)}”`;
    case 'type_text':
      return input?.field ? `Filling in ${String(input.field).slice(0, 24)}` : 'Writing the draft';
    default:
      return 'Working';
  }
}

async function pushChat(
  text: string,
  role: 'assistant' | 'error',
  // What this turn did, and which route it took. Both are read back on the NEXT
  // turn — the trace so a follow-up knows what "it" refers to, the route so a
  // follow-up doesn't get re-classified onto a different one. See ChatMsg.
  meta?: { trace?: string[]; route?: 'chat' | 'look' | 'act' },
) {
  const { tidraChat } = await browser.storage.local.get('tidraChat');
  const chat = (tidraChat as ChatState) || { messages: [], loading: false };
  const msg: ChatMsg = { role, text };
  if (meta?.trace?.length) msg.trace = meta.trace.slice(-TRACE_KEEP);
  chat.messages.push(msg);
  chat.loading = false;
  if (meta?.route) chat.route = meta.route;
  // Mark unread so the collapsed island can surface the new result.
  await browser.storage.local.set({ tidraChat: chat, tidraUnread: true, tidraStatus: null });
}

// ─── Cross-turn memory ──────────────────────────────────────────────────────
// Within a run, `compactMessages` keeps the transcript small. Between runs there
// was nothing at all: every turn re-read the entire chat from storage, forever,
// and the model saw only the final sentence of each past turn. These three
// constants and the two helpers below are the between-turns half.

/** Recent messages sent verbatim. Everything older lives in the summary. */
const HISTORY_WINDOW = 12;
/** Tool calls kept per turn. Enough to reconstruct what happened, not a log. */
const TRACE_KEEP = 12;

const THREAD_SUMMARY_SYSTEM = `You maintain a running summary of a conversation between a user and their browser assistant. Given the summary so far and the turns that have since scrolled out of view, return ONE updated paragraph. Keep: what the user asked for, decisions they made, anything drafted or sent (quote short drafts), names, URLs and numbers that were established. Drop pleasantries. No preamble.`;

/**
 * Fold anything past the window into `chat.summary`, in place.
 *
 * Only the newly-overflowed messages are sent — the previous summary rides
 * along as context — so a long thread costs one small call per overflow rather
 * than re-summarising itself from the top every turn.
 */
async function summariseOverflow(apiKey: string, chat: ChatState, signal?: AbortSignal): Promise<void> {
  const covered = chat.summary?.covers ?? 0;
  const overflowEnd = chat.messages.length - HISTORY_WINDOW;
  if (overflowEnd <= covered) return;

  const chunk = chat.messages
    .slice(covered, overflowEnd)
    .filter((m) => m.role !== 'error')
    .map((m) => {
      const did = m.trace?.length ? `\n  (did: ${m.trace.join('; ').slice(0, 400)})` : '';
      return `${m.role === 'user' ? 'User' : 'Tidra'}: ${m.text.slice(0, 500)}${did}`;
    })
    .join('\n');
  if (!chunk.trim()) {
    chat.summary = { text: chat.summary?.text ?? '', covers: overflowEnd };
    return;
  }

  try {
    const res = await callModel(
      apiKey,
      {
        model: GROQ_MODELS.small,
        max_tokens: 400,
        reasoning_effort: 'low',
        system: THREAD_SUMMARY_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              chat.summary?.text ? `Summary so far:\n${chat.summary.text}` : 'No summary yet.',
              ``,
              `New turns that scrolled out of view:`,
              chunk,
            ].join('\n').slice(0, 16000),
          },
        ],
      },
      signal,
    );
    const text = extractText(res.content).trim();
    if (text) chat.summary = { text, covers: overflowEnd };
  } catch {
    // If this fails the window still applies — the thread loses its distant
    // past, which is worse than having it and better than sinking the turn.
  }
}

// A follow-up carries no route of its own. "make it shorter" re-classified from
// scratch could come back `look`, which moves the run to a hidden tab AND strips
// the current page out of the prompt — the agent then wakes up somewhere else
// with no idea what it was doing. Indistinguishable, from the outside, from
// having forgotten the conversation.
const FOLLOW_UP = /\b(it|that|this|them|those|these|again|instead|shorter|longer|same|one)\b/i;
const CONNECTIVE = /^\s*(no|nope|yes|yeah|yep|ok|okay|sure|and|but|also|then|now|actually|wait|please)\b/i;
// …but a follow-up that names a browser action is a genuinely new request and
// must be routed on its merits: "now reply to it" after a chat answer needs the
// act route, whatever the turn before it was.
const ACTION_VERB =
  /\b(reply|respond|send|post|comment|click|open|fill|submit|buy|order|download|attach|upload|search|log ?in|sign ?in|share|follow|connect|delete|book|check|find)\b/i;

function inheritRoute(text: string, last?: 'chat' | 'look' | 'act'): 'chat' | 'look' | 'act' | null {
  if (!last) return null;
  const t = text.trim();
  if (!t || t.length > 80) return null;
  if (ACTION_VERB.test(t)) return null;
  return FOLLOW_UP.test(t) || CONNECTIVE.test(t) ? last : null;
}

// Cheap router: chat (no browser) / look (browser, read-only → runs hidden) /
// act (browser, changes or drafts something → runs where the user can watch).
// Uses only the prompt + a little history — no page text — so it's a few dozen
// tokens. Errs toward "act" so neither capability nor visibility is lost.
async function classify(
  apiKey: string,
  routerModel: string,
  prompt: string,
  history: ChatMsg[],
  signal?: AbortSignal,
): Promise<'chat' | 'look' | 'act'> {
  try {
    const recent = history
      .slice(-4)
      .map((m) => `${m.role}: ${m.text.slice(0, 200)}`)
      .join('\n');
    const res = await callModel(
      apiKey,
      {
      model: routerModel,
      max_tokens: 5,
      system:
        [
          'Reply with exactly one word: look, act or chat.',
          '',
          'look — the user wants to KNOW something that lives behind a website, their own account, or a folder on their computer they connected to Tidra, and the answer comes back as information. Checking mail, messages, notifications, orders or a feed; looking up a price, a status, a fact on a site; listing what is in one of their folders, reading one of their files, finding the newest one. NOTHING is written, sent, filled in or changed, and the answer is text.',
          '',
          'act — the request CHANGES something, or produces something the user has to look at and approve: replying, writing, posting, commenting, filling a form, connecting, buying, downloading, saving a PDF or a report. ALSO anything about the page the user is looking at right now — "this page", "this post", "this email", "summarise this".',
          '',
          'chat — answerable from general knowledge alone, or about text already in this conversation.',
          '',
          'Being phrased as a question does NOT make it chat. Examples:',
          '"any new emails?" -> look',
          '"do I have new messages on LinkedIn?" -> look',
          '"what did Marco reply?" -> look',
          '"check my notifications" -> look',
          '"how much is the iPhone on amazon?" -> look',
          '"did my order ship?" -> look',
          '"read all files in kindezuschlag" -> look',
          '"what is in my photos folder?" -> look',
          '"open that folder and analyse the last file" -> look',
          '"reply to Marco" -> act',
          '"attach the latest pdf from my folder to this email" -> act',
          '"post the next picture from my folder to LinkedIn" -> act',
          '"answer this post" -> act',
          '"summarise this page" -> act',
          '"make a pdf of this page" -> act',
          '"download this image" -> act',
          '"write a post about our launch" -> act',
          '"what is the capital of Albania?" -> chat',
          '"rewrite that paragraph more formally" -> chat',
          '',
          'If unsure between look and act, answer act. If unsure whether the browser is needed at all, answer look.',
        ].join('\n'),
      messages: [
        {
          role: 'user',
          // All three options, every time. This used to end "(act or chat)",
          // which quietly argued against `look` — the one route that had just
          // been added — in the very last thing the model reads.
          content: `${recent ? `Conversation so far:\n${recent}\n\n` : ''}Request: ${prompt}\nAnswer (look, act or chat):`,
        },
      ],
      },
      signal,
    );
    const t = extractText(res.content).toLowerCase();
    if (t.includes('chat')) return 'chat';
    if (t.includes('look')) return 'look';
    return 'act';
  } catch {
    return 'act'; // safe default: keep full capability, and stay visible
  }
}

function waitForTabLoad(tabId: number, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    function listener(id: number, info: { status?: string }) {
      if (id === tabId && info.status === 'complete') finish();
    }
    browser.tabs.onUpdated.addListener(listener);
    browser.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete') finish();
      })
      .catch(() => {});
    setTimeout(finish, timeoutMs);
  });
}

// Send an action to a tab's content script, retrying until it's ready.
async function sendAction(
  tabId: number,
  payload: Record<string, unknown>,
  retries = 10,
  frameId = 0,
): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      return await browser.tabs.sendMessage(tabId, payload, { frameId });
    } catch {
      await sleep(350);
    }
  }
  throw new Error('Page not reachable (content script not ready).');
}

/** A bound sender for one tab, for the parts of a download only the page can do. */
function pageCaller(tabId: number | undefined) {
  if (tabId == null) return undefined;
  return (payload: Record<string, unknown>) => sendAction(tabId, { type: 'tidra-action', ...payload }, 3);
}

// The last image listing per tab, so the model can say "img_2" instead of
// echoing back a URL — which for an inline data: image would be a megabyte of
// base64 through the context window, and for a signed CDN URL is a fine way to
// mistype one character and download nothing.
interface FoundImage {
  src: string;
  alt: string;
  w: number;
  h: number;
  visible: boolean;
}
const lastImages = new Map<number, FoundImage[]>();

// Refs are per-frame, so the model sees them namespaced: "ref_0-12" is ref_12
// in the top frame, "ref_7-3" is ref_3 inside frame 7. Splitting here keeps the
// content script frame-agnostic — it never has to know its own id.
function parseRef(ref: string): { frameId: number; local: string } {
  const m = /^ref_(\d+)-(\d+)$/.exec(String(ref || '').trim());
  if (!m) return { frameId: 0, local: String(ref || '').trim() };
  return { frameId: Number(m[1]), local: `ref_${m[2]}` };
}

// One snapshot per frame, concatenated. Cross-origin iframes are separate
// content-script instances, so this is the only way to see inside them.
async function snapshotAllFrames(tabId: number): Promise<string> {
  let frames: { frameId: number; url: string }[] = [];
  try {
    frames = ((await browser.webNavigation.getAllFrames({ tabId })) ?? []) as typeof frames;
  } catch {
    frames = [{ frameId: 0, url: '' }];
  }
  if (!frames.length) frames = [{ frameId: 0, url: '' }];

  const parts: string[] = [];
  for (const f of frames.slice(0, 12)) {
    let res: any;
    try {
      // Sub-frames may have no content script (about:blank, sandboxed); skip
      // them quietly rather than stalling the whole snapshot on retries.
      res = await sendAction(tabId, { type: 'tidra-action', action: 'snapshot' }, f.frameId === 0 ? 10 : 1, f.frameId);
    } catch {
      continue;
    }
    const data = res?.data as { tree: string; url: string; title: string; truncated: boolean } | undefined;
    if (!data?.tree) continue;
    // Namespace this frame's refs.
    const tree = data.tree.replace(/\[ref_(\d+)\]/g, `[ref_${f.frameId}-$1]`);
    const head =
      f.frameId === 0
        ? `PAGE: ${data.title} — ${data.url}`
        : `\nFRAME ${f.frameId}: ${f.url}`;
    parts.push(`${head}\n${tree}${data.truncated ? '\n(… truncated — scroll or narrow the task)' : ''}`);
  }
  return parts.join('\n') || 'Nothing interactive found on this page.';
}

// Vision fallback: only when the tree isn't enough. Requires the tab to be the
// visible one in its window, which is why routine tabs can't use it.
async function captureTab(tabId: number): Promise<string> {
  const tab = await browser.tabs.get(tabId);
  if (!tab.active) throw new Error('Screenshots only work on the tab in front.');
  const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId!, { format: 'jpeg', quality: 60 });
  return dataUrl.replace(/^data:image\/jpeg;base64,/, '');
}

// Whether the current act model can read the screenshot itself. When it can't
// (the GPT-OSS default), the image goes through Groq's vision model instead and
// the agent gets its answer as text. Set per run in handleAsk.
let screenshotDirect = false;

// Screenshot pixels per CSS pixel of the last capture, per tab. The vision
// model reports coordinates in image pixels; CDP clicks want CSS ones.
const lastShotScale = new Map<number, number>();

/** One trusted-click retry at the spot a fruitless synthetic click hit.
 * Returns the change report, or null if the retry couldn't run — in which case
 * the original click's own report stands. */
async function retryAsTrustedClick(tabId: number, coords: { x: number; y: number }): Promise<string | null> {
  try {
    await cdpClick(tabId, coords.x, coords.y);
    await sleep(700);
    // The content script still holds the fingerprint from before the synthetic
    // click, so the report covers what the trusted click actually changed.
    const after = await sendAction(tabId, { type: 'tidra-action', action: 'describe_change' }, 2);
    return after?.ok ? String(after.data) : null;
  } catch {
    return null;
  }
}

/** Measure a capture and record its image→CSS scale for later click_at calls. */
async function measureShot(tabId: number, b64: string): Promise<{ imgW: number; imgH: number }> {
  let imgW = 0;
  let imgH = 0;
  try {
    const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    imgW = bmp.width;
    imgH = bmp.height;
    bmp.close();
  } catch {
    /* leave dimensions unknown */
  }
  try {
    const vp = await sendAction(tabId, { type: 'tidra-action', action: 'viewport' }, 2);
    const cssW = Number(vp?.data?.w) || 0;
    if (imgW && cssW) lastShotScale.set(tabId, imgW / cssW);
    else if (vp?.data?.dpr) lastShotScale.set(tabId, Number(vp.data.dpr) || 1);
  } catch {
    /* scale stays whatever it was */
  }
  return { imgW, imgH };
}

type ToolContent = string | (TextBlock | ImageBlock)[];

/** Tidra's own working tab, for tasks that didn't start on a page — so the
 * agent never takes over whatever tab the user happens to be looking at.
 * The id lives in session storage: it survives the worker dying, and the tab
 * is reused across turns instead of piling up blank tabs. */
async function ensureAgentTab(): Promise<number | undefined> {
  const { tidraAgentTab } = await browser.storage.session.get('tidraAgentTab');
  if (typeof tidraAgentTab === 'number') {
    const tab = await browser.tabs.get(tidraAgentTab).catch(() => null);
    if (tab?.id != null) return tab.id;
  }
  const tab = await browser.tabs.create({ url: 'about:blank', active: false }).catch(() => null);
  if (tab?.id == null) return undefined;
  await browser.storage.session.set({ tidraAgentTab: tab.id });
  return tab.id;
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

/**
 * Is this URL just "the site", with no particular page in mind?
 * "https://mail.google.com" is; ".../mail/u/0/#inbox" is not. The difference
 * decides whether an already-open tab gets navigated or simply used where it
 * stands.
 */
function isBareHost(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.pathname === '/' || u.pathname === '') && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/**
 * A tab the user already has open on this site, most recently used first.
 *
 * Opening a second Gmail when one is sitting right there is both untidy and
 * wrong: the open one is signed in, scrolled, and already where the user was
 * working. Tabs pile up one per request until the window is unusable.
 */
async function findOpenTab(url: string): Promise<{ id: number; url: string } | null> {
  const host = hostOf(url);
  if (!host) return null;
  const tabs = await browser.tabs.query({}).catch(() => []);
  const matches = tabs.filter((t) => t.id != null && t.url && hostOf(t.url) === host);
  if (!matches.length) return null;
  // Most recently touched: with two Gmail tabs open, the live one is the one
  // the user was last in, not whichever Chrome happens to list first.
  matches.sort(
    (a, b) =>
      ((b as { lastAccessed?: number }).lastAccessed ?? 0) - ((a as { lastAccessed?: number }).lastAccessed ?? 0),
  );
  const best = matches[0];
  return { id: best.id as number, url: best.url as string };
}

/**
 * Where a background "look" left off. A check ("any new mail?") reads a site
 * without the user watching; the follow-up ("reply to the first one") is about
 * what it found there, not about the page in front of them — so the act run is
 * offered focus_background to pick that tab up and bring it into view.
 */
interface BgContext {
  tabId: number;
  url: string;
  title: string;
  at: number;
}
const BG_FRESH_MS = 20 * 60 * 1000;

async function saveBgContext(tabId: number | undefined): Promise<void> {
  if (tabId == null) return;
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !/^https?:/i.test(tab.url)) return;
  const ctx: BgContext = { tabId, url: tab.url, title: tab.title ?? '', at: Date.now() };
  await browser.storage.session.set({ tidraBg: ctx });
}

/** The last background look, if it is recent and its tab still exists. */
async function freshBgContext(): Promise<BgContext | null> {
  const { tidraBg } = await browser.storage.session.get('tidraBg');
  const ctx = tidraBg as BgContext | undefined;
  if (!ctx?.tabId || Date.now() - ctx.at > BG_FRESH_MS) return null;
  const tab = await browser.tabs.get(ctx.tabId).catch(() => null);
  return tab?.id == null ? null : ctx;
}

const folderGone = (label: string) =>
  `The folder "${label}" can't be read any more — it was probably moved, renamed or deleted. Tell the user to connect it again from a Tidra new tab.`;

/**
 * Pick the folder a tool call means, or explain — to the model, in words it can
 * relay — why it can't have it.
 *
 * The worker shares IndexedDB with the extension's pages, so the handles are
 * right here. What it does NOT share is the ability to win the permission back:
 * that needs a picker and a click, both of which only exist in a page. So a
 * lapsed folder is never retried here — it is handed back as something for the
 * user to fix in one click, which is the honest description of it.
 */
async function resolveFolder(query?: string): Promise<{ rec: FolderRecord } | { error: string }> {
  const all = await listFolders();
  if (!all.length) {
    return {
      error:
        'No folder from the computer is connected. Tell the user to open a Tidra new tab and click "Add folder" — a folder picker can only be opened by them, never by you.',
    };
  }
  const rec = await findFolder(query);
  if (!rec) {
    const names = all.map((f) => `"${f.label}"`).join(', ');
    return {
      error: query
        ? `No connected folder matches "${query}". Connected: ${names}.`
        : `More than one folder is connected (${names}) — ask the user which one.`,
    };
  }
  const access = await folderAccess(rec);
  if (access === 'missing') {
    return {
      error: `The folder "${rec.label}" can't be reached any more — it was probably moved, renamed or deleted. The user needs to connect it again from the new tab.`,
    };
  }
  if (access !== 'granted') {
    return {
      error: `Access to "${rec.label}" has lapsed — Chrome drops folder permission when the browser restarts. Tell the user to open a Tidra new tab and click "Reconnect" on that folder; it is one click and they don't have to find the folder again.`,
    };
  }
  return { rec };
}

async function execTool(
  name: string,
  input: any,
  tabState: TabState,
  // Pressing Enter in a composer sends. That is irreversible, so it is gated in
  // code here — not left to the model remembering a rule in the prompt.
  allowSubmit = false,
): Promise<{ content: ToolContent; isError: boolean }> {
  if ((name === 'fill' || name === 'type_text') && input?.submit && !allowSubmit) {
    return {
      content:
        'Refused: submit=true would send/post this, which is irreversible. Call confirm_action first and wait for the user. If they confirm, you may submit.',
      isError: true,
    };
  }
  // press_key was very nearly a hole straight through the gate above: Enter in a
  // composer sends, and a key press is not a fill. The gate is about the effect,
  // not the tool that produced it, so Enter goes through the same door.
  if (name === 'press_key' && input?.key === 'Enter' && !allowSubmit) {
    return {
      content:
        'Refused: pressing Enter here could send or submit, which is irreversible. Call confirm_action first and wait for the user. Escape, Tab and the arrow keys are always available if you just need to navigate a menu.',
      isError: true,
    };
  }

  // No working tab yet (the ask came from the new-tab chat): give the agent
  // its own background tab rather than the one the user is looking at.
  if (tabState.tabId == null) tabState.tabId = await ensureAgentTab();
  try {
    // Files are made here, not on the page: a generated PDF has no origin, and
    // a download does not care which tab is in front. Both run before the
    // "is there a web page here" guard below, so they still work from the new
    // tab, where there is no content script at all.
    if (name === 'create_report') {
      const body = String(input?.content ?? '').trim();
      if (!body) {
        return { content: 'Nothing to put in the report — pass the document as `content`.', isError: true };
      }
      const report = await saveReport({
        title: String(input?.title ?? '').trim() || 'Report',
        subtitle: String(input?.subtitle ?? '').trim() || undefined,
        markdown: body,
        source: 'chat',
      });
      // The report IS the answer, so it opens in front — unlike the agent's
      // working tabs, which stay in the background.
      await browser.tabs.create({ url: reportUrl(report.id), active: true }).catch(() => {});
      return {
        content: 'Report created and opened in a new tab. It is saved in the Tidra library.',
        isError: false,
      };
    }

    if (name === 'create_pdf') {
      const body = String(input?.content ?? '').trim();
      if (!body) {
        return { content: 'Nothing to put in the PDF — pass the document text as `content`.', isError: true };
      }
      const title = String(input?.title ?? '').trim();
      const filename = safeFilename(input?.filename || title, 'document', 'pdf');
      const bytes = buildPdf({
        title,
        subtitle: String(input?.subtitle ?? '').trim(),
        content: body,
      });
      const result = await saveData(
        `data:application/pdf;base64,${bytesToBase64(bytes)}`,
        filename,
        pageCaller(tabState.tabId),
      );
      if (!result.ok) return { content: `Could not save the PDF — ${result.error}`, isError: true };
      // The built-in PDF fonts cover Latin only. Chinese, Arabic, Greek and
      // emoji have no glyph and are dropped in layout — which would otherwise
      // hand the user a half-empty document with no explanation.
      const solid = (s: string) => s.replace(/\s/g, '').length;
      const kept = solid(toWinAnsiText(body));
      const dropped = solid(body) - kept;
      const note =
        dropped > solid(body) * 0.25
          ? ` Note: about ${Math.round((dropped / Math.max(1, solid(body))) * 100)}% of the characters are in a script this PDF's fonts can't draw (non-Latin text or emoji) and were left out — say so plainly to the user.`
          : '';
      return {
        content: `Saved "${result.filename ?? filename}" to the Downloads folder (${Math.max(1, Math.round(bytes.length / 1024))} KB).${note}`,
        isError: false,
      };
    }

    if (name === 'download_file') {
      const raw = String(input?.url ?? '').trim();
      if (!raw) return { content: 'No URL to download.', isError: true };
      let url = raw;

      const ref = /^img_(\d+)$/i.exec(raw);
      if (ref) {
        const found = tabState.tabId != null ? lastImages.get(tabState.tabId) : undefined;
        const image = found?.[Number(ref[1]) - 1];
        if (!image) {
          return { content: `I don't have ${raw} any more — call list_images again.`, isError: true };
        }
        url = image.src;
      }

      if (!/^(https?|data|blob):/i.test(url)) {
        if (/^\/\//.test(url)) url = 'https:' + url;
        else if (/^[\w.-]+\.[a-z]{2,}\//i.test(url)) url = 'https://' + url;
        else return { content: `"${raw.slice(0, 80)}" is not a downloadable URL.`, isError: true };
      }
      // An inline image carries its type in the URL itself; a normal URL usually
      // carries it in the path. When neither does, the name is left bare and the
      // browser names it from the response's content type.
      const inline = /^data:([\w.+-]+)\/([\w.+-]+)/i.exec(url);
      const ext = inline
        ? inline[2].toLowerCase().replace('jpeg', 'jpg').replace('svg+xml', 'svg')
        : extFromUrl(url, '');
      const filename = safeFilename(
        input?.filename || nameFromUrl(url, inline ? 'image' : 'download'),
        inline ? 'image' : 'download',
        ext,
      );
      const result = await saveUrl(url, filename, pageCaller(tabState.tabId));
      if (!result.ok) return { content: `Could not download that — ${result.error}.`, isError: true };
      return { content: `Saved "${result.filename ?? filename}" to the Downloads folder.`, isError: false };
    }

    // Reading a connected folder needs no page at all, so it runs before the
    // "is there a web page here" guard — the user can ask what's in a folder
    // from the new tab, where no content script exists.
    if (name === 'list_folder_files') {
      const found = await resolveFolder(input?.folder);
      if ('error' in found) return { content: found.error, isError: true };
      const imagesOnly = input?.images_only === true;
      const where = String(input?.path ?? '').trim();
      // A folder deleted or renamed on disk still reports its permission as
      // granted — the handle only breaks when something actually reads it.
      const sort = input?.sort === 'newest' ? 'newest' : 'name';
      const listing = await listTree(found.rec, {
        imagesOnly,
        sort,
        sub: where || undefined,
        depth: Math.min(5, Math.max(1, Number(input?.depth) || 2)),
      }).catch(() => null);
      if (!listing) {
        return {
          content: where
            ? `There is no subfolder "${where}" in "${found.rec.label}".`
            : folderGone(found.rec.label),
          isError: true,
        };
      }

      const scope = `"${found.rec.label}"${where ? `/${where}` : ''}`;
      if (!listing.files.length) {
        // "Empty" is a claim about the folder; the filter having matched nothing
        // is a claim about the filter. Reporting the second as the first is how
        // a folder of nine PDFs gets described to the user as empty.
        if (imagesOnly) {
          const all = await listTree(found.rec, { sub: where || undefined, cap: 1 }).catch(() => null);
          if (all?.files.length) {
            return {
              content: `${scope} has no pictures or videos in it, but it is NOT empty — there are other files. Call again with images_only false to see them.`,
              isError: false,
            };
          }
        }
        if (!listing.dirs.length) return { content: `${scope} is empty.`, isError: false };
      }
      const lines = listing.files.map(
        (f) =>
          `${f.path} — ${Math.max(1, Math.round(f.size / 1024))} KB, changed ${new Date(f.modified).toISOString().slice(0, 16).replace('T', ' ')}${f.used ? ' (already used)' : ''}`,
      );
      const fresh = listing.files.filter((f) => !f.used).length;
      const notes: string[] = [];
      if (listing.dirs.length) notes.push(`Subfolders: ${listing.dirs.join(', ')}`);
      if (imagesOnly) notes.push('Only pictures and videos were listed — other file types are hidden.');
      if (listing.omitted) {
        notes.push(
          `${listing.omitted} more file${listing.omitted > 1 ? 's are' : ' is'} in here but not listed — narrow it with \`path\` if you need them.`,
        );
      }
      if (listing.unexplored.length) {
        notes.push(
          `Not descended into: ${listing.unexplored.join(', ')} — pass one as \`path\` to look inside.`,
        );
      }
      return {
        content: [
          `${scope} — ${listing.files.length} file${listing.files.length === 1 ? '' : 's'} listed${sort === 'newest' ? ', most recently changed FIRST' : ''}, ${fresh} not yet used. This is names, sizes and dates only; use read_folder_file for the contents of one text file, or attach_file to upload one to the page.`,
          '',
          ...lines,
          ...(notes.length ? ['', ...notes] : []),
        ].join('\n'),
        isError: false,
      };
    }

    if (name === 'read_folder_file') {
      const found = await resolveFolder(input?.folder);
      if ('error' in found) return { content: found.error, isError: true };
      const path = String(input?.file ?? '').trim();
      if (!path) return { content: 'Pass the file to read as `file`.', isError: true };
      // PDFs carry instructions for painting glyphs, not text, so they get a
      // parser rather than a read. A scan has no text in it at all — that comes
      // back as a `note`, and it must reach the user as "this is a picture of a
      // document", never as an empty file.
      if (/\.pdf$/i.test(path)) {
        const bytes = await readBytes(found.rec, path).catch(() => null);
        if (!bytes) {
          return {
            content: `There is no file called "${path}" in "${found.rec.label}" — call list_folder_files to see what is there.`,
            isError: true,
          };
        }
        const doc = await extractPdfText(bytes).catch(() => null);
        if (!doc || !doc.text) {
          return { content: doc?.note ?? `Could not read "${path}".`, isError: true };
        }
        const MAX = 20000;
        const cut = doc.text.length > MAX;
        return {
          content:
            `${path} — ${doc.pages} page${doc.pages === 1 ? '' : 's'}${cut ? ', first part only (the document is longer and was cut off)' : ''}:\n\n` +
            doc.text.slice(0, MAX),
          isError: false,
        };
      }

      if (!isText(path)) {
        return {
          content: `"${path}" is not a text file, so its contents would be meaningless as text. To put it on a page, use attach_file.`,
          isError: true,
        };
      }
      const read = await readText(found.rec, path).catch(() => null);
      if (!read) {
        return {
          content: `There is no file called "${path}" in "${found.rec.label}" — call list_folder_files to see what is there.`,
          isError: true,
        };
      }
      return {
        content: read.truncated
          ? `${read.name} (first part only — the file is ${Math.round(read.size / 1024)} KB and was cut off):\n\n${read.text}`
          : `${read.name}:\n\n${read.text}`,
        isError: false,
      };
    }

    // Hand the conversation over to the tab a background check left open, and
    // show it to the user — from here on they watch the work happen.
    if (name === 'focus_background') {
      const ctx = await freshBgContext();
      if (!ctx) {
        return {
          content:
            'There is no background tab to switch to. Work on the current page, or open_url what you need.',
          isError: true,
        };
      }
      const tab = await browser.tabs.get(ctx.tabId).catch(() => null);
      if (tab?.id == null) return { content: 'That background tab is gone.', isError: true };
      await browser.tabs.update(tab.id, { active: true }).catch(() => {});
      if (tab.windowId != null) {
        await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
      tabState.tabId = tab.id;
      await sleep(400);
      const tree = await snapshotAllFrames(tab.id);
      return {
        content: `Now on ${tab.title ?? ''} — ${tab.url ?? ctx.url}, and the user can see it. These refs are fresh.\n\n${tree}`,
        isError: false,
      };
    }

    if (name === 'open_url') {
      let url: string = String(input.url || '');
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

      // Already open? Work in THAT tab. It is signed in, it is where the user
      // left off, and it is the one they meant. Only an explicit new_tab
      // request overrides this — otherwise every "check my mail" leaves another
      // Gmail behind until the window is a row of duplicates.
      const existing = input.new_tab ? null : await findOpenTab(url);
      if (existing) {
        tabState.tabId = existing.id;
        // Asked for the site in general and the tab is already on it: leave it
        // exactly where it is rather than reloading over the user's place.
        if (isBareHost(url)) {
          await sleep(200);
          const tree = await snapshotAllFrames(existing.id);
          return {
            content: `Using the ${hostOf(url)} tab the user already had open — it is on ${existing.url}. If you need a different page there, call open_url with the full URL.\n\n${tree}`,
            isError: false,
          };
        }
        if (existing.url !== url) await browser.tabs.update(existing.id, { url });
      } else if (input.new_tab) {
        // active:false — opening a tab must not yank the user away from
        // whatever they are doing. They can click over to watch if they want.
        const tab = await browser.tabs.create({ url, active: false });
        tabState.tabId = tab.id; // subsequent actions target the new tab
      } else {
        if (tabState.tabId == null) return { content: 'No active tab.', isError: true };
        await browser.tabs.update(tabState.tabId, { url });
      }
      if (tabState.tabId == null) return { content: 'Could not open tab.', isError: true };
      await waitForTabLoad(tabState.tabId);
      await sleep(400);
      const tree = await snapshotAllFrames(tabState.tabId);
      const how = existing ? ' (in the tab that was already open)' : input.new_tab ? ' (new tab)' : '';
      return { content: `Opened ${url}${how}\n\n${tree}`, isError: false };
    }

    if (tabState.tabId == null) return { content: 'No working tab.', isError: true };

    // Extension pages (the new tab, options) and about: pages run no content
    // script, so nothing can be read or clicked there. Say so immediately
    // instead of retrying a message that can never be delivered.
    const current = await browser.tabs.get(tabState.tabId).catch(() => null);
    if (current?.url && !/^https?:/i.test(current.url)) {
      return {
        content: 'There is no web page open in this tab yet. Call open_url first to go to the site.',
        isError: true,
      };
    }

    if (name === 'attach_file') {
      const found = await resolveFolder(input?.folder);
      if ('error' in found) return { content: found.error, isError: true };
      const rec = found.rec;

      let wanted = String(input?.file ?? '').trim();
      if (!wanted) {
        const next = await nextUnused(rec).catch(() => undefined);
        if (next === undefined) return { content: folderGone(rec.label), isError: true };
        if (!next) {
          return {
            content: `Every file in "${rec.label}" has been used already. Tell the user to add new ones to the folder, or name a specific file to reuse.`,
            isError: true,
          };
        }
        wanted = next.path;
      }

      const stat = await statFile(rec, wanted).catch(() => null);
      if (!stat) {
        return {
          content: `There is no file called "${wanted}" in "${rec.label}" — call list_folder_files to see what is there.`,
          isError: true,
        };
      }
      // Checked before the read, not after: base64 roughly doubles the bytes and
      // the whole thing sits in the worker's memory on the way to the page.
      if (stat.size > 20 * 1024 * 1024) {
        return {
          content: `"${wanted}" is ${Math.round(stat.size / (1024 * 1024))} MB — too big to hand to the page. Ask the user for a smaller file.`,
          isError: true,
        };
      }
      const file: FileBytes = await readFile(rec, wanted);

      const res = await sendAction(tabState.tabId, {
        type: 'tidra-action',
        action: 'attach_file',
        name: file.name,
        mime: file.mime,
        base64: file.base64,
        ref: input?.ref,
      });
      if (!res?.ok) {
        return { content: String(res?.error ?? 'The page would not take the file.'), isError: true };
      }
      // Marked used only once it actually landed on the page, so a failed
      // attach doesn't quietly burn tomorrow's picture.
      await markUsed(rec, wanted);
      return {
        content: `${String(res.data)} (from "${rec.label}"). It is attached, NOT posted — draft the rest, then call confirm_action before publishing.`,
        isError: false,
      };
    }

    if (name === 'get_page') {
      const res = await sendAction(tabState.tabId, { type: 'tidra-action', action: 'get_page' });
      const page = res?.data as PageContext;
      // The opening prompt already carries 15k of this page. Cutting the tool
      // that exists to "read it properly" down to 6k meant every deliberate
      // re-read came back with LESS than the model started with — so a long
      // inbox or thread looked like it simply ended, and whatever was asked
      // about got reported as not there.
      const text = page?.text || '';
      const MAX = 15000;
      const cut = text.length > MAX;
      return {
        content:
          `Title: ${page?.title}\nURL: ${page?.url}\n\n${text.slice(0, MAX)}` +
          (cut ? '\n\n[The page is longer than this — scroll() and call get_page again for the rest.]' : ''),
        isError: false,
      };
    }
    if (name === 'list_images') {
      const res = await sendAction(tabState.tabId, { type: 'tidra-action', action: 'list_images' });
      const images = (res?.data as FoundImage[]) ?? [];
      if (!images.length) {
        return { content: 'No real images on this page — nothing bigger than an icon.', isError: false };
      }
      // Bounded: one listing per tab, and only the last few tabs.
      if (lastImages.size >= 8) lastImages.delete(lastImages.keys().next().value!);
      lastImages.set(tabState.tabId, images);
      const lines = images.map((im, i) => {
        // An inline image's src IS the file. Never put it in the transcript.
        const where = im.src.startsWith('data:')
          ? `(inline image, ${Math.round(im.src.length / 1400)} KB — use the ref)`
          : im.src.length > 300
            ? '(long URL — use the ref)'
            : im.src;
        return `img_${i + 1}: ${im.w}x${im.h}${im.visible ? '' : ' offscreen'} — ${im.alt || 'no alt text'}\n  ${where}`;
      });
      return {
        content: `Images on the page, biggest and most visible first. Pass a ref like "img_1" to download_file.\n\n${lines.join('\n')}`,
        isError: false,
      };
    }

    if (name === 'go_back') {
      await browser.tabs.goBack(tabState.tabId);
      await waitForTabLoad(tabState.tabId);
      await sleep(400);
      return { content: `Went back.\n\n${await snapshotAllFrames(tabState.tabId)}`, isError: false };
    }

    if (name === 'snapshot' || name === 'list_actions') {
      return { content: await snapshotAllFrames(tabState.tabId), isError: false };
    }

    if (name === 'screenshot') {
      const b64 = await captureTab(tabState.tabId);
      const { imgW, imgH } = await measureShot(tabState.tabId, b64);
      const dims = imgW ? ` (${imgW}x${imgH} px)` : '';
      if (screenshotDirect) {
        return {
          content: [
            {
              type: 'text',
              text: `Screenshot of the visible part of the page${dims}. click_at takes coordinates in these image pixels.`,
            },
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          ],
          isError: false,
        };
      }
      // The act model can't see images. Groq's vision model becomes its eyes:
      // it answers the question in text, with image-pixel coordinates so
      // click_at stays usable. This is what keeps screenshots available on the
      // cheap text-only tiers instead of being silently dropped from the tools.
      const setup = await modelSetup();
      if (!setup) return { content: 'No API key available for the vision model.', isError: true };
      const question = String(input?.question ?? '').trim() || 'Describe what is on the screen.';
      const res = await callModel(setup.apiKey, {
        model: GROQ_MODELS.vision,
        max_tokens: 900,
        system:
          'You are the eyes of a browser agent that cannot see images. Answer its question about the screenshot precisely, based only on what is visible — quote on-screen text exactly. Then list the interactive elements relevant to the question (buttons, fields, controls), each with the center of where to click in image pixels, like: Send button at (x=812, y=1040). Be concrete and brief.',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
              { type: 'text', text: `The screenshot is${dims || ' the visible viewport'}. Question: ${question}` },
            ],
          },
        ],
      });
      const seen = extractText(res.content as ContentBlock[]).trim();
      if (!seen) return { content: 'The vision model returned nothing for this screenshot.', isError: true };
      return {
        content: `What the screenshot shows${dims}:\n${seen}\n\nTo press something that has no ref in the snapshot, call click_at with those image-pixel coordinates.`,
        isError: false,
      };
    }

    if (name === 'find') {
      const query = String(input?.query ?? '').trim();
      if (!query) return { content: 'Pass a query describing the element you need.', isError: true };
      const setup = await modelSetup();
      if (!setup) return { content: 'No API key available.', isError: true };
      const tree = await snapshotAllFrames(tabState.tabId);
      // A fast model does the matching so the agent never pays for the full
      // tree in its own context — the same trick Claude-in-Chrome's find uses.
      const res = await callModel(setup.apiKey, {
        model: GROQ_MODELS.small,
        max_tokens: 400,
        reasoning_effort: 'low',
        system:
          'You match elements in a web page\'s accessibility tree. Reply with ONLY the tree lines (verbatim, keeping their [ref_...]) that best match the query — up to 8, best match first, one per line. No commentary. If nothing plausibly matches, reply exactly: NO MATCH',
        messages: [{ role: 'user', content: `Query: ${query}\n\nTree:\n${tree.slice(0, 40000)}` }],
      });
      const hits = extractText(res.content as ContentBlock[]).trim();
      if (!hits || /^NO MATCH/i.test(hits)) {
        return {
          content: `Nothing on the page matches "${query}". Take a snapshot to see what is actually there.`,
          isError: false,
        };
      }
      return {
        content: `Elements matching "${query}" — these refs are fresh, refs from earlier snapshots are now stale:\n${hits}`,
        isError: false,
      };
    }

    if (name === 'click_at') {
      if (!cdpAvailable()) return { content: 'Trusted clicks are not available in this browser.', isError: true };
      const scale = lastShotScale.get(tabState.tabId) ?? 1;
      const x = Math.round(Number(input?.x) / scale);
      const y = Math.round(Number(input?.y) / scale);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { content: 'Pass numeric x and y taken from the latest screenshot.', isError: true };
      }
      await sendAction(tabState.tabId, { type: 'tidra-action', action: 'mark_before' }, 2).catch(() => {});
      await cdpClick(tabState.tabId, x, y);
      await sleep(700);
      const after = await sendAction(tabState.tabId, { type: 'tidra-action', action: 'describe_change' }, 2).catch(
        () => null,
      );
      return {
        content: `Clicked at (${input.x}, ${input.y}). ${after?.ok ? after.data : 'Take a snapshot or screenshot to see the result.'}`,
        isError: false,
      };
    }

    // Ref-based actions — the primary path.
    if (
      name === 'click' || name === 'fill' || name === 'select' || name === 'scroll' ||
      name === 'hover' || name === 'press_key' || name === 'clear'
    ) {
      const { frameId, local } = parseRef(input.ref ?? '');
      const res = await sendAction(
        tabState.tabId,
        {
          type: 'tidra-action',
          action: name,
          ref: input.ref ? local : undefined,
          text: input.text,
          option: input.option,
          field: input.field,
          key: input.key,
          submit: !!input.submit,
          direction: input.direction,
          amount: input.amount,
        },
        10,
        input.ref ? frameId : 0,
      );

      // A click that starts a page load returns from the OLD document — settle()
      // caps at 2.5s and the content script answering is the one about to be
      // torn down. So the agent read a page that no longer existed, then acted
      // on refs from it. If the tab went into `loading`, wait it out and say so.
      if ((name === 'click' || name === 'press_key') && res?.ok) {
        const tab = await browser.tabs.get(tabState.tabId).catch(() => null);
        if (tab?.status === 'loading') {
          await waitForTabLoad(tabState.tabId, 15000);
          const now = await browser.tabs.get(tabState.tabId).catch(() => null);
          return {
            content: `${res.data} The page then loaded: now on "${now?.title ?? ''}" (${now?.url ?? ''}). Take a fresh snapshot — every earlier ref is gone.`,
            isError: false,
          };
        }
      }

      // Synthetic events are isTrusted:false and some apps ignore them cold.
      // A click that visibly did nothing gets one retry as a trusted CDP click
      // at the same spot — indistinguishable from a real mouse. Top frame only:
      // a sub-frame reports coordinates relative to itself, not the page.
      if (name === 'click' && res?.ok && res.changed === false && res.coords && frameId === 0 && cdpAvailable()) {
        const retried = await retryAsTrustedClick(tabState.tabId, res.coords);
        if (retried) return { content: `${res.data} Retried as a trusted click: ${retried}`, isError: false };
      }
      return { content: res?.ok ? res.data : res?.error, isError: !res?.ok };
    }
    if (name === 'click_text') {
      const res = await sendAction(tabState.tabId, { type: 'tidra-action', action: 'click_text', text: input.text });
      if (res?.ok && res.changed === false && res.coords && cdpAvailable()) {
        const retried = await retryAsTrustedClick(tabState.tabId, res.coords);
        if (retried) return { content: `${res.data} Retried as a trusted click: ${retried}`, isError: false };
      }
      return { content: res?.ok ? res.data : res?.error, isError: !res?.ok };
    }
    if (name === 'type_text') {
      const res = await sendAction(tabState.tabId, {
        type: 'tidra-action',
        action: 'type_text',
        text: input.text,
        field: input.field,
        submit: !!input.submit,
      });
      return { content: res?.ok ? res.data : res?.error, isError: !res?.ok };
    }
    return { content: `Unknown tool: ${name}`, isError: true };
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}

async function handleAsk(message: AskRequest, senderTabId: number | undefined) {
  const setup = await modelSetup();
  if (!setup) {
    await pushChat('No API key set. Open settings and add a key for your chosen provider.', 'error');
    return;
  }
  const { apiKey, tier } = setup;

  // A fresh turn starts a fresh step trail.
  stepLog = [];
  await browser.storage.local.set({ tidraSteps: [] });

  // Build conversation memory from persisted chat so multi-turn flows work
  // (e.g. Tidra drafts an email, user later says "yes, send it").
  const { tidraChat } = await browser.storage.local.get('tidraChat');
  const chatState = (tidraChat as ChatState | undefined) ?? { messages: [], loading: false };
  const stored = chatState.messages ?? [];

  // Fold anything past the window into the rolling summary, then work from the
  // window alone. Before this, every turn re-sent the entire chat from the very
  // first message — a forty-turn thread paid for forty turns, every time, and
  // the router's view of it got worse the longer you talked.
  await summariseOverflow(apiKey, chatState);

  // Note where the user was when they asked. The full page text only ever rides
  // on the newest turn (that is what keeps the prompt prefix cacheable), so
  // without this breadcrumb a page referred to two turns later has left no
  // trace at all — not even its URL.
  const incoming = stored[stored.length - 1];
  const stampPage =
    incoming?.role === 'user' && !incoming.page && /^https?:/i.test(message.page.url ?? '');
  if (stampPage) {
    incoming.page = { title: (message.page.title ?? '').slice(0, 120), url: message.page.url };
  }
  if (chatState.summary || stampPage) {
    // Merge rather than overwrite: summarising is a network round-trip, and the
    // only parts of the chat this owns are the summary and that breadcrumb.
    const { tidraChat: fresh } = await browser.storage.local.get('tidraChat');
    const base = (fresh as ChatState) ?? chatState;
    const msgs = base.messages ?? [];
    if (stampPage && msgs.length && msgs[msgs.length - 1].role === 'user') {
      msgs[msgs.length - 1].page = incoming.page;
    }
    await browser.storage.local.set({
      tidraChat: { ...base, messages: msgs, summary: chatState.summary ?? base.summary },
    });
  }
  const threadSummary = stored.length > HISTORY_WINDOW ? chatState.summary?.text ?? null : null;
  const history = stored.slice(-HISTORY_WINDOW).filter((m) => m.role !== 'error');

  // Slash skills: "/fact-check the stats" expands into the saved prompt before
  // the model sees it. The chat keeps showing what the user typed; only the
  // request that goes to the API is expanded. A skill's own mode (chat/act)
  // outranks the router's guess — the user told us what this needs.
  const lastUserText =
    history.length && history[history.length - 1].role === 'user'
      ? history[history.length - 1].text
      : message.prompt;
  let expandedPrompt: string | null = null;
  let intent = message.intent;
  const skillHit = matchSkill(lastUserText, await loadSkills());
  if (skillHit) {
    expandedPrompt = await expandSkill(skillHit.skill, skillHit.rest);
    if (!intent && skillHit.skill.mode !== 'auto') intent = skillHit.skill.mode;
  }

  const messages: Message[] = [];
  history.forEach((m, i) => {
    const isLastUser = i === history.length - 1 && m.role === 'user';
    if (isLastUser) {
      messages.push({
        role: 'user',
        content: [
          `Current page:`,
          `Title: ${message.page.title}`,
          `URL: ${message.page.url}`,
          ``,
          `Page content (truncated):`,
          message.page.text,
          ``,
          `---`,
          `User request: ${expandedPrompt ?? m.text}`,
        ].join('\n'),
      });
    } else if (m.role === 'assistant' && m.trace?.length) {
      // The turn's own record of what it did, replayed. This is what lets "make
      // it shorter" find the draft, and "no, the other one" find the button.
      // Written once and never rewritten, so it does not disturb Groq's prefix
      // cache the way a sliding recap would.
      messages.push({
        role: 'assistant',
        content: `${m.text}\n\n[What I did that turn: ${m.trace.join('; ')}]`,
      });
    } else if (m.role === 'user' && m.page?.url) {
      // One line, not the page text: enough that "that page" still resolves
      // three turns later, cheap enough to keep for every turn in the window.
      messages.push({ role: 'user', content: `${m.text}\n(asked on: ${m.page.title} — ${m.page.url})` });
    } else {
      messages.push({ role: m.role as 'user' | 'assistant', content: m.text });
    }
  });
  // Safety net: if history was empty for some reason, use the incoming prompt.
  if (!history.length) {
    messages.push({ role: 'user', content: expandedPrompt ?? message.prompt });
  }

  // Everything older than the window, in one line. Folded into the opening user
  // message where there is one, rather than pushed as a message of its own —
  // the window can begin on either role, and a blind prepend would sometimes
  // produce two user turns (or two assistant turns) back to back.
  if (threadSummary) {
    const opener = `[Earlier in this conversation: ${threadSummary}]`;
    const first = messages[0];
    if (first?.role === 'user' && typeof first.content === 'string') {
      first.content = `${opener}\n\n${first.content}`;
    } else {
      messages.unshift({ role: 'user', content: opener });
    }
  }

  // Requests from the island act on the page they were asked from. Anything
  // else (the new-tab chat, or a sender tab that isn't a real web page) gets
  // Tidra's own background tab — created lazily by execTool — so the agent
  // never borrows, or navigates away, a tab the user is working in.
  let workingTabId = senderTabId;
  if (workingTabId != null) {
    const senderTab = await browser.tabs.get(workingTabId).catch(() => null);
    if (!senderTab?.url || !/^https?:/i.test(senderTab.url)) workingTabId = undefined;
  }
  const tabState: TabState = { tabId: workingTabId };
  // The island sends "Confirmed — …" after the user presses the confirm button.
  // Only then may this turn submit anything.
  const userConfirmed = /^Confirmed\s+—/.test(message.prompt.trim());
  // Auto mode: the user has said, up front, to go ahead without asking each
  // time. Manual (the default) stops at every irreversible step.
  const { tidraAuto } = await browser.storage.local.get('tidraAuto');
  const autoMode = tidraAuto === true;
  const mayAct = userConfirmed || autoMode;

  // Cancellation: the UI's Stop button aborts the in-flight request via `currentAbort`.
  currentAbort?.abort();
  const abort = new AbortController();
  currentAbort = abort;
  const reqOpts = { signal: abort.signal };

  try {
  // Repeated work over many targets can't run as one conversation — it becomes
  // a durable job instead. Only "act" requests are ever candidates.
  //
  // The detector judges the recent THREAD, not just the newest message. "Add
  // 10 connections" → clarifying question → "no criteria, random": the count
  // lives two turns back, and a batch judged only on the reply slips into the
  // normal agent, which then runs out of steps ten items in.
  const threadPrompt =
    history.length > 1
      ? history
          .slice(-5)
          .map((m) => `${m.role === 'user' ? 'User' : 'Tidra'}: ${m.text.slice(0, 400)}`)
          .join('\n')
      : message.prompt;
  if (
    intent !== 'chat' &&
    (await maybeStartJob(
      apiKey,
      tier,
      { ...message, prompt: expandedPrompt ?? threadPrompt },
      abort.signal,
      workingTabId,
    ))
  ) {
    await clearLoading();
    return;
  }

  // Decide route: explicit hint (quick actions, a skill's mode), then an
  // inherited one for a bare follow-up, then the cheap router.
  //
  // The inherit step is not an optimisation. Re-classifying "make it shorter" on
  // its own could land on `look`, and a look runs on a hidden tab with the
  // current page stripped out of the prompt — so a follow-up to an act-run would
  // occasionally wake up somewhere else entirely, with no page and no idea what
  // it had been doing. That reads as amnesia, and it was.
  const inherited = intent ? null : inheritRoute(lastUserText, chatState.route);
  if (inherited) stepLog.push(`Continuing where we left off (${inherited})`);
  const route: 'chat' | 'look' | 'act' =
    intent ??
    inherited ??
    (await classify(apiKey, tier.router, expandedPrompt ?? message.prompt, history, abort.signal));
  // Both browser routes drive the same agent loop with the same tools. What
  // separates them is WHERE: a look works in Tidra's hidden tab and comes back
  // with an answer, an act works where the user can watch it.
  const browsing = route === 'act' || route === 'look';
  if (route === 'look') {
    tabState.tabId = await ensureAgentTab();
    // The user's page isn't where this runs and isn't what it's about, so the
    // whole page dump comes out of the prompt — one line of context is enough,
    // and a look stops paying for text it will never use.
    const last = messages[messages.length - 1];
    if (typeof last?.content === 'string' && last.content.startsWith('Current page:')) {
      messages[messages.length - 1] = {
        role: 'user',
        content: [
          `(For context only — the user is looking at "${message.page.title}" (${message.page.url}). Do not act on it.)`,
          ``,
          `Request: ${expandedPrompt ?? lastUserText}`,
        ].join('\n'),
      };
    }
  }
  // A recent background check the user may now be following up on ("reply to
  // the first one") — the act run can pick that tab up with focus_background.
  const bgCtx = route === 'act' ? await freshBgContext() : null;

  // Attachments ride on the newest user turn. Text files are inlined; images
  // become image blocks, which only the vision model can actually read.
  let attachments = message.attachments ?? [];

  // An image was visible for exactly one turn. The chat bubble keeps a 96px
  // thumbnail, but the model got nothing at all on turn two — so "what's in this
  // screenshot?" → "now write a caption for it" answered about nothing. Carry
  // the last turn's images forward when the follow-up plainly refers back and
  // brings no images of its own.
  if (!attachments.length && inheritRoute(lastUserText, chatState.route)) {
    const { tidraLastImages } = await browser.storage.local.get('tidraLastImages');
    const carried = tidraLastImages as { images?: Attachment[]; ts?: number } | undefined;
    // Half an hour: long enough for a real back-and-forth, short enough that a
    // picture from this morning never silently joins tonight's question.
    if (carried?.images?.length && Date.now() - (carried.ts ?? 0) < 30 * 60 * 1000) {
      attachments = carried.images;
      stepLog.push('Still looking at the image from before');
    }
  }

  const images = attachments.filter((a) => a.kind === 'image');
  // Keep at most two, and only the ones actually used this turn.
  await browser.storage.local.set(
    images.length ? { tidraLastImages: { images: images.slice(0, 2), ts: Date.now() } } : {},
  );
  if (attachments.length) {
    const last = messages[messages.length - 1];
    const parts: ContentBlock[] = [];
    const files = attachments.filter((a) => a.kind === 'text');
    if (files.length) {
      parts.push({
        type: 'text',
        text: files
          .map((f) => `Attached file "${f.name}":\n${f.data.slice(0, 20000)}`)
          .join('\n\n'),
      });
    }
    for (const img of images) {
      parts.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } });
    }
    const existing = typeof last?.content === 'string' ? last.content : '';
    messages[messages.length - 1] = {
      role: 'user',
      content: [...parts, { type: 'text', text: existing }],
    };
  }

  // Chat → cheap model, no tools. Act → the browser tools, starting on the
  // tier's cheap act model when it has one (the cascade below escalates to the
  // big one only if the run stalls — most page actions never need it).
  // An attached image forces the vision model — it is the only one that can see
  // it, and it supports tools too, so the agent loop still works.
  const actModel =
    images.length ? GROQ_MODELS.vision : browsing ? (tier.actStart ?? tier.act) : tier.chat;
  // The cascade may only climb within the plain browser path — never off vision.
  const canEscalate = browsing && !images.length && actModel !== tier.act;
  // Screenshots are offered to every act model: one that can see gets the image
  // itself, the rest get the vision model's text answer (see the screenshot
  // handler in execTool).
  // create_pdf and create_report survive into the chat route as the tools that
  // need no page: "rewrite this as a memo and give me a report" is a chat
  // request right up until the moment it isn't, and the router should not be
  // able to lose the document.
  screenshotDirect = supportsVision(actModel);
  const tools: any[] = !browsing
    ? // get_page comes too: the chat route is given ONE truncated blob of the
      // page and, without this, no way to ever see more of it. A long thread or
      // inbox simply appeared to stop, and "summarise this" answered from the
      // first screenful as though that were the whole thing. Reading is not
      // browsing — it changes nothing and needs no tab of its own.
      TOOLS.filter((t) => ['create_pdf', 'create_report', 'get_page'].includes(t.name))
    : TOOLS.filter((t) => {
        // An unfocused tab cannot be captured, so a look gets no eyes — and it
        // confirms nothing, because it sends nothing.
        if (route === 'look') {
          return !['screenshot', 'click_at', 'confirm_action', 'focus_background'].includes(t.name);
        }
        // Only offer the hand-over when there is actually a tab behind it.
        return t.name !== 'focus_background' || !!bgCtx;
      });

  // Site memory: what past runs learned about this domain, plus the step path
  // of a similar task that succeeded here. Appended to the newest USER message,
  // never the system prompt — the system prompt stays byte-identical across
  // runs so Groq's automatic prefix cache (50% off cached input) keeps hitting.
  // A look starts on a blank tab and picks its own site, so there is no domain
  // to look memory up under yet — the first open_url fills this in, and the
  // run is learned from under whatever site it actually visited.
  let actDomain = route === 'look' ? null : domainOf(message.page.url);
  if (browsing) {
    const extra: string[] = [];
    const hint = actDomain
      ? siteHint(await getSiteMemory(actDomain), expandedPrompt ?? lastUserText)
      : '';
    if (hint) extra.push(hint);
    if (bgCtx) {
      extra.push(
        `\n\nYou checked “${bgCtx.title}” (${bgCtx.url}) in a background tab a moment ago. If this request is about what you found THERE rather than the page above, call focus_background first — it brings that tab into view so the user can watch — and carry on from it.`,
      );
    }
    if (extra.length) {
      const last = messages[messages.length - 1];
      const text = extra.join('');
      if (typeof last.content === 'string') last.content += text;
      else (last.content as ContentBlock[]).push({ type: 'text', text });
    }
  }

  const profileText = (await profilePreamble()) + (await foldersPreamble());
  const modeNote = autoMode
    ? '\n\nAUTO MODE IS ON for this request: the user has already approved irreversible actions in advance. Do not call confirm_action and do not ask — finish the job, including the final click, then report what you did.'
    : '';
  // A look is a fact-finding trip, not a visit: the user is on another page and
  // never sees this tab, so there is nobody to show a draft to or ask.
  const lookNote =
    route === 'look'
      ? `\n\nBACKGROUND MODE for this request. Your tools are pointed at a SEPARATE, hidden tab — not at the page described above. That page is only what the user happens to be looking at; it is context, and you are not on it. So:
- START with open_url for the site the question is about. Your tab is blank until you do — a snapshot before that shows nothing.
- Look things up, read, and REPORT. Do not write, fill in, send, post, connect, buy or change anything. If the request turns out to need that, say what you found and what the next step would be instead of doing it.
- You cannot take screenshots here, and pressing Enter to submit a form is refused. To search, open_url a search URL (https://www.google.com/search?q=… , or the site's own ?q= URL) rather than typing into a search box.
- Finish with the ANSWER in plain text — what you found, concretely, with the details that matter (names, subjects, times, numbers). No narration of the steps you took, and never say you cannot access a site: open it.`
      : '';
  const base = {
    model: actModel,
    max_tokens: 2048,
    // Mechanical page steps don't need chain-of-thought; drafting rides on the
    // same calls, so only the small act model runs at low effort — the big
    // model (quality tier, or after an escalation) thinks at its default depth.
    reasoning_effort: browsing && actModel === GROQ_MODELS.small ? ('low' as const) : undefined,
    system: SYSTEM_PROMPT + profileText + modeNote + lookNote,
  };

  await setStatus(
    route === 'look' ? 'Checking in the background' : route === 'act' ? 'Getting started' : 'Thinking',
  );

  const snapshotIds = new Set<string>();
  // What actually happened, for site memory. And the cascade's stall counter:
  // consecutive rounds whose actions all failed or changed nothing.
  const trace: string[] = [];
  // Domains whose site notes have already been handed over, so a run that
  // bounces between pages is told each site's quirks exactly once.
  const hinted = new Set<string>(actDomain ? [actDomain] : []);
  let badStreak = 0;
  // One automatic second wind: a task that exhausts its steps mid-work gets a
  // compacted transcript and a fresh budget once, instead of stopping.
  let extended = false;
  for (;;) {
  let guard = 0;
  while (guard++ < 30) {
    const params: any = { ...base, messages };
    if (tools.length) params.tools = tools;
    const response = await callModel(apiKey, params, abort.signal);

    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content as any });
      continue;
    }
    if (response.stop_reason !== 'tool_use') {
      await pushChat(extractText(response.content as ContentBlock[]), 'assistant', { trace, route });
      // Remember where the background check ended up, so a follow-up ("reply to
      // the first one") can be picked up on that very page.
      if (route === 'look') await saveBgContext(tabState.tabId);
      // Done and successful: distill what this run learned about the site.
      // Fire-and-forget — the user's answer is already out.
      if (browsing && trace.length >= 3) {
        void learnFromRun(apiKey, actDomain, expandedPrompt ?? lastUserText, trace);
      }
      return;
    }

    // Confirmation checkpoint: if Tidra asks to confirm, end the turn and
    // show the Confirm/Cancel bar instead of continuing to click Send.
    const confirmBlock = (response.content as any[]).find(
      (b) => b.type === 'tool_use' && b.name === 'confirm_action',
    );
    // Weaker models sometimes *describe* the confirm tool instead of calling
    // it — as an XML-ish tag, or as a JSON blob of the call. Either way the
    // Confirm bar would never appear and the safety checkpoint would silently
    // not exist, which is the one failure this whole flow is here to prevent.
    // So a printed confirmation is honoured exactly like a real tool call.
    if (!confirmBlock && response.stop_reason !== 'tool_use') {
      const said = extractText(response.content as ContentBlock[]);
      const printed = parsePrintedConfirm(said);
      if (printed) {
        if (autoMode) {
          messages.push({ role: 'assistant', content: said });
          messages.push({
            role: 'user',
            content: 'Approved automatically (auto mode is on). Complete the action now.',
          });
          continue;
        }
        await pushChat(printed.summary, 'assistant', { trace, route });
        await browser.storage.local.set({ tidraPending: { label: printed.label } });
        return;
      }
    }

    if (confirmBlock && !autoMode) {
      const pre = extractText(response.content as ContentBlock[]);
      const summary = confirmBlock.input?.summary || 'Ready. Do you want me to proceed?';
      await pushChat([pre, summary].filter(Boolean).join('\n\n'), 'assistant', { trace, route });
      await browser.storage.local.set({
        tidraPending: { label: confirmBlock.input?.confirm_label || 'Send' },
      });
      return;
    }
    // Auto mode: approve it ourselves and let the same turn carry on, rather
    // than making the model ask a question nobody is going to answer.
    if (confirmBlock) {
      messages.push({ role: 'assistant', content: response.content as any });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: confirmBlock.id,
            content: 'Approved automatically (auto mode is on). Go ahead and complete the action now.',
          },
        ],
      });
      continue;
    }

    messages.push({ role: 'assistant', content: response.content as any });

    const toolResults: ToolResultBlock[] = [];
    for (const block of response.content as any[]) {
      if (block.type !== 'tool_use') continue;
      await setStatus(statusFor(block.name, block.input));
      // A background look never submits, whatever the user pre-approved: there
      // is nobody watching it, so nothing irreversible happens out of sight.
      const result = await execTool(block.name, block.input, tabState, route !== 'look' && mayAct);
      if (SNAPSHOT_TOOLS.has(block.name)) snapshotIds.add(block.id);
      if (block.name === 'open_url' && block.input?.url) {
        actDomain = domainOf(String(block.input.url)) ?? actDomain;
        // A look picks its own site mid-run, so its site notes can't be injected
        // up front like an act's — they ride in on the landing page instead.
        if (actDomain && !hinted.has(actDomain) && typeof result.content === 'string') {
          hinted.add(actDomain);
          const hint = siteHint(await getSiteMemory(actDomain), expandedPrompt ?? lastUserText);
          if (hint) result.content += hint;
        }
      }
      // Handing over to the background tab moves the run to that site, so what
      // it learns is filed under that site and not the page it started on.
      if (block.name === 'focus_background' && bgCtx) {
        actDomain = domainOf(bgCtx.url) ?? actDomain;
      }
      // Anything that WROTE text gets a longer leash. This trace is what the
      // next turn reads back, and a draft cut off at 100 characters is no use
      // to "make it shorter" — the draft IS the thing being referred to.
      const wrote = block.name === 'fill' || block.name === 'type_text' || block.name === 'create_report';
      trace.push(
        `${block.name}(${JSON.stringify(block.input ?? {}).slice(0, wrote ? 600 : 100)}) ${
          result.isError ? `✗ ${resultText(result.content as any).slice(0, 60)}` : '→ ok'
        }`,
      );
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.content,
        is_error: result.isError,
      });
    }
    if (toolResults.length === 0) {
      await pushChat(extractText(response.content as ContentBlock[]), 'assistant', { trace, route });
      return;
    }
    messages.push({ role: 'user', content: toolResults });
    pruneOldSnapshots(messages, snapshotIds);

    // The cascade: if the cheap model keeps swinging and missing — or the run
    // is dragging on — hand the same conversation to the big model. Nothing
    // else changes; it picks up exactly where the small one left off.
    const allBad = toolResults.every(
      (r) =>
        r.is_error || /no visible change|stale/i.test(resultText(r.content as any).slice(0, 400)),
    );
    badStreak = allBad ? badStreak + 1 : 0;
    if (canEscalate && base.model !== tier.act && (badStreak >= 2 || guard >= 12)) {
      base.model = tier.act;
      base.reasoning_effort = undefined;
      await setStatus('Thinking harder');
    }

    await compactMessages(apiKey, messages, abort.signal);
  }

  // Out of steps. Take the second wind if it's still available.
  if (browsing && !extended) {
    extended = true;
    await compactMessages(apiKey, messages, abort.signal);
    messages.push({
      role: 'user',
      content:
        'You ran out of steps but the task is not finished. Continue exactly where you left off — do not redo work that is already done — and complete what remains. If almost everything is done, wrap up and report.',
    });
    await setStatus('Continuing');
    continue;
  }
  break;
  }

  await pushChat(
    "I ran out of steps before finishing. Tell me what's left and I'll carry on, or break it into smaller pieces.",
    'assistant',
    { trace, route },
  );
  } catch (err) {
    if (abort.signal.aborted) {
      await setStatus(null);
      await clearLoading(); // user pressed Stop — end quietly, no error bubble
      return;
    }
    throw err;
  } finally {
    if (currentAbort === abort) currentAbort = null;
    await cdpDetachAll(); // drop any debugger attachment (and its info bar)
    await setStatus(null);
  }
}

// ─── Routine execution ──────────────────────────────────────────────────────
// "Start routine" runs each learned site's saved task, in the background, on a
// hidden tab — drafting/preparing only, never sending, and reporting back.

const ROUTINE_SYSTEM = `You are Tidra, running one step of the user's saved routine on a website — in the background, on their behalf.

Do exactly what the task describes, using the page. Be decisive and take the needed steps (open the composer, read the thread, write a draft, etc.).

Use snapshot() to see the page's interactive elements — each carries a ref like ref_0-12 — then click(ref) / fill(ref, text). Refs go stale whenever the page changes, so snapshot again after anything that navigates or re-renders. Every action reports what changed; if it says "no visible change", it did not work.

HARD RULES:
- NEVER send, post, submit, publish, buy, or delete anything. Only prepare/draft and leave it for the user to review later.
- Do not ask the user questions — do your best with what's on the page.
- When finished, reply with a SHORT report: 1–3 sentences or a few bullets of what you found or drafted. No preamble.
- Base everything strictly on the actual page content — never invent.`;

async function getPageOf(tabId: number): Promise<PageContext> {
  const res = await sendAction(tabId, { type: 'tidra-action', action: 'get_page' });
  return (res?.data as PageContext) || { title: '', url: '', text: '' };
}

// Run one site's task to completion and return Tidra's short report.
async function runSiteAgent(
  apiKey: string,
  actModel: string,
  task: string,
  tabId: number,
  profileText = '',
): Promise<string> {
  const tabState: TabState = { tabId };
  const page = await getPageOf(tabId);
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        `Routine task: ${task}`,
        ``,
        `Current page:`,
        `Title: ${page.title}`,
        `URL: ${page.url}`,
        ``,
        `Page content (truncated):`,
        (page.text || '').slice(0, 8000),
      ].join('\n'),
    },
  ];
  // No confirm_action / open_url — routine tasks stay on the opened tab and never
  // send. Screenshots need vision, and a background tab can't be captured anyway.
  // Nor do routines write files: nobody asked for a PDF, and the user is not
  // watching this run. Folders stay in, though — "post a picture from this
  // folder every day" is a routine, and reading a folder the user connected by
  // hand is the one filesystem touch they explicitly asked for.
  const tools = TOOLS.filter(
    (t) =>
      ![
        'confirm_action',
        'open_url',
        'screenshot',
        'click_at', // needs a screenshot for coordinates, which a background tab can't take
        'go_back',
        'create_pdf',
        'create_report',
        'download_file',
        'list_images',
        'focus_background', // a routine runs unattended — it never grabs the screen
      ].includes(t.name),
  );
  const snapshotIds = new Set<string>();
  let guard = 0;
  while (guard++ < 24) {
    const res = await callModel(apiKey, {
      model: actModel,
      max_tokens: 1500,
      // Routines are simple, repeated site tasks — no chain-of-thought needed.
      reasoning_effort: 'low',
      system: ROUTINE_SYSTEM + profileText,
      messages,
      tools,
    });
    if (res.stop_reason !== 'tool_use') {
      return extractText(res.content as ContentBlock[]) || 'Done.';
    }
    messages.push({ role: 'assistant', content: res.content as any });
    const toolResults: ToolResultBlock[] = [];
    for (const block of res.content as any[]) {
      if (block.type !== 'tool_use') continue;
      // No allowSubmit: a background routine drafts, never sends.
      const r = await execTool(block.name, block.input, tabState);
      if (SNAPSHOT_TOOLS.has(block.name)) snapshotIds.add(block.id);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: r.content, is_error: r.isError });
    }
    if (!toolResults.length) return extractText(res.content as ContentBlock[]) || 'Done.';
    messages.push({ role: 'user', content: toolResults });
    pruneOldSnapshots(messages, snapshotIds);
  }
  return 'Stopped after too many steps.';
}

let routineRunning = false;
async function runRoutine() {
  if (routineRunning) return;
  routineRunning = true;
  try {
    const store = await browser.storage.local.get([
      'tidraVisits',
      'tidraRoutineHidden',
      'tidraRoutineTasks',
      'tidraRoutineManual',
      'tidraRoutineFolders',
    ]);
    const setup = await modelSetup();
    if (!setup) {
      await pushChat('No API key set. Open settings and add a key for your chosen provider.', 'error');
      return;
    }
    const { apiKey, tier } = setup;
    const visits = (store.tidraVisits as Visit[]) || [];
    const hidden = new Set((store.tidraRoutineHidden as string[]) || []);
    const manual = (store.tidraRoutineManual as { domain: string; url: string }[]) || [];
    // Learned routine + manually-added sites, de-duplicated, minus removed ones.
    const seen = new Set<string>();
    const sites = [...detectRoutine(visits), ...manual].filter((s) => {
      if (hidden.has(s.domain) || seen.has(s.domain)) return false;
      seen.add(s.domain);
      return true;
    });
    const tasks = (store.tidraRoutineTasks as Record<string, string>) || {};
    // Which folder each site's routine may reach into. Stored by folder id, so
    // renaming a folder doesn't quietly unbind the routine that uses it.
    const folderIds = (store.tidraRoutineFolders as Record<string, string>) || {};
    if (!sites.length) {
      await pushChat("You have no learned routine yet, so there's nothing to run.", 'assistant');
      return;
    }

    // Deliberately NOT foldersPreamble() here. An unattended routine gets told
    // about the one folder it was bound to, appended to its own task below —
    // listing every connected folder would let a routine bound to one reach
    // into another while nobody is watching.
    const profileText = await profilePreamble();
    await browser.storage.local.set({ tidraOpen: true });
    await pushChat(
      `Running your routine across ${sites.length} site${sites.length > 1 ? 's' : ''} — I'll draft, never send, and report back.`,
      'assistant',
    );

    // Each site's findings also become a section of one consolidated brief —
    // a report the user can read, keep, and export, instead of piecing the
    // morning together from separate chat bubbles.
    const sections: string[] = [];
    for (const site of sites) {
      const name = prettyDomain(site.domain);
      let task = (tasks[site.domain] || defaultTaskFor(site.domain)).trim();

      // A routine bound to a folder gets told about it up front, so "analyse the
      // last file" has something to resolve against. If the permission lapsed
      // over a restart the run is NOT quietly folder-less — that would look like
      // the routine working while ignoring half of what it was asked to do.
      const bound = folderIds[site.domain] ? await findFolder(folderIds[site.domain]) : null;
      if (bound) {
        const access = await folderAccess(bound);
        if (access === 'granted') {
          task +=
            `\n\nYou also have the user's folder "${bound.label}" from their computer available here. ` +
            `Call list_folder_files with folder: "${bound.label}" to see what is in it — pass sort: "newest" when the task means the latest or most recent file. ` +
            `read_folder_file reads one text file; attach_file uploads one to the page. Do not attach anything the task did not ask for.`;
        } else {
          await pushChat(
            `**${name}** — this routine uses the folder “${bound.label}”, but Tidra can't read it right now. Click Reconnect on it in the new tab and run the routine again.`,
            'error',
          );
          task += `\n\nNote: the folder "${bound.label}" this routine normally uses is NOT available in this run. Do the rest of the task and say plainly that the folder part was skipped.`;
        }
      }

      try {
        // Reuse the site's existing tab. A routine runs every day over the same
        // handful of sites; creating a tab per site per run is how a window ends
        // up with four LinkedIns. The tab is left where the user had it —
        // the routine reads the site, it does not need a pristine landing page.
        const open = await findOpenTab(site.url);
        const tab = open ? { id: open.id } : await browser.tabs.create({ url: site.url, active: false });
        if (tab.id == null) {
          await pushChat(`**${name}** — couldn't open the tab.`, 'error');
          continue;
        }
        if (!open) await waitForTabLoad(tab.id);
        await sleep(700);
        const report = await runSiteAgent(apiKey, tier.act, task, tab.id, profileText);
        sections.push(`## ${name}\n\n${report}`);
        await pushChat(`**${name}**\n${report}`, 'assistant');
      } catch (err) {
        await pushChat(`**${name}** — ${err instanceof Error ? err.message : String(err)}`, 'error');
      }
    }
    if (sections.length) {
      const when = new Date().toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      });
      const brief = await saveReport({
        title: 'Your routine brief',
        subtitle: when,
        markdown: sections.join('\n\n'),
        source: 'routine',
      });
      await browser.tabs.create({ url: reportUrl(brief.id), active: false }).catch(() => {});
      await pushChat(
        '✅ Routine finished — everything is in one brief, opened in a tab (it also lives in the library). Review the drafts in the site tabs before sending anything.',
        'assistant',
      );
    } else {
      await pushChat('✅ Routine finished. Review the drafts in the tabs I opened before sending anything.', 'assistant');
    }
  } finally {
    await cdpDetachAll();
    routineRunning = false;
  }
}

// ─── Batch jobs ─────────────────────────────────────────────────────────────
// "Send 10 connection requests", "write 1000 emails". One agent conversation
// cannot do this: the step budget runs out, the context grows without bound,
// and the service worker is killed long before item 1000. So the model stops
// being the orchestrator and becomes a per-item function — deterministic code
// owns the loop, and the loop's state lives in storage (see lib/jobs.ts).
//
// Shape of a run:
//   plan  → one cheap call: is this a batch, and what is ONE item?
//   collect → build the real work list (from an attachment, or off the page)
//   approve → show the count, the cost, and a real drafted sample
//   pump  → one item per turn, each claimed and settled on its own
//   report → what landed, what failed, what needs eyes

const JOB_ALARM = 'tidra-job-tick';
/** A pump that hasn't touched its job in this long is presumed dead. */
const BEAT_STALE_MS = 90_000;

/** Doing something TO each target — the thing that makes a batch a batch. */
const BATCH_ACTION =
  /\b(send|sending|message|messaging|dm|email|emailing|mail|write|writing|draft|drafting|reply|replying|respond|responding|answer|post|posting|comment|like|follow|unfollow|connect|invite|apply|submit|fill|register|subscribe|unsubscribe|delete|archive|remove|upload|download|export|rename)\b/;

/** Explicitly one-target-at-a-time, whatever the verb: a batch by construction. */
const BATCH_SWEEP =
  /\b(?:one by one|for each|each of (?:these|those|them)|(?:go through|search|check|visit|open|scan|read|look through)\s+(?:all|every|each))\b/;

/** A question about what is already there. Its ANSWER is a list; its work is not. */
const READ_ASK =
  /\b(list|show|tell me|give me|summari[sz]e|how many|how much|which|what|who|where|when|is there|are there|do i have|did i|any new)\b/;

/**
 * Cheap prefilter, so an ordinary message never pays for a planner call.
 *
 * Plurality alone is NOT a batch. "List all my unanswered emails" is one look
 * at one page whose answer happens to be a list; "reply to all my unanswered
 * emails" is a hundred separate visits. What separates them is whether
 * something is DONE to each target, so an action verb is required — not just
 * "all" or a count. Getting this wrong is expensive in exactly the way a user
 * notices: the job path takes the request over, cannot build a list, and asks
 * for a CSV of things that were on the screen the whole time.
 */
function looksBatch(prompt: string): boolean {
  const p = prompt.toLowerCase().trim();
  if (/^confirmed\s+—/.test(p)) return false;
  if (BATCH_SWEEP.test(p)) return true;
  // Many targets: "all/every/each", or a standalone count of 3 or more.
  const many = /\b(all|each|every|everyone|everybody|bulk|mass)\b/.test(p) || /\b([3-9]|\d{2,})\b/.test(p);
  if (!many) return false;
  // Many targets, but only being asked about: still one answer, from wherever
  // it already is.
  if (READ_ASK.test(p) && !BATCH_ACTION.test(p)) return false;
  return BATCH_ACTION.test(p);
}

interface JobPlan {
  batch: boolean;
  mode?: 'act' | 'research';
  count?: number;
  task?: string;
  site?: string;
  source?: 'attachment' | 'page' | 'prompt' | 'unknown';
  irreversible?: boolean;
  labels?: string[];
  missing?: string;
}

/** Pull the first JSON object out of a reply that may be wrapped in prose. */
function extractJson<T>(text: string): T | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

const PLANNER_SYSTEM = `You split a user's request into a repeated unit of work, if it is one. The request may arrive as a short dialogue (User/Tidra turns) — judge what the user is asking for NOW, reading counts and details from the earlier turns. Reply with JSON only — no prose, no code fence.

{
  "batch": true | false,
  "mode": "act" | "research",
  "count": <how many times, best estimate; 0 if unknown>,
  "task": "<the instruction for ONE item, written so it reads correctly with that item's details appended>",
  "site": "<https:// URL where the work happens, or omit>",
  "source": "attachment" | "page" | "prompt" | "unknown",
  "irreversible": true | false,
  "labels": ["<item>", "..."],
  "missing": "<one short question, only when source is unknown>"
}

batch is true only for work that repeats over MULTIPLE targets (3 or more). A single multi-step task ("book a flight", "reply to this email") is NOT a batch — it is one item, so batch is false.

mode — what repeats:
- "act": the user wants an ACTION repeated on each target. Message each person, reply to every email, connect with all of them. irreversible is usually true.
- "research": the user wants to KNOW something that can only be answered by visiting each target and gathering from it, then combining the findings. Nothing is changed. irreversible is always false. Set "task" to what to find out about ONE target.

batch is false — a single research task, not a research batch — when ONE page, list or query would answer it: "list the 3 best-selling sunglasses", "find 10 cheap flights", "show me 5 posts about X". The answer being a list does not make it a batch; the ANSWER is a list, but there is only one place to look.

You are shown an excerpt of the page the user is looking at RIGHT NOW. Read it before deciding. If what was asked for is visible in it — the inbox, the conversation list, the rows — then it is already reachable and batch is false: something else will simply read that page and answer. Never ask for a list of things the excerpt shows are on the screen.

batch is true with mode "research" when the answer genuinely requires opening many SEPARATE places and collecting from each: "search every table for what this user did", "go through all my open PRs and tell me which are blocked", "check each of these 20 sites for a pricing page". Each target is a separate visit, and only combining them answers the question.

If the site has a query console (a SQL editor, a search/filter box, an export) that would answer the whole question at once, that is NOT a batch — it is one task. Prefer that: batch false.

source — where the list of targets comes from:
- "attachment": the user attached a file holding the list (a CSV of recipients, etc).
- "page": the targets are on a website and must be collected from it first (people in a LinkedIn list, emails in an inbox, rows in a dashboard).
- "prompt": the user named every target themselves; put them in "labels".
- "unknown": there is no list anywhere. NEVER invent the targets — set "missing" to the one question that would produce them.

irreversible is true when finishing ONE item sends, posts, submits, buys, applies for, connects, or deletes something. Drafting, saving, reading and collecting are not irreversible.`;

async function planJob(
  apiKey: string,
  model: string,
  prompt: string,
  page: PageContext,
  hasAttachment: boolean,
  signal?: AbortSignal,
): Promise<JobPlan | null> {
  try {
    const res = await callModel(
      apiKey,
      {
        model,
        max_tokens: 700,
        system: PLANNER_SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              `Request: ${prompt}`,
              `Current page: ${page.title} — ${page.url}`,
              hasAttachment ? 'The user attached a file with this message.' : 'No file attached.',
              // Without this the planner is guessing from a URL alone, and it
              // guesses "unknown" — which is how "list my unanswered messages",
              // asked on the page listing them, came back as a request for a CSV.
              ...(page.text?.trim() ? ['', 'Excerpt of that page:', page.text.slice(0, 3000)] : []),
            ].join('\n'),
          },
        ],
      },
      signal,
    );
    return extractJson<JobPlan>(extractText(res.content));
  } catch {
    return null; // planning is an optimisation — never block the normal path on it
  }
}

const RECORD_ITEMS: Tool = {
  name: 'record_items',
  description:
    'Write down the list of things to work through, once you can see all of them. Call this exactly once, then stop.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'One entry per target, in the order they should be handled.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'How a human identifies it — a name, an email, a subject line.' },
            url: { type: 'string', description: 'Direct link to this item, if the page gives one.' },
            note: { type: 'string', description: 'Anything about this item the task will need (role, company, context).' },
          },
          required: ['label'],
        },
      },
    },
    required: ['items'],
  },
};

const COLLECT_SYSTEM = `You are Tidra, building a work list before a batch runs. Your ONLY job right now is to find the targets and write them down — do not act on any of them.

Use snapshot() to read the page, scroll() and a fresh snapshot to reach ones that are offscreen or lazily loaded, and get_page() to read text. Keep going until you can see the number asked for, or until the page has no more to give.

Then call record_items once with everything you found, in page order. Never invent an entry, and never pad the list to hit the number — fewer real targets is correct, made-up ones are not.`;

/** Walk the site and let the model write down the actual targets. */
async function collectItems(
  apiKey: string,
  model: string,
  job: Job,
  want: number,
  tabId: number,
): Promise<{ label: string; key: string; data: Record<string, string> }[]> {
  const tabState: TabState = { tabId };
  const tools = [
    ...TOOLS.filter((t) => ['snapshot', 'find', 'scroll', 'get_page', 'click_text', 'go_back'].includes(t.name)),
    RECORD_ITEMS,
  ];
  const messages: Message[] = [
    {
      role: 'user',
      content: [
        `The user asked: ${job.goal}`,
        ``,
        `Find the ${want > 0 ? want : ''} targets this applies to on this page and record them.`,
        `Each item will later be handled with: ${job.task}`,
        ``,
        await snapshotAllFrames(tabId),
      ].join('\n'),
    },
  ];

  const snapshotIds = new Set<string>();
  let guard = 0;
  while (guard++ < 16) {
    const res = await callModel(apiKey, {
      model,
      max_tokens: 2000,
      // Collecting is mechanical reading — no chain-of-thought needed.
      reasoning_effort: 'low',
      system: COLLECT_SYSTEM,
      messages,
      tools,
    });
    if (res.stop_reason !== 'tool_use') return [];

    const recorded = (res.content as any[]).find((b) => b.type === 'tool_use' && b.name === 'record_items');
    if (recorded) {
      const raw = Array.isArray(recorded.input?.items) ? recorded.input.items : [];
      return raw.slice(0, MAX_ITEMS).map((r: any) => {
        const label = String(r?.label ?? '').trim();
        const data: Record<string, string> = {};
        if (r?.url) data.url = String(r.url);
        if (r?.note) data.note = String(r.note);
        return { label, key: (r?.url ? String(r.url) : label).toLowerCase(), data };
      });
    }

    messages.push({ role: 'assistant', content: res.content as any });
    const results: ToolResultBlock[] = [];
    for (const block of res.content as any[]) {
      if (block.type !== 'tool_use') continue;
      await setStatus('Building the list');
      const r = await execTool(block.name, block.input, tabState);
      if (SNAPSHOT_TOOLS.has(block.name)) snapshotIds.add(block.id);
      results.push({ type: 'tool_result', tool_use_id: block.id, content: r.content, is_error: r.isError });
    }
    if (!results.length) return [];
    messages.push({ role: 'user', content: results });
    pruneOldSnapshots(messages, snapshotIds);
  }
  return [];
}

const FINISH_ITEM: Tool = {
  name: 'finish_item',
  description:
    'End your work on this ONE item. Call it as soon as the item is complete, or as soon as you are certain it cannot be done.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['done', 'failed', 'skipped'],
        description: 'done = finished. failed = tried and could not. skipped = it should not be done at all.',
      },
      result: { type: 'string', description: 'One line: what you did, or why you could not.' },
    },
    required: ['status', 'result'],
  },
};

const JOB_ITEM_SYSTEM = `You are Tidra, working through a long list of near-identical tasks. This turn handles exactly ONE item and nothing else.

You are on a tab opened for this job. Ignore everything on the page that belongs to other items — do not wander, do not "helpfully" handle the next one, do not summarise the list.

Use snapshot() to see the page's interactive elements (refs like ref_0-12), then click(ref) / fill(ref, text). Refs go stale whenever the page changes, so snapshot again after anything that navigates or re-renders. Every action reports what changed; "no visible change" means it did not work — try something else rather than continuing as if it had.

Write real content that fits this specific item. It is one of many, but the person receiving it only ever sees this one, so it must not read as a form letter — use the item's own details.

Work fast and finish: you have a small step budget per item. Call finish_item as soon as this item is complete, or as soon as you are sure it cannot be done. Do not ask the user questions — there is nobody watching an individual item.`;

const JOB_RESEARCH_SYSTEM = `You are Tidra, working through a list of places to look. This turn examines exactly ONE of them and nothing else.

You are on a background tab the user cannot see. Nobody is watching this item, and there is nothing to approve — so READ ONLY. Never click something that sends, saves, deletes, buys or changes anything; if the only way forward would change something, stop and say so.

Use snapshot() to see the page (refs like ref_0-12), click(ref) to open things and go_back() to return, get_page() to read text properly. Refs go stale whenever the page changes.

Your whole output is the FINDING for this one item, passed to finish_item as \`result\`:
- Concrete and specific: names, dates, counts, subjects, values — quoted from the page, never guessed.
- If there is nothing here for what was asked, say exactly that ("nothing for this user") — that is a useful finding, not a failure. Use status "done" for it.
- A few sentences at most. Something else will combine every item's finding into the final answer, so write for that reader, not for a human waiting on this one.

Work fast: you have a small step budget. Call finish_item as soon as you know the answer for this item.`;

const JOB_SAMPLE_RULE = `\n\nTHIS ITEM IS THE SAMPLE. Draft everything, then STOP before the irreversible step — do not click Send/Post/Submit/Connect. Call confirm_action with a summary that QUOTES what you drafted, so the user can approve this one and the rest of the batch from it.`;

const JOB_APPROVED_RULE = `\n\nThe user has already approved this batch, including the final send. Complete the item all the way — click the Send/Post/Submit button yourself. Do not call confirm_action.`;

/** Run one item to completion in the job's tab. */
async function runJobItem(
  apiKey: string,
  model: string,
  job: Job,
  item: JobItem,
  profileText: string,
): Promise<{
  status: 'done' | 'failed' | 'review';
  result: string;
  sample?: string;
  trace?: string[];
}> {
  const tabId = job.tabId!;
  const tabState: TabState = { tabId };

  // Deterministic setup: put the tab where the item starts before the model
  // gets a turn. This is a step the model no longer has to spend, times N.
  const start = item.data?.url || job.site;
  if (start) {
    try {
      await browser.tabs.update(tabId, { url: start });
      await waitForTabLoad(tabId);
      await sleep(400);
    } catch {
      return { status: 'failed', result: `Could not open ${start}` };
    }
  }

  const details = Object.entries(item.data ?? {})
    .filter(([k]) => k !== 'url')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const messages: Message[] = [
    {
      role: 'user',
      content: [
        `Item ${item.i + 1} of ${job.total}: ${item.label}`,
        details ? `\nWhat is known about it:\n${details}` : '',
        `\nTask for this item: ${job.task}`,
        `\nThe wider goal, for context only: ${job.goal}`,
        // The worked example from the first completed item. Near-identical
        // items means the path is near-identical too — following it is what
        // lets the cheap model handle the long tail of the batch.
        job.exemplar
          ? `\nA previous item was completed successfully with these steps — follow the same pattern, adapting refs (take fresh snapshots) and content to THIS item:\n${job.exemplar}`
          : '',
        ``,
        await snapshotAllFrames(tabId),
      ].join('\n'),
    },
  ];

  const research = job.mode === 'research';
  const sampling = job.irreversible && !job.approved;
  const tools = [
    ...TOOLS.filter((t) => {
      if (t.name === 'screenshot' || t.name === 'click_at') return false; // a background tab cannot be captured
      if (t.name === 'create_report') return false; // 1000 items must not open 1000 tabs
      if (t.name === 'focus_background') return false; // item 400 must not jump in front of the user
      // Reading cannot write: the tools that change a page are simply absent,
      // so a research sweep is read-only by construction, not by instruction.
      if (research) {
        return ['snapshot', 'find', 'click', 'scroll', 'get_page', 'go_back', 'open_url', 'click_text'].includes(
          t.name,
        );
      }
      if (t.name === 'confirm_action') return sampling;
      return true;
    }),
    FINISH_ITEM,
  ];
  const system = research
    ? JOB_RESEARCH_SYSTEM
    : JOB_ITEM_SYSTEM + profileText + (sampling ? JOB_SAMPLE_RULE : job.approved ? JOB_APPROVED_RULE : '');

  const snapshotIds = new Set<string>();
  const trace: string[] = [];
  let guard = 0;
  while (guard++ < job.stepsPerItem) {
    const res = await callModel(apiKey, {
      model,
      max_tokens: 1600,
      // The exemplar-following small model works mechanically; the big model
      // (first item, retries) keeps its default depth for drafting quality.
      reasoning_effort: model === GROQ_MODELS.small ? 'low' : undefined,
      system,
      messages,
      tools,
    });

    if (res.stop_reason !== 'tool_use') {
      // Ended with prose. Treat it as the outcome rather than losing the work.
      return {
        status: 'done',
        result: extractText(res.content as ContentBlock[]).slice(0, 300) || 'Done.',
        trace,
      };
    }

    const blocks = res.content as any[];
    const confirm = blocks.find((b) => b.type === 'tool_use' && b.name === 'confirm_action');
    if (confirm) {
      const pre = extractText(res.content as ContentBlock[]);
      const summary = confirm.input?.summary || pre || 'Ready to go.';
      return { status: 'review', result: 'Drafted, waiting for approval.', sample: summary };
    }

    const finish = blocks.find((b) => b.type === 'tool_use' && b.name === 'finish_item');
    if (finish) {
      const status = finish.input?.status === 'done' ? 'done' : 'failed';
      return { status, result: String(finish.input?.result ?? '').slice(0, 300) || 'Done.', trace };
    }

    messages.push({ role: 'assistant', content: blocks as any });
    const results: ToolResultBlock[] = [];
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;
      await setStatus(`${job.done + 1}/${job.total} · ${item.label.slice(0, 28)}`);
      const r = await execTool(block.name, block.input, tabState, job.approved);
      if (SNAPSHOT_TOOLS.has(block.name)) snapshotIds.add(block.id);
      if (!r.isError) {
        trace.push(`${block.name}(${JSON.stringify(block.input ?? {}).slice(0, 100)})`);
      }
      results.push({ type: 'tool_result', tool_use_id: block.id, content: r.content, is_error: r.isError });
    }
    if (!results.length) {
      return {
        status: 'done',
        result: extractText(res.content as ContentBlock[]).slice(0, 300) || 'Done.',
        trace,
      };
    }
    messages.push({ role: 'user', content: results });
    pruneOldSnapshots(messages, snapshotIds);
  }

  // Out of steps on ONE item. That is a stuck item, not a stuck job — the rest
  // of the list is unaffected, which is the entire point of the per-item budget.
  return { status: 'failed', result: `Ran out of steps on this one after ${job.stepsPerItem} tries.` };
}

/** The job's own tab, so a long run never fights the user for the page in front. */
async function ensureJobTab(job: Job): Promise<number> {
  if (job.tabId != null) {
    const tab = await browser.tabs.get(job.tabId).catch(() => null);
    if (tab?.id != null) return tab.id;
  }
  const tab = await browser.tabs.create({ url: job.site || 'about:blank', active: false });
  if (tab.id == null) throw new Error('Could not open a tab for the job.');
  job.tabId = tab.id;
  await waitForTabLoad(tab.id);
  await saveJob(job);
  return tab.id;
}

async function setJobState(job: Job, state: Job['state']): Promise<Job> {
  job.state = state;
  await saveJob(job);
  return job;
}

/**
 * The pump. Runs items back-to-back while the worker is alive, re-reading the
 * job each lap so Pause and Cancel from the UI take effect immediately. If the
 * worker dies mid-run, the watchdog alarm restarts this within a minute.
 */
let pumping = false;
async function pumpJob(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const setup = await modelSetup();
    if (!setup) {
      // Park the job rather than returning: the watchdog would otherwise wake
      // every minute forever, retrying something that cannot succeed, silently.
      const stalled = await loadJob();
      if (stalled) {
        await setJobState(stalled, 'paused');
        await browser.alarms.clear(JOB_ALARM).catch(() => {});
        await pushChat('The batch is paused — there is no API key set. Add one in settings and press Resume.', 'error');
      }
      return;
    }
    const profileText = (await profilePreamble()) + (await foldersPreamble());

    for (;;) {
      let job = await loadJob();
      if (!job || job.state !== 'running') return;

      const item = await claimNext(job);
      if (!item) {
        if (await retrySweep(job)) continue; // one sweep over reversible failures
        // The big model writes the answer: it reads every finding at once, and
        // this is the one call in a sweep where getting it right matters most.
        await finishJob(job, setup.apiKey, setup.tier.act);
        return;
      }

      await ensureJobTab(job);
      // Exemplar economics: the big model solves the task shape once (item 1);
      // every later first attempt runs on the cheap model with that item's
      // step trace as a worked example. Retries escalate back to the big one.
      const itemModel =
        job.exemplar && item.attempts <= 1 ? GROQ_MODELS.small : setup.tier.act;
      let outcome: {
        status: 'done' | 'failed' | 'review';
        result: string;
        sample?: string;
        trace?: string[];
      };
      try {
        outcome = await runJobItem(setup.apiKey, itemModel, job, item, profileText);
      } catch (err) {
        outcome = { status: 'failed', result: err instanceof Error ? err.message : String(err) };
      }

      // The sample came back drafted, not sent — park the job on the user.
      if (outcome.sample) {
        job.sample = outcome.sample;
        await requeue(job, item); // nothing was sent, so this item is untouched work
        await setJobState(job, 'sampling');
        await pushChat(
          `${outcome.sample}\n\nThis is item 1 of ${job.total}. Approve it and I'll run the remaining ${job.total - 1} the same way.`,
          'assistant',
        );
        await setStatus(null);
        return;
      }

      // First completed item: its step trace becomes the batch's exemplar.
      if (outcome.status === 'done' && !job.exemplar && (outcome.trace?.length ?? 0) >= 2) {
        job.exemplar = outcome.trace!.slice(0, 16).join('\n');
      }

      await settle(job, item, outcome.status, outcome.result);
      const after = await loadJob();
      if (!after || after.state !== 'running') return;
      if (job.throttleMs) await sleep(job.throttleMs);
    }
  } finally {
    await cdpDetachAll();
    pumping = false;
  }
}

const SYNTHESIS_SYSTEM = `You are Tidra. A sweep just visited many places one at a time and wrote down what each one held. Turn those findings into the answer to the user's original question.

- Answer the question directly, in the first line. No preamble, no "based on the findings".
- Use ONLY what the findings say. Never invent, never fill a gap with something plausible.
- Lead with what was actually found. Places that held nothing get one closing line at most ("nothing in the other 31"), never a list.
- When several places hold related things, a markdown table is usually the clearest form.
- If nothing was found anywhere, say so plainly in one line.`;

/** How much of a sweep's findings the synthesis reads. Past this it is capped
 *  and the cap is stated, rather than silently answering from a slice. */
const SYNTH_MAX_ITEMS = 120;

/**
 * A research sweep's real output: every item's finding, combined into the
 * answer the user actually asked for. The counts are progress, not the point.
 */
async function answerResearch(job: Job, items: JobItem[], apiKey: string, model: string): Promise<void> {
  const withFindings = items.filter((i) => i.result && (i.state === 'done' || i.state === 'failed'));
  if (!withFindings.length) {
    await pushChat(
      `I went through ${job.total} of them and came back with nothing usable. Worth checking I was looking in the right place.`,
      'assistant',
    );
    return;
  }
  const used = withFindings.slice(0, SYNTH_MAX_ITEMS);
  const digest = used.map((i) => `- ${i.label}: ${i.result}`).join('\n');

  await setStatus('Putting it together');
  const res = await callModel(apiKey, {
    model,
    max_tokens: 1600,
    system: SYNTHESIS_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          `The user asked: ${job.goal}`,
          ``,
          `Findings, one per place looked at:`,
          digest.slice(0, 60000),
        ].join('\n'),
      },
    ],
  });

  const answer = extractText(res.content as ContentBlock[]).trim();
  const notes: string[] = [];
  if (used.length < withFindings.length) {
    notes.push(`_Answered from the first ${used.length} of ${withFindings.length} places checked._`);
  }
  const failed = items.filter((i) => i.state === 'failed').length;
  if (failed) notes.push(`_${failed} of ${job.total} couldn't be read, so anything there is missing._`);

  await pushChat(
    [answer || 'I gathered the findings but could not put an answer together from them.', ...notes].join('\n\n'),
    'assistant',
  );
}

/** Final report: counts first, then the handful of things that need a human. */
async function finishJob(job: Job, apiKey?: string, model?: string): Promise<void> {
  job.state = 'done';
  job.finishedAt = Date.now();
  job.current = undefined;
  await saveJob(job);
  await browser.alarms.clear(JOB_ALARM).catch(() => {});

  const items = await allItems(job);

  // A sweep answers a question; a batch reports what it did to things.
  if (job.mode === 'research' && apiKey && model) {
    try {
      await answerResearch(job, items, apiKey, model);
      await setStatus(null);
      return;
    } catch {
      // Fall through to the plain report rather than losing the run entirely.
    }
  }

  const failed = items.filter((i) => i.state === 'failed');
  const review = items.filter((i) => i.state === 'review');
  const lines = [`✅ Finished — ${job.done} of ${job.total} done.`];
  if (failed.length) {
    lines.push(
      `\n**${failed.length} failed:**\n` +
        failed.slice(0, 8).map((i) => `- ${i.label} — ${i.result ?? 'no reason recorded'}`).join('\n') +
        (failed.length > 8 ? `\n- …and ${failed.length - 8} more` : ''),
    );
  }
  if (review.length) {
    lines.push(
      `\n**${review.length} need checking** (interrupted mid-action, so I won't retry them):\n` +
        review.slice(0, 8).map((i) => `- ${i.label}`).join('\n') +
        (review.length > 8 ? `\n- …and ${review.length - 8} more` : ''),
    );
  }
  await pushChat(lines.join('\n'), 'assistant');
  await setStatus(null);
}

/**
 * Decide whether a request is a batch and, if so, take it over. Returns true
 * when the job path has claimed the request — the normal agent never runs.
 */
async function maybeStartJob(
  apiKey: string,
  tier: { chat: string; act: string; router: string },
  message: AskRequest,
  signal: AbortSignal,
  senderTabId: number | undefined,
): Promise<boolean> {
  if (!looksBatch(message.prompt)) return false;
  const existing = await loadJob();
  if (existing && ['collecting', 'sampling', 'running', 'paused'].includes(existing.state)) return false;
  // A finished job the user never dismissed still owns its item chunks. Drop
  // them here or every batch ever run stays in storage forever.
  if (existing) await clearJob(existing);

  const textFiles = (message.attachments ?? []).filter((a) => a.kind === 'text');
  const plan = await planJob(apiKey, tier.act, message.prompt, message.page, textFiles.length > 0, signal);
  if (!plan?.batch || !plan.task) return false;

  // The planner thinks there is no list anywhere. It is guessing from an
  // excerpt, so before taking the request over to ask for a CSV, try the page
  // the user is actually on — that is where they usually mean. If nothing is
  // there either, the fall-through below hands the whole thing to the normal
  // agent, which can go and look properly.
  const source = plan.source === 'unknown' ? 'page' : plan.source;

  const mode = plan.mode === 'research' ? 'research' : 'act';
  const job = newJob({
    goal: message.prompt,
    task: plan.task,
    mode,
    site: plan.site || (/^https?:/i.test(message.page.url) ? message.page.url : undefined),
    // Research reads and never writes, so there is no send to hold back and no
    // sample to approve — the run is safe by construction.
    irreversible: mode === 'act' && plan.irreversible !== false,
  });
  await saveJob(job);
  await setStatus('Building the list');

  // Build the work list. Where it comes from decides how much this costs: a
  // file or an enumerated prompt is free, a page costs one collection turn.
  let items: { label: string; key: string; data: Record<string, string> }[] = [];
  if (source === 'attachment' && textFiles.length) {
    items = textFiles.flatMap((f) => itemsFromCsv(f.data));
  } else if (source === 'prompt' && plan.labels?.length) {
    items = plan.labels.map((l) => ({ label: String(l), key: String(l).toLowerCase(), data: {} }));
  } else {
    // Collect from the tab the user is already on when it is the right site.
    // A fresh tab pointed at the same URL is NOT the same page: their inbox is
    // open, the thread list is expanded, the feed is scrolled to where they
    // were. Reloading the bare site throws away precisely the state that made
    // them say "they're on the page".
    const siteHost = job.site ? hostOf(job.site) : null;
    const onSite = senderTabId != null && !!siteHost && siteHost === hostOf(message.page.url);
    const tabId = onSite ? senderTabId! : await ensureJobTab(job);
    if (!onSite && job.site) {
      await browser.tabs.update(tabId, { url: job.site }).catch(() => {});
      await waitForTabLoad(tabId);
      await sleep(500);
    }
    items = await collectItems(apiKey, tier.act, job, plan.count ?? 0, tabId);
  }

  // Nothing to run. Do NOT claim the request — the normal agent has the page,
  // the tools and the freedom to go looking, and answering beats a dead end.
  // This used to reply "I couldn't build the list … attach a CSV", which was
  // both a refusal and a lie: the things asked for were usually right there.
  if (!items.length) {
    await clearJob(job);
    await setStatus(null);
    return false;
  }

  await setItems(job, items);
  await setJobState(job, 'sampling');

  const est = estimate(job);
  const cost = est.dollars < 0.01 ? 'under a cent' : `about $${est.dollars.toFixed(2)}`;
  const preview = `${items.slice(0, 3).map((i) => i.label).join(', ')}${
    job.total > 3 ? `, +${job.total - 3} more` : ''
  }`;
  await pushChat(
    (mode === 'research'
      ? [
          `**${job.total} place${job.total === 1 ? '' : 's'}** to look through: ${preview}.`,
          ``,
          `In each one: ${job.task}`,
          ``,
          `Roughly ${humanDuration(est.minutes)} and ${cost} in model usage. Nothing is changed — I read each one, then answer from everything together.`,
        ]
      : [
          `**${job.total} item${job.total === 1 ? '' : 's'}** to work through: ${preview}.`,
          ``,
          `Each one: ${job.task}`,
          ``,
          `Roughly ${humanDuration(est.minutes)} and ${cost} in model usage.` +
            (job.irreversible ? " I'll draft the first one and show it to you before anything is sent." : ''),
        ]
    ).join('\n'),
    'assistant',
  );
  await setStatus(null);
  return true;
}

/** Start (or restart) the pump, with the watchdog alarm behind it. */
async function startPump(job: Job): Promise<void> {
  job.state = 'running';
  job.startedAt ??= Date.now();
  job.beat = Date.now();
  await saveJob(job);
  // The alarm is a resurrection mechanism, not the clock: alarms are clamped to
  // minutes, and 1000 items at a minute each would take a week. The pump runs
  // flat out in memory; the alarm only matters if the worker is killed.
  browser.alarms.create(JOB_ALARM, { periodInMinutes: 1 });
  void pumpJob();
}

/** Watchdog: did a pump die holding the job? */
async function jobWatchdog(): Promise<void> {
  const job = await loadJob();
  if (!job) {
    await browser.alarms.clear(JOB_ALARM).catch(() => {});
    return;
  }
  if (job.state !== 'running') return;
  // `pumping` is per worker instance: if this worker has a live pump, the job
  // is fine and a second pump would double-run items. If the flag is false
  // while the job says "running", the worker that owned it is gone.
  if (pumping) return;
  if (Date.now() - (job.beat ?? 0) < BEAT_STALE_MS) return; // a fresh start still settling
  await reconcile(job);
  void pumpJob();
}

async function handleJobControl(action: string): Promise<void> {
  const job = await loadJob();
  if (!job) return;

  if (action === 'start' || action === 'approve') {
    // "approve" is the user signing off on the drafted sample — from here the
    // batch may complete its own sends. Manual mode gets the draft first; auto
    // mode said up front that it doesn't want to be asked.
    const { tidraAuto } = await browser.storage.local.get('tidraAuto');
    if (action === 'approve' || tidraAuto === true || !job.irreversible) {
      job.approved = true;
      job.sample = undefined;
    }
    await startPump(job);
    return;
  }
  if (action === 'pause') {
    job.current = undefined;
    await setJobState(job, 'paused');
    await setStatus(null);
    await browser.alarms.clear(JOB_ALARM).catch(() => {});
    return;
  }
  if (action === 'resume') {
    await reconcile(job);
    await startPump(job);
    return;
  }
  if (action === 'cancel') {
    await setJobState(job, 'cancelled');
    await browser.alarms.clear(JOB_ALARM).catch(() => {});
    await setStatus(null);
    if (job.tabId != null) browser.tabs.remove(job.tabId).catch(() => {});
    await pushChat(
      job.done ? `Stopped. ${job.done} of ${job.total} were done before I stopped.` : 'Stopped — nothing was sent.',
      'assistant',
    );
    await clearJob(job);
    return;
  }
  if (action === 'dismiss') {
    await clearJob(job);
  }
}

// ─── Voice input ────────────────────────────────────────────────────────────
// The island can't hold a microphone — it's a content script, so getUserMedia
// there belongs to whatever site it's sitting on. The offscreen document does
// the listening at the extension's own origin; this is just the relay.

const OFFSCREEN_PATH = 'offscreen.html';
let offscreenReady: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  // Creating one twice throws, and the worker can restart at any time, so the
  // in-flight promise is cached rather than a boolean.
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    if (!(browser as any).offscreen) throw new Error('offscreen-unsupported');
    const existing = await (browser.runtime as any).getContexts?.({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existing?.length) return;
    try {
      await (browser as any).offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['USER_MEDIA'],
        justification: 'Record the microphone so the user can talk to Tidra instead of typing.',
      });
    } catch (err) {
      // A worker that restarted while the document survived lands here on
      // browsers without getContexts. The document is what we wanted anyway.
      if (!/single offscreen|already exists/i.test(String(err))) throw err;
    }
  })().catch((err) => {
    offscreenReady = null; // let the next attempt try again
    throw err;
  });
  return offscreenReady;
}

/**
 * Which island asked to listen, kept IN STORAGE rather than in a variable.
 *
 * This looks like over-engineering and isn't. Between "start listening" and the
 * words coming back, this worker has nothing to do — and a worker with nothing
 * to do is killed within ~30 seconds. It then restarts to handle the result
 * with every variable reset, so an in-memory id would be null exactly when it
 * was needed, the island would reject its own transcript as belonging to
 * someone else, and the mic would never reset. Storage outlives the worker.
 */
async function voiceRelay(action: string, sid?: string): Promise<any> {
  if (action === 'start') await browser.storage.local.set({ tidraVoiceSid: sid ?? null });
  await ensureOffscreen();
  // createDocument resolves once the document exists, which is not the same as
  // its module script having run and registered a listener. A message that
  // arrives in that gap fails with "receiving end does not exist" — so give the
  // page a moment and try again rather than reporting a broken microphone.
  let lastErr: unknown;
  for (let i = 0; i < 6; i++) {
    try {
      return await browser.runtime.sendMessage({ type: 'tidra-voice-offscreen', action });
    } catch (err) {
      lastErr = err;
      if (!/receiving end|establish connection/i.test(String(err))) throw err;
      await sleep(120);
    }
  }
  throw lastErr;
}

/** Offscreen finished (or gave up). Publish it for the island that asked. */
async function publishVoice(msg: { state?: string; text?: string; error?: string }): Promise<void> {
  const { tidraVoiceSid } = await browser.storage.local.get('tidraVoiceSid');
  const sid = (tidraVoiceSid as string | null) ?? null;
  await browser.storage.local.set({
    tidraVoice: { sid, state: msg.state ?? 'idle', error: msg.error },
    // Only stamp heard text when there is some — an empty result should leave
    // the last thing the user said alone.
    ...(msg.text ? { tidraHeard: { sid, text: msg.text, ts: Date.now() } } : {}),
  });
}

export default defineBackground(() => {
  // A worker that was killed mid-job comes back here. Anything left `doing` is
  // judged before a single new item starts.
  void (async () => {
    const job = await loadJob();
    if (job?.state === 'running') {
      await reconcile(job);
      void pumpJob();
    }
  })();

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === JOB_ALARM) void jobWatchdog();
  });

  browser.commands.onCommand.addListener(async (command) => {
    if (command !== 'toggle-island') return;
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      browser.tabs.sendMessage(tab.id, { type: 'tidra-toggle' }).catch(() => {});
    }
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'tidra-ask') {
      handleAsk(message as AskRequest, sender.tab?.id)
        .catch((err: unknown) => pushChat(err instanceof Error ? err.message : String(err), 'error'))
        .finally(() => sendResponse({ ok: true }));
      return true; // keep the worker alive for the async work
    }
    // The new tab asks which kind of request this is: something it can answer
    // inline, or something that needs the browser (and so needs the agent).
    if (message?.type === 'tidra-route' && typeof message.prompt === 'string') {
      (async () => {
        const setup = await modelSetup();
        if (!setup) return sendResponse({ route: 'chat' });
        // With the conversation, "what are these?" is routable; without it, it
        // is three words about nothing and the verdict is a coin toss.
        const history = Array.isArray(message.history) ? (message.history as ChatMsg[]) : [];
        const route = await classify(setup.apiKey, setup.tier.router, message.prompt, history);
        sendResponse({ route });
      })().catch(() => sendResponse({ route: 'chat' }));
      return true;
    }
    // Voice input: the island asks to listen. What it HEARD comes back later,
    // through storage, because the mic usually closes itself.
    if (message?.type === 'tidra-voice' && typeof message.action === 'string') {
      voiceRelay(message.action, message.sid)
        .then((res) => sendResponse(res ?? { ok: false, error: 'no-response' }))
        .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      return true; // async response
    }
    if (message?.type === 'tidra-voice-result') {
      publishVoice(message).catch(() => {});
      return;
    }
    // Transcribe a clip recorded inside a page. The content script can't call
    // Groq itself — no cross-origin privileges under MV3, and the site's CSP
    // governs the request — so the audio comes here instead.
    if (message?.type === 'tidra-transcribe' && typeof message.audio === 'string') {
      (async () => {
        const { tidraGroqKey } = await browser.storage.local.get('tidraGroqKey');
        if (!tidraGroqKey) return sendResponse({ ok: false, error: 'no-key' });
        try {
          const clip = base64ToBlob(message.audio, message.mime || 'audio/webm');
          sendResponse({ ok: true, text: await transcribe(tidraGroqKey as string, clip) });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      })();
      return true; // async response
    }
    // Batch job controls from the island: start / approve / pause / resume /
    // cancel / dismiss.
    if (message?.type === 'tidra-job' && typeof message.action === 'string') {
      handleJobControl(message.action)
        .catch((err) => pushChat(err instanceof Error ? err.message : String(err), 'error'))
        .finally(() => sendResponse({ ok: true }));
      return true; // keep the worker alive for the async work
    }
    if (message?.type === 'tidra-stop') {
      currentAbort?.abort(); // cancel the in-flight API request
      clearLoading().catch(() => {}); // reset the UI (storage change re-renders)
      return;
    }
    if (message?.type === 'tidra-visit' && typeof message.domain === 'string') {
      handleVisit(message.domain).catch(() => {});
      return;
    }
    if (message?.type === 'tidra-open-routine') {
      browser.storage.local.get('tidraRoutine').then(({ tidraRoutine }) => {
        const sites = (tidraRoutine as { sites?: { url: string }[] } | undefined)?.sites ?? [];
        sites.forEach((s) => browser.tabs.create({ url: s.url, active: false }).catch(() => {}));
        browser.storage.local.set({ tidraRoutine: null });
      });
      return;
    }
    if (message?.type === 'tidra-open-options') {
      browser.runtime.openOptionsPage();
    }
    // Return the currently-learned routine (freshly computed), minus any sites
    // the user has removed. Used by the new-tab "Your routine" panel.
    if (message?.type === 'tidra-get-routine') {
      (async () => {
        const store = await browser.storage.local.get([
          'tidraVisits',
          'tidraRoutineHidden',
          'tidraRoutineEnabled',
        ]);
        const enabled = store.tidraRoutineEnabled !== false;
        const visits = (store.tidraVisits as Visit[]) || [];
        const hidden = new Set((store.tidraRoutineHidden as string[]) || []);
        const sites = detectRoutine(visits).filter((s) => !hidden.has(s.domain));
        sendResponse({ enabled, sites });
      })();
      return true; // async response
    }
    // Run the whole routine in the background (draft-only, reports into the chat).
    if (message?.type === 'tidra-run-routine') {
      runRoutine()
        .catch((err) => pushChat(err instanceof Error ? err.message : String(err), 'error'))
        .finally(() => sendResponse({ ok: true }));
      return true; // keep the worker alive for the async work
    }
  });
});
