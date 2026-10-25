/**
 * System 1. Cheap signals only: changed paths against the repo's risk list,
 * diff size, what CI says, who the author is, the labels. Deterministic rules
 * decide everything they can; a small model is asked only about the PRs the
 * rules leave open, and a failed or absent model falls back to size.
 *
 * The decision is data — it is logged as the first line of the posted review
 * so anyone can see why a PR got the review it got.
 */

import type { RepoConfig } from "./config.ts";
import { matchAny } from "./glob.ts";
import type { ChangedFile, Decision, Effort, ForcedRule, PRSignals, Tier } from "./types.ts";
import { strongerTier } from "./types.ts";

export interface ClassifierInput {
  signals: PRSignals;
  config: RepoConfig;
}

export type ClassifierResult = { tier: Exclude<Tier, "skip">; reason: string };
export type Classifier = (input: ClassifierInput) => Promise<ClassifierResult | null>;

/** "Bump x from 1.2.3 to 2.0.0" — a major version change, which earns a review a bot's patch bump does not. */
export function isMajorBump(title: string): boolean {
  const m = title.match(/\bfrom\s+v?(\d+)(?:\.[\w.-]*)?\s+to\s+v?(\d+)(?:\.[\w.-]*)?/i);
  if (m) return m[1] !== m[2];
  return /\bmajor\b/i.test(title);
}

export function forcedRules(files: ChangedFile[], config: RepoConfig): ForcedRule[] {
  const out: ForcedRule[] = [];
  for (const rule of config.risk) {
    const hits = files.filter((f) => matchAny(rule.paths, f.filename) || (f.previous_filename ? matchAny(rule.paths, f.previous_filename) : false)).map((f) => f.filename);
    if (hits.length) out.push({ rule: rule.label, tier: rule.tier, approve: rule.approve, paths: hits });
  }
  return out;
}

export function isDocsOnly(files: ChangedFile[], config: RepoConfig): boolean {
  return files.length > 0 && files.every((f) => matchAny(config.docsOnly, f.filename));
}

export function sizeTier(lines: number, config: RepoConfig): Exclude<Tier, "skip"> {
  if (lines <= config.size.light) return "light";
  if (lines <= config.size.standard) return "standard";
  return "adversarial";
}

export async function triage(signals: PRSignals, config: RepoConfig, defaultModel: string, classify?: Classifier): Promise<Decision> {
  const reasons: string[] = [];
  const lines = signals.additions + signals.deletions;
  const owner = !!config.owner && signals.author.toLowerCase() === config.owner.toLowerCase();
  const ci = signals.checks.overall;
  let tier: Tier = "standard";
  let mayApprove = true;
  let classifier: Decision["classifier"] = "rules";
  const forced = forcedRules(signals.files, config);

  const lower = (s: string) => s.toLowerCase();
  const waived = signals.labels.find((l) => config.skip.labels.map(lower).includes(lower(l)));
  const botAuthor = config.skip.authors.map(lower).includes(lower(signals.author));

  if (signals.state !== "open") {
    tier = "skip";
    reasons.push(`the PR is ${signals.state}, not open`);
  } else if (signals.draft) {
    tier = "skip";
    reasons.push("draft PRs are not reviewed; mark it ready for review");
  } else if (waived) {
    tier = "skip";
    reasons.push(`label "${waived}" waives the review`);
  } else if (forced.length) {
    tier = forced.reduce<Tier>((t, f) => strongerTier(t, f.tier), "light");
    for (const f of forced) {
      reasons.push(`risk rule "${f.rule}" matched ${f.paths.length === 1 ? f.paths[0] : `${f.paths.length} files (${f.paths.slice(0, 3).join(", ")}${f.paths.length > 3 ? ", …" : ""})`} → ${f.tier}${f.approve ? "" : ", no approval"}`);
      if (!f.approve) mayApprove = false;
    }
  } else if (botAuthor) {
    if (isMajorBump(signals.title)) {
      tier = "standard";
      reasons.push(`author ${signals.author} is a bot, but the title reads as a major version bump — a review it does want`);
    } else {
      tier = "skip";
      reasons.push(`author ${signals.author} is in skip.authors and this is not a major bump; CI proving the bump builds is the whole check`);
    }
  } else if (isDocsOnly(signals.files, config) && lines <= config.size.standard) {
    tier = "light";
    reasons.push(`documentation only (${signals.files.length} file${signals.files.length === 1 ? "" : "s"}, ${lines} lines)`);
  } else if (classify) {
    try {
      const r = await classify({ signals, config });
      if (r) {
        tier = r.tier;
        classifier = "model";
        reasons.push(`triage model: ${r.reason}`);
      } else {
        tier = sizeTier(lines, config);
        classifier = "fallback";
        reasons.push(`triage model gave no usable answer; by size (${lines} lines) → ${tier}`);
      }
    } catch (e) {
      tier = sizeTier(lines, config);
      classifier = "fallback";
      reasons.push(`triage model failed (${e instanceof Error ? e.message.slice(0, 120) : String(e)}); by size (${lines} lines) → ${tier}`);
    }
  } else {
    tier = sizeTier(lines, config);
    reasons.push(`no triage model configured; by size (${lines} lines, ${signals.files.length} files) → ${tier}`);
  }

  if (tier !== "skip") {
    if (ci === "red") {
      tier = strongerTier(tier, "adversarial");
      mayApprove = false;
      reasons.push("a required check is failing → adversarial, no approval");
    } else if (ci === "unknown") {
      mayApprove = false;
      reasons.push(`the required checks could not be read${signals.checks.note ? ` (${signals.checks.note})` : ""} → no approval`);
    } else if (ci === "pending") {
      reasons.push("required checks still pending; the approval step re-reads them");
    }
  }

  if (tier === "skip") mayApprove = false;
  if (!config.approval.enabled) {
    if (mayApprove) reasons.push("approval is disabled in review-bot.json");
    mayApprove = false;
  } else if (tier !== "skip" && !config.approval.tiers.includes(tier)) {
    if (mayApprove) reasons.push(`tier ${tier} is not in approval.tiers`);
    mayApprove = false;
  }
  if (owner) reasons.push(`author ${signals.author} is the configured owner (a signal, not a permission)`);

  const settings = tier === "skip" ? null : config.tiers[tier];
  const effort: Effort = settings ? settings.effort : "none";
  const model = settings ? settings.model ?? defaultModel : "";

  return {
    tier,
    model,
    effort,
    may_approve: mayApprove,
    forced,
    reasons,
    classifier,
    signals: {
      files: signals.files.length,
      additions: signals.additions,
      deletions: signals.deletions,
      ci,
      author: signals.author,
      owner,
      labels: signals.labels,
    },
  };
}

