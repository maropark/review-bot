import { describe, expect, test } from "bun:test";
import { evaluateApproval, renderApprovalBody } from "../src/approve.ts";
import { HEAD, OTHER, checks, clean, config, decision, finding, withFindings } from "./helpers.ts";

const green = checks("green", [{ name: "verified", outcome: "success" }]);
const base = { decision: decision(), review: clean(), reviewedSha: HEAD, liveSha: HEAD, liveState: "open", liveDraft: false, checks: green, config: config() };

describe("the approval gate", () => {
  test("clean, same head, green → approve", () => expect(evaluateApproval(base)).toEqual({ approve: true, reasons: [] }));
  test("an open major blocks", () => {
    const v = evaluateApproval({ ...base, review: withFindings(finding("F1", "major")) });
    expect(v.approve).toBe(false);
    expect(v.reasons[0]).toMatch(/1 major/);
  });
  test("an open blocker blocks", () => expect(evaluateApproval({ ...base, review: withFindings(finding("F1", "blocker")) }).approve).toBe(false));
  test("a fixed major and an open minor do not block", () => {
    expect(evaluateApproval({ ...base, review: withFindings(finding("F1", "major", "fixed"), finding("F2", "minor")) }).approve).toBe(true);
  });
  test("a rebutted blocker does not block", () => expect(evaluateApproval({ ...base, review: withFindings(finding("F1", "blocker", "rebutted")) }).approve).toBe(true));
  test("the head moved", () => {
    const v = evaluateApproval({ ...base, liveSha: OTHER });
    expect(v.approve).toBe(false);
    expect(v.reasons[0]).toMatch(/head moved/);
  });
  test("a failing required check blocks", () => {
    expect(evaluateApproval({ ...base, checks: checks("red", [{ name: "verified", outcome: "failure" }]) }).approve).toBe(false);
  });
  test("a pending check does not block by default (rpa's rule)", () => {
    expect(evaluateApproval({ ...base, checks: checks("pending", [{ name: "verified", outcome: "pending" }]) }).approve).toBe(true);
  });
  test("…but does when the repo requires green", () => {
    const c = config({ approval: { enabled: true, tiers: ["light", "standard", "adversarial"], requireGreenChecks: true, requestChangesOnBlocker: false } });
    expect(evaluateApproval({ ...base, config: c, checks: checks("pending", [{ name: "verified", outcome: "pending" }]) }).approve).toBe(false);
  });
  test("unreadable checks block", () => expect(evaluateApproval({ ...base, checks: { required: [], results: [], overall: "unknown", note: "403" } }).approve).toBe(false));
  test("the triage's may_approve=no is final", () => {
    const v = evaluateApproval({ ...base, decision: decision({ may_approve: false, reasons: ["risk rule matched → adversarial, no approval"] }) });
    expect(v.approve).toBe(false);
    expect(v.reasons[0]).toMatch(/may_approve=no/);
  });
  test("a draft or closed PR is never approved", () => {
    expect(evaluateApproval({ ...base, liveDraft: true }).approve).toBe(false);
    expect(evaluateApproval({ ...base, liveState: "closed" }).approve).toBe(false);
  });
  test("every failed condition is named, not just the first", () => {
    const v = evaluateApproval({ ...base, liveSha: OTHER, review: withFindings(finding("F1", "blocker")), checks: checks("red", [{ name: "verified", outcome: "failure" }]) });
    expect(v.reasons.length).toBe(3);
  });
});

describe("the approval body", () => {
  test("pins the sha, names owned paths and says the approval does not satisfy the owner rule", () => {
    const body = renderApprovalBody({
      version: "v0.1.0",
      sha: HEAD,
      decision: decision(),
      review: withFindings(finding("F1", "minor")),
      checks: green,
      owned: [{ path: ".github/workflows/ci.yml", owners: ["@maropark"] }],
      decisionLine: "review-bot v0.1.0 · tier=standard",
    });
    expect(body.startsWith("review-bot v0.1.0 · tier=standard\n")).toBe(true);
    expect(body).toContain(`<!-- review-bot:v1 sha=${HEAD} kind=approval -->`);
    expect(body).toContain(".github/workflows/ci.yml");
    expect(body).toContain("does not satisfy that rule");
    expect(body).toContain("Open minors, deferred, not blocking: F1");
  });
});
