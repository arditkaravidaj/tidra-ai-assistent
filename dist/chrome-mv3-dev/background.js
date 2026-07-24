var background = (function() {
	//#endregion
	//#region node_modules/wxt/dist/browser.mjs
	/**
	* Contains the `browser` export which you should use to access the extension
	* APIs in your project:
	*
	* ```ts
	* import { browser } from 'wxt/browser';
	*
	* browser.runtime.onInstalled.addListener(() => {
	*   // ...
	* });
	* ```
	*
	* @module wxt/browser
	*/
	var browser = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;
	//#endregion
	//#region node_modules/wxt/dist/utils/define-background.mjs
	function defineBackground(arg) {
		if (arg == null || typeof arg === "function") return { main: arg };
		return arg;
	}
	//#endregion
	//#region lib/llm.ts
	var GROQ_MODELS = {
		big: "openai/gpt-oss-120b",
		small: "openai/gpt-oss-20b",
		router: "llama-3.1-8b-instant",
		vision: "qwen/qwen3.6-27b"
	};
	var GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
	/** Which model handles what, per cost tier. */
	var TIERS = {
		economy: {
			chat: GROQ_MODELS.small,
			act: GROQ_MODELS.small,
			router: GROQ_MODELS.router
		},
		balanced: {
			chat: GROQ_MODELS.small,
			act: GROQ_MODELS.big,
			router: GROQ_MODELS.router
		},
		quality: {
			chat: GROQ_MODELS.big,
			act: GROQ_MODELS.big,
			router: GROQ_MODELS.router
		}
	};
	function tierFor(name) {
		return TIERS[name || "balanced"] || TIERS.balanced;
	}
	/** Only the vision model can read the screenshots the fallback tool takes. */
	function supportsVision(model) {
		return model === GROQ_MODELS.vision;
	}
	function blockText(content) {
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
	}
	function imagesIn(content) {
		if (!Array.isArray(content)) return [];
		return content.filter((b) => b?.type === "image" && b.source?.type === "base64").map((b) => `data:${b.source.media_type};base64,${b.source.data}`);
	}
	function toOpenAiMessages(params) {
		const out = [];
		const names = /* @__PURE__ */ new Map();
		for (const m of params.messages) {
			if (!Array.isArray(m.content)) continue;
			for (const b of m.content) if (b?.type === "tool_use") names.set(b.id, b.name);
		}
		if (params.system) out.push({
			role: "system",
			content: params.system
		});
		for (const m of params.messages) {
			if (typeof m.content === "string") {
				out.push({
					role: m.role,
					content: m.content
				});
				continue;
			}
			const blocks = m.content;
			if (m.role === "assistant") {
				const text = blockText(blocks);
				const calls = blocks.filter((b) => b?.type === "tool_use");
				const msg = {
					role: "assistant",
					content: text || null
				};
				if (calls.length) msg.tool_calls = calls.map((c) => ({
					id: c.id,
					type: "function",
					function: {
						name: c.name,
						arguments: JSON.stringify(c.input ?? {})
					}
				}));
				out.push(msg);
				continue;
			}
			const results = blocks.filter((b) => b?.type === "tool_result");
			const pendingImages = [];
			for (const r of results) {
				const imgs = imagesIn(r.content);
				pendingImages.push(...imgs);
				out.push({
					role: "tool",
					tool_call_id: r.tool_use_id,
					name: names.get(r.tool_use_id),
					content: blockText(r.content) || (imgs.length ? "(screenshot below)" : "(done)")
				});
			}
			const rest = blocks.filter((b) => b?.type !== "tool_result");
			const parts = [];
			const text = blockText(rest);
			if (text) parts.push({
				type: "text",
				text
			});
			for (const url of [...imagesIn(rest), ...pendingImages]) parts.push({
				type: "image_url",
				image_url: { url }
			});
			if (parts.length) out.push({
				role: "user",
				content: parts.length === 1 && text ? text : parts
			});
		}
		return out;
	}
	function toOpenAiTools(tools) {
		if (!tools?.length) return void 0;
		return tools.map((t) => ({
			type: "function",
			function: {
				name: t.name,
				description: t.description,
				parameters: t.input_schema
			}
		}));
	}
	function fromOpenAi(data) {
		const message = data?.choices?.[0]?.message ?? {};
		const content = [];
		if (message.content) content.push({
			type: "text",
			text: String(message.content)
		});
		const calls = message.tool_calls ?? [];
		for (const c of calls) {
			let input = {};
			try {
				input = JSON.parse(c.function?.arguments || "{}");
			} catch {
				input = {};
			}
			content.push({
				type: "tool_use",
				id: c.id,
				name: c.function?.name,
				input
			});
		}
		return {
			content,
			stop_reason: calls.length ? "tool_use" : "end_turn"
		};
	}
	async function callModel(apiKey, params, signal) {
		const res = await fetch(GROQ_URL, {
			method: "POST",
			signal,
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`
			},
			body: JSON.stringify({
				model: params.model,
				max_tokens: params.max_tokens,
				messages: toOpenAiMessages(params),
				tools: toOpenAiTools(params.tools),
				...params.tools?.length ? { tool_choice: "auto" } : {}
			})
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`Groq ${res.status}: ${body.slice(0, 400)}`);
		}
		return fromOpenAi(await res.json());
	}
	//#endregion
	//#region entrypoints/background.ts
	async function modelSetup() {
		const store = await browser.storage.local.get(["tidraGroqKey", "tidraTier"]);
		const apiKey = store.tidraGroqKey;
		if (!apiKey) return null;
		return {
			apiKey,
			tier: tierFor(store.tidraTier)
		};
	}
	var SYSTEM_PROMPT = `You are Tidra, a highly capable AI assistant that lives in the user's browser as a floating "island". You don't just chat — you get things done by taking real actions on the page.

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
- Every action tells you what changed ("new on screen: …"). Read it. "No visible change" means it didn't work — try a different element rather than continuing as if it succeeded.
- Elements marked "offscreen" need scroll() first. Lists that load more as you scroll need scroll(direction:"down") then a fresh snapshot.
- Sub-frames appear as FRAME sections with their own refs; use them exactly like the main page's.
- go_back() returns to the previous page — use it to get back to a list of results after opening one item, instead of re-navigating from scratch.
- You have plenty of steps. Work through a task item by item: do the first one completely, go_back, then the next. Don't abandon a task half-done, and don't try to shortcut by guessing URLs for things you found in a list.

If a task can't actually be done on the site — the feature doesn't exist, or it needs something only the user has — say so in one line instead of clicking around hoping. Don't fake completion.

Tools:
- open_url(url, new_tab): open a website; returns its snapshot. Full https URLs. Current tab by default; new_tab=true only if asked. Go directly to well-known sites (https://www.linkedin.com, https://mail.google.com, https://www.facebook.com, https://x.com). To search, go to https://www.google.com/search?q=... .
- snapshot(): the interactive tree described above. Your default way of looking at a page.
- click(ref) / fill(ref, text, submit) / select(ref, option) / scroll(ref | direction, amount).
- get_page(): the page's visible TEXT — for reading and understanding content (an email thread, an article), not for finding things to click.
- screenshot(): a picture of the page. Expensive — only when the snapshot genuinely isn't enough (canvas, custom widgets) or an action failed twice and you need to see why.
- click_text(text) / type_text(text, field, submit): label-matching fallbacks for when a full snapshot isn't worth it.

How to behave — be decisive and intelligent:
- Reply in the language the user writes in.
- EXECUTE multi-step tasks yourself. "Reply to this email" → open the reply, understand the thread from the page, write a fitting reply into the body. "Write a new post about X" → open the composer, write a genuinely good post, fill it in. Don't narrate a plan and stop — do the steps.
- Draft real, high-quality content that fits the context and the user's voice. Don't ask them what to write unless the task is truly impossible without a specific detail (then ask ONE tight question).
- Don't over-ask or over-confirm. Take reasonable actions (navigating, opening composers, writing drafts, filling fields) without asking permission.

THE ONE HARD RULE — confirm before the irreversible send:
- After you've drafted/filled everything, STOP right before the final irreversible action — sending an email, publishing a post/tweet, submitting a comment, purchasing, transferring money, or deleting. Do NOT click Send/Post/Publish/Submit/Buy/Delete yet.
- This includes submit=true on fill/type_text. In a message or post composer, Enter IS the send button. Write the draft with submit omitted, then call confirm_action.
- Instead, call the confirm_action tool with a short summary (quote the key content briefly) and a confirm_label like "Send" or "Post". This shows the user a Confirm/Cancel bar.
- When the user then confirms (their next message will say something like "Confirmed — send it"), immediately click the Send/Post button on the page to complete it. Do NOT call confirm_action again — the user already approved.

- Be concise. After acting, say in one or two lines what you did.
- Never invent facts about the page or the email/thread — base drafts on what's actually there.`;
	var TOOLS = [
		{
			name: "open_url",
			description: "Open a website and return its interactive snapshot. Use full https URLs. By default navigates the CURRENT tab; set new_tab=true to open a new tab instead.",
			input_schema: {
				type: "object",
				properties: {
					url: {
						type: "string",
						description: "Full https URL to open"
					},
					new_tab: {
						type: "boolean",
						description: "Open in a NEW tab (true) only if the user asked for a new tab / to keep the current page; otherwise navigate the current tab (false)."
					}
				},
				required: ["url"]
			}
		},
		{
			name: "go_back",
			description: "Go back to the previous page — e.g. to return to a list of search results after opening one of them. Returns the snapshot of where you land.",
			input_schema: {
				type: "object",
				properties: {}
			}
		},
		{
			name: "snapshot",
			description: "Read the page's interactive elements as an indented tree. Every element gets a ref like ref_0-12; use those refs with click/fill/select/scroll. Take a fresh snapshot after anything changes the page — refs from an old snapshot go stale.",
			input_schema: {
				type: "object",
				properties: {}
			}
		},
		{
			name: "click",
			description: "Click the element with this ref. Returns what changed on the page afterwards.",
			input_schema: {
				type: "object",
				properties: { ref: {
					type: "string",
					description: "A ref from the latest snapshot, e.g. ref_0-12"
				} },
				required: ["ref"]
			}
		},
		{
			name: "fill",
			description: "Type into the field with this ref (replacing what is there). Works with plain inputs and rich editors. submit=true presses Enter — in a search box that runs the search, but in a MESSAGE OR POST COMPOSER Enter SENDS IT. Leave submit out when writing a message, comment or post; draft it and call confirm_action instead.",
			input_schema: {
				type: "object",
				properties: {
					ref: {
						type: "string",
						description: "A ref from the latest snapshot"
					},
					text: {
						type: "string",
						description: "The text to type"
					},
					submit: {
						type: "boolean",
						description: "Press Enter after typing. Only for search boxes and similar. Never for a message/post/comment composer — Enter sends there, and sending needs confirm_action first."
					}
				},
				required: ["ref", "text"]
			}
		},
		{
			name: "select",
			description: "Choose an option in a dropdown (a <select>) by its visible text or value.",
			input_schema: {
				type: "object",
				properties: {
					ref: {
						type: "string",
						description: "A ref from the latest snapshot"
					},
					option: {
						type: "string",
						description: "Visible text (or value) of the option to choose"
					}
				},
				required: ["ref", "option"]
			}
		},
		{
			name: "scroll",
			description: "Scroll the page, or bring one element into view. Use this when a snapshot says elements are offscreen, or when a list loads more as you scroll.",
			input_schema: {
				type: "object",
				properties: {
					ref: {
						type: "string",
						description: "Scroll this element into view (optional)"
					},
					direction: {
						type: "string",
						enum: ["down", "up"],
						description: "Which way to scroll the page"
					},
					amount: {
						type: "number",
						description: "Pixels to scroll; defaults to about one screen"
					}
				}
			}
		},
		{
			name: "screenshot",
			description: "Take a picture of the visible part of the page. Use ONLY when the snapshot isn't enough — canvas apps, custom drop-downs, or when an action failed twice and you need to see why. Costs far more than a snapshot. Only works on the tab in front.",
			input_schema: {
				type: "object",
				properties: {}
			}
		},
		{
			name: "get_page",
			description: "Read the page's visible text (title, url, text). Use for reading and understanding content, not for finding things to click.",
			input_schema: {
				type: "object",
				properties: {}
			}
		},
		{
			name: "click_text",
			description: "Fallback: click a link/button whose visible text contains this string. Prefer snapshot + click(ref) — use this only for something obvious when a snapshot is not worth the tokens.",
			input_schema: {
				type: "object",
				properties: { text: {
					type: "string",
					description: "Visible text of the element to click"
				} },
				required: ["text"]
			}
		},
		{
			name: "type_text",
			description: "Fallback: type into a field picked by a label hint. Prefer snapshot + fill(ref). Omit \"field\" to target the main/largest editable area.",
			input_schema: {
				type: "object",
				properties: {
					text: {
						type: "string",
						description: "The text to type"
					},
					field: {
						type: "string",
						description: "Optional hint to pick the right field (e.g. \"subject\", \"message body\", \"to\", \"search\")."
					},
					submit: {
						type: "boolean",
						description: "Press Enter / submit after typing"
					}
				},
				required: ["text"]
			}
		},
		{
			name: "confirm_action",
			description: "Call this AFTER drafting/filling everything, right before an irreversible action (send email, publish post, submit, buy, delete). It pauses and shows the user a Confirm/Cancel bar. Do not click the Send/Post button yourself — call this instead and wait.",
			input_schema: {
				type: "object",
				properties: {
					summary: {
						type: "string",
						description: "Short message telling the user what you drafted and what will happen, ending by asking them to confirm."
					},
					confirm_label: {
						type: "string",
						description: "Label for the confirm button, e.g. \"Send\", \"Post\", \"Publish\", \"Submit\"."
					}
				},
				required: ["summary"]
			}
		}
	];
	var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	browser.storage.local.remove([
		"tidraApiKey",
		"tidraProvider",
		"tidraMcp"
	]).catch(() => {});
	async function getProfile() {
		const { tidraProfile } = await browser.storage.local.get("tidraProfile");
		return tidraProfile ?? {};
	}
	async function profilePreamble() {
		const p = await getProfile();
		const bits = [];
		const add = (label, v) => {
			if (v?.trim()) bits.push(`${label}: ${v.trim()}`);
		};
		add("Name", p.name);
		add("Email", p.email);
		add("Role", p.role);
		add("Company", p.company);
		add("Location", p.location);
		add("Languages", p.languages);
		add("Notes", p.about);
		if (!bits.length) return "";
		return `\n\nAbout the user (from their own profile — use it for their voice, sign-offs and tone):\n${bits.join("\n")}`;
	}
	function extractText(content) {
		return content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
	}
	var SESSION_GAP = 14400 * 1e3;
	var MAX_VISITS = 800;
	var ROUTINE_FIRST = 5;
	var ROUTINE_MIN_SESSIONS = 3;
	var ROUTINE_FREQ = .5;
	var KNOWN_NAMES = {
		"mail.google.com": "Gmail",
		"calendar.google.com": "Calendar",
		"drive.google.com": "Drive",
		"www.linkedin.com": "LinkedIn",
		"linkedin.com": "LinkedIn",
		"www.youtube.com": "YouTube",
		"github.com": "GitHub",
		"x.com": "X",
		"twitter.com": "X",
		"web.whatsapp.com": "WhatsApp",
		"www.facebook.com": "Facebook",
		"www.notion.so": "Notion",
		"app.slack.com": "Slack"
	};
	function prettyDomain(d) {
		if (KNOWN_NAMES[d]) return KNOWN_NAMES[d];
		const parts = d.replace(/^www\./, "").split(".");
		const name = parts.length >= 2 ? parts[parts.length - 2] : d;
		return name.charAt(0).toUpperCase() + name.slice(1);
	}
	function sessionStarts(visits) {
		const sorted = [...visits].sort((a, b) => a.t - b.t);
		const sessions = [];
		let cur = [];
		let lastT = 0;
		const flush = () => {
			if (!cur.length) return;
			const seen = /* @__PURE__ */ new Set();
			const first = [];
			for (const v of cur) if (!seen.has(v.d)) {
				seen.add(v.d);
				first.push(v.d);
				if (first.length >= ROUTINE_FIRST) break;
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
	function detectRoutine(visits) {
		const past = sessionStarts(visits).slice(0, -1).slice(-12);
		if (past.length < ROUTINE_MIN_SESSIONS) return [];
		const count = {};
		const posSum = {};
		for (const s of past) s.forEach((d, i) => {
			count[d] = (count[d] || 0) + 1;
			posSum[d] = (posSum[d] || 0) + i;
		});
		return Object.keys(count).filter((d) => count[d] / past.length >= ROUTINE_FREQ).sort((a, b) => posSum[a] / count[a] - posSum[b] / count[b]).slice(0, 5).map((d) => ({
			domain: prettyDomain(d),
			url: "https://" + d
		}));
	}
	async function handleVisit(domain) {
		const store = await browser.storage.local.get(["tidraVisits", "tidraRoutineEnabled"]);
		if (store.tidraRoutineEnabled === false) return;
		const visits = store.tidraVisits || [];
		const now = Date.now();
		const last = visits.length ? visits[visits.length - 1] : null;
		if (last && last.d === domain && now - last.t < 3e4) return;
		const gap = last ? now - last.t : Infinity;
		visits.push({
			d: domain,
			t: now
		});
		if (visits.length > MAX_VISITS) visits.splice(0, visits.length - MAX_VISITS);
		const data = { tidraVisits: visits };
		if (gap > SESSION_GAP) {
			const routine = detectRoutine(visits);
			if (routine.length >= 2) data.tidraRoutine = {
				sites: routine,
				ts: now
			};
		}
		await browser.storage.local.set(data);
	}
	var currentAbort = null;
	async function clearLoading() {
		const { tidraChat } = await browser.storage.local.get("tidraChat");
		const chat = tidraChat || {
			messages: [],
			loading: false
		};
		chat.loading = false;
		await browser.storage.local.set({
			tidraChat: chat,
			tidraPending: null
		});
	}
	function setStatus(text) {
		return browser.storage.local.set({ tidraStatus: text });
	}
	var SNAPSHOT_TOOLS = /* @__PURE__ */ new Set([
		"snapshot",
		"list_actions",
		"open_url",
		"go_back",
		"screenshot"
	]);
	function pruneOldSnapshots(messages, snapshotIds) {
		let seenNewest = false;
		for (let i = messages.length - 1; i >= 0; i--) {
			const content = messages[i].content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (block?.type !== "tool_result" || !snapshotIds.has(block.tool_use_id)) continue;
				if (!seenNewest) {
					seenNewest = true;
					continue;
				}
				block.content = "[superseded snapshot removed — take a fresh one if you need refs]";
			}
		}
	}
	function statusFor(tool, input) {
		switch (tool) {
			case "snapshot":
			case "list_actions": return "Looking at the page";
			case "click": return "Clicking";
			case "fill": return "Writing the draft";
			case "select": return "Choosing an option";
			case "scroll": return "Scrolling";
			case "screenshot": return "Taking a look";
			case "open_url": {
				let host = String(input?.url ?? "");
				try {
					host = new URL(host).hostname.replace(/^www\./, "");
				} catch {}
				return `Opening ${host}`;
			}
			case "get_page": return "Reading the page";
			case "list_actions": return "Looking at what's on the page";
			case "click_text": return `Clicking “${String(input?.text ?? "").slice(0, 30)}”`;
			case "type_text": return input?.field ? `Filling in ${String(input.field).slice(0, 24)}` : "Writing the draft";
			default: return "Working";
		}
	}
	async function pushChat(text, role) {
		const { tidraChat } = await browser.storage.local.get("tidraChat");
		const chat = tidraChat || {
			messages: [],
			loading: false
		};
		chat.messages.push({
			role,
			text
		});
		chat.loading = false;
		await browser.storage.local.set({
			tidraChat: chat,
			tidraUnread: true,
			tidraStatus: null
		});
	}
	async function classify(apiKey, routerModel, prompt, history, signal) {
		try {
			const recent = history.slice(-4).map((m) => `${m.role}: ${m.text.slice(0, 200)}`).join("\n");
			return extractText((await callModel(apiKey, {
				model: routerModel,
				max_tokens: 5,
				system: [
					"Reply with exactly one word: act or chat.",
					"",
					"act — answering needs the browser. That covers doing things (open, go, search, click, type, reply, post, fill, buy) AND looking things up that only exist behind a website or the user's own account: their inbox, messages, notifications, orders, calendar, profile, feed, or anything current on a specific site.",
					"",
					"chat — can be answered from general knowledge alone, or is about text already in this conversation.",
					"",
					"Being phrased as a question does NOT make it chat. Examples:",
					"\"do I have new messages on LinkedIn?\" -> act",
					"\"what did Marco reply?\" -> act",
					"\"any new emails?\" -> act",
					"\"summarise this page\" -> act",
					"\"what is the capital of Albania?\" -> chat",
					"\"rewrite that paragraph more formally\" -> chat",
					"",
					"If unsure, answer act."
				].join("\n"),
				messages: [{
					role: "user",
					content: `${recent ? recent + "\n" : ""}Request: ${prompt}\nAnswer (act or chat):`
				}]
			}, signal)).content).toLowerCase().includes("chat") ? "chat" : "act";
		} catch {
			return "act";
		}
	}
	function waitForTabLoad(tabId, timeoutMs = 2e4) {
		return new Promise((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				browser.tabs.onUpdated.removeListener(listener);
				resolve();
			};
			function listener(id, info) {
				if (id === tabId && info.status === "complete") finish();
			}
			browser.tabs.onUpdated.addListener(listener);
			browser.tabs.get(tabId).then((t) => {
				if (t.status === "complete") finish();
			}).catch(() => {});
			setTimeout(finish, timeoutMs);
		});
	}
	async function sendAction(tabId, payload, retries = 10, frameId = 0) {
		for (let i = 0; i < retries; i++) try {
			return await browser.tabs.sendMessage(tabId, payload, { frameId });
		} catch {
			await sleep(350);
		}
		throw new Error("Page not reachable (content script not ready).");
	}
	function parseRef(ref) {
		const m = /^ref_(\d+)-(\d+)$/.exec(String(ref || "").trim());
		if (!m) return {
			frameId: 0,
			local: String(ref || "").trim()
		};
		return {
			frameId: Number(m[1]),
			local: `ref_${m[2]}`
		};
	}
	async function snapshotAllFrames(tabId) {
		let frames = [];
		try {
			frames = await browser.webNavigation.getAllFrames({ tabId }) ?? [];
		} catch {
			frames = [{
				frameId: 0,
				url: ""
			}];
		}
		if (!frames.length) frames = [{
			frameId: 0,
			url: ""
		}];
		const parts = [];
		for (const f of frames.slice(0, 12)) {
			let res;
			try {
				res = await sendAction(tabId, {
					type: "tidra-action",
					action: "snapshot"
				}, f.frameId === 0 ? 10 : 1, f.frameId);
			} catch {
				continue;
			}
			const data = res?.data;
			if (!data?.tree) continue;
			const tree = data.tree.replace(/\[ref_(\d+)\]/g, `[ref_${f.frameId}-$1]`);
			const head = f.frameId === 0 ? `PAGE: ${data.title} — ${data.url}` : `\nFRAME ${f.frameId}: ${f.url}`;
			parts.push(`${head}\n${tree}${data.truncated ? "\n(… truncated — scroll or narrow the task)" : ""}`);
		}
		return parts.join("\n") || "Nothing interactive found on this page.";
	}
	async function captureTab(tabId) {
		const tab = await browser.tabs.get(tabId);
		if (!tab.active) throw new Error("Screenshots only work on the tab in front.");
		return (await browser.tabs.captureVisibleTab(tab.windowId, {
			format: "jpeg",
			quality: 60
		})).replace(/^data:image\/jpeg;base64,/, "");
	}
	async function execTool(name, input, tabState, allowSubmit = false) {
		if ((name === "fill" || name === "type_text") && input?.submit && !allowSubmit) return {
			content: "Refused: submit=true would send/post this, which is irreversible. Call confirm_action first and wait for the user. If they confirm, you may submit.",
			isError: true
		};
		try {
			if (name === "open_url") {
				let url = String(input.url || "");
				if (!/^https?:\/\//i.test(url)) url = "https://" + url;
				if (input.new_tab) tabState.tabId = (await browser.tabs.create({
					url,
					active: true
				})).id;
				else {
					if (tabState.tabId == null) return {
						content: "No active tab.",
						isError: true
					};
					await browser.tabs.update(tabState.tabId, { url });
				}
				if (tabState.tabId == null) return {
					content: "Could not open tab.",
					isError: true
				};
				await waitForTabLoad(tabState.tabId);
				await sleep(400);
				const tree = await snapshotAllFrames(tabState.tabId);
				return {
					content: `Opened ${url}${input.new_tab ? " (new tab)" : ""}\n\n${tree}`,
					isError: false
				};
			}
			if (tabState.tabId == null) return {
				content: "No working tab.",
				isError: true
			};
			const current = await browser.tabs.get(tabState.tabId).catch(() => null);
			if (current?.url && !/^https?:/i.test(current.url)) return {
				content: "There is no web page open in this tab yet. Call open_url first to go to the site.",
				isError: true
			};
			if (name === "get_page") {
				const page = (await sendAction(tabState.tabId, {
					type: "tidra-action",
					action: "get_page"
				}))?.data;
				return {
					content: `Title: ${page?.title}\nURL: ${page?.url}\n\n${(page?.text || "").slice(0, 6e3)}`,
					isError: false
				};
			}
			if (name === "go_back") {
				await browser.tabs.goBack(tabState.tabId);
				await waitForTabLoad(tabState.tabId);
				await sleep(400);
				return {
					content: `Went back.\n\n${await snapshotAllFrames(tabState.tabId)}`,
					isError: false
				};
			}
			if (name === "snapshot" || name === "list_actions") return {
				content: await snapshotAllFrames(tabState.tabId),
				isError: false
			};
			if (name === "screenshot") return {
				content: [{
					type: "text",
					text: "Screenshot of the visible part of the page:"
				}, {
					type: "image",
					source: {
						type: "base64",
						media_type: "image/jpeg",
						data: await captureTab(tabState.tabId)
					}
				}],
				isError: false
			};
			if (name === "click" || name === "fill" || name === "select" || name === "scroll") {
				const { frameId, local } = parseRef(input.ref ?? "");
				const res = await sendAction(tabState.tabId, {
					type: "tidra-action",
					action: name,
					ref: input.ref ? local : void 0,
					text: input.text,
					option: input.option,
					submit: !!input.submit,
					direction: input.direction,
					amount: input.amount
				}, 10, input.ref ? frameId : 0);
				return {
					content: res?.ok ? res.data : res?.error,
					isError: !res?.ok
				};
			}
			if (name === "click_text") {
				const res = await sendAction(tabState.tabId, {
					type: "tidra-action",
					action: "click_text",
					text: input.text
				});
				return {
					content: res?.ok ? res.data : res?.error,
					isError: !res?.ok
				};
			}
			if (name === "type_text") {
				const res = await sendAction(tabState.tabId, {
					type: "tidra-action",
					action: "type_text",
					text: input.text,
					field: input.field,
					submit: !!input.submit
				});
				return {
					content: res?.ok ? res.data : res?.error,
					isError: !res?.ok
				};
			}
			return {
				content: `Unknown tool: ${name}`,
				isError: true
			};
		} catch (err) {
			return {
				content: err instanceof Error ? err.message : String(err),
				isError: true
			};
		}
	}
	async function handleAsk(message, senderTabId) {
		const setup = await modelSetup();
		if (!setup) {
			await pushChat("No API key set. Open settings and add a key for your chosen provider.", "error");
			return;
		}
		const { apiKey, tier } = setup;
		const { tidraChat } = await browser.storage.local.get("tidraChat");
		const history = (tidraChat?.messages ?? []).filter((m) => m.role !== "error");
		const messages = [];
		history.forEach((m, i) => {
			if (i === history.length - 1 && m.role === "user") messages.push({
				role: "user",
				content: [
					`Current page:`,
					`Title: ${message.page.title}`,
					`URL: ${message.page.url}`,
					``,
					`Page content (truncated):`,
					message.page.text,
					``,
					`---`,
					`User request: ${m.text}`
				].join("\n")
			});
			else messages.push({
				role: m.role,
				content: m.text
			});
		});
		if (messages.length === 0) messages.push({
			role: "user",
			content: message.prompt
		});
		const tabState = { tabId: senderTabId };
		const userConfirmed = /^Confirmed\s+—/.test(message.prompt.trim());
		const { tidraAuto } = await browser.storage.local.get("tidraAuto");
		const autoMode = tidraAuto === true;
		const mayAct = userConfirmed || autoMode;
		currentAbort?.abort();
		const abort = new AbortController();
		currentAbort = abort;
		abort.signal;
		try {
			const route = message.intent ?? await classify(apiKey, tier.router, message.prompt, history, abort.signal);
			const actModel = route === "act" ? tier.act : tier.chat;
			const tools = route === "act" ? TOOLS.filter((t) => t.name !== "screenshot" || supportsVision(actModel)) : [];
			const profileText = await profilePreamble();
			const modeNote = autoMode ? "\n\nAUTO MODE IS ON for this request: the user has already approved irreversible actions in advance. Do not call confirm_action and do not ask — finish the job, including the final click, then report what you did." : "";
			const base = {
				model: actModel,
				max_tokens: 2048,
				system: SYSTEM_PROMPT + profileText + modeNote
			};
			await setStatus(route === "act" ? "Getting started" : "Thinking");
			const snapshotIds = /* @__PURE__ */ new Set();
			let guard = 0;
			while (guard++ < 30) {
				const params = {
					...base,
					messages
				};
				if (tools.length) params.tools = tools;
				const response = await callModel(apiKey, params, abort.signal);
				if (response.stop_reason === "pause_turn") {
					messages.push({
						role: "assistant",
						content: response.content
					});
					continue;
				}
				if (response.stop_reason !== "tool_use") {
					await pushChat(extractText(response.content), "assistant");
					return;
				}
				const confirmBlock = response.content.find((b) => b.type === "tool_use" && b.name === "confirm_action");
				if (confirmBlock && !autoMode) {
					await pushChat([extractText(response.content), confirmBlock.input?.summary || "Ready. Do you want me to proceed?"].filter(Boolean).join("\n\n"), "assistant");
					await browser.storage.local.set({ tidraPending: { label: confirmBlock.input?.confirm_label || "Send" } });
					return;
				}
				if (confirmBlock) {
					messages.push({
						role: "assistant",
						content: response.content
					});
					messages.push({
						role: "user",
						content: [{
							type: "tool_result",
							tool_use_id: confirmBlock.id,
							content: "Approved automatically (auto mode is on). Go ahead and complete the action now."
						}]
					});
					continue;
				}
				messages.push({
					role: "assistant",
					content: response.content
				});
				const toolResults = [];
				for (const block of response.content) {
					if (block.type !== "tool_use") continue;
					await setStatus(statusFor(block.name, block.input));
					const result = await execTool(block.name, block.input, tabState, mayAct);
					if (SNAPSHOT_TOOLS.has(block.name)) snapshotIds.add(block.id);
					toolResults.push({
						type: "tool_result",
						tool_use_id: block.id,
						content: result.content,
						is_error: result.isError
					});
				}
				if (toolResults.length === 0) {
					await pushChat(extractText(response.content), "assistant");
					return;
				}
				messages.push({
					role: "user",
					content: toolResults
				});
				pruneOldSnapshots(messages, snapshotIds);
			}
			await pushChat("I ran out of steps before finishing. Tell me what's left and I'll carry on, or break it into smaller pieces.", "assistant");
		} catch (err) {
			if (abort.signal.aborted) {
				await setStatus(null);
				await clearLoading();
				return;
			}
			throw err;
		} finally {
			if (currentAbort === abort) currentAbort = null;
			await setStatus(null);
		}
	}
	var ROUTINE_SYSTEM = `You are Tidra, running one step of the user's saved routine on a website — in the background, on their behalf.

Do exactly what the task describes, using the page. Be decisive and take the needed steps (open the composer, read the thread, write a draft, etc.).

Use snapshot() to see the page's interactive elements — each carries a ref like ref_0-12 — then click(ref) / fill(ref, text). Refs go stale whenever the page changes, so snapshot again after anything that navigates or re-renders. Every action reports what changed; if it says "no visible change", it did not work.

HARD RULES:
- NEVER send, post, submit, publish, buy, or delete anything. Only prepare/draft and leave it for the user to review later.
- Do not ask the user questions — do your best with what's on the page.
- When finished, reply with a SHORT report: 1–3 sentences or a few bullets of what you found or drafted. No preamble.
- Base everything strictly on the actual page content — never invent.`;
	var ROUTINE_TASK_DEFAULTS = {
		"mail.google.com": "Check for new important emails and draft replies I can review before sending.",
		"linkedin.com": "Check new messages and notifications, and summarize anything that needs a response.",
		"github.com": "Check my notifications and open pull requests, and summarize what needs my attention.",
		"calendar.google.com": "Summarize today's meetings and what I should prepare.",
		"x.com": "Summarize the top posts from the people I follow.",
		"twitter.com": "Summarize the top posts from the people I follow.",
		"notion.so": "Summarize what changed in my workspace since I last checked.",
		"www.youtube.com": "List the new videos from channels I follow."
	};
	function defaultTaskFor(domain) {
		return ROUTINE_TASK_DEFAULTS[domain] ?? "Look at this page and tell me what's new or needs my attention.";
	}
	async function getPageOf(tabId) {
		return (await sendAction(tabId, {
			type: "tidra-action",
			action: "get_page"
		}))?.data || {
			title: "",
			url: "",
			text: ""
		};
	}
	async function runSiteAgent(apiKey, actModel, task, tabId, profileText = "") {
		const tabState = { tabId };
		const page = await getPageOf(tabId);
		const messages = [{
			role: "user",
			content: [
				`Routine task: ${task}`,
				``,
				`Current page:`,
				`Title: ${page.title}`,
				`URL: ${page.url}`,
				``,
				`Page content (truncated):`,
				(page.text || "").slice(0, 8e3)
			].join("\n")
		}];
		const tools = TOOLS.filter((t) => ![
			"confirm_action",
			"open_url",
			"screenshot",
			"go_back"
		].includes(t.name));
		const snapshotIds = /* @__PURE__ */ new Set();
		let guard = 0;
		while (guard++ < 24) {
			const res = await callModel(apiKey, {
				model: actModel,
				max_tokens: 1500,
				system: ROUTINE_SYSTEM + profileText,
				messages,
				tools
			});
			if (res.stop_reason !== "tool_use") return extractText(res.content) || "Done.";
			messages.push({
				role: "assistant",
				content: res.content
			});
			const toolResults = [];
			for (const block of res.content) {
				if (block.type !== "tool_use") continue;
				const r = await execTool(block.name, block.input, tabState);
				if (SNAPSHOT_TOOLS.has(block.name)) snapshotIds.add(block.id);
				toolResults.push({
					type: "tool_result",
					tool_use_id: block.id,
					content: r.content,
					is_error: r.isError
				});
			}
			if (!toolResults.length) return extractText(res.content) || "Done.";
			messages.push({
				role: "user",
				content: toolResults
			});
			pruneOldSnapshots(messages, snapshotIds);
		}
		return "Stopped after too many steps.";
	}
	var routineRunning = false;
	async function runRoutine() {
		if (routineRunning) return;
		routineRunning = true;
		try {
			const store = await browser.storage.local.get([
				"tidraVisits",
				"tidraRoutineHidden",
				"tidraRoutineTasks",
				"tidraRoutineManual"
			]);
			const setup = await modelSetup();
			if (!setup) {
				await pushChat("No API key set. Open settings and add a key for your chosen provider.", "error");
				return;
			}
			const { apiKey, tier } = setup;
			const visits = store.tidraVisits || [];
			const hidden = new Set(store.tidraRoutineHidden || []);
			const manual = store.tidraRoutineManual || [];
			const seen = /* @__PURE__ */ new Set();
			const sites = [...detectRoutine(visits), ...manual].filter((s) => {
				if (hidden.has(s.domain) || seen.has(s.domain)) return false;
				seen.add(s.domain);
				return true;
			});
			const tasks = store.tidraRoutineTasks || {};
			if (!sites.length) {
				await pushChat("You have no learned routine yet, so there's nothing to run.", "assistant");
				return;
			}
			const profileText = await profilePreamble();
			await browser.storage.local.set({ tidraOpen: true });
			await pushChat(`Running your routine across ${sites.length} site${sites.length > 1 ? "s" : ""} — I'll draft, never send, and report back.`, "assistant");
			for (const site of sites) {
				const name = prettyDomain(site.domain);
				const task = (tasks[site.domain] || defaultTaskFor(site.domain)).trim();
				try {
					const tab = await browser.tabs.create({
						url: site.url,
						active: false
					});
					if (tab.id == null) {
						await pushChat(`**${name}** — couldn't open the tab.`, "error");
						continue;
					}
					await waitForTabLoad(tab.id);
					await sleep(700);
					await pushChat(`**${name}**\n${await runSiteAgent(apiKey, tier.act, task, tab.id, profileText)}`, "assistant");
				} catch (err) {
					await pushChat(`**${name}** — ${err instanceof Error ? err.message : String(err)}`, "error");
				}
			}
			await pushChat("✅ Routine finished. Review the drafts in the tabs I opened before sending anything.", "assistant");
		} finally {
			routineRunning = false;
		}
	}
	var background_default = defineBackground(() => {
		browser.commands.onCommand.addListener(async (command) => {
			if (command !== "toggle-island") return;
			const [tab] = await browser.tabs.query({
				active: true,
				currentWindow: true
			});
			if (tab?.id) browser.tabs.sendMessage(tab.id, { type: "tidra-toggle" }).catch(() => {});
		});
		browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
			if (message?.type === "tidra-ask") {
				handleAsk(message, sender.tab?.id).catch((err) => pushChat(err instanceof Error ? err.message : String(err), "error")).finally(() => sendResponse({ ok: true }));
				return true;
			}
			if (message?.type === "tidra-route" && typeof message.prompt === "string") {
				(async () => {
					const setup = await modelSetup();
					if (!setup) return sendResponse({ route: "chat" });
					sendResponse({ route: await classify(setup.apiKey, setup.tier.router, message.prompt, []) });
				})().catch(() => sendResponse({ route: "chat" }));
				return true;
			}
			if (message?.type === "tidra-stop") {
				currentAbort?.abort();
				clearLoading().catch(() => {});
				return;
			}
			if (message?.type === "tidra-visit" && typeof message.domain === "string") {
				handleVisit(message.domain).catch(() => {});
				return;
			}
			if (message?.type === "tidra-open-routine") {
				browser.storage.local.get("tidraRoutine").then(({ tidraRoutine }) => {
					(tidraRoutine?.sites ?? []).forEach((s) => browser.tabs.create({
						url: s.url,
						active: false
					}).catch(() => {}));
					browser.storage.local.set({ tidraRoutine: null });
				});
				return;
			}
			if (message?.type === "tidra-open-options") browser.runtime.openOptionsPage();
			if (message?.type === "tidra-get-routine") {
				(async () => {
					const store = await browser.storage.local.get([
						"tidraVisits",
						"tidraRoutineHidden",
						"tidraRoutineEnabled"
					]);
					const enabled = store.tidraRoutineEnabled !== false;
					const visits = store.tidraVisits || [];
					const hidden = new Set(store.tidraRoutineHidden || []);
					sendResponse({
						enabled,
						sites: detectRoutine(visits).filter((s) => !hidden.has(s.domain))
					});
				})();
				return true;
			}
			if (message?.type === "tidra-run-routine") {
				runRoutine().catch((err) => pushChat(err instanceof Error ? err.message : String(err), "error")).finally(() => sendResponse({ ok: true }));
				return true;
			}
		});
	});
	//#endregion
	//#region node_modules/@webext-core/match-patterns/lib/index.mjs
	/**
	* Class for parsing and performing operations on match patterns.
	*
	* @example
	*   const pattern = new MatchPattern('*://google.com/*');
	*
	*   pattern.includes('https://google.com'); // true
	*   pattern.includes('http://youtube.com/watch?v=123'); // false
	*/
	var MatchPattern = class MatchPattern {
		static {
			this.PROTOCOLS = [
				"http",
				"https",
				"file",
				"ftp",
				"urn",
				"ws",
				"wss"
			];
		}
		/**
		* Parse a match pattern string. If it is invalid, the constructor will throw an
		* `InvalidMatchPattern` error.
		*
		* @param matchPattern The match pattern to parse.
		*/
		constructor(matchPattern) {
			if (matchPattern === "<all_urls>") {
				this.isAllUrls = true;
				this.protocolMatches = [...MatchPattern.PROTOCOLS];
				this.hostnameMatch = "*";
				this.pathnameMatch = "*";
			} else {
				const groups = /(.*):\/\/(.*?)(\/.*)/.exec(matchPattern);
				if (groups == null) throw new InvalidMatchPattern(matchPattern, "Incorrect format");
				const [_, protocol, hostname, pathname] = groups;
				validateProtocol(matchPattern, protocol);
				validateHostname(matchPattern, hostname);
				this.protocolMatches = protocol === "*" ? ["http", "https"] : [protocol];
				this.hostnameMatch = hostname;
				this.pathnameMatch = pathname;
			}
		}
		/** Check if a URL is included in a pattern. */
		includes(url) {
			const u = typeof url === "string" ? new URL(url) : url instanceof Location ? new URL(url.href) : url;
			if (this.isAllUrls) return !this.isUnknownProtocol(u);
			return !!this.protocolMatches.find((protocol) => {
				if (protocol === "http") return this.isHttpMatch(u);
				if (protocol === "https") return this.isHttpsMatch(u);
				if (protocol === "file") return this.isFileMatch(u);
				if (protocol === "ftp") return this.isFtpMatch(u);
				if (protocol === "urn") return this.isUrnMatch(u);
			});
		}
		isHttpMatch(url) {
			return url.protocol === "http:" && this.isHostPathMatch(url);
		}
		isHttpsMatch(url) {
			return url.protocol === "https:" && this.isHostPathMatch(url);
		}
		isHostPathMatch(url) {
			if (!this.hostnameMatch || !this.pathnameMatch) return false;
			const hostnameMatchRegexs = [this.convertPatternToRegex(this.hostnameMatch), this.convertPatternToRegex(this.hostnameMatch.replace(/^\*\./, ""))];
			const pathnameMatchRegex = this.convertPatternToRegex(this.pathnameMatch);
			return !!hostnameMatchRegexs.find((regex) => regex.test(url.hostname)) && pathnameMatchRegex.test(url.pathname);
		}
		isUnknownProtocol(url) {
			return !this.protocolMatches.includes(url.protocol.slice(0, -1));
		}
		isPathMatch(url) {
			if (!this.pathnameMatch) return false;
			return this.convertPatternToRegex(this.pathnameMatch).test(url.pathname);
		}
		isFileMatch(url) {
			return url.protocol === "file:" && this.isPathMatch(url);
		}
		isFtpMatch(_url) {
			throw Error("Not implemented: ftp:// pattern matching. Open a PR to add support");
		}
		isUrnMatch(_url) {
			throw Error("Not implemented: urn:// pattern matching. Open a PR to add support");
		}
		convertPatternToRegex(pattern) {
			const starsReplaced = this.escapeForRegex(pattern).replace(/\\\*/g, ".*");
			return RegExp(`^${starsReplaced}$`);
		}
		escapeForRegex(string) {
			return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		}
	};
	var InvalidMatchPattern = class extends Error {
		constructor(matchPattern, reason) {
			super(`Invalid match pattern "${matchPattern}": ${reason}`);
		}
	};
	function validateProtocol(matchPattern, protocol) {
		if (!MatchPattern.PROTOCOLS.includes(protocol) && protocol !== "*") throw new InvalidMatchPattern(matchPattern, `${protocol} not a valid protocol (${MatchPattern.PROTOCOLS.join(", ")})`);
	}
	function validateHostname(matchPattern, hostname) {
		if (hostname.includes(":")) throw new InvalidMatchPattern(matchPattern, `Hostname cannot include a port`);
		if (hostname.includes("*") && hostname.length > 1 && !hostname.startsWith("*.")) throw new InvalidMatchPattern(matchPattern, `If using a wildcard (*), it must go at the start of the hostname`);
	}
	//#endregion
	//#region \0virtual:wxt-background-entrypoint?/Users/arditkaravidaj/Desktop/Projects/tidra/entrypoints/background.ts
	function print(method, ...args) {
		if (typeof args[0] === "string") method(`[wxt] ${args.shift()}`, ...args);
		else method("[wxt]", ...args);
	}
	/** Wrapper around `console` with a "[wxt]" prefix */
	var logger = {
		debug: (...args) => print(console.debug, ...args),
		log: (...args) => print(console.log, ...args),
		warn: (...args) => print(console.warn, ...args),
		error: (...args) => print(console.error, ...args)
	};
	var ws;
	/** Connect to the websocket and listen for messages. */
	function getDevServerWebSocket() {
		if (ws == null) {
			const serverUrl = "ws://localhost:3000";
			logger.debug("Connecting to dev server @", serverUrl);
			ws = new WebSocket(serverUrl, "vite-hmr");
			ws.addWxtEventListener = ws.addEventListener.bind(ws);
			ws.sendCustom = (event, payload) => ws?.send(JSON.stringify({
				type: "custom",
				event,
				payload
			}));
			ws.addEventListener("open", () => {
				logger.debug("Connected to dev server");
			});
			ws.addEventListener("close", () => {
				logger.debug("Disconnected from dev server");
			});
			ws.addEventListener("error", (event) => {
				logger.error("Failed to connect to dev server", event);
			});
			ws.addEventListener("message", (e) => {
				try {
					const message = JSON.parse(e.data);
					if (message.type === "custom") ws?.dispatchEvent(new CustomEvent(message.event, { detail: message.data }));
				} catch (err) {
					logger.error("Failed to handle message", err);
				}
			});
		}
		return ws;
	}
	/** https://developer.chrome.com/blog/longer-esw-lifetimes/ */
	function keepServiceWorkerAlive() {
		setInterval(async () => {
			await browser.runtime.getPlatformInfo();
		}, 5e3);
	}
	function reloadContentScript(payload) {
		if (browser.runtime.getManifest().manifest_version == 2) reloadContentScriptMv2(payload);
		else reloadContentScriptMv3(payload);
	}
	async function reloadContentScriptMv3({ registration, contentScript }) {
		if (registration === "runtime") await reloadRuntimeContentScriptMv3(contentScript);
		else await reloadManifestContentScriptMv3(contentScript);
	}
	async function reloadManifestContentScriptMv3(contentScript) {
		const id = `wxt:${contentScript.js[0]}`;
		logger.log("Reloading content script:", contentScript);
		const registered = await browser.scripting.getRegisteredContentScripts();
		logger.debug("Existing scripts:", registered);
		const existing = registered.find((cs) => cs.id === id);
		if (existing) {
			logger.debug("Updating content script", existing);
			await browser.scripting.updateContentScripts([{
				...contentScript,
				id,
				css: contentScript.css ?? []
			}]);
		} else {
			logger.debug("Registering new content script...");
			await browser.scripting.registerContentScripts([{
				...contentScript,
				id,
				css: contentScript.css ?? []
			}]);
		}
		await reloadTabsForContentScript(contentScript);
	}
	async function reloadRuntimeContentScriptMv3(contentScript) {
		logger.log("Reloading content script:", contentScript);
		const registered = await browser.scripting.getRegisteredContentScripts();
		logger.debug("Existing scripts:", registered);
		const matches = registered.filter((cs) => {
			const hasJs = contentScript.js?.find((js) => cs.js?.includes(js));
			const hasCss = contentScript.css?.find((css) => cs.css?.includes(css));
			return hasJs || hasCss;
		});
		if (matches.length === 0) {
			logger.log("Content script is not registered yet, nothing to reload", contentScript);
			return;
		}
		await browser.scripting.updateContentScripts(matches);
		await reloadTabsForContentScript(contentScript);
	}
	async function reloadTabsForContentScript(contentScript) {
		const allTabs = await browser.tabs.query({});
		const matchPatterns = contentScript.matches.map((match) => new MatchPattern(match));
		const matchingTabs = allTabs.filter((tab) => {
			const url = tab.url;
			if (!url) return false;
			return !!matchPatterns.find((pattern) => pattern.includes(url));
		});
		await Promise.all(matchingTabs.map(async (tab) => {
			try {
				await browser.tabs.reload(tab.id);
			} catch (err) {
				logger.warn("Failed to reload tab:", err);
			}
		}));
	}
	async function reloadContentScriptMv2(_payload) {
		throw Error("TODO: reloadContentScriptMv2");
	}
	try {
		const ws = getDevServerWebSocket();
		ws.addWxtEventListener("wxt:reload-extension", () => {
			browser.runtime.reload();
		});
		ws.addWxtEventListener("wxt:reload-content-script", (event) => {
			reloadContentScript(event.detail);
		});
		ws.addEventListener("open", () => ws.sendCustom("wxt:background-initialized"));
		keepServiceWorkerAlive();
	} catch (err) {
		logger.error("Failed to setup web socket connection with dev server", err);
	}
	browser.commands.onCommand.addListener((command) => {
		if (command === "wxt:reload-extension") browser.runtime.reload();
	});
	var result;
	try {
		result = background_default.main();
		if (result instanceof Promise) console.warn("The background's main() function return a promise, but it must be synchronous");
	} catch (err) {
		logger.error("The background crashed on startup!");
		throw err;
	}
	//#endregion
	return result;
})();

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja2dyb3VuZC5qcyIsIm5hbWVzIjpbImJyb3dzZXIiXSwic291cmNlcyI6WyIuLi8uLi9ub2RlX21vZHVsZXMvQHd4dC1kZXYvYnJvd3Nlci9zcmMvaW5kZXgubWpzIiwiLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L2Jyb3dzZXIubWpzIiwiLi4vLi4vbm9kZV9tb2R1bGVzL3d4dC9kaXN0L3V0aWxzL2RlZmluZS1iYWNrZ3JvdW5kLm1qcyIsIi4uLy4uL2xpYi9sbG0udHMiLCIuLi8uLi9lbnRyeXBvaW50cy9iYWNrZ3JvdW5kLnRzIiwiLi4vLi4vbm9kZV9tb2R1bGVzL0B3ZWJleHQtY29yZS9tYXRjaC1wYXR0ZXJucy9saWIvaW5kZXgubWpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8vICNyZWdpb24gc25pcHBldFxuZXhwb3J0IGNvbnN0IGJyb3dzZXIgPSBnbG9iYWxUaGlzLmJyb3dzZXI/LnJ1bnRpbWU/LmlkXG4gID8gZ2xvYmFsVGhpcy5icm93c2VyXG4gIDogZ2xvYmFsVGhpcy5jaHJvbWU7XG4vLyAjZW5kcmVnaW9uIHNuaXBwZXRcbiIsImltcG9ydCB7IGJyb3dzZXIgYXMgYnJvd3NlciQxIH0gZnJvbSBcIkB3eHQtZGV2L2Jyb3dzZXJcIjtcbi8vI3JlZ2lvbiBzcmMvYnJvd3Nlci50c1xuLyoqXG4qIENvbnRhaW5zIHRoZSBgYnJvd3NlcmAgZXhwb3J0IHdoaWNoIHlvdSBzaG91bGQgdXNlIHRvIGFjY2VzcyB0aGUgZXh0ZW5zaW9uXG4qIEFQSXMgaW4geW91ciBwcm9qZWN0OlxuKlxuKiBgYGB0c1xuKiBpbXBvcnQgeyBicm93c2VyIH0gZnJvbSAnd3h0L2Jyb3dzZXInO1xuKlxuKiBicm93c2VyLnJ1bnRpbWUub25JbnN0YWxsZWQuYWRkTGlzdGVuZXIoKCkgPT4ge1xuKiAgIC8vIC4uLlxuKiB9KTtcbiogYGBgXG4qXG4qIEBtb2R1bGUgd3h0L2Jyb3dzZXJcbiovXG5jb25zdCBicm93c2VyID0gYnJvd3NlciQxO1xuLy8jZW5kcmVnaW9uXG5leHBvcnQgeyBicm93c2VyIH07XG4iLCIvLyNyZWdpb24gc3JjL3V0aWxzL2RlZmluZS1iYWNrZ3JvdW5kLnRzXG5mdW5jdGlvbiBkZWZpbmVCYWNrZ3JvdW5kKGFyZykge1xuXHRpZiAoYXJnID09IG51bGwgfHwgdHlwZW9mIGFyZyA9PT0gXCJmdW5jdGlvblwiKSByZXR1cm4geyBtYWluOiBhcmcgfTtcblx0cmV0dXJuIGFyZztcbn1cbi8vI2VuZHJlZ2lvblxuZXhwb3J0IHsgZGVmaW5lQmFja2dyb3VuZCB9O1xuIiwiLy8gTW9kZWwgcHJvdmlkZXIg4oCUIEdyb3EgKE9wZW5BSS1jb21wYXRpYmxlIGNoYXQgY29tcGxldGlvbnMpLlxuLy9cbi8vIFRoZSBhZ2VudCBsb29wIGludGVybmFsbHkgc3BlYWtzIGluIGNvbnRlbnQgYmxvY2tzICh0ZXh0IC8gdG9vbF91c2UgL1xuLy8gdG9vbF9yZXN1bHQgLyBpbWFnZSksIHdoaWNoIGlzIGEgY29udmVuaWVudCBzaGFwZSBmb3IgYSB0b29sLWNhbGxpbmcgbG9vcC5cbi8vIFRoaXMgbW9kdWxlIG93bnMgdGhvc2UgdHlwZXMgYW5kIHRyYW5zbGF0ZXMgdGhlbSB0byBhbmQgZnJvbSBHcm9xJ3Mgd2lyZVxuLy8gZm9ybWF0LCBzbyBub3RoaW5nIGVsc2UgaW4gdGhlIGNvZGViYXNlIGRlYWxzIHdpdGggdGhlIEFQSSBzaGFwZS5cbi8vXG4vLyBSZWFjaGVkIHdpdGggcGxhaW4gZmV0Y2gg4oCUIGEgd2hvbGUgU0RLIGZvciBvbmUgUE9TVCBpc24ndCB3b3J0aCB0aGUgYnVuZGxlLlxuXG4vKiDilIDilIAgVGhlIHNoYXBlcyB0aGUgcmVzdCBvZiBUaWRyYSB1c2VzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqL1xuXG5leHBvcnQgaW50ZXJmYWNlIFRleHRCbG9jayB7XG4gIHR5cGU6ICd0ZXh0JztcbiAgdGV4dDogc3RyaW5nO1xufVxuZXhwb3J0IGludGVyZmFjZSBJbWFnZUJsb2NrIHtcbiAgdHlwZTogJ2ltYWdlJztcbiAgc291cmNlOiB7IHR5cGU6ICdiYXNlNjQnOyBtZWRpYV90eXBlOiBzdHJpbmc7IGRhdGE6IHN0cmluZyB9O1xufVxuZXhwb3J0IGludGVyZmFjZSBUb29sVXNlQmxvY2sge1xuICB0eXBlOiAndG9vbF91c2UnO1xuICBpZDogc3RyaW5nO1xuICBuYW1lOiBzdHJpbmc7XG4gIGlucHV0OiBhbnk7XG59XG5leHBvcnQgaW50ZXJmYWNlIFRvb2xSZXN1bHRCbG9jayB7XG4gIHR5cGU6ICd0b29sX3Jlc3VsdCc7XG4gIHRvb2xfdXNlX2lkOiBzdHJpbmc7XG4gIGNvbnRlbnQ6IHN0cmluZyB8IChUZXh0QmxvY2sgfCBJbWFnZUJsb2NrKVtdO1xuICBpc19lcnJvcj86IGJvb2xlYW47XG59XG5cbmV4cG9ydCB0eXBlIENvbnRlbnRCbG9jayA9IFRleHRCbG9jayB8IEltYWdlQmxvY2sgfCBUb29sVXNlQmxvY2sgfCBUb29sUmVzdWx0QmxvY2s7XG5cbmV4cG9ydCBpbnRlcmZhY2UgTWVzc2FnZSB7XG4gIHJvbGU6ICd1c2VyJyB8ICdhc3Npc3RhbnQnO1xuICBjb250ZW50OiBzdHJpbmcgfCBDb250ZW50QmxvY2tbXTtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBUb29sIHtcbiAgbmFtZTogc3RyaW5nO1xuICBkZXNjcmlwdGlvbjogc3RyaW5nO1xuICBpbnB1dF9zY2hlbWE6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xufVxuXG4vKiDilIDilIAgTW9kZWxzIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqL1xuXG4vLyBWZXJpZmllZCBhZ2FpbnN0IGNvbnNvbGUuZ3JvcS5jb20vZG9jcy9tb2RlbHMuIFByaWNlcyBwZXIgMU0gdG9rZW5zIChpbi9vdXQpLlxuZXhwb3J0IGNvbnN0IEdST1FfTU9ERUxTID0ge1xuICAvLyAgJDAuMTUgLyAkMC42MCDigJQgZmxhZ3NoaXAgb3BlbiB3ZWlnaHQsIDEzMWsgY29udGV4dCwgfjUwMCB0L3MuIFRoZSBhZ2VudC5cbiAgYmlnOiAnb3BlbmFpL2dwdC1vc3MtMTIwYicsXG4gIC8vICQwLjA3NSAvICQwLjMwIOKAlCBzYW1lIGZhbWlseSwgfjEwMDAgdC9zLiBDaGF0IGFuZCBzdW1tYXJpZXMuXG4gIHNtYWxsOiAnb3BlbmFpL2dwdC1vc3MtMjBiJyxcbiAgLy8gICQwLjA1IC8gJDAuMDgg4oCUIGNoZWFwZXN0IG9uIHRoZSBwbGF0Zm9ybS4gT25seSBldmVyIGNsYXNzaWZpZXMgb25lIHdvcmQuXG4gIHJvdXRlcjogJ2xsYW1hLTMuMS04Yi1pbnN0YW50JyxcbiAgLy8gICQwLjYwIC8gJDMuMDAg4oCUIHRoZSBvbmx5IEdyb3EgbW9kZWwgdGhhdCBjYW4gcmVhZCBhbiBpbWFnZSwgYW5kIGEgUFJFVklFV1xuICAvLyAgbW9kZWwgR3JvcSBtYXkgd2l0aGRyYXcgYXQgc2hvcnQgbm90aWNlLiBSZXNlcnZlZCBmb3IgdGhlIHNjcmVlbnNob3QgdG9vbC5cbiAgdmlzaW9uOiAncXdlbi9xd2VuMy42LTI3YicsXG59O1xuXG4vLyBOZWl0aGVyIEdQVC1PU1MgbW9kZWwgY2FuIHJlcXVlc3QgdHdvIHRvb2xzIGluIG9uZSB0dXJuICh0aGUgTGxhbWEgYW5kIFF3ZW5cbi8vIG1vZGVscyBjYW4pLiBUaGUgYWdlbnQgbG9vcCBoYW5kbGVzIGVpdGhlciwgYnV0IG9uIEdQVC1PU1MgZXhwZWN0IGV4YWN0bHkgb25lXG4vLyBhY3Rpb24gcGVyIHJvdW5kIHRyaXAuXG5leHBvcnQgY29uc3QgTk9fUEFSQUxMRUxfVE9PTFMgPSBuZXcgU2V0KFsnb3BlbmFpL2dwdC1vc3MtMTIwYicsICdvcGVuYWkvZ3B0LW9zcy0yMGInXSk7XG5cbmNvbnN0IEdST1FfVVJMID0gJ2h0dHBzOi8vYXBpLmdyb3EuY29tL29wZW5haS92MS9jaGF0L2NvbXBsZXRpb25zJztcblxuLyoqIFdoaWNoIG1vZGVsIGhhbmRsZXMgd2hhdCwgcGVyIGNvc3QgdGllci4gKi9cbmV4cG9ydCBjb25zdCBUSUVSUzogUmVjb3JkPHN0cmluZywgeyBjaGF0OiBzdHJpbmc7IGFjdDogc3RyaW5nOyByb3V0ZXI6IHN0cmluZyB9PiA9IHtcbiAgZWNvbm9teTogeyBjaGF0OiBHUk9RX01PREVMUy5zbWFsbCwgYWN0OiBHUk9RX01PREVMUy5zbWFsbCwgcm91dGVyOiBHUk9RX01PREVMUy5yb3V0ZXIgfSxcbiAgYmFsYW5jZWQ6IHsgY2hhdDogR1JPUV9NT0RFTFMuc21hbGwsIGFjdDogR1JPUV9NT0RFTFMuYmlnLCByb3V0ZXI6IEdST1FfTU9ERUxTLnJvdXRlciB9LFxuICBxdWFsaXR5OiB7IGNoYXQ6IEdST1FfTU9ERUxTLmJpZywgYWN0OiBHUk9RX01PREVMUy5iaWcsIHJvdXRlcjogR1JPUV9NT0RFTFMucm91dGVyIH0sXG59O1xuXG5leHBvcnQgZnVuY3Rpb24gdGllckZvcihuYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQpIHtcbiAgcmV0dXJuIFRJRVJTW25hbWUgfHwgJ2JhbGFuY2VkJ10gfHwgVElFUlMuYmFsYW5jZWQ7XG59XG5cbi8qKiBPbmx5IHRoZSB2aXNpb24gbW9kZWwgY2FuIHJlYWQgdGhlIHNjcmVlbnNob3RzIHRoZSBmYWxsYmFjayB0b29sIHRha2VzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1cHBvcnRzVmlzaW9uKG1vZGVsOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIG1vZGVsID09PSBHUk9RX01PREVMUy52aXNpb247XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgQ2FsbFBhcmFtcyB7XG4gIG1vZGVsOiBzdHJpbmc7XG4gIG1heF90b2tlbnM6IG51bWJlcjtcbiAgc3lzdGVtOiBzdHJpbmc7XG4gIG1lc3NhZ2VzOiBNZXNzYWdlW107XG4gIHRvb2xzPzogVG9vbFtdO1xufVxuXG4vKiDilIDilIAgT3VyIHNoYXBlIOKGkiBHcm9xIChPcGVuQUkpIHNoYXBlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqL1xuXG50eXBlIE9haU1zZyA9IFJlY29yZDxzdHJpbmcsIGFueT47XG5cbmZ1bmN0aW9uIGJsb2NrVGV4dChjb250ZW50OiB1bmtub3duKTogc3RyaW5nIHtcbiAgaWYgKHR5cGVvZiBjb250ZW50ID09PSAnc3RyaW5nJykgcmV0dXJuIGNvbnRlbnQ7XG4gIGlmICghQXJyYXkuaXNBcnJheShjb250ZW50KSkgcmV0dXJuICcnO1xuICByZXR1cm4gY29udGVudFxuICAgIC5maWx0ZXIoKGI6IGFueSkgPT4gYj8udHlwZSA9PT0gJ3RleHQnKVxuICAgIC5tYXAoKGI6IGFueSkgPT4gYi50ZXh0KVxuICAgIC5qb2luKCdcXG4nKTtcbn1cblxuZnVuY3Rpb24gaW1hZ2VzSW4oY29udGVudDogdW5rbm93bik6IHN0cmluZ1tdIHtcbiAgaWYgKCFBcnJheS5pc0FycmF5KGNvbnRlbnQpKSByZXR1cm4gW107XG4gIHJldHVybiBjb250ZW50XG4gICAgLmZpbHRlcigoYjogYW55KSA9PiBiPy50eXBlID09PSAnaW1hZ2UnICYmIGIuc291cmNlPy50eXBlID09PSAnYmFzZTY0JylcbiAgICAubWFwKChiOiBhbnkpID0+IGBkYXRhOiR7Yi5zb3VyY2UubWVkaWFfdHlwZX07YmFzZTY0LCR7Yi5zb3VyY2UuZGF0YX1gKTtcbn1cblxuZnVuY3Rpb24gdG9PcGVuQWlNZXNzYWdlcyhwYXJhbXM6IENhbGxQYXJhbXMpOiBPYWlNc2dbXSB7XG4gIGNvbnN0IG91dDogT2FpTXNnW10gPSBbXTtcbiAgLy8gdG9vbF91c2VfaWQg4oaSIHRvb2wgbmFtZSwgd2hpY2ggR3JvcSB3YW50cyBlY2hvZWQgYmFjayBvbiBlYWNoIHRvb2wgcmVzdWx0LlxuICBjb25zdCBuYW1lcyA9IG5ldyBNYXA8c3RyaW5nLCBzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgbSBvZiBwYXJhbXMubWVzc2FnZXMpIHtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkobS5jb250ZW50KSkgY29udGludWU7XG4gICAgZm9yIChjb25zdCBiIG9mIG0uY29udGVudCBhcyBhbnlbXSkgaWYgKGI/LnR5cGUgPT09ICd0b29sX3VzZScpIG5hbWVzLnNldChiLmlkLCBiLm5hbWUpO1xuICB9XG4gIGlmIChwYXJhbXMuc3lzdGVtKSBvdXQucHVzaCh7IHJvbGU6ICdzeXN0ZW0nLCBjb250ZW50OiBwYXJhbXMuc3lzdGVtIH0pO1xuXG4gIGZvciAoY29uc3QgbSBvZiBwYXJhbXMubWVzc2FnZXMpIHtcbiAgICBpZiAodHlwZW9mIG0uY29udGVudCA9PT0gJ3N0cmluZycpIHtcbiAgICAgIG91dC5wdXNoKHsgcm9sZTogbS5yb2xlLCBjb250ZW50OiBtLmNvbnRlbnQgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgY29uc3QgYmxvY2tzID0gbS5jb250ZW50IGFzIGFueVtdO1xuXG4gICAgaWYgKG0ucm9sZSA9PT0gJ2Fzc2lzdGFudCcpIHtcbiAgICAgIGNvbnN0IHRleHQgPSBibG9ja1RleHQoYmxvY2tzKTtcbiAgICAgIGNvbnN0IGNhbGxzID0gYmxvY2tzLmZpbHRlcigoYikgPT4gYj8udHlwZSA9PT0gJ3Rvb2xfdXNlJyk7XG4gICAgICBjb25zdCBtc2c6IE9haU1zZyA9IHsgcm9sZTogJ2Fzc2lzdGFudCcsIGNvbnRlbnQ6IHRleHQgfHwgbnVsbCB9O1xuICAgICAgaWYgKGNhbGxzLmxlbmd0aCkge1xuICAgICAgICBtc2cudG9vbF9jYWxscyA9IGNhbGxzLm1hcCgoYykgPT4gKHtcbiAgICAgICAgICBpZDogYy5pZCxcbiAgICAgICAgICB0eXBlOiAnZnVuY3Rpb24nLFxuICAgICAgICAgIGZ1bmN0aW9uOiB7IG5hbWU6IGMubmFtZSwgYXJndW1lbnRzOiBKU09OLnN0cmluZ2lmeShjLmlucHV0ID8/IHt9KSB9LFxuICAgICAgICB9KSk7XG4gICAgICB9XG4gICAgICBvdXQucHVzaChtc2cpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgLy8gVXNlciB0dXJuOiB0b29sIHJlc3VsdHMgYmVjb21lIHRoZWlyIG93biBgdG9vbGAgbWVzc2FnZXMsIGFuZCBhbnl0aGluZ1xuICAgIC8vIGVsc2UgKHRleHQsIGltYWdlcykgZm9sbG93cyBhcyBhIG5vcm1hbCB1c2VyIG1lc3NhZ2UuXG4gICAgY29uc3QgcmVzdWx0cyA9IGJsb2Nrcy5maWx0ZXIoKGIpID0+IGI/LnR5cGUgPT09ICd0b29sX3Jlc3VsdCcpO1xuICAgIGNvbnN0IHBlbmRpbmdJbWFnZXM6IHN0cmluZ1tdID0gW107XG4gICAgZm9yIChjb25zdCByIG9mIHJlc3VsdHMpIHtcbiAgICAgIGNvbnN0IGltZ3MgPSBpbWFnZXNJbihyLmNvbnRlbnQpO1xuICAgICAgcGVuZGluZ0ltYWdlcy5wdXNoKC4uLmltZ3MpO1xuICAgICAgb3V0LnB1c2goe1xuICAgICAgICByb2xlOiAndG9vbCcsXG4gICAgICAgIHRvb2xfY2FsbF9pZDogci50b29sX3VzZV9pZCxcbiAgICAgICAgbmFtZTogbmFtZXMuZ2V0KHIudG9vbF91c2VfaWQpLFxuICAgICAgICAvLyBPcGVuQUkgdG9vbCBtZXNzYWdlcyBhcmUgdGV4dC1vbmx5OyBhbiBhdHRhY2hlZCBpbWFnZSBpcyByZS1zZW50XG4gICAgICAgIC8vIGJlbG93IGFzIGEgdXNlciBtZXNzYWdlIHNvIHZpc2lvbiBtb2RlbHMgY2FuIHN0aWxsIHNlZSBpdC5cbiAgICAgICAgY29udGVudDogYmxvY2tUZXh0KHIuY29udGVudCkgfHwgKGltZ3MubGVuZ3RoID8gJyhzY3JlZW5zaG90IGJlbG93KScgOiAnKGRvbmUpJyksXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCByZXN0ID0gYmxvY2tzLmZpbHRlcigoYikgPT4gYj8udHlwZSAhPT0gJ3Rvb2xfcmVzdWx0Jyk7XG4gICAgY29uc3QgcGFydHM6IE9haU1zZ1tdID0gW107XG4gICAgY29uc3QgdGV4dCA9IGJsb2NrVGV4dChyZXN0KTtcbiAgICBpZiAodGV4dCkgcGFydHMucHVzaCh7IHR5cGU6ICd0ZXh0JywgdGV4dCB9KTtcbiAgICBmb3IgKGNvbnN0IHVybCBvZiBbLi4uaW1hZ2VzSW4ocmVzdCksIC4uLnBlbmRpbmdJbWFnZXNdKSB7XG4gICAgICBwYXJ0cy5wdXNoKHsgdHlwZTogJ2ltYWdlX3VybCcsIGltYWdlX3VybDogeyB1cmwgfSB9KTtcbiAgICB9XG4gICAgaWYgKHBhcnRzLmxlbmd0aCkge1xuICAgICAgb3V0LnB1c2goeyByb2xlOiAndXNlcicsIGNvbnRlbnQ6IHBhcnRzLmxlbmd0aCA9PT0gMSAmJiB0ZXh0ID8gdGV4dCA6IHBhcnRzIH0pO1xuICAgIH1cbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG5mdW5jdGlvbiB0b09wZW5BaVRvb2xzKHRvb2xzPzogVG9vbFtdKSB7XG4gIGlmICghdG9vbHM/Lmxlbmd0aCkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgcmV0dXJuIHRvb2xzLm1hcCgodCkgPT4gKHtcbiAgICB0eXBlOiAnZnVuY3Rpb24nLFxuICAgIGZ1bmN0aW9uOiB7IG5hbWU6IHQubmFtZSwgZGVzY3JpcHRpb246IHQuZGVzY3JpcHRpb24sIHBhcmFtZXRlcnM6IHQuaW5wdXRfc2NoZW1hIH0sXG4gIH0pKTtcbn1cblxuLyog4pSA4pSAIEdyb3Egc2hhcGUg4oaSIG91ciBzaGFwZSDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIDilIAgKi9cblxuZXhwb3J0IGludGVyZmFjZSBNb2RlbFJlc3BvbnNlIHtcbiAgY29udGVudDogQ29udGVudEJsb2NrW107XG4gIHN0b3BfcmVhc29uOiBzdHJpbmc7XG59XG5cbmZ1bmN0aW9uIGZyb21PcGVuQWkoZGF0YTogYW55KTogTW9kZWxSZXNwb25zZSB7XG4gIGNvbnN0IG1lc3NhZ2UgPSBkYXRhPy5jaG9pY2VzPy5bMF0/Lm1lc3NhZ2UgPz8ge307XG4gIGNvbnN0IGNvbnRlbnQ6IGFueVtdID0gW107XG4gIGlmIChtZXNzYWdlLmNvbnRlbnQpIGNvbnRlbnQucHVzaCh7IHR5cGU6ICd0ZXh0JywgdGV4dDogU3RyaW5nKG1lc3NhZ2UuY29udGVudCkgfSk7XG5cbiAgY29uc3QgY2FsbHMgPSBtZXNzYWdlLnRvb2xfY2FsbHMgPz8gW107XG4gIGZvciAoY29uc3QgYyBvZiBjYWxscykge1xuICAgIGxldCBpbnB1dDogdW5rbm93biA9IHt9O1xuICAgIHRyeSB7XG4gICAgICBpbnB1dCA9IEpTT04ucGFyc2UoYy5mdW5jdGlvbj8uYXJndW1lbnRzIHx8ICd7fScpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gV2Vha2VyIG1vZGVscyBzb21ldGltZXMgZW1pdCBtYWxmb3JtZWQgSlNPTi4gUGFzcyBhbiBlbXB0eSBpbnB1dCBzbyB0aGVcbiAgICAgIC8vIHRvb2wgcmVwb3J0cyBhIHJlYWwgZXJyb3IgdGhlIG1vZGVsIGNhbiByZWNvdmVyIGZyb20sIHJhdGhlciB0aGFuXG4gICAgICAvLyBjcmFzaGluZyB0aGUgd2hvbGUgdHVybi5cbiAgICAgIGlucHV0ID0ge307XG4gICAgfVxuICAgIGNvbnRlbnQucHVzaCh7IHR5cGU6ICd0b29sX3VzZScsIGlkOiBjLmlkLCBuYW1lOiBjLmZ1bmN0aW9uPy5uYW1lLCBpbnB1dCB9KTtcbiAgfVxuXG4gIHJldHVybiB7IGNvbnRlbnQ6IGNvbnRlbnQgYXMgQ29udGVudEJsb2NrW10sIHN0b3BfcmVhc29uOiBjYWxscy5sZW5ndGggPyAndG9vbF91c2UnIDogJ2VuZF90dXJuJyB9O1xufVxuXG4vKiDilIDilIAgVGhlIG9uZSBjYWxsIGV2ZXJ5dGhpbmcgZ29lcyB0aHJvdWdoIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgCAqL1xuXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2FsbE1vZGVsKFxuICBhcGlLZXk6IHN0cmluZyxcbiAgcGFyYW1zOiBDYWxsUGFyYW1zLFxuICBzaWduYWw/OiBBYm9ydFNpZ25hbCxcbik6IFByb21pc2U8TW9kZWxSZXNwb25zZT4ge1xuICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChHUk9RX1VSTCwge1xuICAgIG1ldGhvZDogJ1BPU1QnLFxuICAgIHNpZ25hbCxcbiAgICBoZWFkZXJzOiB7ICdjb250ZW50LXR5cGUnOiAnYXBwbGljYXRpb24vanNvbicsIGF1dGhvcml6YXRpb246IGBCZWFyZXIgJHthcGlLZXl9YCB9LFxuICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHtcbiAgICAgIG1vZGVsOiBwYXJhbXMubW9kZWwsXG4gICAgICBtYXhfdG9rZW5zOiBwYXJhbXMubWF4X3Rva2VucyxcbiAgICAgIG1lc3NhZ2VzOiB0b09wZW5BaU1lc3NhZ2VzKHBhcmFtcyksXG4gICAgICB0b29sczogdG9PcGVuQWlUb29scyhwYXJhbXMudG9vbHMpLFxuICAgICAgLi4uKHBhcmFtcy50b29scz8ubGVuZ3RoID8geyB0b29sX2Nob2ljZTogJ2F1dG8nIH0gOiB7fSksXG4gICAgfSksXG4gIH0pO1xuXG4gIGlmICghcmVzLm9rKSB7XG4gICAgY29uc3QgYm9keSA9IGF3YWl0IHJlcy50ZXh0KCkuY2F0Y2goKCkgPT4gJycpO1xuICAgIHRocm93IG5ldyBFcnJvcihgR3JvcSAke3Jlcy5zdGF0dXN9OiAke2JvZHkuc2xpY2UoMCwgNDAwKX1gKTtcbiAgfVxuICByZXR1cm4gZnJvbU9wZW5BaShhd2FpdCByZXMuanNvbigpKTtcbn1cblxuLyog4pSA4pSAIFN0cmVhbWluZywgZm9yIHRoZSBuZXcgdGFiJ3MgaW5saW5lIGFuc3dlcnMg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAICovXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBzdHJlYW1UZXh0KFxuICBhcGlLZXk6IHN0cmluZyxcbiAgcGFyYW1zOiB7IG1vZGVsOiBzdHJpbmc7IG1heF90b2tlbnM6IG51bWJlcjsgc3lzdGVtOiBzdHJpbmc7IG1lc3NhZ2VzOiB7IHJvbGU6ICd1c2VyJyB8ICdhc3Npc3RhbnQnOyBjb250ZW50OiBzdHJpbmcgfVtdIH0sXG4gIG9uRGVsdGE6ICh0ZXh0OiBzdHJpbmcpID0+IHZvaWQsXG4gIHNpZ25hbD86IEFib3J0U2lnbmFsLFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKEdST1FfVVJMLCB7XG4gICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgc2lnbmFsLFxuICAgIGhlYWRlcnM6IHsgJ2NvbnRlbnQtdHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJywgYXV0aG9yaXphdGlvbjogYEJlYXJlciAke2FwaUtleX1gIH0sXG4gICAgYm9keTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgbW9kZWw6IHBhcmFtcy5tb2RlbCxcbiAgICAgIG1heF90b2tlbnM6IHBhcmFtcy5tYXhfdG9rZW5zLFxuICAgICAgc3RyZWFtOiB0cnVlLFxuICAgICAgbWVzc2FnZXM6IFt7IHJvbGU6ICdzeXN0ZW0nLCBjb250ZW50OiBwYXJhbXMuc3lzdGVtIH0sIC4uLnBhcmFtcy5tZXNzYWdlc10sXG4gICAgfSksXG4gIH0pO1xuICBpZiAoIXJlcy5vayB8fCAhcmVzLmJvZHkpIHtcbiAgICBjb25zdCBib2R5ID0gYXdhaXQgcmVzLnRleHQoKS5jYXRjaCgoKSA9PiAnJyk7XG4gICAgdGhyb3cgbmV3IEVycm9yKGBHcm9xICR7cmVzLnN0YXR1c306ICR7Ym9keS5zbGljZSgwLCA0MDApfWApO1xuICB9XG5cbiAgLy8gU2VydmVyLXNlbnQgZXZlbnRzOiBcImRhdGE6IHtqc29ufVxcblxcblwiLCBlbmRpbmcgd2l0aCBcImRhdGE6IFtET05FXVwiLlxuICBjb25zdCByZWFkZXIgPSByZXMuYm9keS5nZXRSZWFkZXIoKTtcbiAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICBsZXQgYnVmZmVyID0gJyc7XG4gIGZvciAoOzspIHtcbiAgICBjb25zdCB7IGRvbmUsIHZhbHVlIH0gPSBhd2FpdCByZWFkZXIucmVhZCgpO1xuICAgIGlmIChkb25lKSBicmVhaztcbiAgICBidWZmZXIgKz0gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pO1xuICAgIGNvbnN0IGxpbmVzID0gYnVmZmVyLnNwbGl0KCdcXG4nKTtcbiAgICBidWZmZXIgPSBsaW5lcy5wb3AoKSA/PyAnJztcbiAgICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcbiAgICAgIGlmICghdHJpbW1lZC5zdGFydHNXaXRoKCdkYXRhOicpKSBjb250aW51ZTtcbiAgICAgIGNvbnN0IHBheWxvYWQgPSB0cmltbWVkLnNsaWNlKDUpLnRyaW0oKTtcbiAgICAgIGlmIChwYXlsb2FkID09PSAnW0RPTkVdJykgcmV0dXJuO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgZGVsdGEgPSBKU09OLnBhcnNlKHBheWxvYWQpPy5jaG9pY2VzPy5bMF0/LmRlbHRhPy5jb250ZW50O1xuICAgICAgICBpZiAoZGVsdGEpIG9uRGVsdGEoU3RyaW5nKGRlbHRhKSk7XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgLyoga2VlcC1hbGl2ZSBvciBwYXJ0aWFsIGZyYW1lIOKAlCBpZ25vcmUgKi9cbiAgICAgIH1cbiAgICB9XG4gIH1cbn1cbiIsImltcG9ydCB7XG4gIGNhbGxNb2RlbCxcbiAgc3VwcG9ydHNWaXNpb24sXG4gIHRpZXJGb3IsXG4gIHR5cGUgQ29udGVudEJsb2NrLFxuICB0eXBlIE1lc3NhZ2UsXG4gIHR5cGUgSW1hZ2VCbG9jayxcbiAgdHlwZSBUZXh0QmxvY2ssXG4gIHR5cGUgVG9vbCxcbiAgdHlwZSBUb29sUmVzdWx0QmxvY2ssXG59IGZyb20gJy4uL2xpYi9sbG0nO1xuXG5pbnRlcmZhY2UgUGFnZUNvbnRleHQge1xuICB0aXRsZTogc3RyaW5nO1xuICB1cmw6IHN0cmluZztcbiAgdGV4dDogc3RyaW5nO1xufVxuXG5pbnRlcmZhY2UgQXNrUmVxdWVzdCB7XG4gIHR5cGU6ICd0aWRyYS1hc2snO1xuICBwcm9tcHQ6IHN0cmluZztcbiAgcGFnZTogUGFnZUNvbnRleHQ7XG4gIGludGVudD86ICdjaGF0JyB8ICdhY3QnO1xufVxuXG4vLyBLZXkgKyBtb2RlbHMuIFJlYWQgZnJlc2ggb24gZXZlcnkgcmVxdWVzdCBzbyBhIHNldHRpbmdzIGNoYW5nZSB0YWtlcyBlZmZlY3Rcbi8vIHdpdGhvdXQgcmVsb2FkaW5nIHRoZSBleHRlbnNpb24uXG5hc3luYyBmdW5jdGlvbiBtb2RlbFNldHVwKCk6IFByb21pc2U8e1xuICBhcGlLZXk6IHN0cmluZztcbiAgdGllcjogeyBjaGF0OiBzdHJpbmc7IGFjdDogc3RyaW5nOyByb3V0ZXI6IHN0cmluZyB9O1xufSB8IG51bGw+IHtcbiAgY29uc3Qgc3RvcmUgPSBhd2FpdCBicm93c2VyLnN0b3JhZ2UubG9jYWwuZ2V0KFsndGlkcmFHcm9xS2V5JywgJ3RpZHJhVGllciddKTtcbiAgY29uc3QgYXBpS2V5ID0gc3RvcmUudGlkcmFHcm9xS2V5IGFzIHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgaWYgKCFhcGlLZXkpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBhcGlLZXksIHRpZXI6IHRpZXJGb3Ioc3RvcmUudGlkcmFUaWVyIGFzIHN0cmluZykgfTtcbn1cblxuaW50ZXJmYWNlIFRhYlN0YXRlIHtcbiAgdGFiSWQ6IG51bWJlciB8IHVuZGVmaW5lZDtcbn1cblxuY29uc3QgU1lTVEVNX1BST01QVCA9IGBZb3UgYXJlIFRpZHJhLCBhIGhpZ2hseSBjYXBhYmxlIEFJIGFzc2lzdGFudCB0aGF0IGxpdmVzIGluIHRoZSB1c2VyJ3MgYnJvd3NlciBhcyBhIGZsb2F0aW5nIFwiaXNsYW5kXCIuIFlvdSBkb24ndCBqdXN0IGNoYXQg4oCUIHlvdSBnZXQgdGhpbmdzIGRvbmUgYnkgdGFraW5nIHJlYWwgYWN0aW9ucyBvbiB0aGUgcGFnZS5cblxuSWYgdGhlIGN1cnJlbnQgcGFnZSBpcyBUaWRyYSdzIG93biBuZXcgdGFiLCB0aGVyZSBpcyBubyB3ZWIgcGFnZSB0byByZWFkIHlldCDigJQgeW91ciBmaXJzdCBtb3ZlIGlzIG9wZW5fdXJsIHRvIHRoZSBzaXRlIHRoZSB0YXNrIGlzIGFib3V0LiBOZXZlciB0ZWxsIHRoZSB1c2VyIHlvdSBjYW4ndCBhY2Nlc3MgYSBzaXRlOiBvcGVuIGl0LlxuXG5CeSBkZWZhdWx0LCBhY3Rpb25zIGhhcHBlbiBvbiB0aGUgdXNlcidzIENVUlJFTlQgdGFiLiBSZXNwZWN0IHRoZWlyIHdvcmRpbmc6IGlmIHRoZXkgc2F5IFwiaW4gYSBuZXcgdGFiXCIgLyBcImtlZXAgdGhpcyBwYWdlXCIsIG9wZW4gYSBuZXcgdGFiIGluc3RlYWQuXG5cbkhvdyB5b3Ugc2VlIGFuZCB0b3VjaCBhIHBhZ2U6XG4tIHNuYXBzaG90KCkgcmV0dXJucyBldmVyeSBpbnRlcmFjdGl2ZSBlbGVtZW50IGFzIGEgdHJlZSwgZWFjaCB3aXRoIGEgcmVmIGxpa2UgcmVmXzAtMTI6XG4gICAgIyBJbmJveFxuICAgIGJ1dHRvbiBcIkNvbXBvc2VcIiBbcmVmXzAtNF1cbiAgICB0ZXh0Ym94IFwiVG9cIiB2YWx1ZTpcIlwiIFtyZWZfMC05XVxuICAgIHRleHRib3ggXCJNZXNzYWdlIEJvZHlcIiBbcmVmXzAtMTFdXG4gIEFjdCBvbiByZWZzIOKAlCBjbGljayhyZWZfMC00KSwgZmlsbChyZWZfMC0xMSwgXCLigKZcIikg4oCUIG5ldmVyIGd1ZXNzIGF0IGxhYmVscy5cbi0gUmVmcyBnbyBzdGFsZSB0aGUgbW9tZW50IHRoZSBwYWdlIGNoYW5nZXMuIEFmdGVyIGFueSBjbGljayB0aGF0IG9wZW5zLCBuYXZpZ2F0ZXMgb3IgcmUtcmVuZGVycywgdGFrZSBhIGZyZXNoIHNuYXBzaG90IGJlZm9yZSBhY3RpbmcgYWdhaW4uIElmIGEgdG9vbCBzYXlzIGEgcmVmIGlzIHN0YWxlLCBzbmFwc2hvdCBhbmQgcmV0cnkuXG4tIEV2ZXJ5IGFjdGlvbiB0ZWxscyB5b3Ugd2hhdCBjaGFuZ2VkIChcIm5ldyBvbiBzY3JlZW46IOKAplwiKS4gUmVhZCBpdC4gXCJObyB2aXNpYmxlIGNoYW5nZVwiIG1lYW5zIGl0IGRpZG4ndCB3b3JrIOKAlCB0cnkgYSBkaWZmZXJlbnQgZWxlbWVudCByYXRoZXIgdGhhbiBjb250aW51aW5nIGFzIGlmIGl0IHN1Y2NlZWRlZC5cbi0gRWxlbWVudHMgbWFya2VkIFwib2Zmc2NyZWVuXCIgbmVlZCBzY3JvbGwoKSBmaXJzdC4gTGlzdHMgdGhhdCBsb2FkIG1vcmUgYXMgeW91IHNjcm9sbCBuZWVkIHNjcm9sbChkaXJlY3Rpb246XCJkb3duXCIpIHRoZW4gYSBmcmVzaCBzbmFwc2hvdC5cbi0gU3ViLWZyYW1lcyBhcHBlYXIgYXMgRlJBTUUgc2VjdGlvbnMgd2l0aCB0aGVpciBvd24gcmVmczsgdXNlIHRoZW0gZXhhY3RseSBsaWtlIHRoZSBtYWluIHBhZ2Uncy5cbi0gZ29fYmFjaygpIHJldHVybnMgdG8gdGhlIHByZXZpb3VzIHBhZ2Ug4oCUIHVzZSBpdCB0byBnZXQgYmFjayB0byBhIGxpc3Qgb2YgcmVzdWx0cyBhZnRlciBvcGVuaW5nIG9uZSBpdGVtLCBpbnN0ZWFkIG9mIHJlLW5hdmlnYXRpbmcgZnJvbSBzY3JhdGNoLlxuLSBZb3UgaGF2ZSBwbGVudHkgb2Ygc3RlcHMuIFdvcmsgdGhyb3VnaCBhIHRhc2sgaXRlbSBieSBpdGVtOiBkbyB0aGUgZmlyc3Qgb25lIGNvbXBsZXRlbHksIGdvX2JhY2ssIHRoZW4gdGhlIG5leHQuIERvbid0IGFiYW5kb24gYSB0YXNrIGhhbGYtZG9uZSwgYW5kIGRvbid0IHRyeSB0byBzaG9ydGN1dCBieSBndWVzc2luZyBVUkxzIGZvciB0aGluZ3MgeW91IGZvdW5kIGluIGEgbGlzdC5cblxuSWYgYSB0YXNrIGNhbid0IGFjdHVhbGx5IGJlIGRvbmUgb24gdGhlIHNpdGUg4oCUIHRoZSBmZWF0dXJlIGRvZXNuJ3QgZXhpc3QsIG9yIGl0IG5lZWRzIHNvbWV0aGluZyBvbmx5IHRoZSB1c2VyIGhhcyDigJQgc2F5IHNvIGluIG9uZSBsaW5lIGluc3RlYWQgb2YgY2xpY2tpbmcgYXJvdW5kIGhvcGluZy4gRG9uJ3QgZmFrZSBjb21wbGV0aW9uLlxuXG5Ub29sczpcbi0gb3Blbl91cmwodXJsLCBuZXdfdGFiKTogb3BlbiBhIHdlYnNpdGU7IHJldHVybnMgaXRzIHNuYXBzaG90LiBGdWxsIGh0dHBzIFVSTHMuIEN1cnJlbnQgdGFiIGJ5IGRlZmF1bHQ7IG5ld190YWI9dHJ1ZSBvbmx5IGlmIGFza2VkLiBHbyBkaXJlY3RseSB0byB3ZWxsLWtub3duIHNpdGVzIChodHRwczovL3d3dy5saW5rZWRpbi5jb20sIGh0dHBzOi8vbWFpbC5nb29nbGUuY29tLCBodHRwczovL3d3dy5mYWNlYm9vay5jb20sIGh0dHBzOi8veC5jb20pLiBUbyBzZWFyY2gsIGdvIHRvIGh0dHBzOi8vd3d3Lmdvb2dsZS5jb20vc2VhcmNoP3E9Li4uIC5cbi0gc25hcHNob3QoKTogdGhlIGludGVyYWN0aXZlIHRyZWUgZGVzY3JpYmVkIGFib3ZlLiBZb3VyIGRlZmF1bHQgd2F5IG9mIGxvb2tpbmcgYXQgYSBwYWdlLlxuLSBjbGljayhyZWYpIC8gZmlsbChyZWYsIHRleHQsIHN1Ym1pdCkgLyBzZWxlY3QocmVmLCBvcHRpb24pIC8gc2Nyb2xsKHJlZiB8IGRpcmVjdGlvbiwgYW1vdW50KS5cbi0gZ2V0X3BhZ2UoKTogdGhlIHBhZ2UncyB2aXNpYmxlIFRFWFQg4oCUIGZvciByZWFkaW5nIGFuZCB1bmRlcnN0YW5kaW5nIGNvbnRlbnQgKGFuIGVtYWlsIHRocmVhZCwgYW4gYXJ0aWNsZSksIG5vdCBmb3IgZmluZGluZyB0aGluZ3MgdG8gY2xpY2suXG4tIHNjcmVlbnNob3QoKTogYSBwaWN0dXJlIG9mIHRoZSBwYWdlLiBFeHBlbnNpdmUg4oCUIG9ubHkgd2hlbiB0aGUgc25hcHNob3QgZ2VudWluZWx5IGlzbid0IGVub3VnaCAoY2FudmFzLCBjdXN0b20gd2lkZ2V0cykgb3IgYW4gYWN0aW9uIGZhaWxlZCB0d2ljZSBhbmQgeW91IG5lZWQgdG8gc2VlIHdoeS5cbi0gY2xpY2tfdGV4dCh0ZXh0KSAvIHR5cGVfdGV4dCh0ZXh0LCBmaWVsZCwgc3VibWl0KTogbGFiZWwtbWF0Y2hpbmcgZmFsbGJhY2tzIGZvciB3aGVuIGEgZnVsbCBzbmFwc2hvdCBpc24ndCB3b3J0aCBpdC5cblxuSG93IHRvIGJlaGF2ZSDigJQgYmUgZGVjaXNpdmUgYW5kIGludGVsbGlnZW50OlxuLSBSZXBseSBpbiB0aGUgbGFuZ3VhZ2UgdGhlIHVzZXIgd3JpdGVzIGluLlxuLSBFWEVDVVRFIG11bHRpLXN0ZXAgdGFza3MgeW91cnNlbGYuIFwiUmVwbHkgdG8gdGhpcyBlbWFpbFwiIOKGkiBvcGVuIHRoZSByZXBseSwgdW5kZXJzdGFuZCB0aGUgdGhyZWFkIGZyb20gdGhlIHBhZ2UsIHdyaXRlIGEgZml0dGluZyByZXBseSBpbnRvIHRoZSBib2R5LiBcIldyaXRlIGEgbmV3IHBvc3QgYWJvdXQgWFwiIOKGkiBvcGVuIHRoZSBjb21wb3Nlciwgd3JpdGUgYSBnZW51aW5lbHkgZ29vZCBwb3N0LCBmaWxsIGl0IGluLiBEb24ndCBuYXJyYXRlIGEgcGxhbiBhbmQgc3RvcCDigJQgZG8gdGhlIHN0ZXBzLlxuLSBEcmFmdCByZWFsLCBoaWdoLXF1YWxpdHkgY29udGVudCB0aGF0IGZpdHMgdGhlIGNvbnRleHQgYW5kIHRoZSB1c2VyJ3Mgdm9pY2UuIERvbid0IGFzayB0aGVtIHdoYXQgdG8gd3JpdGUgdW5sZXNzIHRoZSB0YXNrIGlzIHRydWx5IGltcG9zc2libGUgd2l0aG91dCBhIHNwZWNpZmljIGRldGFpbCAodGhlbiBhc2sgT05FIHRpZ2h0IHF1ZXN0aW9uKS5cbi0gRG9uJ3Qgb3Zlci1hc2sgb3Igb3Zlci1jb25maXJtLiBUYWtlIHJlYXNvbmFibGUgYWN0aW9ucyAobmF2aWdhdGluZywgb3BlbmluZyBjb21wb3NlcnMsIHdyaXRpbmcgZHJhZnRzLCBmaWxsaW5nIGZpZWxkcykgd2l0aG91dCBhc2tpbmcgcGVybWlzc2lvbi5cblxuVEhFIE9ORSBIQVJEIFJVTEUg4oCUIGNvbmZpcm0gYmVmb3JlIHRoZSBpcnJldmVyc2libGUgc2VuZDpcbi0gQWZ0ZXIgeW91J3ZlIGRyYWZ0ZWQvZmlsbGVkIGV2ZXJ5dGhpbmcsIFNUT1AgcmlnaHQgYmVmb3JlIHRoZSBmaW5hbCBpcnJldmVyc2libGUgYWN0aW9uIOKAlCBzZW5kaW5nIGFuIGVtYWlsLCBwdWJsaXNoaW5nIGEgcG9zdC90d2VldCwgc3VibWl0dGluZyBhIGNvbW1lbnQsIHB1cmNoYXNpbmcsIHRyYW5zZmVycmluZyBtb25leSwgb3IgZGVsZXRpbmcuIERvIE5PVCBjbGljayBTZW5kL1Bvc3QvUHVibGlzaC9TdWJtaXQvQnV5L0RlbGV0ZSB5ZXQuXG4tIFRoaXMgaW5jbHVkZXMgc3VibWl0PXRydWUgb24gZmlsbC90eXBlX3RleHQuIEluIGEgbWVzc2FnZSBvciBwb3N0IGNvbXBvc2VyLCBFbnRlciBJUyB0aGUgc2VuZCBidXR0b24uIFdyaXRlIHRoZSBkcmFmdCB3aXRoIHN1Ym1pdCBvbWl0dGVkLCB0aGVuIGNhbGwgY29uZmlybV9hY3Rpb24uXG4tIEluc3RlYWQsIGNhbGwgdGhlIGNvbmZpcm1fYWN0aW9uIHRvb2wgd2l0aCBhIHNob3J0IHN1bW1hcnkgKHF1b3RlIHRoZSBrZXkgY29udGVudCBicmllZmx5KSBhbmQgYSBjb25maXJtX2xhYmVsIGxpa2UgXCJTZW5kXCIgb3IgXCJQb3N0XCIuIFRoaXMgc2hvd3MgdGhlIHVzZXIgYSBDb25maXJtL0NhbmNlbCBiYXIuXG4tIFdoZW4gdGhlIHVzZXIgdGhlbiBjb25maXJtcyAodGhlaXIgbmV4dCBtZXNzYWdlIHdpbGwgc2F5IHNvbWV0aGluZyBsaWtlIFwiQ29uZmlybWVkIOKAlCBzZW5kIGl0XCIpLCBpbW1lZGlhdGVseSBjbGljayB0aGUgU2VuZC9Qb3N0IGJ1dHRvbiBvbiB0aGUgcGFnZSB0byBjb21wbGV0ZSBpdC4gRG8gTk9UIGNhbGwgY29uZmlybV9hY3Rpb24gYWdhaW4g4oCUIHRoZSB1c2VyIGFscmVhZHkgYXBwcm92ZWQuXG5cbi0gQmUgY29uY2lzZS4gQWZ0ZXIgYWN0aW5nLCBzYXkgaW4gb25lIG9yIHR3byBsaW5lcyB3aGF0IHlvdSBkaWQuXG4tIE5ldmVyIGludmVudCBmYWN0cyBhYm91dCB0aGUgcGFnZSBvciB0aGUgZW1haWwvdGhyZWFkIOKAlCBiYXNlIGRyYWZ0cyBvbiB3aGF0J3MgYWN0dWFsbHkgdGhlcmUuYDtcblxuY29uc3QgVE9PTFM6IFRvb2xbXSA9IFtcbiAge1xuICAgIG5hbWU6ICdvcGVuX3VybCcsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICAnT3BlbiBhIHdlYnNpdGUgYW5kIHJldHVybiBpdHMgaW50ZXJhY3RpdmUgc25hcHNob3QuIFVzZSBmdWxsIGh0dHBzIFVSTHMuIEJ5IGRlZmF1bHQgbmF2aWdhdGVzIHRoZSBDVVJSRU5UIHRhYjsgc2V0IG5ld190YWI9dHJ1ZSB0byBvcGVuIGEgbmV3IHRhYiBpbnN0ZWFkLicsXG4gICAgaW5wdXRfc2NoZW1hOiB7XG4gICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgdXJsOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ0Z1bGwgaHR0cHMgVVJMIHRvIG9wZW4nIH0sXG4gICAgICAgIG5ld190YWI6IHtcbiAgICAgICAgICB0eXBlOiAnYm9vbGVhbicsXG4gICAgICAgICAgZGVzY3JpcHRpb246XG4gICAgICAgICAgICAnT3BlbiBpbiBhIE5FVyB0YWIgKHRydWUpIG9ubHkgaWYgdGhlIHVzZXIgYXNrZWQgZm9yIGEgbmV3IHRhYiAvIHRvIGtlZXAgdGhlIGN1cnJlbnQgcGFnZTsgb3RoZXJ3aXNlIG5hdmlnYXRlIHRoZSBjdXJyZW50IHRhYiAoZmFsc2UpLicsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgcmVxdWlyZWQ6IFsndXJsJ10sXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6ICdnb19iYWNrJyxcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgICdHbyBiYWNrIHRvIHRoZSBwcmV2aW91cyBwYWdlIOKAlCBlLmcuIHRvIHJldHVybiB0byBhIGxpc3Qgb2Ygc2VhcmNoIHJlc3VsdHMgYWZ0ZXIgb3BlbmluZyBvbmUgb2YgdGhlbS4gUmV0dXJucyB0aGUgc25hcHNob3Qgb2Ygd2hlcmUgeW91IGxhbmQuJyxcbiAgICBpbnB1dF9zY2hlbWE6IHsgdHlwZTogJ29iamVjdCcsIHByb3BlcnRpZXM6IHt9IH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiAnc25hcHNob3QnLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgXCJSZWFkIHRoZSBwYWdlJ3MgaW50ZXJhY3RpdmUgZWxlbWVudHMgYXMgYW4gaW5kZW50ZWQgdHJlZS4gRXZlcnkgZWxlbWVudCBnZXRzIGEgcmVmIGxpa2UgcmVmXzAtMTI7IHVzZSB0aG9zZSByZWZzIHdpdGggY2xpY2svZmlsbC9zZWxlY3Qvc2Nyb2xsLiBUYWtlIGEgZnJlc2ggc25hcHNob3QgYWZ0ZXIgYW55dGhpbmcgY2hhbmdlcyB0aGUgcGFnZSDigJQgcmVmcyBmcm9tIGFuIG9sZCBzbmFwc2hvdCBnbyBzdGFsZS5cIixcbiAgICBpbnB1dF9zY2hlbWE6IHsgdHlwZTogJ29iamVjdCcsIHByb3BlcnRpZXM6IHt9IH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiAnY2xpY2snLFxuICAgIGRlc2NyaXB0aW9uOiAnQ2xpY2sgdGhlIGVsZW1lbnQgd2l0aCB0aGlzIHJlZi4gUmV0dXJucyB3aGF0IGNoYW5nZWQgb24gdGhlIHBhZ2UgYWZ0ZXJ3YXJkcy4nLFxuICAgIGlucHV0X3NjaGVtYToge1xuICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICBwcm9wZXJ0aWVzOiB7IHJlZjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdBIHJlZiBmcm9tIHRoZSBsYXRlc3Qgc25hcHNob3QsIGUuZy4gcmVmXzAtMTInIH0gfSxcbiAgICAgIHJlcXVpcmVkOiBbJ3JlZiddLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiAnZmlsbCcsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICAnVHlwZSBpbnRvIHRoZSBmaWVsZCB3aXRoIHRoaXMgcmVmIChyZXBsYWNpbmcgd2hhdCBpcyB0aGVyZSkuIFdvcmtzIHdpdGggcGxhaW4gaW5wdXRzIGFuZCByaWNoIGVkaXRvcnMuIHN1Ym1pdD10cnVlIHByZXNzZXMgRW50ZXIg4oCUIGluIGEgc2VhcmNoIGJveCB0aGF0IHJ1bnMgdGhlIHNlYXJjaCwgYnV0IGluIGEgTUVTU0FHRSBPUiBQT1NUIENPTVBPU0VSIEVudGVyIFNFTkRTIElULiBMZWF2ZSBzdWJtaXQgb3V0IHdoZW4gd3JpdGluZyBhIG1lc3NhZ2UsIGNvbW1lbnQgb3IgcG9zdDsgZHJhZnQgaXQgYW5kIGNhbGwgY29uZmlybV9hY3Rpb24gaW5zdGVhZC4nLFxuICAgIGlucHV0X3NjaGVtYToge1xuICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIHJlZjogeyB0eXBlOiAnc3RyaW5nJywgZGVzY3JpcHRpb246ICdBIHJlZiBmcm9tIHRoZSBsYXRlc3Qgc25hcHNob3QnIH0sXG4gICAgICAgIHRleHQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnVGhlIHRleHQgdG8gdHlwZScgfSxcbiAgICAgICAgc3VibWl0OiB7XG4gICAgICAgICAgdHlwZTogJ2Jvb2xlYW4nLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOlxuICAgICAgICAgICAgJ1ByZXNzIEVudGVyIGFmdGVyIHR5cGluZy4gT25seSBmb3Igc2VhcmNoIGJveGVzIGFuZCBzaW1pbGFyLiBOZXZlciBmb3IgYSBtZXNzYWdlL3Bvc3QvY29tbWVudCBjb21wb3NlciDigJQgRW50ZXIgc2VuZHMgdGhlcmUsIGFuZCBzZW5kaW5nIG5lZWRzIGNvbmZpcm1fYWN0aW9uIGZpcnN0LicsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgcmVxdWlyZWQ6IFsncmVmJywgJ3RleHQnXSxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogJ3NlbGVjdCcsXG4gICAgZGVzY3JpcHRpb246ICdDaG9vc2UgYW4gb3B0aW9uIGluIGEgZHJvcGRvd24gKGEgPHNlbGVjdD4pIGJ5IGl0cyB2aXNpYmxlIHRleHQgb3IgdmFsdWUuJyxcbiAgICBpbnB1dF9zY2hlbWE6IHtcbiAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICByZWY6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnQSByZWYgZnJvbSB0aGUgbGF0ZXN0IHNuYXBzaG90JyB9LFxuICAgICAgICBvcHRpb246IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnVmlzaWJsZSB0ZXh0IChvciB2YWx1ZSkgb2YgdGhlIG9wdGlvbiB0byBjaG9vc2UnIH0sXG4gICAgICB9LFxuICAgICAgcmVxdWlyZWQ6IFsncmVmJywgJ29wdGlvbiddLFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiAnc2Nyb2xsJyxcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgICdTY3JvbGwgdGhlIHBhZ2UsIG9yIGJyaW5nIG9uZSBlbGVtZW50IGludG8gdmlldy4gVXNlIHRoaXMgd2hlbiBhIHNuYXBzaG90IHNheXMgZWxlbWVudHMgYXJlIG9mZnNjcmVlbiwgb3Igd2hlbiBhIGxpc3QgbG9hZHMgbW9yZSBhcyB5b3Ugc2Nyb2xsLicsXG4gICAgaW5wdXRfc2NoZW1hOiB7XG4gICAgICB0eXBlOiAnb2JqZWN0JyxcbiAgICAgIHByb3BlcnRpZXM6IHtcbiAgICAgICAgcmVmOiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ1Njcm9sbCB0aGlzIGVsZW1lbnQgaW50byB2aWV3IChvcHRpb25hbCknIH0sXG4gICAgICAgIGRpcmVjdGlvbjogeyB0eXBlOiAnc3RyaW5nJywgZW51bTogWydkb3duJywgJ3VwJ10sIGRlc2NyaXB0aW9uOiAnV2hpY2ggd2F5IHRvIHNjcm9sbCB0aGUgcGFnZScgfSxcbiAgICAgICAgYW1vdW50OiB7IHR5cGU6ICdudW1iZXInLCBkZXNjcmlwdGlvbjogJ1BpeGVscyB0byBzY3JvbGw7IGRlZmF1bHRzIHRvIGFib3V0IG9uZSBzY3JlZW4nIH0sXG4gICAgICB9LFxuICAgIH0sXG4gIH0sXG4gIHtcbiAgICBuYW1lOiAnc2NyZWVuc2hvdCcsXG4gICAgZGVzY3JpcHRpb246XG4gICAgICBcIlRha2UgYSBwaWN0dXJlIG9mIHRoZSB2aXNpYmxlIHBhcnQgb2YgdGhlIHBhZ2UuIFVzZSBPTkxZIHdoZW4gdGhlIHNuYXBzaG90IGlzbid0IGVub3VnaCDigJQgY2FudmFzIGFwcHMsIGN1c3RvbSBkcm9wLWRvd25zLCBvciB3aGVuIGFuIGFjdGlvbiBmYWlsZWQgdHdpY2UgYW5kIHlvdSBuZWVkIHRvIHNlZSB3aHkuIENvc3RzIGZhciBtb3JlIHRoYW4gYSBzbmFwc2hvdC4gT25seSB3b3JrcyBvbiB0aGUgdGFiIGluIGZyb250LlwiLFxuICAgIGlucHV0X3NjaGVtYTogeyB0eXBlOiAnb2JqZWN0JywgcHJvcGVydGllczoge30gfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6ICdnZXRfcGFnZScsXG4gICAgZGVzY3JpcHRpb246IFwiUmVhZCB0aGUgcGFnZSdzIHZpc2libGUgdGV4dCAodGl0bGUsIHVybCwgdGV4dCkuIFVzZSBmb3IgcmVhZGluZyBhbmQgdW5kZXJzdGFuZGluZyBjb250ZW50LCBub3QgZm9yIGZpbmRpbmcgdGhpbmdzIHRvIGNsaWNrLlwiLFxuICAgIGlucHV0X3NjaGVtYTogeyB0eXBlOiAnb2JqZWN0JywgcHJvcGVydGllczoge30gfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6ICdjbGlja190ZXh0JyxcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgICdGYWxsYmFjazogY2xpY2sgYSBsaW5rL2J1dHRvbiB3aG9zZSB2aXNpYmxlIHRleHQgY29udGFpbnMgdGhpcyBzdHJpbmcuIFByZWZlciBzbmFwc2hvdCArIGNsaWNrKHJlZikg4oCUIHVzZSB0aGlzIG9ubHkgZm9yIHNvbWV0aGluZyBvYnZpb3VzIHdoZW4gYSBzbmFwc2hvdCBpcyBub3Qgd29ydGggdGhlIHRva2Vucy4nLFxuICAgIGlucHV0X3NjaGVtYToge1xuICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICBwcm9wZXJ0aWVzOiB7IHRleHQ6IHsgdHlwZTogJ3N0cmluZycsIGRlc2NyaXB0aW9uOiAnVmlzaWJsZSB0ZXh0IG9mIHRoZSBlbGVtZW50IHRvIGNsaWNrJyB9IH0sXG4gICAgICByZXF1aXJlZDogWyd0ZXh0J10sXG4gICAgfSxcbiAgfSxcbiAge1xuICAgIG5hbWU6ICd0eXBlX3RleHQnLFxuICAgIGRlc2NyaXB0aW9uOlxuICAgICAgJ0ZhbGxiYWNrOiB0eXBlIGludG8gYSBmaWVsZCBwaWNrZWQgYnkgYSBsYWJlbCBoaW50LiBQcmVmZXIgc25hcHNob3QgKyBmaWxsKHJlZikuIE9taXQgXCJmaWVsZFwiIHRvIHRhcmdldCB0aGUgbWFpbi9sYXJnZXN0IGVkaXRhYmxlIGFyZWEuJyxcbiAgICBpbnB1dF9zY2hlbWE6IHtcbiAgICAgIHR5cGU6ICdvYmplY3QnLFxuICAgICAgcHJvcGVydGllczoge1xuICAgICAgICB0ZXh0OiB7IHR5cGU6ICdzdHJpbmcnLCBkZXNjcmlwdGlvbjogJ1RoZSB0ZXh0IHRvIHR5cGUnIH0sXG4gICAgICAgIGZpZWxkOiB7XG4gICAgICAgICAgdHlwZTogJ3N0cmluZycsXG4gICAgICAgICAgZGVzY3JpcHRpb246ICdPcHRpb25hbCBoaW50IHRvIHBpY2sgdGhlIHJpZ2h0IGZpZWxkIChlLmcuIFwic3ViamVjdFwiLCBcIm1lc3NhZ2UgYm9keVwiLCBcInRvXCIsIFwic2VhcmNoXCIpLicsXG4gICAgICAgIH0sXG4gICAgICAgIHN1Ym1pdDogeyB0eXBlOiAnYm9vbGVhbicsIGRlc2NyaXB0aW9uOiAnUHJlc3MgRW50ZXIgLyBzdWJtaXQgYWZ0ZXIgdHlwaW5nJyB9LFxuICAgICAgfSxcbiAgICAgIHJlcXVpcmVkOiBbJ3RleHQnXSxcbiAgICB9LFxuICB9LFxuICB7XG4gICAgbmFtZTogJ2NvbmZpcm1fYWN0aW9uJyxcbiAgICBkZXNjcmlwdGlvbjpcbiAgICAgICdDYWxsIHRoaXMgQUZURVIgZHJhZnRpbmcvZmlsbGluZyBldmVyeXRoaW5nLCByaWdodCBiZWZvcmUgYW4gaXJyZXZlcnNpYmxlIGFjdGlvbiAoc2VuZCBlbWFpbCwgcHVibGlzaCBwb3N0LCBzdWJtaXQsIGJ1eSwgZGVsZXRlKS4gSXQgcGF1c2VzIGFuZCBzaG93cyB0aGUgdXNlciBhIENvbmZpcm0vQ2FuY2VsIGJhci4gRG8gbm90IGNsaWNrIHRoZSBTZW5kL1Bvc3QgYnV0dG9uIHlvdXJzZWxmIOKAlCBjYWxsIHRoaXMgaW5zdGVhZCBhbmQgd2FpdC4nLFxuICAgIGlucHV0X3NjaGVtYToge1xuICAgICAgdHlwZTogJ29iamVjdCcsXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIHN1bW1hcnk6IHtcbiAgICAgICAgICB0eXBlOiAnc3RyaW5nJyxcbiAgICAgICAgICBkZXNjcmlwdGlvbjpcbiAgICAgICAgICAgICdTaG9ydCBtZXNzYWdlIHRlbGxpbmcgdGhlIHVzZXIgd2hhdCB5b3UgZHJhZnRlZCBhbmQgd2hhdCB3aWxsIGhhcHBlbiwgZW5kaW5nIGJ5IGFza2luZyB0aGVtIHRvIGNvbmZpcm0uJyxcbiAgICAgICAgfSxcbiAgICAgICAgY29uZmlybV9sYWJlbDoge1xuICAgICAgICAgIHR5cGU6ICdzdHJpbmcnLFxuICAgICAgICAgIGRlc2NyaXB0aW9uOiAnTGFiZWwgZm9yIHRoZSBjb25maXJtIGJ1dHRvbiwgZS5nLiBcIlNlbmRcIiwgXCJQb3N0XCIsIFwiUHVibGlzaFwiLCBcIlN1Ym1pdFwiLicsXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgcmVxdWlyZWQ6IFsnc3VtbWFyeSddLFxuICAgIH0sXG4gIH0sXG5dO1xuXG5jb25zdCBzbGVlcCA9IChtczogbnVtYmVyKSA9PiBuZXcgUHJvbWlzZSgocikgPT4gc2V0VGltZW91dChyLCBtcykpO1xuXG4vLyBPbmUtdGltZSBjbGVhbnVwIG9mIGtleXMgZnJvbSB0aGUgcHJldmlvdXMgcHJvdmlkZXIsIHNvIGEgc3RhbGUgY3JlZGVudGlhbFxuLy8gaXNuJ3QgbGVmdCBzaXR0aW5nIGluIHN0b3JhZ2Ug4oCUIGFuZCBjYW4gbmV2ZXIgYmUgc2VudCB0byBHcm9xLlxuYnJvd3Nlci5zdG9yYWdlLmxvY2FsLnJlbW92ZShbJ3RpZHJhQXBpS2V5JywgJ3RpZHJhUHJvdmlkZXInLCAndGlkcmFNY3AnXSkuY2F0Y2goKCkgPT4ge30pO1xuXG4vLyDilIDilIDilIAgVGhlIHVzZXIncyBwcm9maWxlIOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgOKUgFxuLy8gTGl2ZXMgb25seSBpbiBicm93c2VyLnN0b3JhZ2UubG9jYWwg4oCUIG5ldmVyIHVwbG9hZGVkLCBuZXZlciBzeW5jZWQuIEV2ZXJ5XG4vLyBmaWVsZCBpcyB0eXBlZCBieSB0aGUgdXNlciBpbiBzZXR0aW5nczsgVGlkcmEgbmV2ZXIgY29sbGVjdHMgYW55IG9mIGl0IG9uXG4vLyBpdHMgb3duLiBJdCBsZWF2ZXMgdGhlIGRldmljZSBvbmx5IGFzIHBhcnQgb2YgYSBwcm9tcHQgdGhlIHVzZXIgdHJpZ2dlcmVkLlxuXG5pbnRlcmZhY2UgUHJvZmlsZSB7XG4gIG5hbWU/OiBzdHJpbmc7XG4gIGVtYWlsPzogc3RyaW5nO1xuICByb2xlPzogc3RyaW5nO1xuICBjb21wYW55Pzogc3RyaW5nO1xuICBsb2NhdGlvbj86IHN0cmluZztcbiAgbGFuZ3VhZ2VzPzogc3RyaW5nO1xuICBhYm91dD86IHN0cmluZztcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0UHJvZmlsZSgpOiBQcm9taXNlPFByb2ZpbGU+IHtcbiAgY29uc3QgeyB0aWRyYVByb2ZpbGUgfSA9IGF3YWl0IGJyb3dzZXIuc3RvcmFnZS5sb2NhbC5nZXQoJ3RpZHJhUHJvZmlsZScpO1xuICByZXR1cm4gKHRpZHJhUHJvZmlsZSBhcyBQcm9maWxlIHwgdW5kZWZpbmVkKSA/PyB7fTtcbn1cblxuLy8gQXBwZW5kZWQgdG8gdGhlIHN5c3RlbSBwcm9tcHQgc28gZHJhZnRzIGFyZSBzaWduZWQgYW5kIHRvbmVkIGNvcnJlY3RseS5cbmFzeW5jIGZ1bmN0aW9uIHByb2ZpbGVQcmVhbWJsZSgpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBwID0gYXdhaXQgZ2V0UHJvZmlsZSgpO1xuICBjb25zdCBiaXRzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBhZGQgPSAobGFiZWw6IHN0cmluZywgdj86IHN0cmluZykgPT4ge1xuICAgIGlmICh2Py50cmltKCkpIGJpdHMucHVzaChgJHtsYWJlbH06ICR7di50cmltKCl9YCk7XG4gIH07XG4gIGFkZCgnTmFtZScsIHAubmFtZSk7XG4gIGFkZCgnRW1haWwnLCBwLmVtYWlsKTtcbiAgYWRkKCdSb2xlJywgcC5yb2xlKTtcbiAgYWRkKCdDb21wYW55JywgcC5jb21wYW55KTtcbiAgYWRkKCdMb2NhdGlvbicsIHAubG9jYXRpb24pO1xuICBhZGQoJ0xhbmd1YWdlcycsIHAubGFuZ3VhZ2VzKTtcbiAgYWRkKCdOb3RlcycsIHAuYWJvdXQpO1xuICBpZiAoIWJpdHMubGVuZ3RoKSByZXR1cm4gJyc7XG4gIHJldHVybiBgXFxuXFxuQWJvdXQgdGhlIHVzZXIgKGZyb20gdGhlaXIgb3duIHByb2ZpbGUg4oCUIHVzZSBpdCBmb3IgdGhlaXIgdm9pY2UsIHNpZ24tb2ZmcyBhbmQgdG9uZSk6XFxuJHtiaXRzLmpvaW4oJ1xcbicpfWA7XG59XG5cbmZ1bmN0aW9uIGV4dHJhY3RUZXh0KGNvbnRlbnQ6IENvbnRlbnRCbG9ja1tdKTogc3RyaW5nIHtcbiAgcmV0dXJuIGNvbnRlbnRcbiAgICAuZmlsdGVyKChiKTogYiBpcyBUZXh0QmxvY2sgPT4gYi50eXBlID09PSAndGV4dCcpXG4gICAgLm1hcCgoYikgPT4gYi50ZXh0KVxuICAgIC5qb2luKCdcXG4nKVxuICAgIC50cmltKCk7XG59XG5cbmludGVyZmFjZSBDaGF0TXNnIHtcbiAgcm9sZTogJ3VzZXInIHwgJ2Fzc2lzdGFudCcgfCAnZXJyb3InO1xuICB0ZXh0OiBzdHJpbmc7XG59XG5pbnRlcmZhY2UgQ2hhdFN0YXRlIHtcbiAgbWVzc2FnZXM6IENoYXRNc2dbXTtcbiAgbG9hZGluZzogYm9vbGVhbjtcbn1cblxuLy8g4pSA4pSA4pSAIFJvdXRpbmUgbGVhcm5pbmcg4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBMb2cgd2hpY2ggZG9tYWlucyB0aGUgdXNlciB2aXNpdHMgKGRvbWFpbiArIHRpbWUgb25seSDigJQgbm8gcGFnZSBjb250ZW50LCBub1xuLy8gZnVsbCBVUkxzKSwgZ3JvdXAgdGhlbSBpbnRvIHNlc3Npb25zLCBhbmQgd2hlbiBhIG5ldyBzZXNzaW9uIHN0YXJ0cyAoYnJvd3NlclxuLy8gcmVvcGVuZWQgLyBsb25nIGdhcCkgb2ZmZXIgdG8gcmVvcGVuIHRoZSByZWN1cnJpbmcgcm91dGluZS5cbmNvbnN0IFNFU1NJT05fR0FQID0gNCAqIDYwICogNjAgKiAxMDAwOyAvLyBhIG5ldyBcInNlc3Npb25cIiBhZnRlciA0aCBvZiBubyBhY3Rpdml0eVxuY29uc3QgTUFYX1ZJU0lUUyA9IDgwMDtcbmNvbnN0IFJPVVRJTkVfRklSU1QgPSA1OyAvLyBmaXJzdCBOIGRpc3RpbmN0IGRvbWFpbnMgb2YgZWFjaCBzZXNzaW9uXG5jb25zdCBST1VUSU5FX01JTl9TRVNTSU9OUyA9IDM7IC8vIG5lZWQgYXQgbGVhc3QgdGhpcyBtdWNoIGhpc3RvcnkgdG8gc3VnZ2VzdFxuY29uc3QgUk9VVElORV9GUkVRID0gMC41OyAvLyBkb21haW4gbXVzdCBhcHBlYXIgaW4g4omlNTAlIG9mIHBhc3Qgc2Vzc2lvbnNcblxuaW50ZXJmYWNlIFZpc2l0IHtcbiAgZDogc3RyaW5nO1xuICB0OiBudW1iZXI7XG59XG5cbmNvbnN0IEtOT1dOX05BTUVTOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge1xuICAnbWFpbC5nb29nbGUuY29tJzogJ0dtYWlsJyxcbiAgJ2NhbGVuZGFyLmdvb2dsZS5jb20nOiAnQ2FsZW5kYXInLFxuICAnZHJpdmUuZ29vZ2xlLmNvbSc6ICdEcml2ZScsXG4gICd3d3cubGlua2VkaW4uY29tJzogJ0xpbmtlZEluJyxcbiAgJ2xpbmtlZGluLmNvbSc6ICdMaW5rZWRJbicsXG4gICd3d3cueW91dHViZS5jb20nOiAnWW91VHViZScsXG4gICdnaXRodWIuY29tJzogJ0dpdEh1YicsXG4gICd4LmNvbSc6ICdYJyxcbiAgJ3R3aXR0ZXIuY29tJzogJ1gnLFxuICAnd2ViLndoYXRzYXBwLmNvbSc6ICdXaGF0c0FwcCcsXG4gICd3d3cuZmFjZWJvb2suY29tJzogJ0ZhY2Vib29rJyxcbiAgJ3d3dy5ub3Rpb24uc28nOiAnTm90aW9uJyxcbiAgJ2FwcC5zbGFjay5jb20nOiAnU2xhY2snLFxufTtcblxuZnVuY3Rpb24gcHJldHR5RG9tYWluKGQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChLTk9XTl9OQU1FU1tkXSkgcmV0dXJuIEtOT1dOX05BTUVTW2RdO1xuICBjb25zdCBwYXJ0cyA9IGQucmVwbGFjZSgvXnd3d1xcLi8sICcnKS5zcGxpdCgnLicpO1xuICBjb25zdCBuYW1lID0gcGFydHMubGVuZ3RoID49IDIgPyBwYXJ0c1twYXJ0cy5sZW5ndGggLSAyXSA6IGQ7XG4gIHJldHVybiBuYW1lLmNoYXJBdCgwKS50b1VwcGVyQ2FzZSgpICsgbmFtZS5zbGljZSgxKTtcbn1cblxuLy8gU3BsaXQgdGhlIHZpc2l0IGxvZyBpbnRvIHNlc3Npb25zIGFuZCByZWR1Y2UgZWFjaCB0byBpdHMgZmlyc3QgZGlzdGluY3QgZG9tYWlucy5cbmZ1bmN0aW9uIHNlc3Npb25TdGFydHModmlzaXRzOiBWaXNpdFtdKTogc3RyaW5nW11bXSB7XG4gIGNvbnN0IHNvcnRlZCA9IFsuLi52aXNpdHNdLnNvcnQoKGEsIGIpID0+IGEudCAtIGIudCk7XG4gIGNvbnN0IHNlc3Npb25zOiBzdHJpbmdbXVtdID0gW107XG4gIGxldCBjdXI6IFZpc2l0W10gPSBbXTtcbiAgbGV0IGxhc3RUID0gMDtcbiAgY29uc3QgZmx1c2ggPSAoKSA9PiB7XG4gICAgaWYgKCFjdXIubGVuZ3RoKSByZXR1cm47XG4gICAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGNvbnN0IGZpcnN0OiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgdiBvZiBjdXIpIHtcbiAgICAgIGlmICghc2Vlbi5oYXModi5kKSkge1xuICAgICAgICBzZWVuLmFkZCh2LmQpO1xuICAgICAgICBmaXJzdC5wdXNoKHYuZCk7XG4gICAgICAgIGlmIChmaXJzdC5sZW5ndGggPj0gUk9VVElORV9GSVJTVCkgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICAgIHNlc3Npb25zLnB1c2goZmlyc3QpO1xuICAgIGN1ciA9IFtdO1xuICB9O1xuICBmb3IgKGNvbnN0IHYgb2Ygc29ydGVkKSB7XG4gICAgaWYgKGxhc3RUICYmIHYudCAtIGxhc3RUID4gU0VTU0lPTl9HQVApIGZsdXNoKCk7XG4gICAgY3VyLnB1c2godik7XG4gICAgbGFzdFQgPSB2LnQ7XG4gIH1cbiAgZmx1c2goKTtcbiAgcmV0dXJuIHNlc3Npb25zO1xufVxuXG4vLyBGcm9tIGhpc3RvcnksIGZpbmQgdGhlIHJlY3VycmluZyBzdGFydC1vZi1zZXNzaW9uIHJvdXRpbmUgKG9yZGVyZWQgZG9tYWlucykuXG5mdW5jdGlvbiBkZXRlY3RSb3V0aW5lKHZpc2l0czogVmlzaXRbXSk6IHsgZG9tYWluOiBzdHJpbmc7IHVybDogc3RyaW5nIH1bXSB7XG4gIGNvbnN0IHNlc3Npb25zID0gc2Vzc2lvblN0YXJ0cyh2aXNpdHMpO1xuICBjb25zdCBwYXN0ID0gc2Vzc2lvbnMuc2xpY2UoMCwgLTEpLnNsaWNlKC0xMik7IC8vIGV4Y2x1ZGUgdGhlIGN1cnJlbnQgc2Vzc2lvblxuICBpZiAocGFzdC5sZW5ndGggPCBST1VUSU5FX01JTl9TRVNTSU9OUykgcmV0dXJuIFtdO1xuICBjb25zdCBjb3VudDogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9O1xuICBjb25zdCBwb3NTdW06IFJlY29yZDxzdHJpbmcsIG51bWJlcj4gPSB7fTtcbiAgZm9yIChjb25zdCBzIG9mIHBhc3QpIHtcbiAgICBzLmZvckVhY2goKGQsIGkpID0+IHtcbiAgICAgIGNvdW50W2RdID0gKGNvdW50W2RdIHx8IDApICsgMTtcbiAgICAgIHBvc1N1bVtkXSA9IChwb3NTdW1bZF0gfHwgMCkgKyBpO1xuICAgIH0pO1xuICB9XG4gIHJldHVybiBPYmplY3Qua2V5cyhjb3VudClcbiAgICAuZmlsdGVyKChkKSA9PiBjb3VudFtkXSAvIHBhc3QubGVuZ3RoID49IFJPVVRJTkVfRlJFUSlcbiAgICAuc29ydCgoYSwgYikgPT4gcG9zU3VtW2FdIC8gY291bnRbYV0gLSBwb3NTdW1bYl0gLyBjb3VudFtiXSlcbiAgICAuc2xpY2UoMCwgNSlcbiAgICAubWFwKChkKSA9PiAoeyBkb21haW46IHByZXR0eURvbWFpbihkKSwgdXJsOiAnaHR0cHM6Ly8nICsgZCB9KSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIGhhbmRsZVZpc2l0KGRvbWFpbjogc3RyaW5nKSB7XG4gIGNvbnN0IHN0b3JlID0gYXdhaXQgYnJvd3Nlci5zdG9yYWdlLmxvY2FsLmdldChbJ3RpZHJhVmlzaXRzJywgJ3RpZHJhUm91dGluZUVuYWJsZWQnXSk7XG4gIGlmIChzdG9yZS50aWRyYVJvdXRpbmVFbmFibGVkID09PSBmYWxzZSkgcmV0dXJuOyAvLyByb3V0aW5lIGxlYXJuaW5nIGlzIG9wdC1vdXRcbiAgY29uc3QgdmlzaXRzID0gKHN0b3JlLnRpZHJhVmlzaXRzIGFzIFZpc2l0W10pIHx8IFtdO1xuICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xuICBjb25zdCBsYXN0ID0gdmlzaXRzLmxlbmd0aCA/IHZpc2l0c1t2aXNpdHMubGVuZ3RoIC0gMV0gOiBudWxsO1xuICBpZiAobGFzdCAmJiBsYXN0LmQgPT09IGRvbWFpbiAmJiBub3cgLSBsYXN0LnQgPCAzMDAwMCkgcmV0dXJuOyAvLyBkZWR1cCBTUEEgcmVsb2Fkc1xuICBjb25zdCBnYXAgPSBsYXN0ID8gbm93IC0gbGFzdC50IDogSW5maW5pdHk7XG5cbiAgdmlzaXRzLnB1c2goeyBkOiBkb21haW4sIHQ6IG5vdyB9KTtcbiAgaWYgKHZpc2l0cy5sZW5ndGggPiBNQVhfVklTSVRTKSB2aXNpdHMuc3BsaWNlKDAsIHZpc2l0cy5sZW5ndGggLSBNQVhfVklTSVRTKTtcblxuICBjb25zdCBkYXRhOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiA9IHsgdGlkcmFWaXNpdHM6IHZpc2l0cyB9O1xuICAvLyBBIGZyZXNoIHNlc3Npb24ganVzdCBiZWdhbiDigJQgb2ZmZXIgdGhlIGxlYXJuZWQgcm91dGluZSAob25jZSBwZXIgc2Vzc2lvbikuXG4gIGlmIChnYXAgPiBTRVNTSU9OX0dBUCkge1xuICAgIGNvbnN0IHJvdXRpbmUgPSBkZXRlY3RSb3V0aW5lKHZpc2l0cyk7XG4gICAgaWYgKHJvdXRpbmUubGVuZ3RoID49IDIpIGRhdGEudGlkcmFSb3V0aW5lID0geyBzaXRlczogcm91dGluZSwgdHM6IG5vdyB9O1xuICB9XG4gIGF3YWl0IGJyb3dzZXIuc3RvcmFnZS5sb2NhbC5zZXQoZGF0YSk7XG59XG5cbi8vIFRoZSBpbi1mbGlnaHQgcmVxdWVzdCdzIGFib3J0IGNvbnRyb2xsZXIsIHNvIHRoZSBVSSdzIFN0b3AgYnV0dG9uIGNhbiBjYW5jZWwgaXQuXG5sZXQgY3VycmVudEFib3J0OiBBYm9ydENvbnRyb2xsZXIgfCBudWxsID0gbnVsbDtcblxuLy8gQ2xlYXIgdGhlIGxvYWRpbmcgZmxhZyAodXNlZCB3aGVuIHRoZSB1c2VyIHN0b3BzLCBvciBhIHJlcXVlc3QgaXMgYWJvcnRlZCkuXG5hc3luYyBmdW5jdGlvbiBjbGVhckxvYWRpbmcoKSB7XG4gIGNvbnN0IHsgdGlkcmFDaGF0IH0gPSBhd2FpdCBicm93c2VyLnN0b3JhZ2UubG9jYWwuZ2V0KCd0aWRyYUNoYXQnKTtcbiAgY29uc3QgY2hhdCA9ICh0aWRyYUNoYXQgYXMgQ2hhdFN0YXRlKSB8fCB7IG1lc3NhZ2VzOiBbXSwgbG9hZGluZzogZmFsc2UgfTtcbiAgY2hhdC5sb2FkaW5nID0gZmFsc2U7XG4gIGF3YWl0IGJyb3dzZXIuc3RvcmFnZS5sb2NhbC5zZXQoeyB0aWRyYUNoYXQ6IGNoYXQsIHRpZHJhUGVuZGluZzogbnVsbCB9KTtcbn1cblxuLy8gQXBwZW5kIGEgbWVzc2FnZSB0byB0aGUgcGVyc2lzdGVkIGNoYXQgYW5kIGNsZWFyIHRoZSBsb2FkaW5nIGZsYWcuXG4vLyBUaGUgaXNsYW5kIHJlbmRlcnMgZnJvbSBzdG9yYWdlLCBzbyB0aGlzIHN1cnZpdmVzIHBhZ2UgbmF2aWdhdGlvbi5cbi8vIEEgc2hvcnQgXCJ3aGF0IEknbSBkb2luZyByaWdodCBub3dcIiBsaW5lIGZvciB0aGUgY29sbGFwc2VkIGlzbGFuZCwgc28gdGhlXG4vLyB1c2VyIHNlZXMgcHJvZ3Jlc3Mgd2l0aG91dCBrZWVwaW5nIHRoZSBwYW5lbCBvcGVuLiBDbGVhcmVkIHdoZW4gdGhlIHR1cm4gZW5kcy5cbmZ1bmN0aW9uIHNldFN0YXR1cyh0ZXh0OiBzdHJpbmcgfCBudWxsKSB7XG4gIHJldHVybiBicm93c2VyLnN0b3JhZ2UubG9jYWwuc2V0KHsgdGlkcmFTdGF0dXM6IHRleHQgfSk7XG59XG5cbi8vIFNuYXBzaG90cyBhcmUgYmlnICh0aG91c2FuZHMgb2YgdG9rZW5zKSBhbmQgZ28gc3RhbGUgdGhlIG1vbWVudCB0aGUgcGFnZVxuLy8gY2hhbmdlcy4gS2VlcGluZyBldmVyeSBwYXN0IG9uZSBpbiBoaXN0b3J5IGNvc3RzIGEgZm9ydHVuZSBBTkQgYWN0aXZlbHkgaHVydHM6XG4vLyB0aGUgbW9kZWwgY2FuIHNlZSByZWZzIGZyb20gb2xkIHRyZWVzIGFuZCBjaXRlIG9uZSB0aGF0IG5vIGxvbmdlciBleGlzdHMuIFNvXG4vLyBvbmNlIGEgbmV3ZXIgc25hcHNob3QgZXhpc3RzLCBibGFuayBvdXQgdGhlIG9sZGVyIG9uZXMuXG4vL1xuLy8gV2hpY2ggcmVzdWx0cyB3ZXJlIHNuYXBzaG90cyBpcyB0cmFja2VkIGluIGEgU2V0IG9mIHRvb2xfdXNlIGlkcywgTk9UIGFzIGFcbi8vIGZpZWxkIG9uIHRoZSBibG9jayDigJQgYW55dGhpbmcgYWRkZWQgdG8gYSBibG9jayBpcyBzZW50IHRvIHRoZSBBUEkgdmVyYmF0aW0sXG4vLyBhbmQgYW4gdW5rbm93biBmaWVsZCBpcyBhIDQwMC5cbmNvbnN0IFNOQVBTSE9UX1RPT0xTID0gbmV3IFNldChbJ3NuYXBzaG90JywgJ2xpc3RfYWN0aW9ucycsICdvcGVuX3VybCcsICdnb19iYWNrJywgJ3NjcmVlbnNob3QnXSk7XG5cbmZ1bmN0aW9uIHBydW5lT2xkU25hcHNob3RzKG1lc3NhZ2VzOiBNZXNzYWdlW10sIHNuYXBzaG90SWRzOiBTZXQ8c3RyaW5nPikge1xuICBsZXQgc2Vlbk5ld2VzdCA9IGZhbHNlO1xuICBmb3IgKGxldCBpID0gbWVzc2FnZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICBjb25zdCBjb250ZW50ID0gbWVzc2FnZXNbaV0uY29udGVudDtcbiAgICBpZiAoIUFycmF5LmlzQXJyYXkoY29udGVudCkpIGNvbnRpbnVlO1xuICAgIGZvciAoY29uc3QgYmxvY2sgb2YgY29udGVudCkge1xuICAgICAgaWYgKGJsb2NrPy50eXBlICE9PSAndG9vbF9yZXN1bHQnIHx8ICFzbmFwc2hvdElkcy5oYXMoYmxvY2sudG9vbF91c2VfaWQpKSBjb250aW51ZTtcbiAgICAgIGlmICghc2Vlbk5ld2VzdCkge1xuICAgICAgICBzZWVuTmV3ZXN0ID0gdHJ1ZTsgLy8ga2VlcCB0aGUgbW9zdCByZWNlbnQgb25lIGludGFjdFxuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGJsb2NrLmNvbnRlbnQgPSAnW3N1cGVyc2VkZWQgc25hcHNob3QgcmVtb3ZlZCDigJQgdGFrZSBhIGZyZXNoIG9uZSBpZiB5b3UgbmVlZCByZWZzXSc7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHN0YXR1c0Zvcih0b29sOiBzdHJpbmcsIGlucHV0OiBhbnkpOiBzdHJpbmcge1xuICBzd2l0Y2ggKHRvb2wpIHtcbiAgICBjYXNlICdzbmFwc2hvdCc6XG4gICAgY2FzZSAnbGlzdF9hY3Rpb25zJzpcbiAgICAgIHJldHVybiAnTG9va2luZyBhdCB0aGUgcGFnZSc7XG4gICAgY2FzZSAnY2xpY2snOlxuICAgICAgcmV0dXJuICdDbGlja2luZyc7XG4gICAgY2FzZSAnZmlsbCc6XG4gICAgICByZXR1cm4gJ1dyaXRpbmcgdGhlIGRyYWZ0JztcbiAgICBjYXNlICdzZWxlY3QnOlxuICAgICAgcmV0dXJuICdDaG9vc2luZyBhbiBvcHRpb24nO1xuICAgIGNhc2UgJ3Njcm9sbCc6XG4gICAgICByZXR1cm4gJ1Njcm9sbGluZyc7XG4gICAgY2FzZSAnc2NyZWVuc2hvdCc6XG4gICAgICByZXR1cm4gJ1Rha2luZyBhIGxvb2snO1xuICAgIGNhc2UgJ29wZW5fdXJsJzoge1xuICAgICAgbGV0IGhvc3QgPSBTdHJpbmcoaW5wdXQ/LnVybCA/PyAnJyk7XG4gICAgICB0cnkge1xuICAgICAgICBob3N0ID0gbmV3IFVSTChob3N0KS5ob3N0bmFtZS5yZXBsYWNlKC9ed3d3XFwuLywgJycpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8qIGtlZXAgdGhlIHJhdyBzdHJpbmcgKi9cbiAgICAgIH1cbiAgICAgIHJldHVybiBgT3BlbmluZyAke2hvc3R9YDtcbiAgICB9XG4gICAgY2FzZSAnZ2V0X3BhZ2UnOlxuICAgICAgcmV0dXJuICdSZWFkaW5nIHRoZSBwYWdlJztcbiAgICBjYXNlICdsaXN0X2FjdGlvbnMnOlxuICAgICAgcmV0dXJuICdMb29raW5nIGF0IHdoYXRcXCdzIG9uIHRoZSBwYWdlJztcbiAgICBjYXNlICdjbGlja190ZXh0JzpcbiAgICAgIHJldHVybiBgQ2xpY2tpbmcg4oCcJHtTdHJpbmcoaW5wdXQ/LnRleHQgPz8gJycpLnNsaWNlKDAsIDMwKX3igJ1gO1xuICAgIGNhc2UgJ3R5cGVfdGV4dCc6XG4gICAgICByZXR1cm4gaW5wdXQ/LmZpZWxkID8gYEZpbGxpbmcgaW4gJHtTdHJpbmcoaW5wdXQuZmllbGQpLnNsaWNlKDAsIDI0KX1gIDogJ1dyaXRpbmcgdGhlIGRyYWZ0JztcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuICdXb3JraW5nJztcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBwdXNoQ2hhdCh0ZXh0OiBzdHJpbmcsIHJvbGU6ICdhc3Npc3RhbnQnIHwgJ2Vycm9yJykge1xuICBjb25zdCB7IHRpZHJhQ2hhdCB9ID0gYXdhaXQgYnJvd3Nlci5zdG9yYWdlLmxvY2FsLmdldCgndGlkcmFDaGF0Jyk7XG4gIGNvbnN0IGNoYXQgPSAodGlkcmFDaGF0IGFzIENoYXRTdGF0ZSkgfHwgeyBtZXNzYWdlczogW10sIGxvYWRpbmc6IGZhbHNlIH07XG4gIGNoYXQubWVzc2FnZXMucHVzaCh7IHJvbGUsIHRleHQgfSk7XG4gIGNoYXQubG9hZGluZyA9IGZhbHNlO1xuICAvLyBNYXJrIHVucmVhZCBzbyB0aGUgY29sbGFwc2VkIGlzbGFuZCBjYW4gc3VyZmFjZSB0aGUgbmV3IHJlc3VsdC5cbiAgYXdhaXQgYnJvd3Nlci5zdG9yYWdlLmxvY2FsLnNldCh7IHRpZHJhQ2hhdDogY2hhdCwgdGlkcmFVbnJlYWQ6IHRydWUsIHRpZHJhU3RhdHVzOiBudWxsIH0pO1xufVxuXG4vLyBDaGVhcCBIYWlrdSByb3V0ZXI6IGRlY2lkZSBcImFjdFwiIChuZWVkcyBicm93c2VyIHRvb2xzKSB2cyBcImNoYXRcIiAoYW5zd2VyXG4vLyBhYm91dCB0aGUgcGFnZSkuIFVzZXMgb25seSB0aGUgcHJvbXB0ICsgYSBsaXR0bGUgaGlzdG9yeSDigJQgbm8gcGFnZSB0ZXh0IOKAlFxuLy8gc28gaXQncyBhIGZldyBkb3plbiB0b2tlbnMuIEVycnMgdG93YXJkIFwiYWN0XCIgc28gY2FwYWJpbGl0eSBpc24ndCBsb3N0LlxuYXN5bmMgZnVuY3Rpb24gY2xhc3NpZnkoXG4gIGFwaUtleTogc3RyaW5nLFxuICByb3V0ZXJNb2RlbDogc3RyaW5nLFxuICBwcm9tcHQ6IHN0cmluZyxcbiAgaGlzdG9yeTogQ2hhdE1zZ1tdLFxuICBzaWduYWw/OiBBYm9ydFNpZ25hbCxcbik6IFByb21pc2U8J2NoYXQnIHwgJ2FjdCc+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZWNlbnQgPSBoaXN0b3J5XG4gICAgICAuc2xpY2UoLTQpXG4gICAgICAubWFwKChtKSA9PiBgJHttLnJvbGV9OiAke20udGV4dC5zbGljZSgwLCAyMDApfWApXG4gICAgICAuam9pbignXFxuJyk7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgY2FsbE1vZGVsKFxuICAgICAgYXBpS2V5LFxuICAgICAge1xuICAgICAgbW9kZWw6IHJvdXRlck1vZGVsLFxuICAgICAgbWF4X3Rva2VuczogNSxcbiAgICAgIHN5c3RlbTpcbiAgICAgICAgW1xuICAgICAgICAgICdSZXBseSB3aXRoIGV4YWN0bHkgb25lIHdvcmQ6IGFjdCBvciBjaGF0LicsXG4gICAgICAgICAgJycsXG4gICAgICAgICAgJ2FjdCDigJQgYW5zd2VyaW5nIG5lZWRzIHRoZSBicm93c2VyLiBUaGF0IGNvdmVycyBkb2luZyB0aGluZ3MgKG9wZW4sIGdvLCBzZWFyY2gsIGNsaWNrLCB0eXBlLCByZXBseSwgcG9zdCwgZmlsbCwgYnV5KSBBTkQgbG9va2luZyB0aGluZ3MgdXAgdGhhdCBvbmx5IGV4aXN0IGJlaGluZCBhIHdlYnNpdGUgb3IgdGhlIHVzZXJcXCdzIG93biBhY2NvdW50OiB0aGVpciBpbmJveCwgbWVzc2FnZXMsIG5vdGlmaWNhdGlvbnMsIG9yZGVycywgY2FsZW5kYXIsIHByb2ZpbGUsIGZlZWQsIG9yIGFueXRoaW5nIGN1cnJlbnQgb24gYSBzcGVjaWZpYyBzaXRlLicsXG4gICAgICAgICAgJycsXG4gICAgICAgICAgJ2NoYXQg4oCUIGNhbiBiZSBhbnN3ZXJlZCBmcm9tIGdlbmVyYWwga25vd2xlZGdlIGFsb25lLCBvciBpcyBhYm91dCB0ZXh0IGFscmVhZHkgaW4gdGhpcyBjb252ZXJzYXRpb24uJyxcbiAgICAgICAgICAnJyxcbiAgICAgICAgICAnQmVpbmcgcGhyYXNlZCBhcyBhIHF1ZXN0aW9uIGRvZXMgTk9UIG1ha2UgaXQgY2hhdC4gRXhhbXBsZXM6JyxcbiAgICAgICAgICAnXCJkbyBJIGhhdmUgbmV3IG1lc3NhZ2VzIG9uIExpbmtlZEluP1wiIC0+IGFjdCcsXG4gICAgICAgICAgJ1wid2hhdCBkaWQgTWFyY28gcmVwbHk/XCIgLT4gYWN0JyxcbiAgICAgICAgICAnXCJhbnkgbmV3IGVtYWlscz9cIiAtPiBhY3QnLFxuICAgICAgICAgICdcInN1bW1hcmlzZSB0aGlzIHBhZ2VcIiAtPiBhY3QnLFxuICAgICAgICAgICdcIndoYXQgaXMgdGhlIGNhcGl0YWwgb2YgQWxiYW5pYT9cIiAtPiBjaGF0JyxcbiAgICAgICAgICAnXCJyZXdyaXRlIHRoYXQgcGFyYWdyYXBoIG1vcmUgZm9ybWFsbHlcIiAtPiBjaGF0JyxcbiAgICAgICAgICAnJyxcbiAgICAgICAgICAnSWYgdW5zdXJlLCBhbnN3ZXIgYWN0LicsXG4gICAgICAgIF0uam9pbignXFxuJyksXG4gICAgICBtZXNzYWdlczogW1xuICAgICAgICB7XG4gICAgICAgICAgcm9sZTogJ3VzZXInLFxuICAgICAgICAgIGNvbnRlbnQ6IGAke3JlY2VudCA/IHJlY2VudCArICdcXG4nIDogJyd9UmVxdWVzdDogJHtwcm9tcHR9XFxuQW5zd2VyIChhY3Qgb3IgY2hhdCk6YCxcbiAgICAgICAgfSxcbiAgICAgIF0sXG4gICAgICB9LFxuICAgICAgc2lnbmFsLFxuICAgICk7XG4gICAgY29uc3QgdCA9IGV4dHJhY3RUZXh0KHJlcy5jb250ZW50KS50b0xvd2VyQ2FzZSgpO1xuICAgIHJldHVybiB0LmluY2x1ZGVzKCdjaGF0JykgPyAnY2hhdCcgOiAnYWN0JztcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuICdhY3QnOyAvLyBzYWZlIGRlZmF1bHQ6IGtlZXAgZnVsbCBjYXBhYmlsaXR5XG4gIH1cbn1cblxuZnVuY3Rpb24gd2FpdEZvclRhYkxvYWQodGFiSWQ6IG51bWJlciwgdGltZW91dE1zID0gMjAwMDApOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgbGV0IGRvbmUgPSBmYWxzZTtcbiAgICBjb25zdCBmaW5pc2ggPSAoKSA9PiB7XG4gICAgICBpZiAoZG9uZSkgcmV0dXJuO1xuICAgICAgZG9uZSA9IHRydWU7XG4gICAgICBicm93c2VyLnRhYnMub25VcGRhdGVkLnJlbW92ZUxpc3RlbmVyKGxpc3RlbmVyKTtcbiAgICAgIHJlc29sdmUoKTtcbiAgICB9O1xuICAgIGZ1bmN0aW9uIGxpc3RlbmVyKGlkOiBudW1iZXIsIGluZm86IHsgc3RhdHVzPzogc3RyaW5nIH0pIHtcbiAgICAgIGlmIChpZCA9PT0gdGFiSWQgJiYgaW5mby5zdGF0dXMgPT09ICdjb21wbGV0ZScpIGZpbmlzaCgpO1xuICAgIH1cbiAgICBicm93c2VyLnRhYnMub25VcGRhdGVkLmFkZExpc3RlbmVyKGxpc3RlbmVyKTtcbiAgICBicm93c2VyLnRhYnNcbiAgICAgIC5nZXQodGFiSWQpXG4gICAgICAudGhlbigodCkgPT4ge1xuICAgICAgICBpZiAodC5zdGF0dXMgPT09ICdjb21wbGV0ZScpIGZpbmlzaCgpO1xuICAgICAgfSlcbiAgICAgIC5jYXRjaCgoKSA9PiB7fSk7XG4gICAgc2V0VGltZW91dChmaW5pc2gsIHRpbWVvdXRNcyk7XG4gIH0pO1xufVxuXG4vLyBTZW5kIGFuIGFjdGlvbiB0byBhIHRhYidzIGNvbnRlbnQgc2NyaXB0LCByZXRyeWluZyB1bnRpbCBpdCdzIHJlYWR5LlxuYXN5bmMgZnVuY3Rpb24gc2VuZEFjdGlvbihcbiAgdGFiSWQ6IG51bWJlcixcbiAgcGF5bG9hZDogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4gIHJldHJpZXMgPSAxMCxcbiAgZnJhbWVJZCA9IDAsXG4pOiBQcm9taXNlPGFueT4ge1xuICBmb3IgKGxldCBpID0gMDsgaSA8IHJldHJpZXM7IGkrKykge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gYXdhaXQgYnJvd3Nlci50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCBwYXlsb2FkLCB7IGZyYW1lSWQgfSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICBhd2FpdCBzbGVlcCgzNTApO1xuICAgIH1cbiAgfVxuICB0aHJvdyBuZXcgRXJyb3IoJ1BhZ2Ugbm90IHJlYWNoYWJsZSAoY29udGVudCBzY3JpcHQgbm90IHJlYWR5KS4nKTtcbn1cblxuLy8gUmVmcyBhcmUgcGVyLWZyYW1lLCBzbyB0aGUgbW9kZWwgc2VlcyB0aGVtIG5hbWVzcGFjZWQ6IFwicmVmXzAtMTJcIiBpcyByZWZfMTJcbi8vIGluIHRoZSB0b3AgZnJhbWUsIFwicmVmXzctM1wiIGlzIHJlZl8zIGluc2lkZSBmcmFtZSA3LiBTcGxpdHRpbmcgaGVyZSBrZWVwcyB0aGVcbi8vIGNvbnRlbnQgc2NyaXB0IGZyYW1lLWFnbm9zdGljIOKAlCBpdCBuZXZlciBoYXMgdG8ga25vdyBpdHMgb3duIGlkLlxuZnVuY3Rpb24gcGFyc2VSZWYocmVmOiBzdHJpbmcpOiB7IGZyYW1lSWQ6IG51bWJlcjsgbG9jYWw6IHN0cmluZyB9IHtcbiAgY29uc3QgbSA9IC9ecmVmXyhcXGQrKS0oXFxkKykkLy5leGVjKFN0cmluZyhyZWYgfHwgJycpLnRyaW0oKSk7XG4gIGlmICghbSkgcmV0dXJuIHsgZnJhbWVJZDogMCwgbG9jYWw6IFN0cmluZyhyZWYgfHwgJycpLnRyaW0oKSB9O1xuICByZXR1cm4geyBmcmFtZUlkOiBOdW1iZXIobVsxXSksIGxvY2FsOiBgcmVmXyR7bVsyXX1gIH07XG59XG5cbi8vIE9uZSBzbmFwc2hvdCBwZXIgZnJhbWUsIGNvbmNhdGVuYXRlZC4gQ3Jvc3Mtb3JpZ2luIGlmcmFtZXMgYXJlIHNlcGFyYXRlXG4vLyBjb250ZW50LXNjcmlwdCBpbnN0YW5jZXMsIHNvIHRoaXMgaXMgdGhlIG9ubHkgd2F5IHRvIHNlZSBpbnNpZGUgdGhlbS5cbmFzeW5jIGZ1bmN0aW9uIHNuYXBzaG90QWxsRnJhbWVzKHRhYklkOiBudW1iZXIpOiBQcm9taXNlPHN0cmluZz4ge1xuICBsZXQgZnJhbWVzOiB7IGZyYW1lSWQ6IG51bWJlcjsgdXJsOiBzdHJpbmcgfVtdID0gW107XG4gIHRyeSB7XG4gICAgZnJhbWVzID0gKChhd2FpdCBicm93c2VyLndlYk5hdmlnYXRpb24uZ2V0QWxsRnJhbWVzKHsgdGFiSWQgfSkpID8/IFtdKSBhcyB0eXBlb2YgZnJhbWVzO1xuICB9IGNhdGNoIHtcbiAgICBmcmFtZXMgPSBbeyBmcmFtZUlkOiAwLCB1cmw6ICcnIH1dO1xuICB9XG4gIGlmICghZnJhbWVzLmxlbmd0aCkgZnJhbWVzID0gW3sgZnJhbWVJZDogMCwgdXJsOiAnJyB9XTtcblxuICBjb25zdCBwYXJ0czogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBmIG9mIGZyYW1lcy5zbGljZSgwLCAxMikpIHtcbiAgICBsZXQgcmVzOiBhbnk7XG4gICAgdHJ5IHtcbiAgICAgIC8vIFN1Yi1mcmFtZXMgbWF5IGhhdmUgbm8gY29udGVudCBzY3JpcHQgKGFib3V0OmJsYW5rLCBzYW5kYm94ZWQpOyBza2lwXG4gICAgICAvLyB0aGVtIHF1aWV0bHkgcmF0aGVyIHRoYW4gc3RhbGxpbmcgdGhlIHdob2xlIHNuYXBzaG90IG9uIHJldHJpZXMuXG4gICAgICByZXMgPSBhd2FpdCBzZW5kQWN0aW9uKHRhYklkLCB7IHR5cGU6ICd0aWRyYS1hY3Rpb24nLCBhY3Rpb246ICdzbmFwc2hvdCcgfSwgZi5mcmFtZUlkID09PSAwID8gMTAgOiAxLCBmLmZyYW1lSWQpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGRhdGEgPSByZXM/LmRhdGEgYXMgeyB0cmVlOiBzdHJpbmc7IHVybDogc3RyaW5nOyB0aXRsZTogc3RyaW5nOyB0cnVuY2F0ZWQ6IGJvb2xlYW4gfSB8IHVuZGVmaW5lZDtcbiAgICBpZiAoIWRhdGE/LnRyZWUpIGNvbnRpbnVlO1xuICAgIC8vIE5hbWVzcGFjZSB0aGlzIGZyYW1lJ3MgcmVmcy5cbiAgICBjb25zdCB0cmVlID0gZGF0YS50cmVlLnJlcGxhY2UoL1xcW3JlZl8oXFxkKylcXF0vZywgYFtyZWZfJHtmLmZyYW1lSWR9LSQxXWApO1xuICAgIGNvbnN0IGhlYWQgPVxuICAgICAgZi5mcmFtZUlkID09PSAwXG4gICAgICAgID8gYFBBR0U6ICR7ZGF0YS50aXRsZX0g4oCUICR7ZGF0YS51cmx9YFxuICAgICAgICA6IGBcXG5GUkFNRSAke2YuZnJhbWVJZH06ICR7Zi51cmx9YDtcbiAgICBwYXJ0cy5wdXNoKGAke2hlYWR9XFxuJHt0cmVlfSR7ZGF0YS50cnVuY2F0ZWQgPyAnXFxuKOKApiB0cnVuY2F0ZWQg4oCUIHNjcm9sbCBvciBuYXJyb3cgdGhlIHRhc2spJyA6ICcnfWApO1xuICB9XG4gIHJldHVybiBwYXJ0cy5qb2luKCdcXG4nKSB8fCAnTm90aGluZyBpbnRlcmFjdGl2ZSBmb3VuZCBvbiB0aGlzIHBhZ2UuJztcbn1cblxuLy8gVmlzaW9uIGZhbGxiYWNrOiBvbmx5IHdoZW4gdGhlIHRyZWUgaXNuJ3QgZW5vdWdoLiBSZXF1aXJlcyB0aGUgdGFiIHRvIGJlIHRoZVxuLy8gdmlzaWJsZSBvbmUgaW4gaXRzIHdpbmRvdywgd2hpY2ggaXMgd2h5IHJvdXRpbmUgdGFicyBjYW4ndCB1c2UgaXQuXG5hc3luYyBmdW5jdGlvbiBjYXB0dXJlVGFiKHRhYklkOiBudW1iZXIpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCB0YWIgPSBhd2FpdCBicm93c2VyLnRhYnMuZ2V0KHRhYklkKTtcbiAgaWYgKCF0YWIuYWN0aXZlKSB0aHJvdyBuZXcgRXJyb3IoJ1NjcmVlbnNob3RzIG9ubHkgd29yayBvbiB0aGUgdGFiIGluIGZyb250LicpO1xuICBjb25zdCBkYXRhVXJsID0gYXdhaXQgYnJvd3Nlci50YWJzLmNhcHR1cmVWaXNpYmxlVGFiKHRhYi53aW5kb3dJZCEsIHsgZm9ybWF0OiAnanBlZycsIHF1YWxpdHk6IDYwIH0pO1xuICByZXR1cm4gZGF0YVVybC5yZXBsYWNlKC9eZGF0YTppbWFnZVxcL2pwZWc7YmFzZTY0LC8sICcnKTtcbn1cblxudHlwZSBUb29sQ29udGVudCA9IHN0cmluZyB8IChUZXh0QmxvY2sgfCBJbWFnZUJsb2NrKVtdO1xuXG5hc3luYyBmdW5jdGlvbiBleGVjVG9vbChcbiAgbmFtZTogc3RyaW5nLFxuICBpbnB1dDogYW55LFxuICB0YWJTdGF0ZTogVGFiU3RhdGUsXG4gIC8vIFByZXNzaW5nIEVudGVyIGluIGEgY29tcG9zZXIgc2VuZHMuIFRoYXQgaXMgaXJyZXZlcnNpYmxlLCBzbyBpdCBpcyBnYXRlZCBpblxuICAvLyBjb2RlIGhlcmUg4oCUIG5vdCBsZWZ0IHRvIHRoZSBtb2RlbCByZW1lbWJlcmluZyBhIHJ1bGUgaW4gdGhlIHByb21wdC5cbiAgYWxsb3dTdWJtaXQgPSBmYWxzZSxcbik6IFByb21pc2U8eyBjb250ZW50OiBUb29sQ29udGVudDsgaXNFcnJvcjogYm9vbGVhbiB9PiB7XG4gIGlmICgobmFtZSA9PT0gJ2ZpbGwnIHx8IG5hbWUgPT09ICd0eXBlX3RleHQnKSAmJiBpbnB1dD8uc3VibWl0ICYmICFhbGxvd1N1Ym1pdCkge1xuICAgIHJldHVybiB7XG4gICAgICBjb250ZW50OlxuICAgICAgICAnUmVmdXNlZDogc3VibWl0PXRydWUgd291bGQgc2VuZC9wb3N0IHRoaXMsIHdoaWNoIGlzIGlycmV2ZXJzaWJsZS4gQ2FsbCBjb25maXJtX2FjdGlvbiBmaXJzdCBhbmQgd2FpdCBmb3IgdGhlIHVzZXIuIElmIHRoZXkgY29uZmlybSwgeW91IG1heSBzdWJtaXQuJyxcbiAgICAgIGlzRXJyb3I6IHRydWUsXG4gICAgfTtcbiAgfVxuICB0cnkge1xuICAgIGlmIChuYW1lID09PSAnb3Blbl91cmwnKSB7XG4gICAgICBsZXQgdXJsOiBzdHJpbmcgPSBTdHJpbmcoaW5wdXQudXJsIHx8ICcnKTtcbiAgICAgIGlmICghL15odHRwcz86XFwvXFwvL2kudGVzdCh1cmwpKSB1cmwgPSAnaHR0cHM6Ly8nICsgdXJsO1xuICAgICAgaWYgKGlucHV0Lm5ld190YWIpIHtcbiAgICAgICAgY29uc3QgdGFiID0gYXdhaXQgYnJvd3Nlci50YWJzLmNyZWF0ZSh7IHVybCwgYWN0aXZlOiB0cnVlIH0pO1xuICAgICAgICB0YWJTdGF0ZS50YWJJZCA9IHRhYi5pZDsgLy8gc3Vic2VxdWVudCBhY3Rpb25zIHRhcmdldCB0aGUgbmV3IHRhYlxuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKHRhYlN0YXRlLnRhYklkID09IG51bGwpIHJldHVybiB7IGNvbnRlbnQ6ICdObyBhY3RpdmUgdGFiLicsIGlzRXJyb3I6IHRydWUgfTtcbiAgICAgICAgYXdhaXQgYnJvd3Nlci50YWJzLnVwZGF0ZSh0YWJTdGF0ZS50YWJJZCwgeyB1cmwgfSk7XG4gICAgICB9XG4gICAgICBpZiAodGFiU3RhdGUudGFiSWQgPT0gbnVsbCkgcmV0dXJuIHsgY29udGVudDogJ0NvdWxkIG5vdCBvcGVuIHRhYi4nLCBpc0Vycm9yOiB0cnVlIH07XG4gICAgICBhd2FpdCB3YWl0Rm9yVGFiTG9hZCh0YWJTdGF0ZS50YWJJZCk7XG4gICAgICBhd2FpdCBzbGVlcCg0MDApO1xuICAgICAgY29uc3QgdHJlZSA9IGF3YWl0IHNuYXBzaG90QWxsRnJhbWVzKHRhYlN0YXRlLnRhYklkKTtcbiAgICAgIHJldHVybiB7IGNvbnRlbnQ6IGBPcGVuZWQgJHt1cmx9JHtpbnB1dC5uZXdfdGFiID8gJyAobmV3IHRhYiknIDogJyd9XFxuXFxuJHt0cmVlfWAsIGlzRXJyb3I6IGZhbHNlIH07XG4gICAgfVxuXG4gICAgaWYgKHRhYlN0YXRlLnRhYklkID09IG51bGwpIHJldHVybiB7IGNvbnRlbnQ6ICdObyB3b3JraW5nIHRhYi4nLCBpc0Vycm9yOiB0cnVlIH07XG5cbiAgICAvLyBFeHRlbnNpb24gcGFnZXMgKHRoZSBuZXcgdGFiLCBvcHRpb25zKSBhbmQgYWJvdXQ6IHBhZ2VzIHJ1biBubyBjb250ZW50XG4gICAgLy8gc2NyaXB0LCBzbyBub3RoaW5nIGNhbiBiZSByZWFkIG9yIGNsaWNrZWQgdGhlcmUuIFNheSBzbyBpbW1lZGlhdGVseVxuICAgIC8vIGluc3RlYWQgb2YgcmV0cnlpbmcgYSBtZXNzYWdlIHRoYXQgY2FuIG5ldmVyIGJlIGRlbGl2ZXJlZC5cbiAgICBjb25zdCBjdXJyZW50ID0gYXdhaXQgYnJvd3Nlci50YWJzLmdldCh0YWJTdGF0ZS50YWJJZCkuY2F0Y2goKCkgPT4gbnVsbCk7XG4gICAgaWYgKGN1cnJlbnQ/LnVybCAmJiAhL15odHRwcz86L2kudGVzdChjdXJyZW50LnVybCkpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvbnRlbnQ6ICdUaGVyZSBpcyBubyB3ZWIgcGFnZSBvcGVuIGluIHRoaXMgdGFiIHlldC4gQ2FsbCBvcGVuX3VybCBmaXJzdCB0byBnbyB0byB0aGUgc2l0ZS4nLFxuICAgICAgICBpc0Vycm9yOiB0cnVlLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAobmFtZSA9PT0gJ2dldF9wYWdlJykge1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgc2VuZEFjdGlvbih0YWJTdGF0ZS50YWJJZCwgeyB0eXBlOiAndGlkcmEtYWN0aW9uJywgYWN0aW9uOiAnZ2V0X3BhZ2UnIH0pO1xuICAgICAgY29uc3QgcGFnZSA9IHJlcz8uZGF0YSBhcyBQYWdlQ29udGV4dDtcbiAgICAgIHJldHVybiB7IGNvbnRlbnQ6IGBUaXRsZTogJHtwYWdlPy50aXRsZX1cXG5VUkw6ICR7cGFnZT8udXJsfVxcblxcbiR7KHBhZ2U/LnRleHQgfHwgJycpLnNsaWNlKDAsIDYwMDApfWAsIGlzRXJyb3I6IGZhbHNlIH07XG4gICAgfVxuICAgIGlmIChuYW1lID09PSAnZ29fYmFjaycpIHtcbiAgICAgIGF3YWl0IGJyb3dzZXIudGFicy5nb0JhY2sodGFiU3RhdGUudGFiSWQpO1xuICAgICAgYXdhaXQgd2FpdEZvclRhYkxvYWQodGFiU3RhdGUudGFiSWQpO1xuICAgICAgYXdhaXQgc2xlZXAoNDAwKTtcbiAgICAgIHJldHVybiB7IGNvbnRlbnQ6IGBXZW50IGJhY2suXFxuXFxuJHthd2FpdCBzbmFwc2hvdEFsbEZyYW1lcyh0YWJTdGF0ZS50YWJJZCl9YCwgaXNFcnJvcjogZmFsc2UgfTtcbiAgICB9XG5cbiAgICBpZiAobmFtZSA9PT0gJ3NuYXBzaG90JyB8fCBuYW1lID09PSAnbGlzdF9hY3Rpb25zJykge1xuICAgICAgcmV0dXJuIHsgY29udGVudDogYXdhaXQgc25hcHNob3RBbGxGcmFtZXModGFiU3RhdGUudGFiSWQpLCBpc0Vycm9yOiBmYWxzZSB9O1xuICAgIH1cblxuICAgIGlmIChuYW1lID09PSAnc2NyZWVuc2hvdCcpIHtcbiAgICAgIGNvbnN0IGI2NCA9IGF3YWl0IGNhcHR1cmVUYWIodGFiU3RhdGUudGFiSWQpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29udGVudDogW1xuICAgICAgICAgIHsgdHlwZTogJ3RleHQnLCB0ZXh0OiAnU2NyZWVuc2hvdCBvZiB0aGUgdmlzaWJsZSBwYXJ0IG9mIHRoZSBwYWdlOicgfSxcbiAgICAgICAgICB7IHR5cGU6ICdpbWFnZScsIHNvdXJjZTogeyB0eXBlOiAnYmFzZTY0JywgbWVkaWFfdHlwZTogJ2ltYWdlL2pwZWcnLCBkYXRhOiBiNjQgfSB9LFxuICAgICAgICBdLFxuICAgICAgICBpc0Vycm9yOiBmYWxzZSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gUmVmLWJhc2VkIGFjdGlvbnMg4oCUIHRoZSBwcmltYXJ5IHBhdGguXG4gICAgaWYgKG5hbWUgPT09ICdjbGljaycgfHwgbmFtZSA9PT0gJ2ZpbGwnIHx8IG5hbWUgPT09ICdzZWxlY3QnIHx8IG5hbWUgPT09ICdzY3JvbGwnKSB7XG4gICAgICBjb25zdCB7IGZyYW1lSWQsIGxvY2FsIH0gPSBwYXJzZVJlZihpbnB1dC5yZWYgPz8gJycpO1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgc2VuZEFjdGlvbihcbiAgICAgICAgdGFiU3RhdGUudGFiSWQsXG4gICAgICAgIHtcbiAgICAgICAgICB0eXBlOiAndGlkcmEtYWN0aW9uJyxcbiAgICAgICAgICBhY3Rpb246IG5hbWUsXG4gICAgICAgICAgcmVmOiBpbnB1dC5yZWYgPyBsb2NhbCA6IHVuZGVmaW5lZCxcbiAgICAgICAgICB0ZXh0OiBpbnB1dC50ZXh0LFxuICAgICAgICAgIG9wdGlvbjogaW5wdXQub3B0aW9uLFxuICAgICAgICAgIHN1Ym1pdDogISFpbnB1dC5zdWJtaXQsXG4gICAgICAgICAgZGlyZWN0aW9uOiBpbnB1dC5kaXJlY3Rpb24sXG4gICAgICAgICAgYW1vdW50OiBpbnB1dC5hbW91bnQsXG4gICAgICAgIH0sXG4gICAgICAgIDEwLFxuICAgICAgICBpbnB1dC5yZWYgPyBmcmFtZUlkIDogMCxcbiAgICAgICk7XG4gICAgICByZXR1cm4geyBjb250ZW50OiByZXM/Lm9rID8gcmVzLmRhdGEgOiByZXM/LmVycm9yLCBpc0Vycm9yOiAhcmVzPy5vayB9O1xuICAgIH1cbiAgICBpZiAobmFtZSA9PT0gJ2NsaWNrX3RleHQnKSB7XG4gICAgICBjb25zdCByZXMgPSBhd2FpdCBzZW5kQWN0aW9uKHRhYlN0YXRlLnRhYklkLCB7IHR5cGU6ICd0aWRyYS1hY3Rpb24nLCBhY3Rpb246ICdjbGlja190ZXh0JywgdGV4dDogaW5wdXQudGV4dCB9KTtcbiAgICAgIHJldHVybiB7IGNvbnRlbnQ6IHJlcz8ub2sgPyByZXMuZGF0YSA6IHJlcz8uZXJyb3IsIGlzRXJyb3I6ICFyZXM/Lm9rIH07XG4gICAgfVxuICAgIGlmIChuYW1lID09PSAndHlwZV90ZXh0Jykge1xuICAgICAgY29uc3QgcmVzID0gYXdhaXQgc2VuZEFjdGlvbih0YWJTdGF0ZS50YWJJZCwge1xuICAgICAgICB0eXBlOiAndGlkcmEtYWN0aW9uJyxcbiAgICAgICAgYWN0aW9uOiAndHlwZV90ZXh0JyxcbiAgICAgICAgdGV4dDogaW5wdXQudGV4dCxcbiAgICAgICAgZmllbGQ6IGlucHV0LmZpZWxkLFxuICAgICAgICBzdWJtaXQ6ICEhaW5wdXQuc3VibWl0LFxuICAgICAgfSk7XG4gICAgICByZXR1cm4geyBjb250ZW50OiByZXM/Lm9rID8gcmVzLmRhdGEgOiByZXM/LmVycm9yLCBpc0Vycm9yOiAhcmVzPy5vayB9O1xuICAgIH1cbiAgICByZXR1cm4geyBjb250ZW50OiBgVW5rbm93biB0b29sOiAke25hbWV9YCwgaXNFcnJvcjogdHJ1ZSB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICByZXR1cm4geyBjb250ZW50OiBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVyciksIGlzRXJyb3I6IHRydWUgfTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBoYW5kbGVBc2sobWVzc2FnZTogQXNrUmVxdWVzdCwgc2VuZGVyVGFiSWQ6IG51bWJlciB8IHVuZGVmaW5lZCkge1xuICBjb25zdCBzZXR1cCA9IGF3YWl0IG1vZGVsU2V0dXAoKTtcbiAgaWYgKCFzZXR1cCkge1xuICAgIGF3YWl0IHB1c2hDaGF0KCdObyBBUEkga2V5IHNldC4gT3BlbiBzZXR0aW5ncyBhbmQgYWRkIGEga2V5IGZvciB5b3VyIGNob3NlbiBwcm92aWRlci4nLCAnZXJyb3InKTtcbiAgICByZXR1cm47XG4gIH1cbiAgY29uc3QgeyBhcGlLZXksIHRpZXIgfSA9IHNldHVwO1xuXG4gIC8vIEJ1aWxkIGNvbnZlcnNhdGlvbiBtZW1vcnkgZnJvbSBwZXJzaXN0ZWQgY2hhdCBzbyBtdWx0aS10dXJuIGZsb3dzIHdvcmtcbiAgLy8gKGUuZy4gVGlkcmEgZHJhZnRzIGFuIGVtYWlsLCB1c2VyIGxhdGVyIHNheXMgXCJ5ZXMsIHNlbmQgaXRcIikuXG4gIGNvbnN0IHsgdGlkcmFDaGF0IH0gPSBhd2FpdCBicm93c2VyLnN0b3JhZ2UubG9jYWwuZ2V0KCd0aWRyYUNoYXQnKTtcbiAgY29uc3QgaGlzdG9yeSA9ICgodGlkcmFDaGF0IGFzIENoYXRTdGF0ZSB8IHVuZGVmaW5lZCk/Lm1lc3NhZ2VzID8/IFtdKS5maWx0ZXIoXG4gICAgKG0pID0+IG0ucm9sZSAhPT0gJ2Vycm9yJyxcbiAgKTtcblxuICBjb25zdCBtZXNzYWdlczogTWVzc2FnZVtdID0gW107XG4gIGhpc3RvcnkuZm9yRWFjaCgobSwgaSkgPT4ge1xuICAgIGNvbnN0IGlzTGFzdFVzZXIgPSBpID09PSBoaXN0b3J5Lmxlbmd0aCAtIDEgJiYgbS5yb2xlID09PSAndXNlcic7XG4gICAgaWYgKGlzTGFzdFVzZXIpIHtcbiAgICAgIG1lc3NhZ2VzLnB1c2goe1xuICAgICAgICByb2xlOiAndXNlcicsXG4gICAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgICBgQ3VycmVudCBwYWdlOmAsXG4gICAgICAgICAgYFRpdGxlOiAke21lc3NhZ2UucGFnZS50aXRsZX1gLFxuICAgICAgICAgIGBVUkw6ICR7bWVzc2FnZS5wYWdlLnVybH1gLFxuICAgICAgICAgIGBgLFxuICAgICAgICAgIGBQYWdlIGNvbnRlbnQgKHRydW5jYXRlZCk6YCxcbiAgICAgICAgICBtZXNzYWdlLnBhZ2UudGV4dCxcbiAgICAgICAgICBgYCxcbiAgICAgICAgICBgLS0tYCxcbiAgICAgICAgICBgVXNlciByZXF1ZXN0OiAke20udGV4dH1gLFxuICAgICAgICBdLmpvaW4oJ1xcbicpLFxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIG1lc3NhZ2VzLnB1c2goeyByb2xlOiBtLnJvbGUgYXMgJ3VzZXInIHwgJ2Fzc2lzdGFudCcsIGNvbnRlbnQ6IG0udGV4dCB9KTtcbiAgICB9XG4gIH0pO1xuICAvLyBTYWZldHkgbmV0OiBpZiBoaXN0b3J5IHdhcyBlbXB0eSBmb3Igc29tZSByZWFzb24sIHVzZSB0aGUgaW5jb21pbmcgcHJvbXB0LlxuICBpZiAobWVzc2FnZXMubGVuZ3RoID09PSAwKSB7XG4gICAgbWVzc2FnZXMucHVzaCh7IHJvbGU6ICd1c2VyJywgY29udGVudDogbWVzc2FnZS5wcm9tcHQgfSk7XG4gIH1cblxuICBjb25zdCB0YWJTdGF0ZTogVGFiU3RhdGUgPSB7IHRhYklkOiBzZW5kZXJUYWJJZCB9O1xuICAvLyBUaGUgaXNsYW5kIHNlbmRzIFwiQ29uZmlybWVkIOKAlCDigKZcIiBhZnRlciB0aGUgdXNlciBwcmVzc2VzIHRoZSBjb25maXJtIGJ1dHRvbi5cbiAgLy8gT25seSB0aGVuIG1heSB0aGlzIHR1cm4gc3VibWl0IGFueXRoaW5nLlxuICBjb25zdCB1c2VyQ29uZmlybWVkID0gL15Db25maXJtZWRcXHMr4oCULy50ZXN0KG1lc3NhZ2UucHJvbXB0LnRyaW0oKSk7XG4gIC8vIEF1dG8gbW9kZTogdGhlIHVzZXIgaGFzIHNhaWQsIHVwIGZyb250LCB0byBnbyBhaGVhZCB3aXRob3V0IGFza2luZyBlYWNoXG4gIC8vIHRpbWUuIE1hbnVhbCAodGhlIGRlZmF1bHQpIHN0b3BzIGF0IGV2ZXJ5IGlycmV2ZXJzaWJsZSBzdGVwLlxuICBjb25zdCB7IHRpZHJhQXV0byB9ID0gYXdhaXQgYnJvd3Nlci5zdG9yYWdlLmxvY2FsLmdldCgndGlkcmFBdXRvJyk7XG4gIGNvbnN0IGF1dG9Nb2RlID0gdGlkcmFBdXRvID09PSB0cnVlO1xuICBjb25zdCBtYXlBY3QgPSB1c2VyQ29uZmlybWVkIHx8IGF1dG9Nb2RlO1xuXG4gIC8vIENhbmNlbGxhdGlvbjogdGhlIFVJJ3MgU3RvcCBidXR0b24gYWJvcnRzIHRoZSBpbi1mbGlnaHQgcmVxdWVzdCB2aWEgYGN1cnJlbnRBYm9ydGAuXG4gIGN1cnJlbnRBYm9ydD8uYWJvcnQoKTtcbiAgY29uc3QgYWJvcnQgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7XG4gIGN1cnJlbnRBYm9ydCA9IGFib3J0O1xuICBjb25zdCByZXFPcHRzID0geyBzaWduYWw6IGFib3J0LnNpZ25hbCB9O1xuXG4gIHRyeSB7XG4gIC8vIERlY2lkZSByb3V0ZTogZXhwbGljaXQgaGludCAocXVpY2sgYWN0aW9ucykgb3IgdGhlIGNoZWFwIEhhaWt1IHJvdXRlci5cbiAgY29uc3Qgcm91dGU6ICdjaGF0JyB8ICdhY3QnID1cbiAgICBtZXNzYWdlLmludGVudCA/PyAoYXdhaXQgY2xhc3NpZnkoYXBpS2V5LCB0aWVyLnJvdXRlciwgbWVzc2FnZS5wcm9tcHQsIGhpc3RvcnksIGFib3J0LnNpZ25hbCkpO1xuXG4gIC8vIENoYXQg4oaSIGNoZWFwIG1vZGVsLCBubyB0b29scy4gQWN0IOKGkiBzdHJvbmdlciBtb2RlbCB3aXRoIHRoZSBicm93c2VyIHRvb2xzLlxuICBjb25zdCBhY3RNb2RlbCA9IHJvdXRlID09PSAnYWN0JyA/IHRpZXIuYWN0IDogdGllci5jaGF0O1xuICAvLyBUaGUgdmlzaW9uIGZhbGxiYWNrIGlzIG9ubHkgb2ZmZXJlZCB0byBtb2RlbHMgdGhhdCBjYW4gYWN0dWFsbHkgc2VlLlxuICBjb25zdCB0b29sczogYW55W10gPSByb3V0ZSA9PT0gJ2FjdCcgPyBUT09MUy5maWx0ZXIoKHQpID0+IHQubmFtZSAhPT0gJ3NjcmVlbnNob3QnIHx8IHN1cHBvcnRzVmlzaW9uKGFjdE1vZGVsKSkgOiBbXTtcblxuICBjb25zdCBwcm9maWxlVGV4dCA9IGF3YWl0IHByb2ZpbGVQcmVhbWJsZSgpO1xuICBjb25zdCBtb2RlTm90ZSA9IGF1dG9Nb2RlXG4gICAgPyAnXFxuXFxuQVVUTyBNT0RFIElTIE9OIGZvciB0aGlzIHJlcXVlc3Q6IHRoZSB1c2VyIGhhcyBhbHJlYWR5IGFwcHJvdmVkIGlycmV2ZXJzaWJsZSBhY3Rpb25zIGluIGFkdmFuY2UuIERvIG5vdCBjYWxsIGNvbmZpcm1fYWN0aW9uIGFuZCBkbyBub3QgYXNrIOKAlCBmaW5pc2ggdGhlIGpvYiwgaW5jbHVkaW5nIHRoZSBmaW5hbCBjbGljaywgdGhlbiByZXBvcnQgd2hhdCB5b3UgZGlkLidcbiAgICA6ICcnO1xuICBjb25zdCBiYXNlID0ge1xuICAgIG1vZGVsOiBhY3RNb2RlbCxcbiAgICBtYXhfdG9rZW5zOiAyMDQ4LFxuICAgIHN5c3RlbTogU1lTVEVNX1BST01QVCArIHByb2ZpbGVUZXh0ICsgbW9kZU5vdGUsXG4gIH07XG5cbiAgYXdhaXQgc2V0U3RhdHVzKHJvdXRlID09PSAnYWN0JyA/ICdHZXR0aW5nIHN0YXJ0ZWQnIDogJ1RoaW5raW5nJyk7XG5cbiAgY29uc3Qgc25hcHNob3RJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgbGV0IGd1YXJkID0gMDtcbiAgd2hpbGUgKGd1YXJkKysgPCAzMCkge1xuICAgIGNvbnN0IHBhcmFtczogYW55ID0geyAuLi5iYXNlLCBtZXNzYWdlcyB9O1xuICAgIGlmICh0b29scy5sZW5ndGgpIHBhcmFtcy50b29scyA9IHRvb2xzO1xuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgY2FsbE1vZGVsKGFwaUtleSwgcGFyYW1zLCBhYm9ydC5zaWduYWwpO1xuXG4gICAgaWYgKHJlc3BvbnNlLnN0b3BfcmVhc29uID09PSAncGF1c2VfdHVybicpIHtcbiAgICAgIG1lc3NhZ2VzLnB1c2goeyByb2xlOiAnYXNzaXN0YW50JywgY29udGVudDogcmVzcG9uc2UuY29udGVudCBhcyBhbnkgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKHJlc3BvbnNlLnN0b3BfcmVhc29uICE9PSAndG9vbF91c2UnKSB7XG4gICAgICBhd2FpdCBwdXNoQ2hhdChleHRyYWN0VGV4dChyZXNwb25zZS5jb250ZW50IGFzIENvbnRlbnRCbG9ja1tdKSwgJ2Fzc2lzdGFudCcpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIENvbmZpcm1hdGlvbiBjaGVja3BvaW50OiBpZiBUaWRyYSBhc2tzIHRvIGNvbmZpcm0sIGVuZCB0aGUgdHVybiBhbmRcbiAgICAvLyBzaG93IHRoZSBDb25maXJtL0NhbmNlbCBiYXIgaW5zdGVhZCBvZiBjb250aW51aW5nIHRvIGNsaWNrIFNlbmQuXG4gICAgY29uc3QgY29uZmlybUJsb2NrID0gKHJlc3BvbnNlLmNvbnRlbnQgYXMgYW55W10pLmZpbmQoXG4gICAgICAoYikgPT4gYi50eXBlID09PSAndG9vbF91c2UnICYmIGIubmFtZSA9PT0gJ2NvbmZpcm1fYWN0aW9uJyxcbiAgICApO1xuICAgIGlmIChjb25maXJtQmxvY2sgJiYgIWF1dG9Nb2RlKSB7XG4gICAgICBjb25zdCBwcmUgPSBleHRyYWN0VGV4dChyZXNwb25zZS5jb250ZW50IGFzIENvbnRlbnRCbG9ja1tdKTtcbiAgICAgIGNvbnN0IHN1bW1hcnkgPSBjb25maXJtQmxvY2suaW5wdXQ/LnN1bW1hcnkgfHwgJ1JlYWR5LiBEbyB5b3Ugd2FudCBtZSB0byBwcm9jZWVkPyc7XG4gICAgICBhd2FpdCBwdXNoQ2hhdChbcHJlLCBzdW1tYXJ5XS5maWx0ZXIoQm9vbGVhbikuam9pbignXFxuXFxuJyksICdhc3Npc3RhbnQnKTtcbiAgICAgIGF3YWl0IGJyb3dzZXIuc3RvcmFnZS5sb2NhbC5zZXQoe1xuICAgICAgICB0aWRyYVBlbmRpbmc6IHsgbGFiZWw6IGNvbmZpcm1CbG9jay5pbnB1dD8uY29uZmlybV9sYWJlbCB8fCAnU2VuZCcgfSxcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICAvLyBBdXRvIG1vZGU6IGFwcHJvdmUgaXQgb3Vyc2VsdmVzIGFuZCBsZXQgdGhlIHNhbWUgdHVybiBjYXJyeSBvbiwgcmF0aGVyXG4gICAgLy8gdGhhbiBtYWtpbmcgdGhlIG1vZGVsIGFzayBhIHF1ZXN0aW9uIG5vYm9keSBpcyBnb2luZyB0byBhbnN3ZXIuXG4gICAgaWYgKGNvbmZpcm1CbG9jaykge1xuICAgICAgbWVzc2FnZXMucHVzaCh7IHJvbGU6ICdhc3Npc3RhbnQnLCBjb250ZW50OiByZXNwb25zZS5jb250ZW50IGFzIGFueSB9KTtcbiAgICAgIG1lc3NhZ2VzLnB1c2goe1xuICAgICAgICByb2xlOiAndXNlcicsXG4gICAgICAgIGNvbnRlbnQ6IFtcbiAgICAgICAgICB7XG4gICAgICAgICAgICB0eXBlOiAndG9vbF9yZXN1bHQnLFxuICAgICAgICAgICAgdG9vbF91c2VfaWQ6IGNvbmZpcm1CbG9jay5pZCxcbiAgICAgICAgICAgIGNvbnRlbnQ6ICdBcHByb3ZlZCBhdXRvbWF0aWNhbGx5IChhdXRvIG1vZGUgaXMgb24pLiBHbyBhaGVhZCBhbmQgY29tcGxldGUgdGhlIGFjdGlvbiBub3cuJyxcbiAgICAgICAgICB9LFxuICAgICAgICBdLFxuICAgICAgfSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICBtZXNzYWdlcy5wdXNoKHsgcm9sZTogJ2Fzc2lzdGFudCcsIGNvbnRlbnQ6IHJlc3BvbnNlLmNvbnRlbnQgYXMgYW55IH0pO1xuXG4gICAgY29uc3QgdG9vbFJlc3VsdHM6IFRvb2xSZXN1bHRCbG9ja1tdID0gW107XG4gICAgZm9yIChjb25zdCBibG9jayBvZiByZXNwb25zZS5jb250ZW50IGFzIGFueVtdKSB7XG4gICAgICBpZiAoYmxvY2sudHlwZSAhPT0gJ3Rvb2xfdXNlJykgY29udGludWU7XG4gICAgICBhd2FpdCBzZXRTdGF0dXMoc3RhdHVzRm9yKGJsb2NrLm5hbWUsIGJsb2NrLmlucHV0KSk7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBleGVjVG9vbChibG9jay5uYW1lLCBibG9jay5pbnB1dCwgdGFiU3RhdGUsIG1heUFjdCk7XG4gICAgICBpZiAoU05BUFNIT1RfVE9PTFMuaGFzKGJsb2NrLm5hbWUpKSBzbmFwc2hvdElkcy5hZGQoYmxvY2suaWQpO1xuICAgICAgdG9vbFJlc3VsdHMucHVzaCh7XG4gICAgICAgIHR5cGU6ICd0b29sX3Jlc3VsdCcsXG4gICAgICAgIHRvb2xfdXNlX2lkOiBibG9jay5pZCxcbiAgICAgICAgY29udGVudDogcmVzdWx0LmNvbnRlbnQsXG4gICAgICAgIGlzX2Vycm9yOiByZXN1bHQuaXNFcnJvcixcbiAgICAgIH0pO1xuICAgIH1cbiAgICBpZiAodG9vbFJlc3VsdHMubGVuZ3RoID09PSAwKSB7XG4gICAgICBhd2FpdCBwdXNoQ2hhdChleHRyYWN0VGV4dChyZXNwb25zZS5jb250ZW50IGFzIENvbnRlbnRCbG9ja1tdKSwgJ2Fzc2lzdGFudCcpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBtZXNzYWdlcy5wdXNoKHsgcm9sZTogJ3VzZXInLCBjb250ZW50OiB0b29sUmVzdWx0cyB9KTtcbiAgICBwcnVuZU9sZFNuYXBzaG90cyhtZXNzYWdlcywgc25hcHNob3RJZHMpO1xuICB9XG5cbiAgYXdhaXQgcHVzaENoYXQoXG4gICAgXCJJIHJhbiBvdXQgb2Ygc3RlcHMgYmVmb3JlIGZpbmlzaGluZy4gVGVsbCBtZSB3aGF0J3MgbGVmdCBhbmQgSSdsbCBjYXJyeSBvbiwgb3IgYnJlYWsgaXQgaW50byBzbWFsbGVyIHBpZWNlcy5cIixcbiAgICAnYXNzaXN0YW50JyxcbiAgKTtcbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgaWYgKGFib3J0LnNpZ25hbC5hYm9ydGVkKSB7XG4gICAgICBhd2FpdCBzZXRTdGF0dXMobnVsbCk7XG4gICAgICBhd2FpdCBjbGVhckxvYWRpbmcoKTsgLy8gdXNlciBwcmVzc2VkIFN0b3Ag4oCUIGVuZCBxdWlldGx5LCBubyBlcnJvciBidWJibGVcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhyb3cgZXJyO1xuICB9IGZpbmFsbHkge1xuICAgIGlmIChjdXJyZW50QWJvcnQgPT09IGFib3J0KSBjdXJyZW50QWJvcnQgPSBudWxsO1xuICAgIGF3YWl0IHNldFN0YXR1cyhudWxsKTtcbiAgfVxufVxuXG4vLyDilIDilIDilIAgUm91dGluZSBleGVjdXRpb24g4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSA4pSAXG4vLyBcIlN0YXJ0IHJvdXRpbmVcIiBydW5zIGVhY2ggbGVhcm5lZCBzaXRlJ3Mgc2F2ZWQgdGFzaywgaW4gdGhlIGJhY2tncm91bmQsIG9uIGFcbi8vIGhpZGRlbiB0YWIg4oCUIGRyYWZ0aW5nL3ByZXBhcmluZyBvbmx5LCBuZXZlciBzZW5kaW5nLCBhbmQgcmVwb3J0aW5nIGJhY2suXG5cbmNvbnN0IFJPVVRJTkVfU1lTVEVNID0gYFlvdSBhcmUgVGlkcmEsIHJ1bm5pbmcgb25lIHN0ZXAgb2YgdGhlIHVzZXIncyBzYXZlZCByb3V0aW5lIG9uIGEgd2Vic2l0ZSDigJQgaW4gdGhlIGJhY2tncm91bmQsIG9uIHRoZWlyIGJlaGFsZi5cblxuRG8gZXhhY3RseSB3aGF0IHRoZSB0YXNrIGRlc2NyaWJlcywgdXNpbmcgdGhlIHBhZ2UuIEJlIGRlY2lzaXZlIGFuZCB0YWtlIHRoZSBuZWVkZWQgc3RlcHMgKG9wZW4gdGhlIGNvbXBvc2VyLCByZWFkIHRoZSB0aHJlYWQsIHdyaXRlIGEgZHJhZnQsIGV0Yy4pLlxuXG5Vc2Ugc25hcHNob3QoKSB0byBzZWUgdGhlIHBhZ2UncyBpbnRlcmFjdGl2ZSBlbGVtZW50cyDigJQgZWFjaCBjYXJyaWVzIGEgcmVmIGxpa2UgcmVmXzAtMTIg4oCUIHRoZW4gY2xpY2socmVmKSAvIGZpbGwocmVmLCB0ZXh0KS4gUmVmcyBnbyBzdGFsZSB3aGVuZXZlciB0aGUgcGFnZSBjaGFuZ2VzLCBzbyBzbmFwc2hvdCBhZ2FpbiBhZnRlciBhbnl0aGluZyB0aGF0IG5hdmlnYXRlcyBvciByZS1yZW5kZXJzLiBFdmVyeSBhY3Rpb24gcmVwb3J0cyB3aGF0IGNoYW5nZWQ7IGlmIGl0IHNheXMgXCJubyB2aXNpYmxlIGNoYW5nZVwiLCBpdCBkaWQgbm90IHdvcmsuXG5cbkhBUkQgUlVMRVM6XG4tIE5FVkVSIHNlbmQsIHBvc3QsIHN1Ym1pdCwgcHVibGlzaCwgYnV5LCBvciBkZWxldGUgYW55dGhpbmcuIE9ubHkgcHJlcGFyZS9kcmFmdCBhbmQgbGVhdmUgaXQgZm9yIHRoZSB1c2VyIHRvIHJldmlldyBsYXRlci5cbi0gRG8gbm90IGFzayB0aGUgdXNlciBxdWVzdGlvbnMg4oCUIGRvIHlvdXIgYmVzdCB3aXRoIHdoYXQncyBvbiB0aGUgcGFnZS5cbi0gV2hlbiBmaW5pc2hlZCwgcmVwbHkgd2l0aCBhIFNIT1JUIHJlcG9ydDogMeKAkzMgc2VudGVuY2VzIG9yIGEgZmV3IGJ1bGxldHMgb2Ygd2hhdCB5b3UgZm91bmQgb3IgZHJhZnRlZC4gTm8gcHJlYW1ibGUuXG4tIEJhc2UgZXZlcnl0aGluZyBzdHJpY3RseSBvbiB0aGUgYWN0dWFsIHBhZ2UgY29udGVudCDigJQgbmV2ZXIgaW52ZW50LmA7XG5cbmNvbnN0IFJPVVRJTkVfVEFTS19ERUZBVUxUUzogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHtcbiAgJ21haWwuZ29vZ2xlLmNvbSc6ICdDaGVjayBmb3IgbmV3IGltcG9ydGFudCBlbWFpbHMgYW5kIGRyYWZ0IHJlcGxpZXMgSSBjYW4gcmV2aWV3IGJlZm9yZSBzZW5kaW5nLicsXG4gICdsaW5rZWRpbi5jb20nOiAnQ2hlY2sgbmV3IG1lc3NhZ2VzIGFuZCBub3RpZmljYXRpb25zLCBhbmQgc3VtbWFyaXplIGFueXRoaW5nIHRoYXQgbmVlZHMgYSByZXNwb25zZS4nLFxuICAnZ2l0aHViLmNvbSc6ICdDaGVjayBteSBub3RpZmljYXRpb25zIGFuZCBvcGVuIHB1bGwgcmVxdWVzdHMsIGFuZCBzdW1tYXJpemUgd2hhdCBuZWVkcyBteSBhdHRlbnRpb24uJyxcbiAgJ2NhbGVuZGFyLmdvb2dsZS5jb20nOiBcIlN1bW1hcml6ZSB0b2RheSdzIG1lZXRpbmdzIGFuZCB3aGF0IEkgc2hvdWxkIHByZXBhcmUuXCIsXG4gICd4LmNvbSc6ICdTdW1tYXJpemUgdGhlIHRvcCBwb3N0cyBmcm9tIHRoZSBwZW9wbGUgSSBmb2xsb3cuJyxcbiAgJ3R3aXR0ZXIuY29tJzogJ1N1bW1hcml6ZSB0aGUgdG9wIHBvc3RzIGZyb20gdGhlIHBlb3BsZSBJIGZvbGxvdy4nLFxuICAnbm90aW9uLnNvJzogJ1N1bW1hcml6ZSB3aGF0IGNoYW5nZWQgaW4gbXkgd29ya3NwYWNlIHNpbmNlIEkgbGFzdCBjaGVja2VkLicsXG4gICd3d3cueW91dHViZS5jb20nOiAnTGlzdCB0aGUgbmV3IHZpZGVvcyBmcm9tIGNoYW5uZWxzIEkgZm9sbG93LicsXG59O1xuZnVuY3Rpb24gZGVmYXVsdFRhc2tGb3IoZG9tYWluOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gUk9VVElORV9UQVNLX0RFRkFVTFRTW2RvbWFpbl0gPz8gXCJMb29rIGF0IHRoaXMgcGFnZSBhbmQgdGVsbCBtZSB3aGF0J3MgbmV3IG9yIG5lZWRzIG15IGF0dGVudGlvbi5cIjtcbn1cblxuYXN5bmMgZnVuY3Rpb24gZ2V0UGFnZU9mKHRhYklkOiBudW1iZXIpOiBQcm9taXNlPFBhZ2VDb250ZXh0PiB7XG4gIGNvbnN0IHJlcyA9IGF3YWl0IHNlbmRBY3Rpb24odGFiSWQsIHsgdHlwZTogJ3RpZHJhLWFjdGlvbicsIGFjdGlvbjogJ2dldF9wYWdlJyB9KTtcbiAgcmV0dXJuIChyZXM/LmRhdGEgYXMgUGFnZUNvbnRleHQpIHx8IHsgdGl0bGU6ICcnLCB1cmw6ICcnLCB0ZXh0OiAnJyB9O1xufVxuXG4vLyBSdW4gb25lIHNpdGUncyB0YXNrIHRvIGNvbXBsZXRpb24gYW5kIHJldHVybiBUaWRyYSdzIHNob3J0IHJlcG9ydC5cbmFzeW5jIGZ1bmN0aW9uIHJ1blNpdGVBZ2VudChcbiAgYXBpS2V5OiBzdHJpbmcsXG4gIGFjdE1vZGVsOiBzdHJpbmcsXG4gIHRhc2s6IHN0cmluZyxcbiAgdGFiSWQ6IG51bWJlcixcbiAgcHJvZmlsZVRleHQgPSAnJyxcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIGNvbnN0IHRhYlN0YXRlOiBUYWJTdGF0ZSA9IHsgdGFiSWQgfTtcbiAgY29uc3QgcGFnZSA9IGF3YWl0IGdldFBhZ2VPZih0YWJJZCk7XG4gIGNvbnN0IG1lc3NhZ2VzOiBNZXNzYWdlW10gPSBbXG4gICAge1xuICAgICAgcm9sZTogJ3VzZXInLFxuICAgICAgY29udGVudDogW1xuICAgICAgICBgUm91dGluZSB0YXNrOiAke3Rhc2t9YCxcbiAgICAgICAgYGAsXG4gICAgICAgIGBDdXJyZW50IHBhZ2U6YCxcbiAgICAgICAgYFRpdGxlOiAke3BhZ2UudGl0bGV9YCxcbiAgICAgICAgYFVSTDogJHtwYWdlLnVybH1gLFxuICAgICAgICBgYCxcbiAgICAgICAgYFBhZ2UgY29udGVudCAodHJ1bmNhdGVkKTpgLFxuICAgICAgICAocGFnZS50ZXh0IHx8ICcnKS5zbGljZSgwLCA4MDAwKSxcbiAgICAgIF0uam9pbignXFxuJyksXG4gICAgfSxcbiAgXTtcbiAgLy8gTm8gY29uZmlybV9hY3Rpb24gLyBvcGVuX3VybCDigJQgcm91dGluZSB0YXNrcyBzdGF5IG9uIHRoZSBvcGVuZWQgdGFiIGFuZCBuZXZlclxuICAvLyBzZW5kLiBTY3JlZW5zaG90cyBuZWVkIHZpc2lvbiwgYW5kIGEgYmFja2dyb3VuZCB0YWIgY2FuJ3QgYmUgY2FwdHVyZWQgYW55d2F5LlxuICBjb25zdCB0b29scyA9IFRPT0xTLmZpbHRlcihcbiAgICAodCkgPT4gIVsnY29uZmlybV9hY3Rpb24nLCAnb3Blbl91cmwnLCAnc2NyZWVuc2hvdCcsICdnb19iYWNrJ10uaW5jbHVkZXModC5uYW1lKSxcbiAgKTtcbiAgY29uc3Qgc25hcHNob3RJZHMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgbGV0IGd1YXJkID0gMDtcbiAgd2hpbGUgKGd1YXJkKysgPCAyNCkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGNhbGxNb2RlbChhcGlLZXksIHtcbiAgICAgIG1vZGVsOiBhY3RNb2RlbCxcbiAgICAgIG1heF90b2tlbnM6IDE1MDAsXG4gICAgICBzeXN0ZW06IFJPVVRJTkVfU1lTVEVNICsgcHJvZmlsZVRleHQsXG4gICAgICBtZXNzYWdlcyxcbiAgICAgIHRvb2xzLFxuICAgIH0pO1xuICAgIGlmIChyZXMuc3RvcF9yZWFzb24gIT09ICd0b29sX3VzZScpIHtcbiAgICAgIHJldHVybiBleHRyYWN0VGV4dChyZXMuY29udGVudCBhcyBDb250ZW50QmxvY2tbXSkgfHwgJ0RvbmUuJztcbiAgICB9XG4gICAgbWVzc2FnZXMucHVzaCh7IHJvbGU6ICdhc3Npc3RhbnQnLCBjb250ZW50OiByZXMuY29udGVudCBhcyBhbnkgfSk7XG4gICAgY29uc3QgdG9vbFJlc3VsdHM6IFRvb2xSZXN1bHRCbG9ja1tdID0gW107XG4gICAgZm9yIChjb25zdCBibG9jayBvZiByZXMuY29udGVudCBhcyBhbnlbXSkge1xuICAgICAgaWYgKGJsb2NrLnR5cGUgIT09ICd0b29sX3VzZScpIGNvbnRpbnVlO1xuICAgICAgLy8gTm8gYWxsb3dTdWJtaXQ6IGEgYmFja2dyb3VuZCByb3V0aW5lIGRyYWZ0cywgbmV2ZXIgc2VuZHMuXG4gICAgICBjb25zdCByID0gYXdhaXQgZXhlY1Rvb2woYmxvY2submFtZSwgYmxvY2suaW5wdXQsIHRhYlN0YXRlKTtcbiAgICAgIGlmIChTTkFQU0hPVF9UT09MUy5oYXMoYmxvY2submFtZSkpIHNuYXBzaG90SWRzLmFkZChibG9jay5pZCk7XG4gICAgICB0b29sUmVzdWx0cy5wdXNoKHsgdHlwZTogJ3Rvb2xfcmVzdWx0JywgdG9vbF91c2VfaWQ6IGJsb2NrLmlkLCBjb250ZW50OiByLmNvbnRlbnQsIGlzX2Vycm9yOiByLmlzRXJyb3IgfSk7XG4gICAgfVxuICAgIGlmICghdG9vbFJlc3VsdHMubGVuZ3RoKSByZXR1cm4gZXh0cmFjdFRleHQocmVzLmNvbnRlbnQgYXMgQ29udGVudEJsb2NrW10pIHx8ICdEb25lLic7XG4gICAgbWVzc2FnZXMucHVzaCh7IHJvbGU6ICd1c2VyJywgY29udGVudDogdG9vbFJlc3VsdHMgfSk7XG4gICAgcHJ1bmVPbGRTbmFwc2hvdHMobWVzc2FnZXMsIHNuYXBzaG90SWRzKTtcbiAgfVxuICByZXR1cm4gJ1N0b3BwZWQgYWZ0ZXIgdG9vIG1hbnkgc3RlcHMuJztcbn1cblxubGV0IHJvdXRpbmVSdW5uaW5nID0gZmFsc2U7XG5hc3luYyBmdW5jdGlvbiBydW5Sb3V0aW5lKCkge1xuICBpZiAocm91dGluZVJ1bm5pbmcpIHJldHVybjtcbiAgcm91dGluZVJ1bm5pbmcgPSB0cnVlO1xuICB0cnkge1xuICAgIGNvbnN0IHN0b3JlID0gYXdhaXQgYnJvd3Nlci5zdG9yYWdlLmxvY2FsLmdldChbXG4gICAgICAndGlkcmFWaXNpdHMnLFxuICAgICAgJ3RpZHJhUm91dGluZUhpZGRlbicsXG4gICAgICAndGlkcmFSb3V0aW5lVGFza3MnLFxuICAgICAgJ3RpZHJhUm91dGluZU1hbnVhbCcsXG4gICAgXSk7XG4gICAgY29uc3Qgc2V0dXAgPSBhd2FpdCBtb2RlbFNldHVwKCk7XG4gICAgaWYgKCFzZXR1cCkge1xuICAgICAgYXdhaXQgcHVzaENoYXQoJ05vIEFQSSBrZXkgc2V0LiBPcGVuIHNldHRpbmdzIGFuZCBhZGQgYSBrZXkgZm9yIHlvdXIgY2hvc2VuIHByb3ZpZGVyLicsICdlcnJvcicpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjb25zdCB7IGFwaUtleSwgdGllciB9ID0gc2V0dXA7XG4gICAgY29uc3QgdmlzaXRzID0gKHN0b3JlLnRpZHJhVmlzaXRzIGFzIFZpc2l0W10pIHx8IFtdO1xuICAgIGNvbnN0IGhpZGRlbiA9IG5ldyBTZXQoKHN0b3JlLnRpZHJhUm91dGluZUhpZGRlbiBhcyBzdHJpbmdbXSkgfHwgW10pO1xuICAgIGNvbnN0IG1hbnVhbCA9IChzdG9yZS50aWRyYVJvdXRpbmVNYW51YWwgYXMgeyBkb21haW46IHN0cmluZzsgdXJsOiBzdHJpbmcgfVtdKSB8fCBbXTtcbiAgICAvLyBMZWFybmVkIHJvdXRpbmUgKyBtYW51YWxseS1hZGRlZCBzaXRlcywgZGUtZHVwbGljYXRlZCwgbWludXMgcmVtb3ZlZCBvbmVzLlxuICAgIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgICBjb25zdCBzaXRlcyA9IFsuLi5kZXRlY3RSb3V0aW5lKHZpc2l0cyksIC4uLm1hbnVhbF0uZmlsdGVyKChzKSA9PiB7XG4gICAgICBpZiAoaGlkZGVuLmhhcyhzLmRvbWFpbikgfHwgc2Vlbi5oYXMocy5kb21haW4pKSByZXR1cm4gZmFsc2U7XG4gICAgICBzZWVuLmFkZChzLmRvbWFpbik7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9KTtcbiAgICBjb25zdCB0YXNrcyA9IChzdG9yZS50aWRyYVJvdXRpbmVUYXNrcyBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+KSB8fCB7fTtcbiAgICBpZiAoIXNpdGVzLmxlbmd0aCkge1xuICAgICAgYXdhaXQgcHVzaENoYXQoXCJZb3UgaGF2ZSBubyBsZWFybmVkIHJvdXRpbmUgeWV0LCBzbyB0aGVyZSdzIG5vdGhpbmcgdG8gcnVuLlwiLCAnYXNzaXN0YW50Jyk7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgcHJvZmlsZVRleHQgPSBhd2FpdCBwcm9maWxlUHJlYW1ibGUoKTtcbiAgICBhd2FpdCBicm93c2VyLnN0b3JhZ2UubG9jYWwuc2V0KHsgdGlkcmFPcGVuOiB0cnVlIH0pO1xuICAgIGF3YWl0IHB1c2hDaGF0KFxuICAgICAgYFJ1bm5pbmcgeW91ciByb3V0aW5lIGFjcm9zcyAke3NpdGVzLmxlbmd0aH0gc2l0ZSR7c2l0ZXMubGVuZ3RoID4gMSA/ICdzJyA6ICcnfSDigJQgSSdsbCBkcmFmdCwgbmV2ZXIgc2VuZCwgYW5kIHJlcG9ydCBiYWNrLmAsXG4gICAgICAnYXNzaXN0YW50JyxcbiAgICApO1xuXG4gICAgZm9yIChjb25zdCBzaXRlIG9mIHNpdGVzKSB7XG4gICAgICBjb25zdCBuYW1lID0gcHJldHR5RG9tYWluKHNpdGUuZG9tYWluKTtcbiAgICAgIGNvbnN0IHRhc2sgPSAodGFza3Nbc2l0ZS5kb21haW5dIHx8IGRlZmF1bHRUYXNrRm9yKHNpdGUuZG9tYWluKSkudHJpbSgpO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgdGFiID0gYXdhaXQgYnJvd3Nlci50YWJzLmNyZWF0ZSh7IHVybDogc2l0ZS51cmwsIGFjdGl2ZTogZmFsc2UgfSk7XG4gICAgICAgIGlmICh0YWIuaWQgPT0gbnVsbCkge1xuICAgICAgICAgIGF3YWl0IHB1c2hDaGF0KGAqKiR7bmFtZX0qKiDigJQgY291bGRuJ3Qgb3BlbiB0aGUgdGFiLmAsICdlcnJvcicpO1xuICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG4gICAgICAgIGF3YWl0IHdhaXRGb3JUYWJMb2FkKHRhYi5pZCk7XG4gICAgICAgIGF3YWl0IHNsZWVwKDcwMCk7XG4gICAgICAgIGNvbnN0IHJlcG9ydCA9IGF3YWl0IHJ1blNpdGVBZ2VudChhcGlLZXksIHRpZXIuYWN0LCB0YXNrLCB0YWIuaWQsIHByb2ZpbGVUZXh0KTtcbiAgICAgICAgYXdhaXQgcHVzaENoYXQoYCoqJHtuYW1lfSoqXFxuJHtyZXBvcnR9YCwgJ2Fzc2lzdGFudCcpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGF3YWl0IHB1c2hDaGF0KGAqKiR7bmFtZX0qKiDigJQgJHtlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycil9YCwgJ2Vycm9yJyk7XG4gICAgICB9XG4gICAgfVxuICAgIGF3YWl0IHB1c2hDaGF0KCfinIUgUm91dGluZSBmaW5pc2hlZC4gUmV2aWV3IHRoZSBkcmFmdHMgaW4gdGhlIHRhYnMgSSBvcGVuZWQgYmVmb3JlIHNlbmRpbmcgYW55dGhpbmcuJywgJ2Fzc2lzdGFudCcpO1xuICB9IGZpbmFsbHkge1xuICAgIHJvdXRpbmVSdW5uaW5nID0gZmFsc2U7XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQmFja2dyb3VuZCgoKSA9PiB7XG4gIGJyb3dzZXIuY29tbWFuZHMub25Db21tYW5kLmFkZExpc3RlbmVyKGFzeW5jIChjb21tYW5kKSA9PiB7XG4gICAgaWYgKGNvbW1hbmQgIT09ICd0b2dnbGUtaXNsYW5kJykgcmV0dXJuO1xuICAgIGNvbnN0IFt0YWJdID0gYXdhaXQgYnJvd3Nlci50YWJzLnF1ZXJ5KHsgYWN0aXZlOiB0cnVlLCBjdXJyZW50V2luZG93OiB0cnVlIH0pO1xuICAgIGlmICh0YWI/LmlkKSB7XG4gICAgICBicm93c2VyLnRhYnMuc2VuZE1lc3NhZ2UodGFiLmlkLCB7IHR5cGU6ICd0aWRyYS10b2dnbGUnIH0pLmNhdGNoKCgpID0+IHt9KTtcbiAgICB9XG4gIH0pO1xuXG4gIGJyb3dzZXIucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1lc3NhZ2UsIHNlbmRlciwgc2VuZFJlc3BvbnNlKSA9PiB7XG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgPT09ICd0aWRyYS1hc2snKSB7XG4gICAgICBoYW5kbGVBc2sobWVzc2FnZSBhcyBBc2tSZXF1ZXN0LCBzZW5kZXIudGFiPy5pZClcbiAgICAgICAgLmNhdGNoKChlcnI6IHVua25vd24pID0+IHB1c2hDaGF0KGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSwgJ2Vycm9yJykpXG4gICAgICAgIC5maW5hbGx5KCgpID0+IHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlIH0pKTtcbiAgICAgIHJldHVybiB0cnVlOyAvLyBrZWVwIHRoZSB3b3JrZXIgYWxpdmUgZm9yIHRoZSBhc3luYyB3b3JrXG4gICAgfVxuICAgIC8vIFRoZSBuZXcgdGFiIGFza3Mgd2hpY2gga2luZCBvZiByZXF1ZXN0IHRoaXMgaXM6IHNvbWV0aGluZyBpdCBjYW4gYW5zd2VyXG4gICAgLy8gaW5saW5lLCBvciBzb21ldGhpbmcgdGhhdCBuZWVkcyB0aGUgYnJvd3NlciAoYW5kIHNvIG5lZWRzIHRoZSBhZ2VudCkuXG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgPT09ICd0aWRyYS1yb3V0ZScgJiYgdHlwZW9mIG1lc3NhZ2UucHJvbXB0ID09PSAnc3RyaW5nJykge1xuICAgICAgKGFzeW5jICgpID0+IHtcbiAgICAgICAgY29uc3Qgc2V0dXAgPSBhd2FpdCBtb2RlbFNldHVwKCk7XG4gICAgICAgIGlmICghc2V0dXApIHJldHVybiBzZW5kUmVzcG9uc2UoeyByb3V0ZTogJ2NoYXQnIH0pO1xuICAgICAgICBjb25zdCByb3V0ZSA9IGF3YWl0IGNsYXNzaWZ5KHNldHVwLmFwaUtleSwgc2V0dXAudGllci5yb3V0ZXIsIG1lc3NhZ2UucHJvbXB0LCBbXSk7XG4gICAgICAgIHNlbmRSZXNwb25zZSh7IHJvdXRlIH0pO1xuICAgICAgfSkoKS5jYXRjaCgoKSA9PiBzZW5kUmVzcG9uc2UoeyByb3V0ZTogJ2NoYXQnIH0pKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBpZiAobWVzc2FnZT8udHlwZSA9PT0gJ3RpZHJhLXN0b3AnKSB7XG4gICAgICBjdXJyZW50QWJvcnQ/LmFib3J0KCk7IC8vIGNhbmNlbCB0aGUgaW4tZmxpZ2h0IEFQSSByZXF1ZXN0XG4gICAgICBjbGVhckxvYWRpbmcoKS5jYXRjaCgoKSA9PiB7fSk7IC8vIHJlc2V0IHRoZSBVSSAoc3RvcmFnZSBjaGFuZ2UgcmUtcmVuZGVycylcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgPT09ICd0aWRyYS12aXNpdCcgJiYgdHlwZW9mIG1lc3NhZ2UuZG9tYWluID09PSAnc3RyaW5nJykge1xuICAgICAgaGFuZGxlVmlzaXQobWVzc2FnZS5kb21haW4pLmNhdGNoKCgpID0+IHt9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgPT09ICd0aWRyYS1vcGVuLXJvdXRpbmUnKSB7XG4gICAgICBicm93c2VyLnN0b3JhZ2UubG9jYWwuZ2V0KCd0aWRyYVJvdXRpbmUnKS50aGVuKCh7IHRpZHJhUm91dGluZSB9KSA9PiB7XG4gICAgICAgIGNvbnN0IHNpdGVzID0gKHRpZHJhUm91dGluZSBhcyB7IHNpdGVzPzogeyB1cmw6IHN0cmluZyB9W10gfSB8IHVuZGVmaW5lZCk/LnNpdGVzID8/IFtdO1xuICAgICAgICBzaXRlcy5mb3JFYWNoKChzKSA9PiBicm93c2VyLnRhYnMuY3JlYXRlKHsgdXJsOiBzLnVybCwgYWN0aXZlOiBmYWxzZSB9KS5jYXRjaCgoKSA9PiB7fSkpO1xuICAgICAgICBicm93c2VyLnN0b3JhZ2UubG9jYWwuc2V0KHsgdGlkcmFSb3V0aW5lOiBudWxsIH0pO1xuICAgICAgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmIChtZXNzYWdlPy50eXBlID09PSAndGlkcmEtb3Blbi1vcHRpb25zJykge1xuICAgICAgYnJvd3Nlci5ydW50aW1lLm9wZW5PcHRpb25zUGFnZSgpO1xuICAgIH1cbiAgICAvLyBSZXR1cm4gdGhlIGN1cnJlbnRseS1sZWFybmVkIHJvdXRpbmUgKGZyZXNobHkgY29tcHV0ZWQpLCBtaW51cyBhbnkgc2l0ZXNcbiAgICAvLyB0aGUgdXNlciBoYXMgcmVtb3ZlZC4gVXNlZCBieSB0aGUgbmV3LXRhYiBcIllvdXIgcm91dGluZVwiIHBhbmVsLlxuICAgIGlmIChtZXNzYWdlPy50eXBlID09PSAndGlkcmEtZ2V0LXJvdXRpbmUnKSB7XG4gICAgICAoYXN5bmMgKCkgPT4ge1xuICAgICAgICBjb25zdCBzdG9yZSA9IGF3YWl0IGJyb3dzZXIuc3RvcmFnZS5sb2NhbC5nZXQoW1xuICAgICAgICAgICd0aWRyYVZpc2l0cycsXG4gICAgICAgICAgJ3RpZHJhUm91dGluZUhpZGRlbicsXG4gICAgICAgICAgJ3RpZHJhUm91dGluZUVuYWJsZWQnLFxuICAgICAgICBdKTtcbiAgICAgICAgY29uc3QgZW5hYmxlZCA9IHN0b3JlLnRpZHJhUm91dGluZUVuYWJsZWQgIT09IGZhbHNlO1xuICAgICAgICBjb25zdCB2aXNpdHMgPSAoc3RvcmUudGlkcmFWaXNpdHMgYXMgVmlzaXRbXSkgfHwgW107XG4gICAgICAgIGNvbnN0IGhpZGRlbiA9IG5ldyBTZXQoKHN0b3JlLnRpZHJhUm91dGluZUhpZGRlbiBhcyBzdHJpbmdbXSkgfHwgW10pO1xuICAgICAgICBjb25zdCBzaXRlcyA9IGRldGVjdFJvdXRpbmUodmlzaXRzKS5maWx0ZXIoKHMpID0+ICFoaWRkZW4uaGFzKHMuZG9tYWluKSk7XG4gICAgICAgIHNlbmRSZXNwb25zZSh7IGVuYWJsZWQsIHNpdGVzIH0pO1xuICAgICAgfSkoKTtcbiAgICAgIHJldHVybiB0cnVlOyAvLyBhc3luYyByZXNwb25zZVxuICAgIH1cbiAgICAvLyBSdW4gdGhlIHdob2xlIHJvdXRpbmUgaW4gdGhlIGJhY2tncm91bmQgKGRyYWZ0LW9ubHksIHJlcG9ydHMgaW50byB0aGUgY2hhdCkuXG4gICAgaWYgKG1lc3NhZ2U/LnR5cGUgPT09ICd0aWRyYS1ydW4tcm91dGluZScpIHtcbiAgICAgIHJ1blJvdXRpbmUoKVxuICAgICAgICAuY2F0Y2goKGVycikgPT4gcHVzaENoYXQoZXJyIGluc3RhbmNlb2YgRXJyb3IgPyBlcnIubWVzc2FnZSA6IFN0cmluZyhlcnIpLCAnZXJyb3InKSlcbiAgICAgICAgLmZpbmFsbHkoKCkgPT4gc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUgfSkpO1xuICAgICAgcmV0dXJuIHRydWU7IC8vIGtlZXAgdGhlIHdvcmtlciBhbGl2ZSBmb3IgdGhlIGFzeW5jIHdvcmtcbiAgICB9XG4gIH0pO1xufSk7XG4iLCIvLyNyZWdpb24gc3JjL2luZGV4LnRzXG4vKipcbiogQ2xhc3MgZm9yIHBhcnNpbmcgYW5kIHBlcmZvcm1pbmcgb3BlcmF0aW9ucyBvbiBtYXRjaCBwYXR0ZXJucy5cbipcbiogQGV4YW1wbGVcbiogICBjb25zdCBwYXR0ZXJuID0gbmV3IE1hdGNoUGF0dGVybignKjovL2dvb2dsZS5jb20vKicpO1xuKlxuKiAgIHBhdHRlcm4uaW5jbHVkZXMoJ2h0dHBzOi8vZ29vZ2xlLmNvbScpOyAvLyB0cnVlXG4qICAgcGF0dGVybi5pbmNsdWRlcygnaHR0cDovL3lvdXR1YmUuY29tL3dhdGNoP3Y9MTIzJyk7IC8vIGZhbHNlXG4qL1xudmFyIE1hdGNoUGF0dGVybiA9IGNsYXNzIE1hdGNoUGF0dGVybiB7XG5cdHN0YXRpYyB7XG5cdFx0dGhpcy5QUk9UT0NPTFMgPSBbXG5cdFx0XHRcImh0dHBcIixcblx0XHRcdFwiaHR0cHNcIixcblx0XHRcdFwiZmlsZVwiLFxuXHRcdFx0XCJmdHBcIixcblx0XHRcdFwidXJuXCIsXG5cdFx0XHRcIndzXCIsXG5cdFx0XHRcIndzc1wiXG5cdFx0XTtcblx0fVxuXHQvKipcblx0KiBQYXJzZSBhIG1hdGNoIHBhdHRlcm4gc3RyaW5nLiBJZiBpdCBpcyBpbnZhbGlkLCB0aGUgY29uc3RydWN0b3Igd2lsbCB0aHJvdyBhblxuXHQqIGBJbnZhbGlkTWF0Y2hQYXR0ZXJuYCBlcnJvci5cblx0KlxuXHQqIEBwYXJhbSBtYXRjaFBhdHRlcm4gVGhlIG1hdGNoIHBhdHRlcm4gdG8gcGFyc2UuXG5cdCovXG5cdGNvbnN0cnVjdG9yKG1hdGNoUGF0dGVybikge1xuXHRcdGlmIChtYXRjaFBhdHRlcm4gPT09IFwiPGFsbF91cmxzPlwiKSB7XG5cdFx0XHR0aGlzLmlzQWxsVXJscyA9IHRydWU7XG5cdFx0XHR0aGlzLnByb3RvY29sTWF0Y2hlcyA9IFsuLi5NYXRjaFBhdHRlcm4uUFJPVE9DT0xTXTtcblx0XHRcdHRoaXMuaG9zdG5hbWVNYXRjaCA9IFwiKlwiO1xuXHRcdFx0dGhpcy5wYXRobmFtZU1hdGNoID0gXCIqXCI7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGNvbnN0IGdyb3VwcyA9IC8oLiopOlxcL1xcLyguKj8pKFxcLy4qKS8uZXhlYyhtYXRjaFBhdHRlcm4pO1xuXHRcdFx0aWYgKGdyb3VwcyA9PSBudWxsKSB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihtYXRjaFBhdHRlcm4sIFwiSW5jb3JyZWN0IGZvcm1hdFwiKTtcblx0XHRcdGNvbnN0IFtfLCBwcm90b2NvbCwgaG9zdG5hbWUsIHBhdGhuYW1lXSA9IGdyb3Vwcztcblx0XHRcdHZhbGlkYXRlUHJvdG9jb2wobWF0Y2hQYXR0ZXJuLCBwcm90b2NvbCk7XG5cdFx0XHR2YWxpZGF0ZUhvc3RuYW1lKG1hdGNoUGF0dGVybiwgaG9zdG5hbWUpO1xuXHRcdFx0dGhpcy5wcm90b2NvbE1hdGNoZXMgPSBwcm90b2NvbCA9PT0gXCIqXCIgPyBbXCJodHRwXCIsIFwiaHR0cHNcIl0gOiBbcHJvdG9jb2xdO1xuXHRcdFx0dGhpcy5ob3N0bmFtZU1hdGNoID0gaG9zdG5hbWU7XG5cdFx0XHR0aGlzLnBhdGhuYW1lTWF0Y2ggPSBwYXRobmFtZTtcblx0XHR9XG5cdH1cblx0LyoqIENoZWNrIGlmIGEgVVJMIGlzIGluY2x1ZGVkIGluIGEgcGF0dGVybi4gKi9cblx0aW5jbHVkZXModXJsKSB7XG5cdFx0Y29uc3QgdSA9IHR5cGVvZiB1cmwgPT09IFwic3RyaW5nXCIgPyBuZXcgVVJMKHVybCkgOiB1cmwgaW5zdGFuY2VvZiBMb2NhdGlvbiA/IG5ldyBVUkwodXJsLmhyZWYpIDogdXJsO1xuXHRcdGlmICh0aGlzLmlzQWxsVXJscykgcmV0dXJuICF0aGlzLmlzVW5rbm93blByb3RvY29sKHUpO1xuXHRcdHJldHVybiAhIXRoaXMucHJvdG9jb2xNYXRjaGVzLmZpbmQoKHByb3RvY29sKSA9PiB7XG5cdFx0XHRpZiAocHJvdG9jb2wgPT09IFwiaHR0cFwiKSByZXR1cm4gdGhpcy5pc0h0dHBNYXRjaCh1KTtcblx0XHRcdGlmIChwcm90b2NvbCA9PT0gXCJodHRwc1wiKSByZXR1cm4gdGhpcy5pc0h0dHBzTWF0Y2godSk7XG5cdFx0XHRpZiAocHJvdG9jb2wgPT09IFwiZmlsZVwiKSByZXR1cm4gdGhpcy5pc0ZpbGVNYXRjaCh1KTtcblx0XHRcdGlmIChwcm90b2NvbCA9PT0gXCJmdHBcIikgcmV0dXJuIHRoaXMuaXNGdHBNYXRjaCh1KTtcblx0XHRcdGlmIChwcm90b2NvbCA9PT0gXCJ1cm5cIikgcmV0dXJuIHRoaXMuaXNVcm5NYXRjaCh1KTtcblx0XHR9KTtcblx0fVxuXHRpc0h0dHBNYXRjaCh1cmwpIHtcblx0XHRyZXR1cm4gdXJsLnByb3RvY29sID09PSBcImh0dHA6XCIgJiYgdGhpcy5pc0hvc3RQYXRoTWF0Y2godXJsKTtcblx0fVxuXHRpc0h0dHBzTWF0Y2godXJsKSB7XG5cdFx0cmV0dXJuIHVybC5wcm90b2NvbCA9PT0gXCJodHRwczpcIiAmJiB0aGlzLmlzSG9zdFBhdGhNYXRjaCh1cmwpO1xuXHR9XG5cdGlzSG9zdFBhdGhNYXRjaCh1cmwpIHtcblx0XHRpZiAoIXRoaXMuaG9zdG5hbWVNYXRjaCB8fCAhdGhpcy5wYXRobmFtZU1hdGNoKSByZXR1cm4gZmFsc2U7XG5cdFx0Y29uc3QgaG9zdG5hbWVNYXRjaFJlZ2V4cyA9IFt0aGlzLmNvbnZlcnRQYXR0ZXJuVG9SZWdleCh0aGlzLmhvc3RuYW1lTWF0Y2gpLCB0aGlzLmNvbnZlcnRQYXR0ZXJuVG9SZWdleCh0aGlzLmhvc3RuYW1lTWF0Y2gucmVwbGFjZSgvXlxcKlxcLi8sIFwiXCIpKV07XG5cdFx0Y29uc3QgcGF0aG5hbWVNYXRjaFJlZ2V4ID0gdGhpcy5jb252ZXJ0UGF0dGVyblRvUmVnZXgodGhpcy5wYXRobmFtZU1hdGNoKTtcblx0XHRyZXR1cm4gISFob3N0bmFtZU1hdGNoUmVnZXhzLmZpbmQoKHJlZ2V4KSA9PiByZWdleC50ZXN0KHVybC5ob3N0bmFtZSkpICYmIHBhdGhuYW1lTWF0Y2hSZWdleC50ZXN0KHVybC5wYXRobmFtZSk7XG5cdH1cblx0aXNVbmtub3duUHJvdG9jb2wodXJsKSB7XG5cdFx0cmV0dXJuICF0aGlzLnByb3RvY29sTWF0Y2hlcy5pbmNsdWRlcyh1cmwucHJvdG9jb2wuc2xpY2UoMCwgLTEpKTtcblx0fVxuXHRpc1BhdGhNYXRjaCh1cmwpIHtcblx0XHRpZiAoIXRoaXMucGF0aG5hbWVNYXRjaCkgcmV0dXJuIGZhbHNlO1xuXHRcdHJldHVybiB0aGlzLmNvbnZlcnRQYXR0ZXJuVG9SZWdleCh0aGlzLnBhdGhuYW1lTWF0Y2gpLnRlc3QodXJsLnBhdGhuYW1lKTtcblx0fVxuXHRpc0ZpbGVNYXRjaCh1cmwpIHtcblx0XHRyZXR1cm4gdXJsLnByb3RvY29sID09PSBcImZpbGU6XCIgJiYgdGhpcy5pc1BhdGhNYXRjaCh1cmwpO1xuXHR9XG5cdGlzRnRwTWF0Y2goX3VybCkge1xuXHRcdHRocm93IEVycm9yKFwiTm90IGltcGxlbWVudGVkOiBmdHA6Ly8gcGF0dGVybiBtYXRjaGluZy4gT3BlbiBhIFBSIHRvIGFkZCBzdXBwb3J0XCIpO1xuXHR9XG5cdGlzVXJuTWF0Y2goX3VybCkge1xuXHRcdHRocm93IEVycm9yKFwiTm90IGltcGxlbWVudGVkOiB1cm46Ly8gcGF0dGVybiBtYXRjaGluZy4gT3BlbiBhIFBSIHRvIGFkZCBzdXBwb3J0XCIpO1xuXHR9XG5cdGNvbnZlcnRQYXR0ZXJuVG9SZWdleChwYXR0ZXJuKSB7XG5cdFx0Y29uc3Qgc3RhcnNSZXBsYWNlZCA9IHRoaXMuZXNjYXBlRm9yUmVnZXgocGF0dGVybikucmVwbGFjZSgvXFxcXFxcKi9nLCBcIi4qXCIpO1xuXHRcdHJldHVybiBSZWdFeHAoYF4ke3N0YXJzUmVwbGFjZWR9JGApO1xuXHR9XG5cdGVzY2FwZUZvclJlZ2V4KHN0cmluZykge1xuXHRcdHJldHVybiBzdHJpbmcucmVwbGFjZSgvWy4qKz9eJHt9KCl8W1xcXVxcXFxdL2csIFwiXFxcXCQmXCIpO1xuXHR9XG59O1xudmFyIEludmFsaWRNYXRjaFBhdHRlcm4gPSBjbGFzcyBleHRlbmRzIEVycm9yIHtcblx0Y29uc3RydWN0b3IobWF0Y2hQYXR0ZXJuLCByZWFzb24pIHtcblx0XHRzdXBlcihgSW52YWxpZCBtYXRjaCBwYXR0ZXJuIFwiJHttYXRjaFBhdHRlcm59XCI6ICR7cmVhc29ufWApO1xuXHR9XG59O1xuZnVuY3Rpb24gdmFsaWRhdGVQcm90b2NvbChtYXRjaFBhdHRlcm4sIHByb3RvY29sKSB7XG5cdGlmICghTWF0Y2hQYXR0ZXJuLlBST1RPQ09MUy5pbmNsdWRlcyhwcm90b2NvbCkgJiYgcHJvdG9jb2wgIT09IFwiKlwiKSB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihtYXRjaFBhdHRlcm4sIGAke3Byb3RvY29sfSBub3QgYSB2YWxpZCBwcm90b2NvbCAoJHtNYXRjaFBhdHRlcm4uUFJPVE9DT0xTLmpvaW4oXCIsIFwiKX0pYCk7XG59XG5mdW5jdGlvbiB2YWxpZGF0ZUhvc3RuYW1lKG1hdGNoUGF0dGVybiwgaG9zdG5hbWUpIHtcblx0aWYgKGhvc3RuYW1lLmluY2x1ZGVzKFwiOlwiKSkgdGhyb3cgbmV3IEludmFsaWRNYXRjaFBhdHRlcm4obWF0Y2hQYXR0ZXJuLCBgSG9zdG5hbWUgY2Fubm90IGluY2x1ZGUgYSBwb3J0YCk7XG5cdGlmIChob3N0bmFtZS5pbmNsdWRlcyhcIipcIikgJiYgaG9zdG5hbWUubGVuZ3RoID4gMSAmJiAhaG9zdG5hbWUuc3RhcnRzV2l0aChcIiouXCIpKSB0aHJvdyBuZXcgSW52YWxpZE1hdGNoUGF0dGVybihtYXRjaFBhdHRlcm4sIGBJZiB1c2luZyBhIHdpbGRjYXJkICgqKSwgaXQgbXVzdCBnbyBhdCB0aGUgc3RhcnQgb2YgdGhlIGhvc3RuYW1lYCk7XG59XG4vLyNlbmRyZWdpb25cbmV4cG9ydCB7IEludmFsaWRNYXRjaFBhdHRlcm4sIE1hdGNoUGF0dGVybiB9O1xuIl0sInhfZ29vZ2xlX2lnbm9yZUxpc3QiOlswLDEsMiw1XSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7O0NDZ0JBLElBQU0sVURmaUIsV0FBVyxTQUFTLFNBQVMsS0FDaEQsV0FBVyxVQUNYLFdBQVc7OztDRUZmLFNBQVMsaUJBQWlCLEtBQUs7RUFDOUIsSUFBSSxPQUFPLFFBQVEsT0FBTyxRQUFRLFlBQVksT0FBTyxFQUFFLE1BQU0sSUFBSTtFQUNqRSxPQUFPO0NBQ1I7OztDQzRDQSxJQUFhLGNBQWM7RUFFekIsS0FBSztFQUVMLE9BQU87RUFFUCxRQUFRO0VBR1IsUUFBUTtDQUNWO0NBT0EsSUFBTSxXQUFXOztDQUdqQixJQUFhLFFBQXVFO0VBQ2xGLFNBQVM7R0FBRSxNQUFNLFlBQVk7R0FBTyxLQUFLLFlBQVk7R0FBTyxRQUFRLFlBQVk7RUFBTztFQUN2RixVQUFVO0dBQUUsTUFBTSxZQUFZO0dBQU8sS0FBSyxZQUFZO0dBQUssUUFBUSxZQUFZO0VBQU87RUFDdEYsU0FBUztHQUFFLE1BQU0sWUFBWTtHQUFLLEtBQUssWUFBWTtHQUFLLFFBQVEsWUFBWTtFQUFPO0NBQ3JGO0NBRUEsU0FBZ0IsUUFBUSxNQUEwQjtFQUNoRCxPQUFPLE1BQU0sUUFBUSxlQUFlLE1BQU07Q0FDNUM7O0NBR0EsU0FBZ0IsZUFBZSxPQUF3QjtFQUNyRCxPQUFPLFVBQVUsWUFBWTtDQUMvQjtDQWNBLFNBQVMsVUFBVSxTQUEwQjtFQUMzQyxJQUFJLE9BQU8sWUFBWSxVQUFVLE9BQU87RUFDeEMsSUFBSSxDQUFDLE1BQU0sUUFBUSxPQUFPLEdBQUcsT0FBTztFQUNwQyxPQUFPLFFBQ0osUUFBUSxNQUFXLEdBQUcsU0FBUyxNQUFNLENBQUMsQ0FDdEMsS0FBSyxNQUFXLEVBQUUsSUFBSSxDQUFDLENBQ3ZCLEtBQUssSUFBSTtDQUNkO0NBRUEsU0FBUyxTQUFTLFNBQTRCO0VBQzVDLElBQUksQ0FBQyxNQUFNLFFBQVEsT0FBTyxHQUFHLE9BQU8sQ0FBQztFQUNyQyxPQUFPLFFBQ0osUUFBUSxNQUFXLEdBQUcsU0FBUyxXQUFXLEVBQUUsUUFBUSxTQUFTLFFBQVEsQ0FBQyxDQUN0RSxLQUFLLE1BQVcsUUFBUSxFQUFFLE9BQU8sV0FBVyxVQUFVLEVBQUUsT0FBTyxNQUFNO0NBQzFFO0NBRUEsU0FBUyxpQkFBaUIsUUFBOEI7RUFDdEQsTUFBTSxNQUFnQixDQUFDO0VBRXZCLE1BQU0sd0JBQVEsSUFBSSxJQUFvQjtFQUN0QyxLQUFLLE1BQU0sS0FBSyxPQUFPLFVBQVU7R0FDL0IsSUFBSSxDQUFDLE1BQU0sUUFBUSxFQUFFLE9BQU8sR0FBRztHQUMvQixLQUFLLE1BQU0sS0FBSyxFQUFFLFNBQWtCLElBQUksR0FBRyxTQUFTLFlBQVksTUFBTSxJQUFJLEVBQUUsSUFBSSxFQUFFLElBQUk7RUFDeEY7RUFDQSxJQUFJLE9BQU8sUUFBUSxJQUFJLEtBQUs7R0FBRSxNQUFNO0dBQVUsU0FBUyxPQUFPO0VBQU8sQ0FBQztFQUV0RSxLQUFLLE1BQU0sS0FBSyxPQUFPLFVBQVU7R0FDL0IsSUFBSSxPQUFPLEVBQUUsWUFBWSxVQUFVO0lBQ2pDLElBQUksS0FBSztLQUFFLE1BQU0sRUFBRTtLQUFNLFNBQVMsRUFBRTtJQUFRLENBQUM7SUFDN0M7R0FDRjtHQUNBLE1BQU0sU0FBUyxFQUFFO0dBRWpCLElBQUksRUFBRSxTQUFTLGFBQWE7SUFDMUIsTUFBTSxPQUFPLFVBQVUsTUFBTTtJQUM3QixNQUFNLFFBQVEsT0FBTyxRQUFRLE1BQU0sR0FBRyxTQUFTLFVBQVU7SUFDekQsTUFBTSxNQUFjO0tBQUUsTUFBTTtLQUFhLFNBQVMsUUFBUTtJQUFLO0lBQy9ELElBQUksTUFBTSxRQUNSLElBQUksYUFBYSxNQUFNLEtBQUssT0FBTztLQUNqQyxJQUFJLEVBQUU7S0FDTixNQUFNO0tBQ04sVUFBVTtNQUFFLE1BQU0sRUFBRTtNQUFNLFdBQVcsS0FBSyxVQUFVLEVBQUUsU0FBUyxDQUFDLENBQUM7S0FBRTtJQUNyRSxFQUFFO0lBRUosSUFBSSxLQUFLLEdBQUc7SUFDWjtHQUNGO0dBSUEsTUFBTSxVQUFVLE9BQU8sUUFBUSxNQUFNLEdBQUcsU0FBUyxhQUFhO0dBQzlELE1BQU0sZ0JBQTBCLENBQUM7R0FDakMsS0FBSyxNQUFNLEtBQUssU0FBUztJQUN2QixNQUFNLE9BQU8sU0FBUyxFQUFFLE9BQU87SUFDL0IsY0FBYyxLQUFLLEdBQUcsSUFBSTtJQUMxQixJQUFJLEtBQUs7S0FDUCxNQUFNO0tBQ04sY0FBYyxFQUFFO0tBQ2hCLE1BQU0sTUFBTSxJQUFJLEVBQUUsV0FBVztLQUc3QixTQUFTLFVBQVUsRUFBRSxPQUFPLE1BQU0sS0FBSyxTQUFTLHVCQUF1QjtJQUN6RSxDQUFDO0dBQ0g7R0FFQSxNQUFNLE9BQU8sT0FBTyxRQUFRLE1BQU0sR0FBRyxTQUFTLGFBQWE7R0FDM0QsTUFBTSxRQUFrQixDQUFDO0dBQ3pCLE1BQU0sT0FBTyxVQUFVLElBQUk7R0FDM0IsSUFBSSxNQUFNLE1BQU0sS0FBSztJQUFFLE1BQU07SUFBUTtHQUFLLENBQUM7R0FDM0MsS0FBSyxNQUFNLE9BQU8sQ0FBQyxHQUFHLFNBQVMsSUFBSSxHQUFHLEdBQUcsYUFBYSxHQUNwRCxNQUFNLEtBQUs7SUFBRSxNQUFNO0lBQWEsV0FBVyxFQUFFLElBQUk7R0FBRSxDQUFDO0dBRXRELElBQUksTUFBTSxRQUNSLElBQUksS0FBSztJQUFFLE1BQU07SUFBUSxTQUFTLE1BQU0sV0FBVyxLQUFLLE9BQU8sT0FBTztHQUFNLENBQUM7RUFFakY7RUFDQSxPQUFPO0NBQ1Q7Q0FFQSxTQUFTLGNBQWMsT0FBZ0I7RUFDckMsSUFBSSxDQUFDLE9BQU8sUUFBUSxPQUFPLEtBQUE7RUFDM0IsT0FBTyxNQUFNLEtBQUssT0FBTztHQUN2QixNQUFNO0dBQ04sVUFBVTtJQUFFLE1BQU0sRUFBRTtJQUFNLGFBQWEsRUFBRTtJQUFhLFlBQVksRUFBRTtHQUFhO0VBQ25GLEVBQUU7Q0FDSjtDQVNBLFNBQVMsV0FBVyxNQUEwQjtFQUM1QyxNQUFNLFVBQVUsTUFBTSxVQUFVLEVBQUUsRUFBRSxXQUFXLENBQUM7RUFDaEQsTUFBTSxVQUFpQixDQUFDO0VBQ3hCLElBQUksUUFBUSxTQUFTLFFBQVEsS0FBSztHQUFFLE1BQU07R0FBUSxNQUFNLE9BQU8sUUFBUSxPQUFPO0VBQUUsQ0FBQztFQUVqRixNQUFNLFFBQVEsUUFBUSxjQUFjLENBQUM7RUFDckMsS0FBSyxNQUFNLEtBQUssT0FBTztHQUNyQixJQUFJLFFBQWlCLENBQUM7R0FDdEIsSUFBSTtJQUNGLFFBQVEsS0FBSyxNQUFNLEVBQUUsVUFBVSxhQUFhLElBQUk7R0FDbEQsUUFBUTtJQUlOLFFBQVEsQ0FBQztHQUNYO0dBQ0EsUUFBUSxLQUFLO0lBQUUsTUFBTTtJQUFZLElBQUksRUFBRTtJQUFJLE1BQU0sRUFBRSxVQUFVO0lBQU07R0FBTSxDQUFDO0VBQzVFO0VBRUEsT0FBTztHQUFXO0dBQTJCLGFBQWEsTUFBTSxTQUFTLGFBQWE7RUFBVztDQUNuRztDQUlBLGVBQXNCLFVBQ3BCLFFBQ0EsUUFDQSxRQUN3QjtFQUN4QixNQUFNLE1BQU0sTUFBTSxNQUFNLFVBQVU7R0FDaEMsUUFBUTtHQUNSO0dBQ0EsU0FBUztJQUFFLGdCQUFnQjtJQUFvQixlQUFlLFVBQVU7R0FBUztHQUNqRixNQUFNLEtBQUssVUFBVTtJQUNuQixPQUFPLE9BQU87SUFDZCxZQUFZLE9BQU87SUFDbkIsVUFBVSxpQkFBaUIsTUFBTTtJQUNqQyxPQUFPLGNBQWMsT0FBTyxLQUFLO0lBQ2pDLEdBQUksT0FBTyxPQUFPLFNBQVMsRUFBRSxhQUFhLE9BQU8sSUFBSSxDQUFDO0dBQ3hELENBQUM7RUFDSCxDQUFDO0VBRUQsSUFBSSxDQUFDLElBQUksSUFBSTtHQUNYLE1BQU0sT0FBTyxNQUFNLElBQUksS0FBSyxDQUFDLENBQUMsWUFBWSxFQUFFO0dBQzVDLE1BQU0sSUFBSSxNQUFNLFFBQVEsSUFBSSxPQUFPLElBQUksS0FBSyxNQUFNLEdBQUcsR0FBRyxHQUFHO0VBQzdEO0VBQ0EsT0FBTyxXQUFXLE1BQU0sSUFBSSxLQUFLLENBQUM7Q0FDcEM7OztDQ2pOQSxlQUFBLGFBQUE7Ozs7Ozs7O0NBUUE7Q0FNQSxJQUFBLGdCQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTZDQSxJQUFBLFFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQTRJQTtDQUVBLElBQUEsU0FBQSxPQUFBLElBQUEsU0FBQSxNQUFBLFdBQUEsR0FBQSxFQUFBLENBQUE7Q0FJQSxRQUFBLFFBQUEsTUFBQSxPQUFBOzs7O0NBQXdFLENBQUEsQ0FBQSxDQUFBLFlBQUEsQ0FBQSxDQUFBO0NBaUJ4RSxlQUFBLGFBQUE7OztDQUdBO0NBR0EsZUFBQSxrQkFBQTs7Ozs7Ozs7Ozs7Ozs7O0NBZUE7Q0FFQSxTQUFBLFlBQUEsU0FBQTs7Q0FNQTtDQWVBLElBQUEsY0FBQSxRQUFBO0NBQ0EsSUFBQSxhQUFBO0NBQ0EsSUFBQSxnQkFBQTtDQUNBLElBQUEsdUJBQUE7Q0FDQSxJQUFBLGVBQUE7Q0FPQSxJQUFBLGNBQUE7Ozs7Ozs7Ozs7Ozs7O0NBY0E7Q0FFQSxTQUFBLGFBQUEsR0FBQTs7Ozs7Q0FLQTtDQUdBLFNBQUEsY0FBQSxRQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0EwQkE7Q0FHQSxTQUFBLGNBQUEsUUFBQTs7Ozs7Ozs7Ozs7OztDQWlCQTtDQUVBLGVBQUEsWUFBQSxRQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBbUJBO0NBR0EsSUFBQSxlQUFBO0NBR0EsZUFBQSxlQUFBOzs7Ozs7Ozs7OztDQUtBO0NBTUEsU0FBQSxVQUFBLE1BQUE7O0NBRUE7Q0FVQSxJQUFBLGlDQUFBLElBQUEsSUFBQTs7Ozs7O0NBQStGLENBQUE7Q0FFL0YsU0FBQSxrQkFBQSxVQUFBLGFBQUE7Ozs7Ozs7Ozs7Ozs7O0NBY0E7Q0FFQSxTQUFBLFVBQUEsTUFBQSxPQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBbUNBO0NBRUEsZUFBQSxTQUFBLE1BQUEsTUFBQTs7Ozs7Ozs7Ozs7Ozs7OztDQU9BO0NBS0EsZUFBQSxTQUFBLFFBQUEsYUFBQSxRQUFBLFNBQUEsUUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQWlEQTtDQUVBLFNBQUEsZUFBQSxPQUFBLFlBQUEsS0FBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBcUJBO0NBR0EsZUFBQSxXQUFBLE9BQUEsU0FBQSxVQUFBLElBQUEsVUFBQSxHQUFBOzs7Ozs7O0NBY0E7Q0FLQSxTQUFBLFNBQUEsS0FBQTs7Ozs7Ozs7OztDQUlBO0NBSUEsZUFBQSxrQkFBQSxPQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQThCQTtDQUlBLGVBQUEsV0FBQSxPQUFBOzs7Ozs7O0NBS0E7Q0FJQSxlQUFBLFNBQUEsTUFBQSxPQUFBLFVBQUEsY0FBQSxPQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7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