/**
 * The record: what the bot posts, and how it reads its own posts back.
 *
 * `adversary-v1` is the block packmaster.work's `scripts/review-record.ts`
 * parses — a `sha:` line, `status:` per finding or `verdict: clean` with three
 * `considered:` lines. `generic` is the same content as a plain list. Either
 * way the review body carries a marker naming the sha it pins and a base64
 * copy of the machine data, so a later run finds the prior findings without
 * parsing prose.
 */

import type { Decision, Finding, ReviewResult } from "./types.ts";
import { FINDING_STATUSES, SEVERITIES } from "./types.ts";

export const BOT_MARKER = "review-bot:v1";
export const ADVERSARY_MARKER = "<!-- adversary:v1 -->";

export function botMarker(sha: string, kind: "review" | "approval"): string {
  return `<!-- ${BOT_MARKER} sha=${sha} kind=${kind} -->`;
}

export function parseBotMarker(body: string | null | undefined): { sha: string; kind: "review" | "approval" } | null {
  if (!body) return null;
  const m = body.match(/<!--\s*review-bot:v1\s+sha=([0-9a-f]{7,40})\s+kind=(review|approval)\s*-->/i);
  return m ? { sha: m[1]!.toLowerCase(), kind: m[2]!.toLowerCase() as "review" | "approval" } : null;
}

export interface BotData {
  version: string;
  decision: Decision;
  review: ReviewResult;
  sha: string;
  diffBytes: number;
  files: number;
}

export function encodeData(data: BotData): string {
  return `<!-- review-bot:data:b64 ${Buffer.from(JSON.stringify(data), "utf8").toString("base64")} -->`;
}

