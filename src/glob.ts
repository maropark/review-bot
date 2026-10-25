/**
 * A small glob matcher for changed-path rules. Supports `**` (any number of
 * path segments), `*` (within one segment), `?`, and `{a,b}` alternatives. A
 * pattern with no slash also matches by basename, the way .gitignore does. No
 * dependency: the whole bot is meant to run from one bundled file.
 */

function escapeRe(s: string): string {
  return s.replace(/[.+^$()|[\]\\]/g, "\\$&");
}

export function globToRegExp(glob: string): RegExp {
  let g = glob.trim();
  if (g.startsWith("./")) g = g.slice(2);
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = g.indexOf("}", i);
      if (end > i) {
        const alts = g.slice(i + 1, end).split(",").map((a) => escapeRe(a.trim()));
        re += `(?:${alts.join("|")})`;
        i = end;
      } else {
        re += "\\{";
      }
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchGlob(glob: string, path: string): boolean {
  const p = path.replace(/^\.?\//, "");
  const re = globToRegExp(glob);
  if (re.test(p)) return true;
  if (!glob.includes("/")) {
    const base = p.split("/").pop() ?? p;
    return re.test(base);
  }
  return false;
}

export function matchAny(globs: readonly string[], path: string): boolean {
  return globs.some((g) => matchGlob(g, path));
}
