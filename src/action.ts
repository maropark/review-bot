/**
 * GitHub Action entry. Inputs arrive as INPUT_<NAME>; provider settings come
 * from the job's env (REVIEW_*, TRIAGE_*). Writes a step summary and outputs.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { envConfig, type ProviderConfig } from "./config.ts";
import { GitHub } from "./github.ts";
import { OpenAICompatible } from "./llm.ts";
import { defaultConfigPath, run, type LLM } from "./main.ts";
import { consoleLogger } from "./types.ts";
import { VERSION } from "./version.ts";

function input(name: string): string {
  return (process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

function truthy(v: string): boolean {
  return /^(true|1|yes|on)$/i.test(v);
}

function append(file: string | undefined, text: string): void {
  if (file) appendFileSync(file, text);
}

function output(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `rb_${Math.random().toString(36).slice(2)}`;
  append(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function prNumber(): number {
  const fromInput = input("pr");
  if (fromInput) {
    const n = Number(fromInput);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`input pr must be a PR number, got "${fromInput}"`);
    return n;
  }
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: { number?: number }; inputs?: { pr?: string }; issue?: { number?: number; pull_request?: unknown } };
    if (event.pull_request?.number) return event.pull_request.number;
    if (event.inputs?.pr && Number(event.inputs.pr) > 0) return Number(event.inputs.pr);
    if (event.issue?.pull_request && event.issue.number) return event.issue.number;
  }
  throw new Error("no pull request: run on a pull_request event, or pass the `pr` input");
}

async function main(): Promise<void> {
  const log = consoleLogger(truthy(process.env.RUNNER_DEBUG ?? "") || truthy(input("verbose")));
  const env = envConfig(process.env);
  const token = input("github-token") || env.githubToken;
  if (!token) throw new Error("no GitHub token: pass `github-token` or set GITHUB_TOKEN");
  const repo = input("repository") || process.env.GITHUB_REPOSITORY || "";
  if (!repo) throw new Error("no repository: GITHUB_REPOSITORY is unset");

  const dryRun = truthy(input("dry-run"));
  const outcome = await run(
    {
      repo,
      pr: prNumber(),
      dryRun,
      force: truthy(input("force")),
      triageOnly: truthy(input("triage-only")),
      waitForChecksMinutes: Number(input("wait-for-checks-minutes") || 0),
      configPath: input("config") || defaultConfigPath(),
      checkoutDir: input("checkout") || process.env.GITHUB_WORKSPACE || null,
      policyRef: input("policy-ref") || "base",
      ...(input("worry") ? { worry: input("worry") } : {}),
      version: VERSION,
    },
    {
      gh: new GitHub(token, env.githubApi),
      env,
      makeLLM: (cfg: ProviderConfig): LLM => new OpenAICompatible(cfg),
      log,
    },
  );

  output("tier", outcome.decision.tier);
  output("may_approve", String(outcome.decision.may_approve));
  output("approved", String(outcome.approved));
  output("skipped", String(outcome.skipped));
  output("review_url", outcome.posted.reviewUrl ?? "");
  output("approval_url", outcome.posted.approvalUrl ?? "");
  output("decision", JSON.stringify(outcome.decision));

  const summary: string[] = [`### review-bot ${VERSION}${dryRun ? " (dry run)" : ""}`, "", `\`${outcome.decisionLine}\``, ""];
  for (const r of outcome.decision.reasons) summary.push(`- ${r}`);
  if (outcome.skipped) summary.push("", "Nothing posted: tier skip.");
  if (outcome.review) {
    summary.push("", `**Verdict:** ${outcome.review.verdict}, ${outcome.review.findings.length} finding(s)${outcome.reused ? " (reused the review already pinned to this head)" : ""}${outcome.posted.reviewUrl ? ` — ${outcome.posted.reviewUrl}` : ""}`);
    for (const f of outcome.review.findings) summary.push(`- ${f.id} · ${f.severity} · \`${f.where}\` · ${f.status} — ${f.claim}`);
  }
  summary.push("", outcome.approved ? `**Approved**${outcome.posted.approvalUrl ? ` — ${outcome.posted.approvalUrl}` : dryRun ? " (dry run: would approve)" : ""}` : `**Not approved**: ${outcome.approvalReasons.join("; ") || "no reason recorded"}`);
  if (dryRun && outcome.reviewBody) summary.push("", "<details><summary>Review body (dry run)</summary>", "", outcome.reviewBody, "", "</details>");
  if (dryRun && outcome.approvalBody && outcome.approved) summary.push("", "<details><summary>Approval body (dry run)</summary>", "", outcome.approvalBody, "", "</details>");
  append(process.env.GITHUB_STEP_SUMMARY, summary.join("\n") + "\n");

  if (dryRun && outcome.reviewBody) {
    console.log("\n──── review body (dry run) ────\n" + outcome.reviewBody);
    if (outcome.approvalBody && outcome.approved) console.log("\n──── approval body (dry run) ────\n" + outcome.approvalBody);
  }
  console.log(`::notice title=review-bot::${outcome.decisionLine}`);
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`::error title=review-bot failed::${msg}`);
  if (e instanceof Error && e.stack && truthy(process.env.RUNNER_DEBUG ?? "")) console.error(e.stack);
  process.exit(1);
});
