/** The shared vocabulary. Nothing here talks to a network. */

export type Tier = "skip" | "light" | "standard" | "adversarial";
export const TIER_ORDER: readonly Tier[] = ["skip", "light", "standard", "adversarial"];
export const REVIEW_TIERS: readonly Exclude<Tier, "skip">[] = ["light", "standard", "adversarial"];

export function strongerTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER.indexOf(a) >= TIER_ORDER.indexOf(b) ? a : b;
}

export type Effort = "none" | "low" | "medium" | "high";
export type Severity = "blocker" | "major" | "minor";
export type FindingStatus = "open" | "fixed" | "rebutted" | "deferred";

export const SEVERITIES: readonly Severity[] = ["blocker", "major", "minor"];
export const FINDING_STATUSES: readonly FindingStatus[] = ["open", "fixed", "rebutted", "deferred"];

export interface Finding {
  id: string;
  severity: Severity;
  where: string;
  claim: string;
  scenario: string;
  status: FindingStatus;
  /** Why the status is what it is — the fixing sha, the rebuttal, the ticket. */
  note?: string;
}

export interface ReviewResult {
  verdict: "findings" | "clean";
  findings: Finding[];
  /** For a clean verdict: what the reviewer looked for and why it is absent. */
  considered: string[];
  summary?: string;
}

export interface ChangedFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export type CheckOutcome = "success" | "failure" | "pending" | "missing";

export interface CheckState {
  /** The contexts the base branch's ruleset requires; empty when there is no such rule. */
  required: string[];
  results: { name: string; outcome: CheckOutcome; detail?: string }[];
  overall: "green" | "red" | "pending" | "unknown";
  note?: string;
}

export interface PRSignals {
  repo: string;
  number: number;
  title: string;
  body: string;
  author: string;
  authorType: string;
  draft: boolean;
  state: string;
  labels: string[];
  headSha: string;
  baseSha: string;
  baseRef: string;
  headRef: string;
  isFork: boolean;
  files: ChangedFile[];
  additions: number;
  deletions: number;
  checks: CheckState;
}

export interface ForcedRule {
  rule: string;
  tier: Tier;
  approve: boolean;
  paths: string[];
}

export interface Decision {
  tier: Tier;
  model: string;
  effort: Effort;
  may_approve: boolean;
  forced: ForcedRule[];
  reasons: string[];
  classifier: "rules" | "model" | "fallback";
  signals: {
    files: number;
    additions: number;
    deletions: number;
    ci: CheckState["overall"];
    author: string;
    owner: boolean;
    labels: string[];
  };
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

export function consoleLogger(verbose = false): Logger {
  return {
    info: (m) => console.log(m),
    warn: (m) => console.warn(`warning: ${m}`),
    error: (m) => console.error(`error: ${m}`),
    debug: (m) => { if (verbose) console.log(`debug: ${m}`); },
  };
}
