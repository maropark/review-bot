import { describe, expect, test } from "bun:test";
import type { ProviderConfig } from "../src/config.ts";
import { envConfig } from "../src/config.ts";
import { FLAG_QUESTIONS, TIER_QUESTION, TypeSafe, tierFromAnswers, triageState, typesafeClassifier, type SystemOneAnswer } from "../src/typesafe.ts";
import { config, file, signals } from "./helpers.ts";

const cfg = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({ provider: "typesafe", baseUrl: "https://api.typesafe.test", apiKey: "ts-key", model: "jev-latest", api: "chat", timeoutMs: 5000, extraHeaders: {}, ...over });

function fakeFetch(responses: { status: number; body: unknown; headers?: Record<string, string> }[]) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    const r = responses.shift() ?? { status: 500, body: { detail: "no canned response" } };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const noSleep = async () => {};

const choice = (c: string, confidence: number, probabilities: Record<string, number>): SystemOneAnswer => ({ type: "choice", choice: c, confidence, probabilities });
const noul = (p: number): SystemOneAnswer => ({ type: "noul", noul: p });

describe("the state Jev judges", () => {
  test("named fields, no diff, the repo's risk labels as hints, files capped at 150", () => {
    const many = Array.from({ length: 170 }, (_, i) => file(`src/f${i}.ts`, 1, 0));
    const st = triageState({ signals: signals({ files: many, body: "x".repeat(5000) }), config: config({ risk: [{ label: "money", paths: ["a"], tier: "adversarial", approve: false }] }) });
    expect(st.files.length).toBe(150);
    expect(st.files_omitted).toBe(20);
    expect(st.risk_areas).toEqual(["money"]);
    expect(st.description.length).toBe(2000);
    expect(JSON.stringify(st)).not.toContain("diff --git");
  });
  test("the tier question offers exactly the three review tiers", () => {
    expect(TIER_QUESTION.type).toBe("choice");
    expect(Object.keys((TIER_QUESTION as { criteria: Record<string, string> }).criteria).sort()).toEqual(["adversarial", "light", "standard"]);
    for (const q of Object.values(FLAG_QUESTIONS)) expect(q.type).toBe("noul");
  });
});

describe("tierFromAnswers — code owns the policy", () => {
  test("a confident choice is taken as is, with the probabilities in the reason", () => {
    const r = tierFromAnswers({ tier: choice("standard", 0.7, { light: 0.1, standard: 0.8, adversarial: 0.1 }) });
    expect(r?.tier).toBe("standard");
    expect(r?.reason).toContain("standard 0.80");
    expect(r?.worry).toBeUndefined();
  });
  test("low confidence never goes lighter than standard", () => {
    const r = tierFromAnswers({ tier: choice("light", 0.3, { light: 0.4, standard: 0.35, adversarial: 0.25 }) });
    expect(r?.tier).toBe("standard");
    expect(r?.reason).toContain("confidence 0.30 is low");
  });
  test("low confidence on adversarial stays adversarial", () => {
    expect(tierFromAnswers({ tier: choice("adversarial", 0.2, { light: 0.3, standard: 0.3, adversarial: 0.4 }) })?.tier).toBe("adversarial");
  });
  test("a strong flag lifts light to standard and becomes the reviewer's worry", () => {
    const r = tierFromAnswers({ tier: choice("light", 0.9, { light: 0.9, standard: 0.05, adversarial: 0.05 }), money: noul(0.85), auth: noul(0.1) });
    expect(r?.tier).toBe("standard");
    expect(r?.flags).toEqual({ money: 0.85, auth: 0.1 });
    expect(r?.worry).toBe("The triage model flagged this change as likely touching: money (0.85).");
  });
  test("a weak flag changes nothing and is not a worry", () => {
    const r = tierFromAnswers({ tier: choice("light", 0.9, { light: 0.9, standard: 0.05, adversarial: 0.05 }), money: noul(0.5) });
    expect(r?.tier).toBe("light");
    expect(r?.worry).toBeUndefined();
  });
  test("a missing or unknown tier answer is no answer", () => {
    expect(tierFromAnswers({})).toBeNull();
    expect(tierFromAnswers({ tier: noul(0.5) })).toBeNull();
    expect(tierFromAnswers({ tier: choice("skip", 0.9, { skip: 1 }) })).toBeNull();
  });
});

