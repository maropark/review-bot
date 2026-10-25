/**
 * TypeSafe's System One API (Jev) as the triage model. Jev does not generate
 * text: it answers typed questions over a `state` with calibrated
 * probabilities, which is exactly what a system-1 router wants. One request
 * carries the tier Choice and a handful of speculative Nouls; code decides what
 * to do with the probabilities.
 *
 * Reference: https://docs.typesafe.ai/api.md (POST /v1/systemone, bearer auth,
 * `model`, `state`, `questions`; answers keyed by question name).
 */

import type { ProviderConfig } from "./config.ts";
import { LLMError } from "./llm.ts";
import type { ClassifierInput, ClassifierResult } from "./triage.ts";
import type { Logger, Tier } from "./types.ts";
import { silentLogger } from "./types.ts";

export type SystemOneQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string };

export interface SystemOneRequest {
  model: string;
  state: unknown;
  questions: Record<string, SystemOneQuestion>;
}

export type SystemOneAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "noul"; noul: number };

export interface SystemOneResponse {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

type FetchLike = typeof fetch;

export class TypeSafe {
  constructor(
    private cfg: ProviderConfig,
    private fetchImpl: FetchLike = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!cfg.apiKey) throw new LLMError(0, "TRIAGE_API_KEY is required for the TypeSafe triage");
  }

  get model(): string {
    return this.cfg.model || "jev-latest";
  }

  async systemOne(req: Omit<SystemOneRequest, "model"> & { model?: string }): Promise<SystemOneResponse> {
    const body: SystemOneRequest = { model: req.model ?? this.model, state: req.state, questions: req.questions };
    for (let attempt = 1; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.cfg.baseUrl}/v1/systemone`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}`, ...this.cfg.extraHeaders },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        if (attempt < 3) {
          await this.sleep(1000 * attempt);
          continue;
        }
        throw new LLMError(0, `${this.cfg.baseUrl}/v1/systemone: ${e instanceof Error ? e.message : String(e)}`);
      }
      clearTimeout(timer);
      const text = await res.text();
      if (res.ok) {
        try {
          return JSON.parse(text) as SystemOneResponse;
        } catch {
          throw new LLMError(res.status, `/v1/systemone returned non-JSON: ${text.slice(0, 200)}`);
        }
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * attempt);
        continue;
      }
      throw new LLMError(res.status, `/v1/systemone → ${res.status}: ${text.slice(0, 400)}`);
    }
  }
}

/** The state Jev judges: named fields, never the diff. */
export function triageState(input: ClassifierInput) {
  const { signals, config } = input;
  return {
    title: signals.title,
    author: signals.author,
    author_type: signals.authorType,
    labels: signals.labels,
    size: { files: signals.files.length, additions: signals.additions, deletions: signals.deletions },
    ci: signals.checks.overall,
    files: signals.files.slice(0, 150).map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, status: f.status })),
    files_omitted: Math.max(0, signals.files.length - 150),
    description: (signals.body || "").slice(0, 2000),
    risk_areas: config.risk.map((r) => r.label),
  };
}

export const TIER_QUESTION: SystemOneQuestion = {
  type: "choice",
  instructions:
    "How much independent code review does this pull request need before it merges? Judge from `title`, `description` (the author's own claim, not evidence), the `files` changed with their sizes and statuses, `labels` and `author`. The repository names its high-risk areas in `risk_areas`; no path rule matched this PR, so judge whether the change still touches those concerns by what it does.",
  criteria: {
    light: "Cosmetic, documentation, copy, or configuration nobody else depends on; a change a reader verifies at a glance; no new data path and no behaviour another system or user relies on.",
    standard: "An ordinary code change with a bounded blast radius: new or changed behaviour inside one feature, touching no money, permissions, stored data shape, external contract or CI.",
    adversarial: "Money, prices, payments or postage; data integrity, a migration or a stored data shape; authentication, authorization or permissions; a contract another system depends on; concurrency or a read-then-write; CI, build or deploy configuration; the tests or fixtures themselves; or a diff too large or tangled to reason about quickly.",
  },
};

export const FLAG_QUESTIONS: Record<string, SystemOneQuestion> = {
  money: { type: "noul", instructions: "Does this change affect how money, prices, discounts, payments, refunds, commissions, postage or anything purchasable is computed, charged or recorded?" },
  auth: { type: "noul", instructions: "Does this change affect who may do what: authentication, sessions, roles, permissions, access checks, or a route reachable without them?" },
  data: { type: "noul", instructions: "Does this change alter how data is stored or migrated, the shape of stored data, or a read-then-write that could lose an update under concurrency?" },
  contract: { type: "noul", instructions: "Does this change alter a payload, endpoint, webhook, file format or schedule that another system depends on?" },
  tests_weakened: { type: "noul", instructions: "Does this change remove, skip, loosen or disable a test, fixture, assertion, lint rule or check?" },
};

/** Code owns the policy: low confidence never goes lighter than standard; a strong flag lifts light to standard. */
export function tierFromAnswers(
  answers: Record<string, SystemOneAnswer>,
  thresholds = { lowConfidence: 0.5, flag: 0.6, strongFlag: 0.75 },
): ClassifierResult | null {
  const tierAnswer = answers.tier;
  if (!tierAnswer || tierAnswer.type !== "choice") return null;
  const choice = tierAnswer.choice;
  if (choice !== "light" && choice !== "standard" && choice !== "adversarial") return null;
  let tier: Exclude<Tier, "skip"> = choice;
  const notes: string[] = [];
  const flags: Record<string, number> = {};
  for (const [name, a] of Object.entries(answers)) {
    if (a.type === "noul" && name in FLAG_QUESTIONS) flags[name] = a.noul;
  }
  const raised = Object.entries(flags)
    .filter(([, p]) => p >= thresholds.flag)
    .sort((a, b) => b[1] - a[1]);
  if (tier === "light" && tierAnswer.confidence < thresholds.lowConfidence) {
    tier = "standard";
    notes.push(`confidence ${tierAnswer.confidence.toFixed(2)} is low, so not lighter than standard`);
  }
  if (tier === "light" && raised.some(([, p]) => p >= thresholds.strongFlag)) {
    tier = "standard";
    notes.push("a strong flag lifts light to standard");
  }
  const probs = Object.entries(tierAnswer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .map(([k, p]) => `${k} ${p.toFixed(2)}`)
    .join(", ");
  const flagText = raised.length ? `; flags: ${raised.map(([k, p]) => `${k} ${p.toFixed(2)}`).join(", ")}` : "";
  const reason = `Jev chose ${choice} (${probs}; confidence ${tierAnswer.confidence.toFixed(2)})${flagText}${notes.length ? ` — ${notes.join("; ")}` : ""}`;
  const worry = raised.length ? `The triage model flagged this change as likely touching: ${raised.map(([k, p]) => `${k} (${p.toFixed(2)})`).join(", ")}.` : undefined;
  return { tier, reason, flags, ...(worry ? { worry } : {}) };
}

export function typesafeClassifier(client: TypeSafe, log: Logger = silentLogger) {
  return async (input: ClassifierInput): Promise<ClassifierResult | null> => {
    const res = await client.systemOne({ state: triageState(input), questions: { tier: TIER_QUESTION, ...FLAG_QUESTIONS } });
    log.debug(`TypeSafe ${res.model}: ${JSON.stringify(res.answers)}${res.usage ? ` (${res.usage.input_tokens ?? "?"} input tokens)` : ""}`);
    return tierFromAnswers(res.answers);
  };
}
