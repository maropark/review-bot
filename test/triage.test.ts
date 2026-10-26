import { describe, expect, test } from "bun:test";
import { formatDecisionLine, isMajorBump, parseClassifierReply, triage, type Classifier } from "../src/triage.ts";
import { checks, config, file, signals } from "./helpers.ts";

const RISKY = config({
  risk: [
    { label: "the gate and the deploys", paths: [".github/**", "wrangler.jsonc"], tier: "adversarial", approve: false },
    { label: "migrations", paths: ["supabase/migrations/**"], tier: "adversarial", approve: false },
    { label: "docs that matter", paths: ["docs/DEPLOY.md"], tier: "standard", approve: true },
  ],
});

const never: Classifier = async () => {
  throw new Error("the classifier must not be called here");
};

describe("deterministic rules", () => {
  test("a draft is skipped", async () => {
    const d = await triage(signals({ draft: true }), RISKY, "m", never);
    expect(d.tier).toBe("skip");
    expect(d.may_approve).toBe(false);
  });
  test("a closed PR is skipped", async () => {
    const d = await triage(signals({ state: "closed" }), RISKY, "m", never);
    expect(d.tier).toBe("skip");
  });
  test("the waiver label skips", async () => {
    const d = await triage(signals({ labels: ["review:waived"] }), RISKY, "m", never);
    expect(d.tier).toBe("skip");
    expect(d.reasons.join()).toContain("review:waived");
  });
  test("a workflow change forces adversarial and forbids approval, without asking the model", async () => {
    const d = await triage(signals({ files: [file(".github/workflows/ci.yml"), file("README.md")] }), RISKY, "m", never);
    expect(d.tier).toBe("adversarial");
    expect(d.may_approve).toBe(false);
    expect(d.forced.map((f) => f.rule)).toEqual(["the gate and the deploys"]);
    expect(d.forced[0]!.paths).toEqual([".github/workflows/ci.yml"]);
    expect(d.classifier).toBe("rules");
  });
  test("a renamed file is matched by its old name too", async () => {
    const d = await triage(signals({ files: [{ filename: "infra/moved.sql", previous_filename: "supabase/migrations/x.sql", status: "renamed", additions: 0, deletions: 0 }] }), RISKY, "m", never);
    expect(d.forced.map((f) => f.rule)).toEqual(["migrations"]);
  });
  test("a rule may keep approval open and force only standard", async () => {
    const d = await triage(signals({ files: [file("docs/DEPLOY.md")] }), RISKY, "m", never);
    expect(d.tier).toBe("standard");
    expect(d.may_approve).toBe(true);
  });
  test("the strongest matched rule wins", async () => {
    const d = await triage(signals({ files: [file("docs/DEPLOY.md"), file("wrangler.jsonc")] }), RISKY, "m", never);
    expect(d.tier).toBe("adversarial");
    expect(d.may_approve).toBe(false);
  });
  test("red CI forces adversarial and forbids approval even when the model said light", async () => {
    const light: Classifier = async () => ({ tier: "light", reason: "tiny" });
    const d = await triage(signals({ checks: checks("red", [{ name: "verified", outcome: "failure" }]) }), RISKY, "m", light);
    expect(d.tier).toBe("adversarial");
    expect(d.may_approve).toBe(false);
    expect(d.classifier).toBe("model");
  });
  test("unreadable CI keeps the tier but forbids approval", async () => {
    const d = await triage(signals({ checks: { required: [], results: [], overall: "unknown", note: "403" } }), config(), "m");
    expect(d.tier).toBe("standard");
    expect(d.may_approve).toBe(false);
    expect(d.reasons.join()).toContain("could not be read");
  });
  test("pending CI changes nothing at triage time", async () => {
    const d = await triage(signals({ checks: checks("pending", [{ name: "verified", outcome: "pending" }]) }), config(), "m");
    expect(d.may_approve).toBe(true);
    expect(d.reasons.join()).toContain("pending");
  });
  test("a dependabot patch bump is skipped", async () => {
    const d = await triage(signals({ author: "dependabot[bot]", authorType: "Bot", title: "Bump next from 16.3.8 to 16.4.3" }), config(), "m", never);
    expect(d.tier).toBe("skip");
  });
  test("a dependabot major bump gets a standard review", async () => {
    const d = await triage(signals({ author: "dependabot[bot]", authorType: "Bot", title: "Bump eslint from 9.2.0 to 10.0.1" }), config(), "m", never);
    expect(d.tier).toBe("standard");
  });
  test("a dependabot bump of a workflow still hits the risk rule", async () => {
    const d = await triage(signals({ author: "dependabot[bot]", title: "Bump actions/checkout from 6 to 7", files: [file(".github/workflows/ci.yml")] }), RISKY, "m", never);
    expect(d.tier).toBe("adversarial");
  });
  test("a small docs-only diff is light without a model call", async () => {
    const d = await triage(signals({ files: [file("README.md", 5, 1), file("docs/x.md", 3, 0)] }), config(), "m", never);
    expect(d.tier).toBe("light");
    expect(d.effort).toBe("low");
  });
});

