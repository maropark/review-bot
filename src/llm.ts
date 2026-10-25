/**
 * One client for every OpenAI-compatible endpoint: OpenAI, OpenRouter, Ollama,
 * vLLM, LM Studio, or an Anthropic-compatible proxy. Chat Completions by
 * default, the Responses API on request. No SDK.
 *
 * Reasoning effort and JSON mode are sent when asked for and DROPPED on the
 * one error shape every server emits for an unknown parameter — a 400 that
 * names it — so a model that has no reasoning dial still answers. The dropped
 * parameters are reported, so the decision line can say what was spent.
 */

import type { Effort } from "./types.ts";
import type { ProviderConfig } from "./config.ts";

export interface CompletionRequest {
  system: string;
  user: string;
  effort?: Effort;
  json?: boolean;
}

export interface CompletionResult {
  text: string;
  model: string;
  attempts: number;
  droppedParams: string[];
  usage?: { input?: number; output?: number };
}

export class LLMError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;

export class OpenAICompatible {
  constructor(
    private cfg: ProviderConfig,
    private fetchImpl: FetchLike = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!cfg.model) throw new LLMError(0, "no model configured (REVIEW_MODEL / TRIAGE_MODEL)");
  }

  get model(): string {
    return this.cfg.model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const dropped = new Set<string>();
    const path = this.cfg.api === "responses" ? "/responses" : "/chat/completions";
    let attempts = 0;
    for (;;) {
      attempts++;
      const body = this.cfg.api === "responses" ? responsesBody(this.cfg.model, req, dropped) : chatBody(this.cfg.model, req, dropped);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
            ...this.cfg.extraHeaders,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if (attempts < 3) {
          await this.sleep(1000 * attempts);
          continue;
        }
        throw new LLMError(0, `${this.cfg.baseUrl}${path}: ${e instanceof Error ? e.message : String(e)}`);
      }
      clearTimeout(timer);
      const text = await res.text();
      if (res.ok) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new LLMError(res.status, `${path} returned non-JSON: ${text.slice(0, 200)}`);
        }
        return {
          text: this.cfg.api === "responses" ? extractResponsesText(parsed) : extractChatText(parsed),
          model: this.cfg.model,
          attempts,
          droppedParams: [...dropped],
          usage: extractUsage(parsed),
        };
      }
      if (res.status === 400 && attempts < 6) {
        const culprit = unsupportedParam(text, this.cfg.api, dropped);
        if (culprit) {
          dropped.add(culprit);
          continue;
        }
      }
      if ((res.status === 429 || res.status >= 500) && attempts < 4) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * attempts);
        continue;
      }
      throw new LLMError(res.status, `${path} → ${res.status}: ${text.slice(0, 400)}`);
    }
  }
}

function chatBody(model: string, req: CompletionRequest, dropped: Set<string>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
  };
  if (req.effort && req.effort !== "none" && !dropped.has("reasoning_effort")) body.reasoning_effort = req.effort;
  if (req.json && !dropped.has("response_format")) body.response_format = { type: "json_object" };
  return body;
}

function responsesBody(model: string, req: CompletionRequest, dropped: Set<string>): Record<string, unknown> {
  const body: Record<string, unknown> = { model, instructions: req.system, input: req.user };
  if (req.effort && req.effort !== "none" && !dropped.has("reasoning")) body.reasoning = { effort: req.effort };
  if (req.json && !dropped.has("text")) body.text = { format: { type: "json_object" } };
  return body;
}

/** The parameter a 400 complains about, if it is one we can live without. */
export function unsupportedParam(errorText: string, api: "chat" | "responses", already: Set<string>): string | null {
  const candidates = api === "responses" ? ["reasoning", "text"] : ["reasoning_effort", "response_format"];
  const lower = errorText.toLowerCase();
  for (const c of candidates) {
    if (already.has(c)) continue;
    // "Unrecognized request argument supplied: reasoning_effort", "Unsupported parameter: 'reasoning'",
    // "reasoning_effort is not supported with this model", "'text.format' …", "response_format … not supported"
    const re = new RegExp(`(^|[^a-z_.])${c}([^a-z_]|$|\\.format)`, "i");
    if (re.test(lower) && /unsupported|unrecognized|unknown|not supported|invalid|does not support|extra inputs|not permitted|additional properties/i.test(lower)) return c;
  }
  return null;
}

export function extractChatText(parsed: unknown): string {
  const p = parsed as { choices?: { message?: { content?: unknown } }[] };
  const content = p.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")).join("");
  }
  throw new LLMError(0, "chat completion had no message content");
}

export function extractResponsesText(parsed: unknown): string {
  const p = parsed as { output_text?: unknown; output?: { type?: string; content?: { type?: string; text?: unknown }[] }[] };
  if (typeof p.output_text === "string" && p.output_text.length) return p.output_text;
  const parts: string[] = [];
  for (const item of p.output ?? []) {
    if (item.type && item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if ((c.type === "output_text" || c.type === "text") && typeof c.text === "string") parts.push(c.text);
    }
  }
  if (parts.length) return parts.join("");
  throw new LLMError(0, "response had no output text");
}

function extractUsage(parsed: unknown): CompletionResult["usage"] {
  const u = (parsed as { usage?: Record<string, unknown> }).usage;
  if (!u) return undefined;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : undefined);
  return { input: n("prompt_tokens") ?? n("input_tokens"), output: n("completion_tokens") ?? n("output_tokens") };
}

/** The first JSON object in a model reply, fences and prose tolerated. */
export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1]!.trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start === -1 || end <= start) throw new LLMError(0, `reply contained no JSON object: ${text.slice(0, 200)}`);
    return JSON.parse(t.slice(start, end + 1));
  }
}
