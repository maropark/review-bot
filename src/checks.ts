/**
 * What CI says about the head commit, reduced to one word the triage and the
 * approval gate can act on. "Required" means the contexts the base branch's
 * ruleset names; with no such rule, every observed check counts.
 *
 * `skipped` is NOT a pass here. GitHub reports a skipped required job as
 * success to a ruleset, and both repos this was built for document that as a
 * hole, not a feature.
 */

import type { GitHub, BranchRule } from "./github.ts";
import type { CheckOutcome, CheckState } from "./types.ts";

export interface ObservedCheck {
  name: string;
  outcome: CheckOutcome;
  detail?: string;
  /** epoch ms, to pick the newest of several runs with one name */
  at: number;
}

export function outcomeOfCheckRun(status: string, conclusion: string | null): { outcome: CheckOutcome; detail?: string } {
  if (status !== "completed") return { outcome: "pending", detail: status };
  switch (conclusion) {
    case "success":
    case "neutral":
      return { outcome: "success" };
    case "skipped":
      return { outcome: "missing", detail: "skipped" };
    case "failure":
    case "timed_out":
    case "cancelled":
    case "action_required":
    case "startup_failure":
    case "stale":
      return { outcome: "failure", detail: conclusion };
    default:
      return { outcome: "pending", detail: conclusion ?? "no conclusion" };
  }
}

export function outcomeOfStatus(state: string): CheckOutcome {
  if (state === "success") return "success";
  if (state === "failure" || state === "error") return "failure";
  return "pending";
}

export function requiredFromRules(rules: BranchRule[]): string[] {
  const out: string[] = [];
  for (const r of rules) {
    if (r.type !== "required_status_checks") continue;
    const list = (r.parameters?.required_status_checks ?? []) as { context?: string }[];
    for (const c of list) if (typeof c.context === "string") out.push(c.context);
  }
  return [...new Set(out)];
}

export function summarize(required: string[], observed: ObservedCheck[], ownNames: string[] = ["review-bot"], note?: string): CheckState {
  const newest = new Map<string, ObservedCheck>();
  for (const o of observed) {
    const prev = newest.get(o.name);
    if (!prev || o.at >= prev.at) newest.set(o.name, o);
  }
  const isOwn = (name: string) => ownNames.some((own) => name.toLowerCase().includes(own.toLowerCase()));
  const targets = required.length ? required : [...newest.keys()].filter((n) => !isOwn(n));
  const results = targets.map((name) => {
    const o = newest.get(name);
    return o ? { name, outcome: o.outcome, ...(o.detail ? { detail: o.detail } : {}) } : { name, outcome: "missing" as CheckOutcome, detail: "not reported yet" };
  });
  let overall: CheckState["overall"];
  if (results.some((r) => r.outcome === "failure")) overall = "red";
  else if (targets.length === 0) overall = "unknown";
  else if (results.some((r) => r.outcome === "pending" || r.outcome === "missing")) overall = "pending";
  else overall = "green";
  const state: CheckState = { required, results, overall };
  if (note) state.note = note;
  else if (targets.length === 0) state.note = "no required checks are configured and none have reported";
  return state;
}

export async function readChecks(
  gh: GitHub,
  repo: string,
  baseRef: string,
  headSha: string,
  override: string[] | null,
  ownNames: string[] = ["review-bot"],
): Promise<CheckState> {
  let required: string[] = [];
  let note: string | undefined;
  if (override) {
    required = override;
  } else {
    try {
      required = requiredFromRules(await gh.getBranchRules(repo, baseRef));
    } catch (e) {
      note = `could not read the rules for ${baseRef}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  const observed: ObservedCheck[] = [];
  try {
    for (const run of await gh.listCheckRuns(repo, headSha)) {
      const { outcome, detail } = outcomeOfCheckRun(run.status, run.conclusion);
      observed.push({ name: run.name, outcome, ...(detail ? { detail } : {}), at: Date.parse(run.completed_at ?? run.started_at ?? "") || 0 });
    }
    for (const s of await gh.listStatuses(repo, headSha)) {
      observed.push({ name: s.context, outcome: outcomeOfStatus(s.state), detail: s.state, at: Date.parse(s.updated_at) || 0 });
    }
  } catch (e) {
    return {
      required,
      results: [],
      overall: "unknown",
      note: `could not read checks for ${headSha.slice(0, 12)}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const state = summarize(required, observed, ownNames, note);
  // A rule we could not read is an alarm, not a pass: nothing is "green" by default.
  if (note && !override && state.overall === "green") state.overall = "unknown";
  return state;
}

export function describeChecks(checks: CheckState): string {
  if (checks.results.length === 0) return `${checks.overall}${checks.note ? ` (${checks.note})` : ""}`;
  const mark = (o: CheckOutcome) => (o === "success" ? "✓" : o === "failure" ? "✗" : o === "missing" ? "·" : "…");
  return `${checks.overall}: ${checks.results.map((r) => `${r.name} ${mark(r.outcome)}${r.detail && r.outcome !== "success" ? ` (${r.detail})` : ""}`).join(", ")}`;
}
