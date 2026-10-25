/**
 * The approval gate — rpa's step 5, as code. Approve only if ALL hold: the
 * triage allowed it, no blocker or major is open, the live head is the head
 * that was reviewed, and no required check is failing (pending does not block
 * unless the repo asks for green). Anything else: say exactly which condition
 * failed, and do not approve.
 */

import type { RepoConfig } from "./config.ts";
import { describeChecks } from "./checks.ts";
import { openCounts } from "./record.ts";
import type { CheckState, Decision, ReviewResult } from "./types.ts";

export interface ApprovalInput {
  decision: Decision;
  review: ReviewResult;
  reviewedSha: string;
  liveSha: string;
  liveState: string;
  liveDraft: boolean;
  checks: CheckState;
  config: RepoConfig;
}

export interface ApprovalVerdict {
  approve: boolean;
  reasons: string[];
}

export function evaluateApproval(input: ApprovalInput): ApprovalVerdict {
  const reasons: string[] = [];
  const counts = openCounts(input.review.findings);

  if (!input.decision.may_approve) reasons.push(`the triage decided may_approve=no (${input.decision.reasons.filter((r) => /approv/i.test(r)).join("; ") || "see the decision"})`);
  if (input.decision.tier === "skip") reasons.push("tier skip: nothing was reviewed");
  if (counts.blocker || counts.major) reasons.push(`${counts.blocker} blocker and ${counts.major} major finding(s) are open`);
  if (input.liveSha.toLowerCase() !== input.reviewedSha.toLowerCase()) reasons.push(`the head moved: reviewed ${input.reviewedSha.slice(0, 12)}, live ${input.liveSha.slice(0, 12)} — a push voids the review`);
  if (input.liveState !== "open") reasons.push(`the PR is ${input.liveState}`);
  if (input.liveDraft) reasons.push("the PR is a draft");
  if (input.checks.overall === "red") reasons.push(`a required check is failing (${describeChecks(input.checks)})`);
  else if (input.checks.overall === "unknown") reasons.push(`the required checks could not be read (${input.checks.note ?? "no detail"})`);
  else if (input.checks.overall === "pending" && input.config.approval.requireGreenChecks) reasons.push(`required checks are still pending and approval.requireGreenChecks is on (${describeChecks(input.checks)})`);

  return { approve: reasons.length === 0, reasons };
}

export interface ApprovalBodyInput {
  version: string;
  sha: string;
  decision: Decision;
  review: ReviewResult;
  checks: CheckState;
  owned: { path: string; owners: string[] }[];
  decisionLine: string;
}

export function renderApprovalBody(input: ApprovalBodyInput): string {
  const counts = openCounts(input.review.findings);
  const minors = input.review.findings.filter((f) => f.status === "open" && f.severity === "minor");
  const lines = [
    input.decisionLine,
    `<!-- review-bot:v1 sha=${input.sha} kind=approval -->`,
    "",
    `**Approval at \`${input.sha}\`** by review-bot ${input.version}.`,
    "",
    `Record above: ${input.review.verdict}${input.review.findings.length ? `, ${input.review.findings.length} finding(s), ${counts.open} open (${counts.blocker} blocker, ${counts.major} major, ${counts.minor} minor)` : ""}. Checks: ${describeChecks(input.checks)}${input.checks.overall === "pending" ? " — pending blocks the merge, not this approval" : ""}.`,
  ];
  if (minors.length) lines.push("", `Open minors, deferred, not blocking: ${minors.map((f) => f.id).join(", ")}.`);
  if (input.owned.length) {
    lines.push(
      "",
      `Code-owner paths in this diff: ${input.owned.map((o) => `\`${o.path}\` (${o.owners.join(" ")})`).join(", ")}. **This approval does not satisfy that rule** — the named owner's review does.`,
    );
  }
  lines.push("", "_A new push voids this approval along with the review it rests on._");
  return lines.join("\n");
}
