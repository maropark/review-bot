import { DEFAULT_REPO_CONFIG, type RepoConfig } from "../src/config.ts";
import type { ChangedFile, CheckState, Decision, PRSignals, ReviewResult } from "../src/types.ts";

export const HEAD = "8d4f5081f2c3a4b5c6d7e8f90a1b2c3d4e5f6071";
export const OTHER = "1111111122223333444455556666777788889999";

export function file(filename: string, additions = 10, deletions = 2, status = "modified"): ChangedFile {
  return { filename, additions, deletions, status };
}

export function checks(overall: CheckState["overall"], results: CheckState["results"] = []): CheckState {
  return { required: results.map((r) => r.name), results, overall };
}

export function signals(over: Partial<PRSignals> = {}): PRSignals {
  const files = over.files ?? [file("src/a.ts", 20, 5), file("src/b.ts", 30, 10)];
  return {
    repo: "acme/widgets",
    number: 7,
    title: "Make the thing do the other thing",
    body: "It does the other thing now.",
    author: "someone",
    authorType: "User",
    draft: false,
    state: "open",
    labels: [],
    headSha: HEAD,
    baseSha: OTHER,
    baseRef: "main",
    headRef: "feature",
    isFork: false,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
    checks: checks("green", [{ name: "verified", outcome: "success" }]),
    ...over,
  };
}

export function config(over: Partial<RepoConfig> = {}): RepoConfig {
  return { ...structuredClone(DEFAULT_REPO_CONFIG), owner: "maropark", ...over };
}

export function decision(over: Partial<Decision> = {}): Decision {
  return {
    tier: "standard",
    model: "test-model",
    effort: "medium",
    may_approve: true,
    forced: [],
    reasons: [],
    classifier: "rules",
    signals: { files: 2, additions: 50, deletions: 15, ci: "green", author: "someone", owner: false, labels: [] },
    ...over,
  };
}

export function clean(): ReviewResult {
  return { verdict: "clean", findings: [], considered: ["shape 1 — nothing leaves the process", "shape 3 — the new assertion compares against a literal", "shape 4 — nothing is removed"] };
}

export function withFindings(...f: ReviewResult["findings"]): ReviewResult {
  return { verdict: "findings", findings: f, considered: [] };
}

export function finding(id: string, severity: "blocker" | "major" | "minor", status: "open" | "fixed" | "rebutted" | "deferred" = "open") {
  return { id, severity, where: "src/a.ts:12", claim: `${id} is wrong`, scenario: `when x, ${id} breaks`, status };
}
