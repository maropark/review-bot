import { describe, expect, test } from "bun:test";
import { matchGlob } from "../src/glob.ts";

describe("matchGlob", () => {
  const yes: [string, string][] = [
    [".github/workflows/**", ".github/workflows/ci.yml"],
    [".github/**", ".github/CODEOWNERS"],
    ["supabase/migrations/**", "supabase/migrations/20260101_x.sql"],
    ["supabase/migrations/*.sql", "supabase/migrations/20260101_x.sql"],
    ["**/*.md", "README.md"],
    ["**/*.md", "docs/deep/er/file.md"],
    ["scripts/*-fixtures.ts", "scripts/review-record-fixtures.ts"],
    ["src/lib/*.functions.ts", "src/lib/ehub.functions.ts"],
    ["src/**/labels*", "src/lib/labels.functions.ts"],
    ["wrangler.jsonc", "wrangler.jsonc"],
    ["LICENSE*", "LICENSE.md"],
    ["*.sql", "a/b/c.sql"],
    ["lib/{snappay,cardshield}*", "lib/cardshield.ts"],
    ["app/api/payments/**", "app/api/payments/snappay/route.ts"],
    ["docs/", "docs/x.md"],
  ];
  for (const [g, p] of yes) test(`${g} matches ${p}`, () => expect(matchGlob(g, p)).toBe(true));

  const no: [string, string][] = [
    [".github/workflows/**", ".github/CODEOWNERS"],
    ["supabase/migrations/*.sql", "supabase/migrations/nested/x.sql"],
    ["scripts/*-fixtures.ts", "scripts/review-record.ts"],
    ["src/lib/*.functions.ts", "src/lib/nested/x.functions.ts"],
    ["wrangler.jsonc", "sites/wrangler.jsonc.bak"],
    ["docs/**", "src/docs.ts"],
    ["*.sql", "a/b/c.sqlx"],
  ];
  for (const [g, p] of no) test(`${g} does not match ${p}`, () => expect(matchGlob(g, p)).toBe(false));

  test("a bare filename matches by basename anywhere", () => {
    expect(matchGlob("package.json", "sites/packmaster-world/package.json")).toBe(true);
  });
});