describe("the TypeSafe client", () => {
  test("posts to /v1/systemone with the bearer key, the model and the questions", async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { model: "jev-1.14.0", answers: { tier: choice("light", 0.9, { light: 0.9, standard: 0.05, adversarial: 0.05 }) } } }]);
    const r = await typesafeClassifier(new TypeSafe(cfg(), f, noSleep))({ signals: signals(), config: config() });
    expect(calls[0]!.url).toBe("https://api.typesafe.test/v1/systemone");
    expect(calls[0]!.headers.authorization).toBe("Bearer ts-key");
    expect(calls[0]!.body.model).toBe("jev-latest");
    expect(Object.keys(calls[0]!.body.questions as object).sort()).toEqual(["auth", "contract", "data", "money", "tests_weakened", "tier"]);
    expect(r?.tier).toBe("light");
  });
  test("429 is retried, 422 is an error", async () => {
    const { f, calls } = fakeFetch([{ status: 429, body: {}, headers: { "retry-after": "0" } }, { status: 200, body: { model: "m", answers: {} } }]);
    await new TypeSafe(cfg(), f, noSleep).systemOne({ state: {}, questions: {} });
    expect(calls.length).toBe(2);
    const bad = fakeFetch([{ status: 422, body: { detail: "state too long" } }]);
    await expect(new TypeSafe(cfg(), bad.f, noSleep).systemOne({ state: {}, questions: {} })).rejects.toThrow(/422/);
  });
  test("no key is refused up front", () => expect(() => new TypeSafe(cfg({ apiKey: "" }))).toThrow(/TRIAGE_API_KEY/));
});

describe("provider inference from the environment", () => {
  const base = { REVIEW_MODEL: "sol", REVIEW_API_KEY: "k" };
  test("a jev model means TypeSafe, at its default endpoint, with its own key", () => {
    const e = envConfig({ ...base, TRIAGE_MODEL: "jev-latest", TRIAGE_API_KEY: "ts" });
    expect(e.triage?.provider).toBe("typesafe");
    expect(e.triage?.baseUrl).toBe("https://api.typesafe.ai");
    expect(e.triage?.apiKey).toBe("ts");
  });
  test("the TypeSafe URL means TypeSafe, and the model defaults to jev-latest", () => {
    const e = envConfig({ ...base, TRIAGE_BASE_URL: "https://api.typesafe.ai/", TRIAGE_API_KEY: "ts" });
    expect(e.triage?.provider).toBe("typesafe");
    expect(e.triage?.model).toBe("jev-latest");
  });
  test("TRIAGE_PROVIDER=typesafe is explicit; the review key is never sent to TypeSafe", () => {
    const e = envConfig({ ...base, TRIAGE_PROVIDER: "typesafe" });
    expect(e.triage?.provider).toBe("typesafe");
    expect(e.triage?.apiKey).toBe("");
  });
  test("any other triage model is an OpenAI-compatible endpoint sharing the review's URL and key", () => {
    const e = envConfig({ ...base, TRIAGE_MODEL: "small-model" });
    expect(e.triage?.provider).toBe("openai");
    expect(e.triage?.baseUrl).toBe("https://api.openai.com/v1");
    expect(e.triage?.apiKey).toBe("k");
  });
  test("no triage model and no provider means rules only", () => expect(envConfig(base).triage).toBeNull());
  test("the review cannot be TypeSafe", () => expect(() => envConfig({ ...base, REVIEW_PROVIDER: "typesafe" })).toThrow(/REVIEW_PROVIDER must be openai/));
});
