import { describe, expect, test } from "bun:test";
import type { ProviderConfig } from "../src/config.ts";
import { OpenAICompatible, extractJson, extractResponsesText, unsupportedParam } from "../src/llm.ts";

const cfg = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({ provider: "openai", baseUrl: "https://llm.test/v1", apiKey: "k", model: "m", api: "chat", timeoutMs: 5000, extraHeaders: {}, ...over });

function fakeFetch(responses: { status: number; body: unknown; headers?: Record<string, string> }[]) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    const r = responses.shift() ?? { status: 500, body: { error: "no more canned responses" } };
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const noSleep = async () => {};
const chatOk = (content: string) => ({ status: 200, body: { choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } } });

describe("OpenAICompatible", () => {
  test("chat completions: effort and json mode are sent", async () => {
    const { f, calls } = fakeFetch([chatOk('{"tier":"light","reason":"x"}')]);
    const r = await new OpenAICompatible(cfg(), f, noSleep).complete({ system: "s", user: "u", effort: "high", json: true });
    expect(calls[0]!.url).toBe("https://llm.test/v1/chat/completions");
    expect(calls[0]!.body.reasoning_effort).toBe("high");
    expect(calls[0]!.body.response_format).toEqual({ type: "json_object" });
    expect(calls[0]!.headers.authorization).toBe("Bearer k");
    expect(r.text).toBe('{"tier":"light","reason":"x"}');
    expect(r.usage).toEqual({ input: 10, output: 5 });
  });
  test("a 400 naming reasoning_effort is retried without it, and reported", async () => {
    const { f, calls } = fakeFetch([{ status: 400, body: { error: { message: "Unsupported parameter: 'reasoning_effort' is not supported with this model." } } }, chatOk("ok")]);
    const r = await new OpenAICompatible(cfg(), f, noSleep).complete({ system: "s", user: "u", effort: "high" });
    expect(calls.length).toBe(2);
    expect(calls[1]!.body.reasoning_effort).toBeUndefined();
    expect(r.droppedParams).toEqual(["reasoning_effort"]);
  });
  test("a 400 about something else is an error, not a loop", async () => {
    const { f, calls } = fakeFetch([{ status: 400, body: { error: { message: "This model's maximum context length is 128000 tokens" } } }]);
    await expect(new OpenAICompatible(cfg(), f, noSleep).complete({ system: "s", user: "u", effort: "high" })).rejects.toThrow(/400/);
    expect(calls.length).toBe(1);
  });
  test("429 then 200 is retried", async () => {
    const { f, calls } = fakeFetch([{ status: 429, body: { error: "slow down" }, headers: { "retry-after": "0" } }, chatOk("fine")]);
    const r = await new OpenAICompatible(cfg(), f, noSleep).complete({ system: "s", user: "u" });
    expect(r.text).toBe("fine");
    expect(calls.length).toBe(2);
  });
  test("no effort → no reasoning parameter at all (a plain model never sees it)", async () => {
    const { f, calls } = fakeFetch([chatOk("x")]);
    await new OpenAICompatible(cfg(), f, noSleep).complete({ system: "s", user: "u", effort: "none" });
    expect("reasoning_effort" in calls[0]!.body).toBe(false);
  });
  test("xhigh is sent through untouched (the API documents low, medium, high, xhigh, max)", async () => {
    const { f, calls } = fakeFetch([chatOk("x")]);
    await new OpenAICompatible(cfg(), f, noSleep).complete({ system: "s", user: "u", effort: "xhigh" });
    expect(calls[0]!.body.reasoning_effort).toBe("xhigh");
  });
  test("responses API shape", async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { output_text: "hello", usage: { input_tokens: 3, output_tokens: 1 } } }]);
    const r = await new OpenAICompatible(cfg({ api: "responses" }), f, noSleep).complete({ system: "s", user: "u", effort: "low", json: true });
    expect(calls[0]!.url).toBe("https://llm.test/v1/responses");
    expect(calls[0]!.body.instructions).toBe("s");
    expect(calls[0]!.body.reasoning).toEqual({ effort: "low" });
    expect(r.text).toBe("hello");
  });
  test("extra headers reach the endpoint and no key means no authorization header", async () => {
    const { f, calls } = fakeFetch([chatOk("x")]);
    await new OpenAICompatible(cfg({ apiKey: "", extraHeaders: { "CF-Access-Client-Id": "id" } }), f, noSleep).complete({ system: "s", user: "u" });
    expect(calls[0]!.headers["CF-Access-Client-Id"]).toBe("id");
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });
  test("a missing model is refused up front", () => {
    expect(() => new OpenAICompatible(cfg({ model: "" }))).toThrow(/no model/);
  });
});

describe("parsers", () => {
  test("unsupportedParam", () => {
    expect(unsupportedParam("Unrecognized request argument supplied: reasoning_effort", "chat", new Set())).toBe("reasoning_effort");
    expect(unsupportedParam("response_format is not supported by this model", "chat", new Set())).toBe("response_format");
    expect(unsupportedParam("Unsupported parameter: 'reasoning'", "responses", new Set())).toBe("reasoning");
    expect(unsupportedParam("Invalid value: 'text.format.type'", "responses", new Set())).toBe("text");
    expect(unsupportedParam("context length exceeded", "chat", new Set())).toBeNull();
    expect(unsupportedParam("reasoning_effort unsupported", "chat", new Set(["reasoning_effort"]))).toBeNull();
  });
  test("extractJson tolerates fences and prose", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a":{"b":[1,2]}} hope that helps')).toEqual({ a: { b: [1, 2] } });
    expect(() => extractJson("no json here")).toThrow(/no JSON object/);
  });
  test("extractResponsesText walks the output array", () => {
    expect(extractResponsesText({ output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: "a" }, { type: "output_text", text: "b" }] }] })).toBe("ab");
  });
});
