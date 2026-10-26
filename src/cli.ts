/**
 * The same run from a laptop. `review-bot run --repo owner/name --pr 12 --dry-run`
 * prints the decision and the review it would post, and posts nothing.
 */

import { execFileSync } from "node:child_process";
import { envConfig, type ProviderConfig } from "./config.ts";
import { GitHub } from "./github.ts";
import { OpenAICompatible } from "./llm.ts";
import { defaultConfigPath, run, type LLM } from "./main.ts";
import { consoleLogger } from "./types.ts";
import { VERSION } from "./version.ts";

const USAGE = `review-bot ${VERSION}

usage:
  review-bot run    --repo owner/name --pr N [options]   triage, review, post, approve
  review-bot triage --repo owner/name --pr N [options]   print the triage decision only
  review-bot version

options:
  --checkout <dir>       the PR head checked out locally (default: read files through the API)
  --config <path>        repo config (default .github/review-bot.json)
  --policy-ref <ref>     where the config, protocol files and CODEOWNERS are read: base (default), head, or a sha
  --dry-run              print the decision and the review; post nothing
  --force                review again even if a review is already pinned to the head
  --wait-checks <min>    wait up to this long for pending required checks before deciding to approve
  --worry "<text>"       what you are worried about; handed to the reviewer
  --verbose

environment:
  GITHUB_TOKEN           or \`gh auth token\` is used
  REVIEW_BASE_URL        default https://api.openai.com/v1 (any OpenAI-compatible endpoint)
  REVIEW_API_KEY         bearer token for that endpoint (may be empty for a local server)
  REVIEW_MODEL           the review model
  REVIEW_API             chat (default) | responses
  TRIAGE_BASE_URL/TRIAGE_API_KEY/TRIAGE_MODEL/TRIAGE_API   the cheap triage model; unset → rules only
  REVIEW_EXTRA_HEADERS   JSON object of extra headers (e.g. a Cloudflare Access service token)
`;

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | true> } {
  const [cmd = "", ...rest] = argv;
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument "${a}"`);
    const key = a.slice(2);
    const next = rest[i + 1];
    if (key === "dry-run" || key === "force" || key === "verbose") flags[key] = true;
    else if (next === undefined || next.startsWith("--")) throw new Error(`--${key} needs a value`);
    else {
      flags[key] = next;
      i++;
    }
  }
  return { cmd, flags };
}

async function main(): Promise<void> {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (cmd === "version") {
    console.log(VERSION);
    return;
  }
  if (cmd !== "run" && cmd !== "triage") {
    console.log(USAGE);
    process.exit(cmd === "" || cmd === "help" || cmd === "--help" ? 0 : 2);
  }
  const repo = String(flags.repo ?? "");
  const pr = Number(flags.pr ?? 0);
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("--repo must be owner/name");
  if (!Number.isInteger(pr) || pr <= 0) throw new Error("--pr must be a pull request number");

  const env = envConfig(process.env);
  let token = env.githubToken;
  if (!token) {
    try {
      token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
    } catch {
      throw new Error("no GitHub token: set GITHUB_TOKEN or log in with `gh auth login`");
    }
  }
  const log = consoleLogger(flags.verbose === true);
  const outcome = await run(
    {
      repo,
      pr,
      dryRun: flags["dry-run"] === true,
      force: flags.force === true,
      triageOnly: cmd === "triage",
      waitForChecksMinutes: Number(flags["wait-checks"] ?? 0),
      configPath: String(flags.config ?? defaultConfigPath()),
      checkoutDir: flags.checkout ? String(flags.checkout) : null,
      policyRef: String(flags["policy-ref"] ?? "base"),
      ...(flags.worry ? { worry: String(flags.worry) } : {}),
      version: VERSION,
    },
    { gh: new GitHub(token, env.githubApi), env, makeLLM: (cfg: ProviderConfig): LLM => new OpenAICompatible(cfg), log },
  );

  console.log("\n──── decision ────");
  console.log(JSON.stringify(outcome.decision, null, 2));
  if (cmd === "triage") return;
  if (outcome.reviewBody && (flags["dry-run"] === true || !outcome.posted.reviewUrl)) {
    console.log("\n──── review body ────\n" + outcome.reviewBody);
  }
  if (outcome.approvalBody && outcome.approved && flags["dry-run"] === true) {
    console.log("\n──── approval body ────\n" + outcome.approvalBody);
  }
  console.log("\n──── outcome ────");
  console.log(`review:   ${outcome.posted.reviewUrl ?? (outcome.skipped ? "skipped" : flags["dry-run"] ? "not posted (dry run)" : "not posted")}`);
  console.log(`approved: ${outcome.approved ? "yes" + (flags["dry-run"] ? " (dry run)" : "") : "no — " + outcome.approvalReasons.join("; ")}`);
  if (outcome.posted.approvalUrl) console.log(`approval: ${outcome.posted.approvalUrl}`);
}

main().catch((e: unknown) => {
  console.error(`review-bot: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