/** The audit line: first line of everything the bot posts. */
export function formatDecisionLine(d: Decision, version: string): string {
  const forced = d.forced.length ? d.forced.map((f) => f.rule).join("; ") : "none";
  return [
    `review-bot ${version}`,
    `tier=${d.tier}`,
    `model=${d.model || "-"}`,
    `effort=${d.effort}`,
    `may_approve=${d.may_approve ? "yes" : "no"}`,
    `classifier=${d.classifier}`,
    `forced=${forced}`,
    `ci=${d.signals.ci}`,
    `${d.signals.files} files +${d.signals.additions}/−${d.signals.deletions}`,
    `author=${d.signals.author}${d.signals.owner ? " (owner)" : ""}`,
    `labels=${d.signals.labels.length ? d.signals.labels.join(",") : "none"}`,
  ].join(" · ");
}

/** The prompt for the small model. It sees a summary, never the diff. */
export function classifierPrompts(input: ClassifierInput): { system: string; user: string } {
  const { signals, config } = input;
  const system = [
    "You are the fast triage in front of a code-review bot. Decide how much review this pull request needs, from its summary alone.",
    "Answer with one JSON object and nothing else: {\"tier\": \"light\" | \"standard\" | \"adversarial\", \"reason\": \"<one sentence>\"}.",
    "light: cosmetic, documentation, copy, a config nobody else reads, or a change a glance verifies.",
    "standard: an ordinary code change with a bounded blast radius.",
    "adversarial: anything touching money, data integrity, authentication or permissions, a contract another system depends on, concurrency, a migration, CI or deploy configuration, test or fixture logic, or a diff too large or tangled to reason about quickly.",
    "When unsure, say standard. Never say skip.",
    config.risk.length ? `The repository names these areas as high risk (no path matched this PR, but the names are a hint): ${config.risk.map((r) => r.label).join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const files = signals.files
    .slice(0, 150)
    .map((f) => `- ${f.filename} (+${f.additions}/−${f.deletions}${f.status !== "modified" ? `, ${f.status}` : ""})`)
    .join("\n");
  const user = [
    `Title: ${signals.title}`,
    `Author: ${signals.author} (${signals.authorType})${signals.labels.length ? ` · labels: ${signals.labels.join(", ")}` : ""}`,
    `Size: ${signals.files.length} files, +${signals.additions}/−${signals.deletions}`,
    `CI: ${signals.checks.overall}`,
    "",
    "Changed files:",
    files + (signals.files.length > 150 ? `\n- … ${signals.files.length - 150} more` : ""),
    "",
    "Description (the author's claim, not evidence):",
    (signals.body || "(none)").slice(0, 1500),
  ].join("\n");
  return { system, user };
}

export function parseClassifierReply(parsed: unknown): ClassifierResult | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as { tier?: unknown; reason?: unknown };
  const tier = typeof p.tier === "string" ? p.tier.trim().toLowerCase() : "";
  if (tier !== "light" && tier !== "standard" && tier !== "adversarial") return null;
  return { tier, reason: typeof p.reason === "string" && p.reason.trim() ? p.reason.trim().slice(0, 300) : "no reason given" };
}
