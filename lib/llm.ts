// Model provider — Groq (OpenAI-compatible chat completions).
//
// The agent loop internally speaks in content blocks (text / tool_use /
// tool_result / image), which is a convenient shape for a tool-calling loop.
// This module owns those types and translates them to and from Groq's wire
// format, so nothing else in the codebase deals with the API shape.
//
// Reached with plain fetch — a whole SDK for one POST isn't worth the bundle.

/* ── The shapes the rest of Tidra uses ────────────────────────────────────── */

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: any;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | (TextBlock | ImageBlock)[];
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface Tool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/* ── Models ───────────────────────────────────────────────────────────────── */

// Verified against console.groq.com/docs/models. Prices per 1M tokens (in/out).
export const GROQ_MODELS = {
  //  $0.15 / $0.60 — flagship open weight, 131k context, ~500 t/s. The agent.
  big: 'openai/gpt-oss-120b',
  // $0.075 / $0.30 — same family, ~1000 t/s. Chat and summaries.
  small: 'openai/gpt-oss-20b',
  //  $0.05 / $0.08 — cheapest on the platform. Only ever classifies one word.
  router: 'llama-3.1-8b-instant',
  //  $0.60 / $3.00 — the only Groq model that can read an image, and a PREVIEW
  //  model Groq may withdraw at short notice. Reserved for the screenshot tool.
  vision: 'qwen/qwen3.6-27b',
};

// Neither GPT-OSS model can request two tools in one turn (the Llama and Qwen
// models can). The agent loop handles either, but on GPT-OSS expect exactly one
// action per round trip.
export const NO_PARALLEL_TOOLS = new Set(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Which model handles what, per cost tier. */
export const TIERS: Record<string, { chat: string; act: string; router: string }> = {
  economy: { chat: GROQ_MODELS.small, act: GROQ_MODELS.small, router: GROQ_MODELS.router },
  balanced: { chat: GROQ_MODELS.small, act: GROQ_MODELS.big, router: GROQ_MODELS.router },
  quality: { chat: GROQ_MODELS.big, act: GROQ_MODELS.big, router: GROQ_MODELS.router },
};

export function tierFor(name: string | undefined) {
  return TIERS[name || 'balanced'] || TIERS.balanced;
}

/** Only the vision model can read the screenshots the fallback tool takes. */
export function supportsVision(model: string): boolean {
  return model === GROQ_MODELS.vision;
}

export interface CallParams {
  model: string;
  max_tokens: number;
  system: string;
  messages: Message[];
  tools?: Tool[];
}

/* ── Our shape → Groq (OpenAI) shape ──────────────────────────────────────── */

type OaiMsg = Record<string, any>;

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('\n');
}

function imagesIn(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((b: any) => b?.type === 'image' && b.source?.type === 'base64')
    .map((b: any) => `data:${b.source.media_type};base64,${b.source.data}`);
}

function toOpenAiMessages(params: CallParams): OaiMsg[] {
  const out: OaiMsg[] = [];
  // tool_use_id → tool name, which Groq wants echoed back on each tool result.
  const names = new Map<string, string>();
  for (const m of params.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as any[]) if (b?.type === 'tool_use') names.set(b.id, b.name);
  }
  if (params.system) out.push({ role: 'system', content: params.system });

  for (const m of params.messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = m.content as any[];

    if (m.role === 'assistant') {
      const text = blockText(blocks);
      const calls = blocks.filter((b) => b?.type === 'tool_use');
      const msg: OaiMsg = { role: 'assistant', content: text || null };
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }));
      }
      out.push(msg);
      continue;
    }

    // User turn: tool results become their own `tool` messages, and anything
    // else (text, images) follows as a normal user message.
    const results = blocks.filter((b) => b?.type === 'tool_result');
    const pendingImages: string[] = [];
    for (const r of results) {
      const imgs = imagesIn(r.content);
      pendingImages.push(...imgs);
      out.push({
        role: 'tool',
        tool_call_id: r.tool_use_id,
        name: names.get(r.tool_use_id),
        // OpenAI tool messages are text-only; an attached image is re-sent
        // below as a user message so vision models can still see it.
        content: blockText(r.content) || (imgs.length ? '(screenshot below)' : '(done)'),
      });
    }

    const rest = blocks.filter((b) => b?.type !== 'tool_result');
    const parts: OaiMsg[] = [];
    const text = blockText(rest);
    if (text) parts.push({ type: 'text', text });
    for (const url of [...imagesIn(rest), ...pendingImages]) {
      parts.push({ type: 'image_url', image_url: { url } });
    }
    if (parts.length) {
      out.push({ role: 'user', content: parts.length === 1 && text ? text : parts });
    }
  }
  return out;
}

function toOpenAiTools(tools?: Tool[]) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/* ── Groq shape → our shape ───────────────────────────────────────────────── */

export interface ModelResponse {
  content: ContentBlock[];
  stop_reason: string;
}

function fromOpenAi(data: any): ModelResponse {
  const message = data?.choices?.[0]?.message ?? {};
  const content: any[] = [];
  if (message.content) content.push({ type: 'text', text: String(message.content) });

  const calls = message.tool_calls ?? [];
  for (const c of calls) {
    let input: unknown = {};
    try {
      input = JSON.parse(c.function?.arguments || '{}');
    } catch {
      // Weaker models sometimes emit malformed JSON. Pass an empty input so the
      // tool reports a real error the model can recover from, rather than
      // crashing the whole turn.
      input = {};
    }
    content.push({ type: 'tool_use', id: c.id, name: c.function?.name, input });
  }

  return { content: content as ContentBlock[], stop_reason: calls.length ? 'tool_use' : 'end_turn' };
}

/* ── The one call everything goes through ─────────────────────────────────── */

export async function callModel(
  apiKey: string,
  params: CallParams,
  signal?: AbortSignal,
): Promise<ModelResponse> {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.max_tokens,
      messages: toOpenAiMessages(params),
      tools: toOpenAiTools(params.tools),
      ...(params.tools?.length ? { tool_choice: 'auto' } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${body.slice(0, 400)}`);
  }
  return fromOpenAi(await res.json());
}

/* ── Streaming, for the new tab's inline answers ──────────────────────────── */

export async function streamText(
  apiKey: string,
  params: { model: string; max_tokens: number; system: string; messages: { role: 'user' | 'assistant'; content: string }[] },
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: params.model,
      max_tokens: params.max_tokens,
      stream: true,
      messages: [{ role: 'system', content: params.system }, ...params.messages],
    }),
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${body.slice(0, 400)}`);
  }

  // Server-sent events: "data: {json}\n\n", ending with "data: [DONE]".
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') return;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
        if (delta) onDelta(String(delta));
      } catch {
        /* keep-alive or partial frame — ignore */
      }
    }
  }
}