export function decodeData(body: string | null | undefined): BotData | null {
  if (!body) return null;
  const m = body.match(/<!--\s*review-bot:data:b64\s+([A-Za-z0-9+/=]+)\s*-->/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8")) as BotData;
    if (!parsed || typeof parsed !== "object" || !parsed.review || !Array.isArray(parsed.review.findings)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function openCounts(findings: Finding[]): { blocker: number; major: number; minor: number; open: number } {
  const open = findings.filter((f) => f.status === "open");
  return {
    blocker: open.filter((f) => f.severity === "blocker").length,
    major: open.filter((f) => f.severity === "major").length,
    minor: open.filter((f) => f.severity === "minor").length,
    open: open.length,
  };
}

export function findingNumber(id: string): number | null {
  const m = id.match(/^F(\d+)$/i);
  return m ? Number(m[1]) : null;
}

export function nextFindingId(findings: Finding[]): number {
  let max = 0;
  for (const f of findings) {
    const n = findingNumber(f.id);
    if (n !== null && n > max) max = n;
  }
  return max + 1;
}

function oneLine(s: unknown): string {
  return String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeId(raw: unknown): string | null {
  const s = oneLine(raw).toUpperCase();
  const m = s.match(/^F?-?\s*(\d+)$/);
  return m ? `F${Number(m[1])}` : null;
}

/**
 * Normalise and validate what the model returned. Problems are returned, not
 * thrown, so the caller can re-prompt once with them.
 */
export function validateReview(parsed: unknown, opts: { nextId: number; priorIds: Set<string> }): { review: ReviewResult | null; problems: string[] } {
  const problems: string[] = [];
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { review: null, problems: ["the reply is not a JSON object"] };
  const p = parsed as Record<string, unknown>;

  const rawFindings = Array.isArray(p.findings) ? p.findings : p.findings === undefined ? [] : null;
  if (rawFindings === null) problems.push("findings must be an array");

  const findings: Finding[] = [];
  const seen = new Set<string>();
  (rawFindings ?? []).forEach((rf, i) => {
    if (!rf || typeof rf !== "object") {
      problems.push(`findings[${i}] is not an object`);
      return;
    }
    const f = rf as Record<string, unknown>;
    const id = normalizeId(f.id);
    if (!id) {
      problems.push(`findings[${i}].id "${oneLine(f.id)}" is not of the form F<n>`);
      return;
    }
    if (seen.has(id)) problems.push(`finding id ${id} is used twice`);
    seen.add(id);
    const n = findingNumber(id)!;
    if (!opts.priorIds.has(id) && n < opts.nextId) problems.push(`${id} is a new finding but ids below F${opts.nextId} are taken on this PR's thread; new findings start at F${opts.nextId}`);
    const severity = oneLine(f.severity).toLowerCase();
    if (!SEVERITIES.includes(severity as Finding["severity"])) problems.push(`${id}: severity "${severity}" must be one of ${SEVERITIES.join(", ")}`);
    const statusRaw = oneLine(f.status).toLowerCase() || "open";
    const status = statusRaw.startsWith("fixed") ? "fixed" : statusRaw;
    if (!FINDING_STATUSES.includes(status as Finding["status"])) problems.push(`${id}: status "${statusRaw}" must be one of ${FINDING_STATUSES.join(", ")}`);
    const where = oneLine(f.where);
    const claim = oneLine(f.claim);
    const scenario = oneLine(f.scenario);
    if (!where) problems.push(`${id}: "where" (path:line) is empty`);
    if (!claim) problems.push(`${id}: "claim" is empty`);
    if (!scenario) problems.push(`${id}: "scenario" is empty — a finding whose scenario cannot be stated is not a finding`);
    const note = oneLine(f.note);
    findings.push({
      id,
      severity: severity as Finding["severity"],
      where,
      claim,
      scenario,
      status: status as Finding["status"],
      ...(note ? { note } : {}),
    });
  });

  const considered = Array.isArray(p.considered) ? p.considered.map(oneLine).filter(Boolean) : [];
  let verdict = oneLine(p.verdict).toLowerCase();
  if (verdict !== "clean" && verdict !== "findings") verdict = findings.length ? "findings" : "clean";
  const open = findings.filter((f) => f.status === "open");
  if (verdict === "clean") {
    if (open.length) problems.push(`verdict is clean but ${open.length} finding(s) are open`);
    if (considered.length < 3) problems.push(`a clean verdict needs at least three "considered" lines (got ${considered.length}), each naming a specific thing looked for and why it is absent`);
  } else if (findings.length === 0) {
    problems.push('verdict is "findings" but there are none');
  }

  const summary = oneLine(p.summary);
  const review: ReviewResult = { verdict: verdict as ReviewResult["verdict"], findings, considered, ...(summary ? { summary } : {}) };
  return { review: problems.length ? null : review, problems };
}

// ── Rendering ───────────────────────────────────────────────────────────────

export interface RecordInput {
  sha: string;
  diffBytes: number;
  files: number;
  review: ReviewResult;
}

/** The block packmaster.work's /adversary posts and review-record.ts reads. */
export function renderAdversaryRecord(input: RecordInput, withMarker = true): string {
  const { review } = input;
  const counts = openCounts(review.findings);
  const lines: string[] = [];
  if (withMarker) lines.push(ADVERSARY_MARKER);
  lines.push("kind: adversary", `sha: ${input.sha}`, `diff-bytes: ${input.diffBytes}`, `files: ${input.files}`, `verdict: ${review.verdict}`);
  if (review.findings.length) {
    lines.push("findings:");
    for (const f of review.findings) {
      lines.push(`  - id: ${f.id}`, `    severity: ${f.severity}`, `    where: ${oneLine(f.where)}`, `    claim: ${oneLine(f.claim)}`, `    scenario: ${oneLine(f.scenario)}`, `    status: ${f.status}${f.note ? ` — ${oneLine(f.note)}` : ""}`);
    }
  }
  if (review.verdict === "clean") for (const c of review.considered) lines.push(`considered: ${oneLine(c)}`);
  lines.push(`open: ${counts.open}`);
  return lines.join("\n");
}

export function renderGenericRecord(input: RecordInput): string {
  const { review } = input;
  const counts = openCounts(review.findings);
  const lines: string[] = [`Review of ${input.sha} (${input.files} files, ${input.diffBytes} diff bytes)`, `verdict: ${review.verdict}`];
  for (const f of review.findings) {
    lines.push(`${f.id} / ${f.severity} / ${oneLine(f.where)} / ${oneLine(f.claim)} / ${oneLine(f.scenario)} / status: ${f.status}${f.note ? ` (${oneLine(f.note)})` : ""}`);
  }
  if (review.verdict === "clean") for (const c of review.considered) lines.push(`considered: ${c}`);
  lines.push(`open: ${counts.open} (${counts.blocker} blocker, ${counts.major} major, ${counts.minor} minor)`);
  return lines.join("\n");
}

export function renderFindingsMarkdown(review: ReviewResult): string {
  const counts = openCounts(review.findings);
  const out: string[] = [];
  if (review.verdict === "clean") {
    out.push("**Verdict: clean.** What was looked for, and why it is absent:");
    for (const c of review.considered) out.push(`- ${c}`);
  } else {
    const parts = [counts.blocker && `${counts.blocker} blocker`, counts.major && `${counts.major} major`, counts.minor && `${counts.minor} minor`].filter(Boolean);
    out.push(`**Verdict: ${review.findings.length} finding${review.findings.length === 1 ? "" : "s"}, ${counts.open} open${parts.length ? ` (${parts.join(", ")})` : ""}.**`);
    for (const f of review.findings) {
      out.push("", `#### ${f.id} · ${f.severity} · \`${f.where}\` · ${f.status}${f.note ? ` — ${f.note}` : ""}`, `**Claim.** ${f.claim}`, "", `**Scenario.** ${f.scenario}`);
    }
    if (review.considered.length) {
      out.push("", "Also considered:");
      for (const c of review.considered) out.push(`- ${c}`);
    }
  }
  if (review.summary) out.push("", review.summary);
  return out.join("\n");
}

export interface ReviewBodyInput {
  version: string;
  decisionLine: string;
  decision: Decision;
  review: ReviewResult;
  sha: string;
  diffBytes: number;
  files: number;
  kind: "adversary-v1" | "generic";
  modelNote?: string;
}

export function renderReviewBody(input: ReviewBodyInput): string {
  const record = input.kind === "adversary-v1" ? renderAdversaryRecord({ sha: input.sha, diffBytes: input.diffBytes, files: input.files, review: input.review }, false) : renderGenericRecord({ sha: input.sha, diffBytes: input.diffBytes, files: input.files, review: input.review });
  const data: BotData = { version: input.version, decision: input.decision, review: input.review, sha: input.sha, diffBytes: input.diffBytes, files: input.files };
  return [
    input.decisionLine,
    botMarker(input.sha, "review"),
    encodeData(data),
    "",
    renderFindingsMarkdown(input.review),
    "",
    "<details><summary>Why this tier</summary>",
    "",
    ...input.decision.reasons.map((r) => `- ${r}`),
    "",
    "</details>",
    "",
    `<details><summary>Record (${input.kind})</summary>`,
    "",
    "```text",
    record,
    "```",
    "",
    "</details>",
    "",
    `_Independent review of \`${input.sha}\` by review-bot ${input.version} (${input.decision.model}, effort ${input.decision.effort}${input.modelNote ? `, ${input.modelNote}` : ""}). A new push voids it. An approval, if one follows, is a separate review and never stands in for a code owner's._`,
  ].join("\n");
}
