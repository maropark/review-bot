import { describe, expect, test } from "bun:test";
import { describeChecks, outcomeOfCheckRun, requiredFromRules, summarize } from "../src/checks.ts";

const at = 1;
describe("check summaries", () => {
  test("every required check success → green", () => {
    expect(summarize(["verified"], [{ name: "verified", outcome: "success", at }]).overall).toBe("green");
  });
  test("a failing required check → red, whatever else passed", () => {
    expect(summarize(["verified"], [{ name: "verified", outcome: "failure", at }, { name: "gate", outcome: "success", at }]).overall).toBe("red");
  });
  test("a required check not yet reported → pending", () => {
    const s = summarize(["verified"], []);
    expect(s.overall).toBe("pending");
    expect(s.results[0]).toEqual({ name: "verified", outcome: "missing", detail: "not reported yet" });
  });
  test("a SKIPPED required check is not a pass", () => {
    expect(summarize(["verified"], [{ name: "verified", outcome: "missing", detail: "skipped", at }]).overall).toBe("pending");
  });
  test("the newest run of a name wins", () => {
    expect(summarize(["verified"], [{ name: "verified", outcome: "failure", at: 1 }, { name: "verified", outcome: "success", at: 2 }]).overall).toBe("green");
    expect(summarize(["verified"], [{ name: "verified", outcome: "success", at: 1 }, { name: "verified", outcome: "failure", at: 2 }]).overall).toBe("red");
  });
  test("without a required list, every observed check counts except the bot's own", () => {
    expect(summarize([], [{ name: "review-bot", outcome: "pending", at }, { name: "test", outcome: "success", at }]).overall).toBe("green");
    expect(summarize([], [{ name: "review-bot", outcome: "pending", at }]).overall).toBe("unknown");
  });
  test("only the required checks are judged when there is a list", () => {
    expect(summarize(["verified"], [{ name: "verified", outcome: "success", at }, { name: "review-record", outcome: "failure", at }]).overall).toBe("green");
  });
  test("outcomeOfCheckRun", () => {
    expect(outcomeOfCheckRun("completed", "success").outcome).toBe("success");
    expect(outcomeOfCheckRun("completed", "neutral").outcome).toBe("success");
    expect(outcomeOfCheckRun("completed", "skipped")).toEqual({ outcome: "missing", detail: "skipped" });
    expect(outcomeOfCheckRun("completed", "timed_out").outcome).toBe("failure");
    expect(outcomeOfCheckRun("completed", "cancelled").outcome).toBe("failure");
    expect(outcomeOfCheckRun("in_progress", null).outcome).toBe("pending");
    expect(outcomeOfCheckRun("queued", null).outcome).toBe("pending");
  });
  test("requiredFromRules reads the live ruleset shape", () => {
    const rules = [
      { type: "deletion" },
      { type: "pull_request", parameters: { required_approving_review_count: 0 } },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "verified", integration_id: 15368 }] } },
    ];
    expect(requiredFromRules(rules)).toEqual(["verified"]);
    expect(requiredFromRules([])).toEqual([]);
  });
  test("describeChecks is readable", () => {
    expect(describeChecks(summarize(["verified"], [{ name: "verified", outcome: "failure", detail: "failure", at }]))).toBe("red: verified ✗ (failure)");
  });
});
