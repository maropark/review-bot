import { describe, expect, test } from "bun:test";
import { ConfigError, parseRepoConfig, parseRepoConfigText } from "../src/config.ts";

describe("repo config", () => {
  test("null → defaults", () => {
    const c = parseRepoConfigText(null);
    expect(c.protocol.kind).toBe("generic");
    expect(c.skip.authors).toContain("dependabot[bot]");
    expect(c.approval.enabled).toBe(true);
  });
  test("a full config parses with defaults filled", () => {
    const c = parseRepoConfig({
      owner: "maropark",
      protocol: { kind: "adversary-v1", files: ["AGENTS.md"] },
      risk: [{ label: "gate", paths: [".github/**"] }, { label: "docs", paths: ["docs/**"], tier: "standard", approve: true }],
      approval: { requireGreenChecks: true },
      tiers: { adversarial: { model: "big", effort: "high" } },
    });
    expect(c.risk[0]).toEqual({ label: "gate", paths: [".github/**"], tier: "adversarial", approve: false });
    expect(c.risk[1]!.approve).toBe(true);
    expect(c.approval.requireGreenChecks).toBe(true);
    expect(c.approval.requestChangesOnBlocker).toBe(false);
    expect(c.tiers.adversarial.model).toBe("big");
    expect(c.tiers.light.effort).toBe("low");
  });
  const bad: [string, unknown][] = [
    ["unknown key", { nope: 1 }],
    ["bad protocol kind", { protocol: { kind: "fancy" } }],
    ["risk without label", { risk: [{ paths: ["x"] }] }],
    ["risk without paths", { risk: [{ label: "x", paths: [] }] }],
    ["risk tier skip", { risk: [{ label: "x", paths: ["y"], tier: "skip" }] }],
    ["size inverted", { size: { light: 500, standard: 100 } }],
    ["bad effort", { tiers: { light: { effort: "max" } } }],
    ["unknown tier", { tiers: { ultra: { effort: "high" } } }],
    ["approval tier typo", { approval: { tiers: ["lite"] } }],
    ["not an object", [1, 2]],
  ];
  for (const [name, raw] of bad) test(`rejects ${name}`, () => expect(() => parseRepoConfig(raw)).toThrow(ConfigError));
  test("invalid JSON names the problem", () => expect(() => parseRepoConfigText("{")).toThrow(/not valid JSON/));
});
