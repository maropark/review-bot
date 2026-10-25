/**
 * Two kinds of configuration, deliberately apart:
 *
 *  - PROVIDER settings come from the environment (`REVIEW_*`, `TRIAGE_*`).
 *    Which model answers, where it lives and with which key is an operational
 *    choice, so it is a repository variable or secret, never a committed file.
 *    Switching from OpenAI to OpenRouter, Ollama, vLLM or LM Studio is a new
 *    `REVIEW_BASE_URL`; nothing in the code knows the difference.
 *
 *  - REPO settings come from `.github/review-bot.json` in the reviewed repo:
 *    its risk paths, its review protocol files, who its code owner is, what it
 *    lets the bot approve. Governance belongs with the repo it governs.
 */

import type { Effort, Tier } from "./types.ts";
import { REVIEW_TIERS } from "./types.ts";

export type ApiKind = "chat" | "responses";

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  api: ApiKind;
  timeoutMs: number;
  /** Extra request headers, e.g. a Cloudflare Access service token in front of a tunnel. */
  extraHeaders: Record<string, string>;
}

export interface EnvConfig {
  githubToken: string;
  githubApi: string;
  review: ProviderConfig;
  /** null → the triage runs on deterministic rules alone. */
  triage: ProviderConfig | null;
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function apiKind(v: string | undefined): ApiKind {
  const k = (v ?? "chat").trim().toLowerCase();
  if (k === "chat" || k === "responses") return k;
  throw new Error(`REVIEW_API / TRIAGE_API must be "chat" or "responses", got "${v}"`);
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`expected a non-negative number, got "${v}"`);
  return n;
}