describe("the model, and its fallbacks", () => {
  test("the classifier's tier is used", async () => {
    const d = await triage(signals(), config(), "m", async () => ({ tier: "adversarial", reason: "touches concurrency" }));
    expect(d.tier).toBe("adversarial");
    expect(d.classifier).toBe("model");
    expect(d.reasons.join()).toContain("touches concurrency");
  });
  test("a null answer falls back to size", async () => {
    const d = await triage(signals(), config(), "m", async () => null);
    expect(d.tier).toBe("standard");
    expect(d.classifier).toBe("fallback");
  });
  test("a thrown classifier falls back to size and says so", async () => {
    const d = await triage(signals(), config(), "m", async () => {
      throw new Error("502 from the triage endpoint");
    });
    expect(d.classifier).toBe("fallback");
    expect(d.reasons.join()).toContain("502");
  });
  test("no classifier: size thresholds, at the boundaries", async () => {
    const c = config({ size: { light: 60, standard: 400 } });
    const at = async (lines: number) => (await triage(signals({ files: [file("src/x.ts", lines, 0)] }), c, "m")).tier;
    expect(await at(60)).toBe("light");
    expect(await at(61)).toBe("standard");
    expect(await at(400)).toBe("standard");
    expect(await at(401)).toBe("adversarial");
  });
});

describe("approval policy and models", () => {
  test("approval disabled by config", async () => {
    const d = await triage(signals(), config({ approval: { enabled: false, tiers: ["light", "standard", "adversarial"], requireGreenChecks: false, requestChangesOnBlocker: false } }), "m");
    expect(d.may_approve).toBe(false);
  });
  test("a tier outside approval.tiers may not approve", async () => {
    const c = config({ approval: { enabled: true, tiers: ["light", "standard"], requireGreenChecks: false, requestChangesOnBlocker: false } });
    const d = await triage(signals(), c, "m", async () => ({ tier: "adversarial", reason: "big" }));
    expect(d.may_approve).toBe(false);
  });
  test("per-tier model override beats the default; effort follows the tier", async () => {
    const c = config({ tiers: { light: { effort: "low" }, standard: { effort: "medium" }, adversarial: { model: "big-model", effort: "high" } } });
    const d = await triage(signals(), c, "default-model", async () => ({ tier: "adversarial", reason: "x" }));
    expect(d.model).toBe("big-model");
    expect(d.effort).toBe("high");
    const s = await triage(signals(), c, "default-model", async () => ({ tier: "standard", reason: "x" }));
    expect(s.model).toBe("default-model");
  });
  test("the owner is a signal, not a permission", async () => {
    const d = await triage(signals({ author: "maropark" }), config(), "m");
    expect(d.signals.owner).toBe(true);
    expect(d.may_approve).toBe(true);
  });
});

