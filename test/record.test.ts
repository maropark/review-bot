import { describe, expect, test } from "bun:test";
import {
  ADVERSARY_MARKER,
  decodeData,
  encodeData,
  nextFindingId,
  openCounts,
  parseBotMarker,
  renderAdversaryRecord,
  renderReviewBody,
  validateReview,
} from "../src/record.ts";
import { HEAD, clean, decision, finding, withFindings } from "./helpers.ts";

// The three parsers packmaster.work's scripts/review-record.ts applies to a
// record, copied here verbatim so this suite fails the day the format drifts.
function recordSha(body: string): string | null {
  const m = /^\s*sha:\s*([0-9a-f]{7,40})\s*$/im.exec(body);
  return m ? m[1]!.toLowerCase() : null;
}
function recordIsWellFormed(body: string): boolean {
  if (/^\s*status:\s*\S+/im.test(body)) return true;
  if (!/^\s*verdict:\s*clean\s*$/im.test(body)) return false;
  return (body.match(/^\s*considered:\s*\S+/gim) ?? []).length >= 3;
}

describe("the adversary-v1 record, as packmaster.work reads it", () => {
  test("findings: pinned sha, a status per finding, well-formed", () => {
    const rec = renderAdversaryRecord({ sha: HEAD, diffBytes: 1234, files: 2, review: withFindings(finding("F1", "major"), finding("F2", "minor", "fixed")) });
    expect(rec.startsWith(ADVERSARY_MARKER + "\n")).toBe(true);
    expect(recordSha(rec)).toBe(HEAD);
    expect(recordIsWellFormed(rec)).toBe(true);
    expect(rec).toContain("kind: adversary");
    expect(rec).toContain("diff-bytes: 1234");
    expect(rec).toContain("files: 2");
    expect(rec).toContain("verdict: findings");
    expect(rec).toContain("    status: open");
    expect(rec).toContain("    status: fixed");
    expect(rec.trim().endsWith("open: 1")).toBe(true);
  });
  test("clean: verdict clean with three considered lines is well-formed", () => {
    const rec = renderAdversaryRecord({ sha: HEAD, diffBytes: 10, files: 1, review: clean() });
    expect(recordIsWellFormed(rec)).toBe(true);
    expect(rec).toContain("verdict: clean");
    expect(rec.trim().endsWith("open: 0")).toBe(true);
  });
  test("clean with two considered lines would NOT be well-formed (the validator refuses it upstream)", () => {
    const rec = renderAdversaryRecord({ sha: HEAD, diffBytes: 10, files: 1, review: { verdict: "clean", findings: [], considered: ["a", "b"] } });
    expect(recordIsWellFormed(rec)).toBe(false);
  });
  test("a multi-line claim is flattened so the YAML-ish block stays line-oriented", () => {
    const f = { ...finding("F1", "minor"), claim: "line one\nline two" };
    const rec = renderAdversaryRecord({ sha: HEAD, diffBytes: 1, files: 1, review: withFindings(f) }, false);
    expect(rec).not.toContain("line one\nline two");
    expect(rec).not.toContain(ADVERSARY_MARKER);
  });
});

describe("the review body", () => {
  const body = renderReviewBody({
    version: "v0.1.0",
    decisionLine: "review-bot v0.1.0 · tier=standard · model=m",
    decision: decision({ reasons: ["because"] }),
    review: withFindings(finding("F1", "major")),
    sha: HEAD,
    diffBytes: 99,
    files: 1,
    kind: "adversary-v1",
  });
  test("the decision line is the first line", () => expect(body.split("\n")[0]).toBe("review-bot v0.1.0 · tier=standard · model=m"));
  test("it carries the bot marker pinned to the sha", () => expect(parseBotMarker(body)).toEqual({ sha: HEAD, kind: "review" }));
  test("it never carries the adversary comment marker (a review is not an issue comment)", () => expect(body).not.toContain(ADVERSARY_MARKER));
  test("the machine data round-trips", () => {
    const data = decodeData(body);
    expect(data?.sha).toBe(HEAD);
    expect(data?.review.findings[0]?.id).toBe("F1");
    expect(data?.decision.tier).toBe("standard");
  });
  test("the human section names the finding", () => expect(body).toContain("#### F1 · major"));
});

