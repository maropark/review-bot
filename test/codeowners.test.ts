import { describe, expect, test } from "bun:test";
import { ownedPaths, ownersOf, parseCodeowners } from "../src/codeowners.ts";

const PMW = `# comment
/.github/               @maropark
/wrangler.jsonc         @maropark
/supabase/migrations/   @maropark
`;
const EPEPS = `*                       @maropark
/.github/               @maropark
/vercel.json            @maropark
/lib/supabase/          @maropark
`;

describe("CODEOWNERS", () => {
  test("packmaster.work's three paths", () => {
    const rules = parseCodeowners(PMW);
    expect(ownersOf(rules, ".github/workflows/ci.yml")).toEqual(["@maropark"]);
    expect(ownersOf(rules, ".github/review-bot.json")).toEqual(["@maropark"]);
    expect(ownersOf(rules, "wrangler.jsonc")).toEqual(["@maropark"]);
    expect(ownersOf(rules, "supabase/migrations/2026_x.sql")).toEqual(["@maropark"]);
    expect(ownersOf(rules, "src/lib/labels.functions.ts")).toEqual([]);
    expect(ownersOf(rules, "sites/x/wrangler.jsonc")).toEqual([]);
  });
  test("epeptides' catch-all owns everything", () => {
    const rules = parseCodeowners(EPEPS);
    expect(ownersOf(rules, "lib/anything.ts")).toEqual(["@maropark"]);
    expect(ownedPaths(rules, ["a.ts", "b.ts"]).length).toBe(2);
  });
  test("last match wins", () => {
    const rules = parseCodeowners("* @a\n/docs/ @b\n");
    expect(ownersOf(rules, "docs/x.md")).toEqual(["@b"]);
    expect(ownersOf(rules, "src/x.ts")).toEqual(["@a"]);
  });
});