function headers(v: string | undefined, name: string): Record<string, string> {
  if (!v || !v.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    throw new Error(`${name} must be a JSON object of header name → value`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object of header name → value`);
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val !== "string") throw new Error(`${name}: header ${k} must be a string`);
    out[k] = val;
  }
  return out;
}

export function envConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const reviewBase = trimSlash(env.REVIEW_BASE_URL?.trim() || "https://api.openai.com/v1");
  const review: ProviderConfig = {
    baseUrl: reviewBase,
    apiKey: env.REVIEW_API_KEY ?? "",
    model: env.REVIEW_MODEL?.trim() ?? "",
    api: apiKind(env.REVIEW_API),
    timeoutMs: num(env.REVIEW_TIMEOUT_SECONDS, 900) * 1000,
    extraHeaders: headers(env.REVIEW_EXTRA_HEADERS, "REVIEW_EXTRA_HEADERS"),
  };
  const triageModel = env.TRIAGE_MODEL?.trim() ?? "";
  const triage: ProviderConfig | null = triageModel
    ? {
        baseUrl: trimSlash(env.TRIAGE_BASE_URL?.trim() || reviewBase),
        apiKey: env.TRIAGE_API_KEY || review.apiKey,
        model: triageModel,
        api: apiKind(env.TRIAGE_API ?? env.REVIEW_API),
        timeoutMs: num(env.TRIAGE_TIMEOUT_SECONDS, 120) * 1000,
        extraHeaders: headers(env.TRIAGE_EXTRA_HEADERS ?? env.REVIEW_EXTRA_HEADERS, "TRIAGE_EXTRA_HEADERS"),
      }
    : null;
  return {
    githubToken: env.GITHUB_TOKEN ?? env.GH_TOKEN ?? "",
    githubApi: trimSlash(env.GITHUB_API_URL?.trim() || "https://api.github.com"),
    review,
    triage,
  };
}

// ── The repository's own configuration ──────────────────────────────────────

export interface RiskRule {
  label: string;
  paths: string[];
  /** The tier a match forces. Default: adversarial. */
  tier: Exclude<Tier, "skip">;
  /** Whether the bot may still approve when this rule matched. Default: false. */
  approve: boolean;
}

export interface TierSettings {
  /** Overrides REVIEW_MODEL for this tier. */
  model?: string;
  effort: Effort;
}

export interface RepoConfig {
  /** The human code owner / maintainer. A signal, not a permission. */
  owner: string;
  protocol: {
    /** `adversary-v1` renders the record packmaster.work's reader parses; `generic` is the plain findings list. */
    kind: "adversary-v1" | "generic";
    /** Files read from the repo at run time and handed to the reviewer as its protocol and domain rules. */
    files: string[];
  };
  risk: RiskRule[];
  skip: { labels: string[]; authors: string[] };
  tiers: Record<Exclude<Tier, "skip">, TierSettings>;
  /** Total changed lines at or below which an unforced PR is `light` / `standard`; above is `adversarial`. */
  size: { light: number; standard: number };
  /** Globs that count as documentation; a small docs-only diff is `light` without a model call. */
  docsOnly: string[];
  approval: {
    enabled: boolean;
    tiers: Tier[];
    /** rpa's rule is that a PENDING check does not block an approval; set true to require green. */
    requireGreenChecks: boolean;
    /** Post REQUEST_CHANGES when a blocker is open. Default false: a bot should not hold a merge hostage on a false positive. */
    requestChangesOnBlocker: boolean;
  };
  /** Override for the required check names; null reads them from the base branch's rules. */
  requiredChecks: string[] | null;
  post: {
    /** Also post the record as an issue comment (what /adversary does), so a comment-reading status can see it. */
    recordComment: boolean;
  };
  limits: {
    maxDiffBytes: number;
    maxInlineBytes: number;
    maxFileBytes: number;
    maxProtocolBytes: number;
    maxBodyChars: number;
  };
}

export const DEFAULT_REPO_CONFIG: RepoConfig = {
  owner: "",
  protocol: { kind: "generic", files: ["AGENTS.md"] },
  risk: [],
  skip: { labels: ["review:waived"], authors: ["dependabot[bot]"] },
  tiers: {
    light: { effort: "low" },
    standard: { effort: "medium" },
    adversarial: { effort: "high" },
  },
  size: { light: 60, standard: 400 },
  docsOnly: ["**/*.md", "**/*.mdx", "**/*.txt", "docs/**", "LICENSE*"],
  approval: { enabled: true, tiers: ["light", "standard", "adversarial"], requireGreenChecks: false, requestChangesOnBlocker: false },
  requiredChecks: null,
  post: { recordComment: false },
  limits: { maxDiffBytes: 300_000, maxInlineBytes: 200_000, maxFileBytes: 60_000, maxProtocolBytes: 60_000, maxBodyChars: 6_000 },
};

export class ConfigError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function strings(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) throw new ConfigError(`${where} must be an array of strings`);
  return v as string[];
}

function bool(v: unknown, where: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") throw new ConfigError(`${where} must be true or false`);
  return v;
}

function int(v: unknown, where: string, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ConfigError(`${where} must be a non-negative integer`);
  return v;
}

const EFFORTS: readonly Effort[] = ["none", "low", "medium", "high"];
const TIERS: readonly Tier[] = ["skip", "light", "standard", "adversarial"];

function effort(v: unknown, where: string, fallback: Effort): Effort {
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !EFFORTS.includes(v as Effort)) throw new ConfigError(`${where} must be one of ${EFFORTS.join(", ")}`);
  return v as Effort;
}

/** Parse and validate a repo config object, filling defaults. Throws ConfigError with a readable message. */
export function parseRepoConfig(raw: unknown): RepoConfig {
  if (raw === null || raw === undefined) return structuredClone(DEFAULT_REPO_CONFIG);
  if (!isRecord(raw)) throw new ConfigError("review-bot.json must be a JSON object");
  const d = DEFAULT_REPO_CONFIG;

  if (raw.owner !== undefined && typeof raw.owner !== "string") throw new ConfigError("owner must be a string");

  let protocol = { ...d.protocol, files: [...d.protocol.files] };
  if (raw.protocol !== undefined) {
    if (!isRecord(raw.protocol)) throw new ConfigError("protocol must be an object");
    const kind = raw.protocol.kind ?? d.protocol.kind;
    if (kind !== "adversary-v1" && kind !== "generic") throw new ConfigError('protocol.kind must be "adversary-v1" or "generic"');
    protocol = { kind, files: raw.protocol.files === undefined ? [...d.protocol.files] : strings(raw.protocol.files, "protocol.files") };
  }

  const risk: RiskRule[] = [];
  if (raw.risk !== undefined) {
    if (!Array.isArray(raw.risk)) throw new ConfigError("risk must be an array");
    raw.risk.forEach((r, i) => {
      if (!isRecord(r)) throw new ConfigError(`risk[${i}] must be an object`);
      if (typeof r.label !== "string" || !r.label.trim()) throw new ConfigError(`risk[${i}].label must be a non-empty string`);
      const paths = strings(r.paths, `risk[${i}].paths`);
      if (paths.length === 0) throw new ConfigError(`risk[${i}].paths must name at least one glob`);
      const tier = r.tier ?? "adversarial";
      if (!REVIEW_TIERS.includes(tier as Exclude<Tier, "skip">)) throw new ConfigError(`risk[${i}].tier must be one of ${REVIEW_TIERS.join(", ")}`);
      risk.push({ label: r.label, paths, tier: tier as Exclude<Tier, "skip">, approve: bool(r.approve, `risk[${i}].approve`, false) });
    });
  }

  let skip = { labels: [...d.skip.labels], authors: [...d.skip.authors] };
  if (raw.skip !== undefined) {
    if (!isRecord(raw.skip)) throw new ConfigError("skip must be an object");
    skip = {
      labels: raw.skip.labels === undefined ? skip.labels : strings(raw.skip.labels, "skip.labels"),
      authors: raw.skip.authors === undefined ? skip.authors : strings(raw.skip.authors, "skip.authors"),
    };
  }

  const tiers = structuredClone(d.tiers);
  if (raw.tiers !== undefined) {
    if (!isRecord(raw.tiers)) throw new ConfigError("tiers must be an object");
    for (const t of REVIEW_TIERS) {
      const v = raw.tiers[t];
      if (v === undefined) continue;
      if (!isRecord(v)) throw new ConfigError(`tiers.${t} must be an object`);
      if (v.model !== undefined && typeof v.model !== "string") throw new ConfigError(`tiers.${t}.model must be a string`);
      tiers[t] = { ...(typeof v.model === "string" ? { model: v.model } : {}), effort: effort(v.effort, `tiers.${t}.effort`, d.tiers[t].effort) };
    }
    for (const k of Object.keys(raw.tiers)) {
      if (!REVIEW_TIERS.includes(k as Exclude<Tier, "skip">)) throw new ConfigError(`tiers.${k} is not a tier (${REVIEW_TIERS.join(", ")})`);
    }
  }

  let size = { ...d.size };
  if (raw.size !== undefined) {
    if (!isRecord(raw.size)) throw new ConfigError("size must be an object");
    size = { light: int(raw.size.light, "size.light", d.size.light), standard: int(raw.size.standard, "size.standard", d.size.standard) };
    if (size.light > size.standard) throw new ConfigError("size.light must not exceed size.standard");
  }

  const docsOnly = raw.docsOnly === undefined ? [...d.docsOnly] : strings(raw.docsOnly, "docsOnly");

  let approval = { ...d.approval, tiers: [...d.approval.tiers] };
  if (raw.approval !== undefined) {
    if (!isRecord(raw.approval)) throw new ConfigError("approval must be an object");
    const at = raw.approval.tiers === undefined ? approval.tiers : strings(raw.approval.tiers, "approval.tiers");
    for (const t of at) if (!TIERS.includes(t as Tier)) throw new ConfigError(`approval.tiers contains "${t}", not a tier`);
    approval = {
      enabled: bool(raw.approval.enabled, "approval.enabled", d.approval.enabled),
      tiers: at as Tier[],
      requireGreenChecks: bool(raw.approval.requireGreenChecks, "approval.requireGreenChecks", d.approval.requireGreenChecks),
      requestChangesOnBlocker: bool(raw.approval.requestChangesOnBlocker, "approval.requestChangesOnBlocker", d.approval.requestChangesOnBlocker),
    };
  }

  let requiredChecks: string[] | null = null;
  if (raw.requiredChecks !== undefined && raw.requiredChecks !== null) requiredChecks = strings(raw.requiredChecks, "requiredChecks");

  let post = { ...d.post };
  if (raw.post !== undefined) {
    if (!isRecord(raw.post)) throw new ConfigError("post must be an object");
    post = { recordComment: bool(raw.post.recordComment, "post.recordComment", d.post.recordComment) };
  }

  let limits = { ...d.limits };
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) throw new ConfigError("limits must be an object");
    limits = {
      maxDiffBytes: int(raw.limits.maxDiffBytes, "limits.maxDiffBytes", d.limits.maxDiffBytes),
      maxInlineBytes: int(raw.limits.maxInlineBytes, "limits.maxInlineBytes", d.limits.maxInlineBytes),
      maxFileBytes: int(raw.limits.maxFileBytes, "limits.maxFileBytes", d.limits.maxFileBytes),
      maxProtocolBytes: int(raw.limits.maxProtocolBytes, "limits.maxProtocolBytes", d.limits.maxProtocolBytes),
      maxBodyChars: int(raw.limits.maxBodyChars, "limits.maxBodyChars", d.limits.maxBodyChars),
    };
  }

  const known = new Set(["$schema", "owner", "protocol", "risk", "skip", "tiers", "size", "docsOnly", "approval", "requiredChecks", "post", "limits"]);
  for (const k of Object.keys(raw)) {
    if (!known.has(k)) throw new ConfigError(`unknown key "${k}" in review-bot.json (known: ${[...known].filter((x) => x !== "$schema").join(", ")})`);
  }

  return { owner: (raw.owner as string | undefined) ?? "", protocol, risk, skip, tiers, size, docsOnly, approval, requiredChecks, post, limits };
}

export function parseRepoConfigText(text: string | null): RepoConfig {
  if (text === null) return structuredClone(DEFAULT_REPO_CONFIG);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`review-bot.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseRepoConfig(json);
}