describe("markers and data", () => {
  test("parseBotMarker ignores other comments", () => {
    expect(parseBotMarker("<!-- adversary:v1 -->\nsha: abc")).toBeNull();
    expect(parseBotMarker(`x <!-- review-bot:v1 sha=${HEAD} kind=approval --> y`)).toEqual({ sha: HEAD, kind: "approval" });
    expect(parseBotMarker(null)).toBeNull();
  });
  test("decodeData refuses garbage", () => {
    expect(decodeData("<!-- review-bot:data:b64 aGVsbG8= -->")).toBeNull();
    expect(decodeData("nothing")).toBeNull();
  });
  test("encodeData has no `-->` inside the comment", () => {
    const enc = encodeData({ version: "v", decision: decision(), review: withFindings({ ...finding("F1", "minor"), claim: "a --> b" }), sha: HEAD, diffBytes: 1, files: 1 });
    expect(enc.indexOf("-->")).toBe(enc.length - 3);
  });
  test("openCounts and nextFindingId", () => {
    const fs = [finding("F1", "blocker"), finding("F2", "major", "fixed"), finding("F7", "minor")];
    expect(openCounts(fs)).toEqual({ blocker: 1, major: 0, minor: 1, open: 2 });
    expect(nextFindingId(fs)).toBe(8);
    expect(nextFindingId([])).toBe(1);
  });
});

describe("validateReview", () => {
  const opts = { nextId: 1, priorIds: new Set<string>() };
  test("a good reply normalises ids, severities and statuses", () => {
    const v = validateReview(
      { verdict: "findings", findings: [{ id: "1", severity: "Major", where: "a.ts:1", claim: "c", scenario: "s" }, { id: "f2", severity: "minor", where: "b.ts:2", claim: "c", scenario: "s", status: "fixed:abc123" }] },
      opts,
    );
    expect(v.problems).toEqual([]);
    expect(v.review?.findings.map((f) => f.id)).toEqual(["F1", "F2"]);
    expect(v.review?.findings[0]?.severity).toBe("major");
    expect(v.review?.findings[0]?.status).toBe("open");
    expect(v.review?.findings[1]?.status).toBe("fixed");
  });
  test("verdict is inferred when missing", () => {
    expect(validateReview({ findings: [{ id: "F1", severity: "minor", where: "a:1", claim: "c", scenario: "s" }] }, opts).review?.verdict).toBe("findings");
    expect(validateReview({ considered: ["a", "b", "c"] }, opts).review?.verdict).toBe("clean");
  });
  test("a clean verdict needs three considered lines", () => {
    const v = validateReview({ verdict: "clean", considered: ["a", "b"] }, opts);
    expect(v.review).toBeNull();
    expect(v.problems[0]).toMatch(/three "considered"/);
  });
  test("a clean verdict with an open finding is contradictory", () => {
    expect(validateReview({ verdict: "clean", findings: [{ id: "F1", severity: "minor", where: "a:1", claim: "c", scenario: "s" }], considered: ["a", "b", "c"] }, opts).problems.join()).toMatch(/clean but 1/);
  });
  test("duplicate and reused ids are refused", () => {
    const dup = validateReview({ findings: [{ id: "F1", severity: "minor", where: "a:1", claim: "c", scenario: "s" }, { id: "F1", severity: "minor", where: "a:2", claim: "c", scenario: "s" }] }, opts);
    expect(dup.problems.join()).toMatch(/used twice/);
    const low = validateReview({ findings: [{ id: "F2", severity: "minor", where: "a:1", claim: "c", scenario: "s" }] }, { nextId: 4, priorIds: new Set(["F1"]) });
    expect(low.problems.join()).toMatch(/new findings start at F4/);
    const prior = validateReview({ findings: [{ id: "F1", severity: "minor", where: "a:1", claim: "c", scenario: "s", status: "fixed" }] }, { nextId: 4, priorIds: new Set(["F1"]) });
    expect(prior.problems).toEqual([]);
  });
  test("a finding without a scenario is not a finding", () => {
    expect(validateReview({ findings: [{ id: "F1", severity: "minor", where: "a:1", claim: "c" }] }, opts).problems.join()).toMatch(/scenario/);
  });
  test("bad severity, bad status, non-object", () => {
    expect(validateReview({ findings: [{ id: "F1", severity: "critical", where: "a:1", claim: "c", scenario: "s" }] }, opts).problems.join()).toMatch(/severity/);
    expect(validateReview({ findings: [{ id: "F1", severity: "minor", where: "a:1", claim: "c", scenario: "s", status: "wontfix" }] }, opts).problems.join()).toMatch(/status/);
    expect(validateReview("nope", opts).problems[0]).toMatch(/not a JSON object/);
  });
});
