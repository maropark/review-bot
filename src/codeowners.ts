/**
 * Just enough CODEOWNERS to say which changed paths have an owner — so the
 * approval body can state, honestly, that the bot's approval does not stand in
 * for that owner's. Last matching line wins, as on GitHub.
 */

import { globToRegExp, matchGlob } from "./glob.ts";

export interface OwnerRule {
  pattern: string;
  owners: string[];
}

export function parseCodeowners(text: string): OwnerRule[] {
  const rules: OwnerRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern) continue;
    rules.push({ pattern, owners: owners.filter((o) => o.startsWith("@") || o.includes("@")) });
  }
  return rules;
}

export function codeownersMatch(pattern: string, path: string): boolean {
  const p = path.replace(/^\//, "");
  let pat = pattern;
  if (pat === "*") return true;
  const anchored = pat.startsWith("/");
  if (anchored) pat = pat.slice(1);
  if (pat.endsWith("/")) pat += "**";
  else if (!pat.includes("*") && !pat.includes(".")) {
    // a bare directory name without a trailing slash still matches its contents
    if (anchored ? globToRegExp(`${pat}/**`).test(p) : matchGlob(`**/${pat}/**`, p)) return true;
  }
  // anchored: from the root only — never by basename
  if (anchored) return globToRegExp(pat).test(p);
  // unanchored: match anywhere in the tree
  return matchGlob(pat, p) || matchGlob(`**/${pat}`, p);
}

export function ownersOf(rules: OwnerRule[], path: string): string[] {
  let owners: string[] = [];
  for (const r of rules) if (codeownersMatch(r.pattern, path)) owners = r.owners;
  return owners;
}

/** Changed paths that have at least one owner, with their owners. */
export function ownedPaths(rules: OwnerRule[], paths: string[]): { path: string; owners: string[] }[] {
  return paths.map((path) => ({ path, owners: ownersOf(rules, path) })).filter((x) => x.owners.length > 0);
}