describe("a risk rule may name its own model and effort", () => {
  const MODELS = config({
    tiers: { light: { model: "luna", effort: "medium" }, standard: { model: "sol", effort: "medium" }, adversarial: { model: "sol", effort: "high" } },
    risk: [
      { label: "the gate", paths: [".github/**"], tier: "adversarial", approve: false },
      { label: "migrations", paths: ["supabase/migrations/**"], tier: "adversarial", approve: false, model: "astra", effort: "high" },
      { label: "payments", paths: ["lib/pay/**"], tier: "adversarial", approve: false, model: "astra", effort: "xhigh" },
      { label: "docs that matter", paths: ["docs/DEPLOY.md"], tier: "standard", approve: true, effort: "low" },
    ],
  });
  test("a rule without a model uses the tier's model and effort", async () => {
    const d = await triage(signals({ files: [file(".github/workflows/ci.yml")] }), MODELS, "default", never);
    expect([d.model, d.effort]).toEqual(["sol", "high"]);
  });
  test("a rule with a model and effort overrides the tier's", async () => {
    const d = await triage(signals({ files: [file("supabase/migrations/x.sql")] }), MODELS, "default", never);
    expect([d.tier, d.model, d.effort]).toEqual(["adversarial", "astra", "high"]);
    expect(d.reasons.join()).toContain('risk rule "migrations" sets the model astra at effort high');
  });
  test("with several matched rules, the one asking the most effort decides both", async () => {
    const d = await triage(signals({ files: [file("supabase/migrations/x.sql"), file("lib/pay/charge.ts"), file(".github/workflows/ci.yml")] }), MODELS, "default", never);
    expect([d.model, d.effort]).toEqual(["astra", "xhigh"]);
  });
  test("an effort-only rule keeps the tier's model", async () => {
    const d = await triage(signals({ files: [file("docs/DEPLOY.md")] }), MODELS, "default", never);
    expect([d.tier, d.model, d.effort, d.may_approve]).toEqual(["standard", "sol", "low", true]);
  });
  test("the unforced tiers use their own models", async () => {
    const light = await triage(signals({ files: [file("README.md", 3, 1)] }), MODELS, "default", never);
    expect([light.model, light.effort]).toEqual(["luna", "medium"]);
    const adv = await triage(signals(), MODELS, "default", async () => ({ tier: "adversarial", reason: "x" }));
    expect([adv.model, adv.effort]).toEqual(["sol", "high"]);
  });
});

describe("small parsers", () => {
  test("isMajorBump", () => {
    expect(isMajorBump("Bump next from 16.3.8 to 16.4.3")).toBe(false);
    expect(isMajorBump("Bump eslint from 9.2.0 to 10.0.1")).toBe(true);
    expect(isMajorBump("Bump actions/checkout from 6 to 7")).toBe(true);
    expect(isMajorBump("Bump the routine group with 7 updates")).toBe(false);
    expect(isMajorBump("chore(deps): bump vite from v8.3.0 to v8.3.4")).toBe(false);
  });
  test("parseClassifierReply", () => {
    expect(parseClassifierReply({ tier: "Light", reason: "docs" })).toEqual({ tier: "light", reason: "docs" });
    expect(parseClassifierReply({ tier: "skip" })).toBeNull();
    expect(parseClassifierReply("light")).toBeNull();
    expect(parseClassifierReply({ tier: "standard" })?.reason).toBe("no reason given");
  });
  test("the decision line carries the audit fields", async () => {
    const d = await triage(signals({ files: [file(".github/workflows/x.yml")] }), RISKY, "m");
    const line = formatDecisionLine(d, "v0.1.0");
    for (const part of ["tier=adversarial", "model=m", "effort=high", "may_approve=no", "forced=the gate and the deploys", "ci=green", "author=someone"]) expect(line).toContain(part);
  });
});
