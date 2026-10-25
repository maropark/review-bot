/**
 * One run: triage → review → post → approve-or-say-why-not, for one PR.
 *
 * Idempotent per head sha. A bot review already pinned to the head is reused
 * (no second model call) and the run goes straight to the approval gate, so a
 * re-run after CI finishes costs nothing but a few API reads.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { evaluateApproval, renderApprovalBody } from "./approve.ts";
import { describeChecks, readChecks } from "./checks.ts";
import { ownedPaths, parseCodeowners } from "./codeowners.ts";
import { parseRepoConfigText, type EnvConfig, type ProviderConfig, type RepoConfig } from "./config.ts";
import { GitHub, GitHubError, type ReviewResponse } from "./github.ts";
import { extractJson, type CompletionRequest, type CompletionResult } from "./llm.ts";
import { buildPrompts, type ProtocolFile } from "./protocol.ts";
import {
  decodeData,
  nextFindingId,
  openCounts,
  parseBotMarker,
  renderAdversaryRecord,
  renderReviewBody,
  validateReview,
  type BotData,
} from "./record.ts";
import { classifierPrompts, formatDecisionLine, parseClassifierReply, triage, type Classifier } from "./triage.ts";
import { TypeSafe, typesafeClassifier } from "./typesafe.ts";
import type { Decision, Finding, Logger, PRSignals, ReviewResult } from "./types.ts";

export interface RunOptions {
  repo: string;
  pr: number;
  dryRun: boolean;
  force: boolean;
  triageOnly: boolean;
  waitForChecksMinutes: number;
  configPath: string;
  /** Where the PR head is checked out. null → every file is read through the API at the head sha. */
  checkoutDir: string | null;
  worry?: string;
  version: string;
}

export interface LLM {
  model: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export interface RunDeps {
  gh: GitHub;
  env: EnvConfig;
  makeLLM: (cfg: ProviderConfig) => LLM;
  /** Test seam for the TypeSafe triage client. */
  makeTypeSafe?: (cfg: ProviderConfig) => TypeSafe;
  log: Logger;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOutcome {
  decision: Decision;
  decisionLine: string;
  signals: PRSignals;
  review: ReviewResult | null;
  reviewBody: string | null;
  approvalBody: string | null;
  posted: { reviewUrl?: string; commentUrl?: string; approvalUrl?: string };
  approved: boolean;
  approvalReasons: string[];
  skipped: boolean;
  reused: boolean;
  modelNote?: string;
}

type Reader = (path: string) => Promise<string | null>;

function fileReader(gh: GitHub, repo: string, sha: string, checkoutDir: string | null, log: Logger): Reader {
  if (checkoutDir) {
    const root = resolve(checkoutDir);
    return async (path) => {
      const full = resolve(root, path);
      if (full !== root && !full.startsWith(root + sep)) {
        log.warn(`refusing to read ${path}: outside the checkout`);
        return null;
      }
      if (!existsSync(full)) return null;
      try {
        return readFileSync(full, "utf8");
      } catch (e) {
        log.warn(`could not read ${path}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    };
  }
  return (path) => gh.getContent(repo, path, sha);
}

function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= max) return { text, truncated: false };
  let cut = text.slice(0, max);
  while (Buffer.byteLength(cut, "utf8") > max) cut = cut.slice(0, -Math.ceil((Buffer.byteLength(cut, "utf8") - max) / 2) || -1);
  return { text: cut + "\n…(truncated)", truncated: true };
}

function looksBinary(text: string): boolean {
  return text.includes("\u0000");
}

export async function run(opts: RunOptions, deps: RunDeps): Promise<RunOutcome> {
  const { gh, env, log } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const posted: RunOutcome["posted"] = {};

  const pr = await gh.getPull(opts.repo, opts.pr);
  const files = await gh.listFiles(opts.repo, opts.pr);
  const headSha = pr.head.sha;
  log.info(`${opts.repo}#${pr.number} "${pr.title}" by ${pr.user.login} · head ${headSha.slice(0, 12)} · ${pr.draft ? "draft" : pr.state} · ${files.length} files`);

  const read = fileReader(gh, opts.repo, headSha, opts.checkoutDir, log);
  const configText = await read(opts.configPath);
  if (configText === null) log.warn(`${opts.configPath} not found at the head; using the built-in defaults (generic protocol, no risk rules)`);
  const config: RepoConfig = parseRepoConfigText(configText);

  const checks = await readChecks(gh, opts.repo, pr.base.ref, headSha, config.requiredChecks);
  log.info(`checks: ${describeChecks(checks)}`);

  const signals: PRSignals = {
    repo: opts.repo,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    author: pr.user.login,
    authorType: pr.user.type,
    draft: pr.draft,
    state: pr.state,
    labels: pr.labels.map((l) => l.name),
    headSha,
    baseSha: pr.base.sha,
    baseRef: pr.base.ref,
    headRef: pr.head.ref,
    isFork: pr.head.repo ? pr.head.repo.fork : false,
    files,
    additions: pr.additions,
    deletions: pr.deletions,
    checks,
  };

  let classifier: Classifier | undefined;
  if (env.triage?.provider === "typesafe") {
    classifier = typesafeClassifier(deps.makeTypeSafe ? deps.makeTypeSafe(env.triage) : new TypeSafe(env.triage), log);
  } else if (env.triage) {
    const triageCfg = env.triage;
    classifier = async (input) => {
      const llm = deps.makeLLM(triageCfg);
      const { system, user } = classifierPrompts(input);
      const r = await llm.complete({ system, user, json: true, effort: "low" });
      log.debug(`triage model ${llm.model} answered in ${r.attempts} attempt(s): ${r.text.slice(0, 200)}`);
      return parseClassifierReply(extractJson(r.text));
    };
  }

  const decision = await triage(signals, config, env.review.model, classifier);
  const decisionLine = formatDecisionLine(decision, opts.version);
  log.info(decisionLine);
  for (const r of decision.reasons) log.info(`  - ${r}`);

  const base: RunOutcome = {
    decision,
    decisionLine,
    signals,
    review: null,
    reviewBody: null,
    approvalBody: null,
    posted,
    approved: false,
    approvalReasons: [],
    skipped: false,
    reused: false,
  };

  if (decision.tier === "skip" || opts.triageOnly) {
    return { ...base, skipped: decision.tier === "skip", approvalReasons: decision.tier === "skip" ? ["tier skip: nothing to review or approve"] : ["triage only"] };
  }
  if (!decision.model) throw new Error("no review model: set REVIEW_MODEL (or tiers.<tier>.model in review-bot.json)");

  // ── What the bot already said on this PR ──────────────────────────────────
  const reviews = await gh.listReviews(opts.repo, opts.pr);
  const botReviews = reviews
    .map((r) => ({ r, marker: parseBotMarker(r.body), data: decodeData(r.body) }))
    .filter((x): x is { r: ReviewResponse; marker: { sha: string; kind: "review" }; data: BotData } => !!x.marker && x.marker.kind === "review" && !!x.data)
    .sort((a, b) => Date.parse(a.r.submitted_at ?? "") - Date.parse(b.r.submitted_at ?? ""));
  const existing = botReviews.find((x) => x.marker.sha === headSha.toLowerCase());

  let review: ReviewResult;
  let diffBytes: number;
  let reviewBody: string;
  let reused = false;
  let modelNote: string | undefined;

  if (existing && !opts.force) {
    review = existing.data.review;
    diffBytes = existing.data.diffBytes;
    reviewBody = existing.r.body ?? "";
    posted.reviewUrl = existing.r.html_url;
    reused = true;
    log.info(`a review pinned to ${headSha.slice(0, 12)} is already on the PR (${existing.r.html_url}); reusing it`);
  } else {
    const rawDiff = await gh.getDiff(opts.repo, opts.pr);
    diffBytes = Buffer.byteLength(rawDiff, "utf8");
    const diff = truncate(rawDiff, config.limits.maxDiffBytes);

    const protocolFiles: ProtocolFile[] = [];
    for (const path of config.protocol.files) {
      const text = await read(path);
      if (text === null) {
        log.warn(`protocol file ${path} is not in the repository at ${headSha.slice(0, 12)}; skipping it`);
        continue;
      }
      const t = truncate(text, config.limits.maxProtocolBytes);
      protocolFiles.push({ path, text: t.text, truncated: t.truncated });
    }
    if (!protocolFiles.length) log.warn("no protocol files could be read; the reviewer gets the generic protocol");

    const inlineFiles: { path: string; text: string; truncated: boolean }[] = [];
    let budget = config.limits.maxInlineBytes;
    const candidates = files.filter((f) => f.status !== "removed").sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
    for (const f of candidates) {
      if (budget <= 0) break;
      const text = await read(f.filename);
      if (text === null || looksBinary(text)) continue;
      const t = truncate(text, Math.min(config.limits.maxFileBytes, budget));
      inlineFiles.push({ path: f.filename, text: t.text, truncated: t.truncated });
      budget -= Buffer.byteLength(t.text, "utf8");
    }

    // Round two: every finding ever posted by the bot is a claim to re-check; ids continue.
    const allPrior: Finding[] = botReviews.flatMap((x) => x.data.review.findings);
    const latest = botReviews.at(-1);
    let prior: { findings: Finding[]; thread: string[] } | null = null;
    if (latest) {
      const since = Date.parse(latest.r.submitted_at ?? "") || 0;
      const comments = (await gh.listComments(opts.repo, opts.pr)).filter((c) => Date.parse(c.created_at) > since && c.body);
      const thread = comments.slice(-20).map((c) => `> **${c.user?.login ?? "someone"}** (${c.created_at}):\n${(c.body ?? "").slice(0, 2000)}`);
      prior = { findings: latest.data.review.findings, thread };
      log.info(`round ${botReviews.length + 1}: ${prior.findings.length} prior finding(s) to re-check, ${thread.length} comment(s) since the last record`);
    }
    const nextId = nextFindingId(allPrior);
    const priorIds = new Set(allPrior.map((f) => f.id));

    const llm = deps.makeLLM({ ...env.review, model: decision.model });
    const worry = [opts.worry, decision.worry].filter(Boolean).join(" ") || undefined;
    const promptBase = { signals, decision, config, diff: diff.text, diffBytes, diffTruncated: diff.truncated, protocolFiles, inlineFiles, prior, nextId, worry };
    let problems: string[] = [];
    let parsed: ReviewResult | null = null;
    let lastText = "";
    for (let attempt = 1; attempt <= 2 && !parsed; attempt++) {
      const { system, user } = buildPrompts({ ...promptBase, problems });
      log.info(`review: ${llm.model}, effort ${decision.effort}, attempt ${attempt} (${Buffer.byteLength(system + user, "utf8")} prompt bytes)`);
      const r = await llm.complete({ system, user, effort: decision.effort, json: true });
      lastText = r.text;
      if (r.droppedParams.length) modelNote = `the endpoint rejected ${r.droppedParams.join(", ")}, sent without`;
      if (r.usage?.input || r.usage?.output) log.info(`usage: ${r.usage.input ?? "?"} in / ${r.usage.output ?? "?"} out`);
      let json: unknown;
      try {
        json = extractJson(r.text);
      } catch (e) {
        problems = [e instanceof Error ? e.message : String(e)];
        log.warn(`attempt ${attempt}: ${problems[0]}`);
        continue;
      }
      const v = validateReview(json, { nextId, priorIds });
      if (v.review) parsed = v.review;
      else {
        problems = v.problems;
        log.warn(`attempt ${attempt} did not validate:\n  - ${problems.join("\n  - ")}`);
      }
    }
    if (!parsed) {
      log.error(`the model's last reply:\n${lastText.slice(0, 4000)}`);
      throw new Error(`the review did not parse after two attempts: ${problems.join("; ")}`);
    }
    review = parsed;

    reviewBody = renderReviewBody({
      version: opts.version,
      decisionLine,
      decision,
      review,
      sha: headSha,
      diffBytes,
      files: files.length,
      kind: config.protocol.kind,
      ...(modelNote ? { modelNote } : {}),
    });
    const counts = openCounts(review.findings);
    const event = counts.blocker && config.approval.requestChangesOnBlocker ? "REQUEST_CHANGES" : "COMMENT";
    log.info(`verdict: ${review.verdict}, ${review.findings.length} finding(s), ${counts.open} open (${counts.blocker} blocker, ${counts.major} major, ${counts.minor} minor) → ${event}`);

    if (opts.dryRun) {
      log.info("dry run: not posting the review");
    } else {
      const r = await gh.createReview(opts.repo, opts.pr, { commit_id: headSha, body: reviewBody, event });
      posted.reviewUrl = r.html_url;
      log.info(`posted ${event} review ${r.html_url}`);
      if (config.post.recordComment && config.protocol.kind === "adversary-v1") {
        const c = await gh.createComment(opts.repo, opts.pr, renderAdversaryRecord({ sha: headSha, diffBytes, files: files.length, review }, true));
        posted.commentUrl = c.html_url;
        log.info(`posted the record as a comment ${c.html_url}`);
      }
    }
  }

  // ── Approve, or say exactly why not ───────────────────────────────────────
  let liveChecks = checks;
  if (opts.waitForChecksMinutes > 0 && decision.may_approve) {
    const deadline = Date.now() + opts.waitForChecksMinutes * 60_000;
    while (Date.now() < deadline) {
      liveChecks = await readChecks(gh, opts.repo, pr.base.ref, headSha, config.requiredChecks);
      if (liveChecks.overall !== "pending") break;
      log.info(`waiting for required checks (${describeChecks(liveChecks)})`);
      await sleep(30_000);
    }
  } else {
    liveChecks = await readChecks(gh, opts.repo, pr.base.ref, headSha, config.requiredChecks);
  }
  const live = await gh.getPull(opts.repo, opts.pr);
  const verdict = evaluateApproval({
    decision,
    review,
    reviewedSha: headSha,
    liveSha: live.head.sha,
    liveState: live.state,
    liveDraft: live.draft,
    checks: liveChecks,
    config,
  });

  let approvalBody: string | null = null;
  let approved = false;
  const approvalReasons = [...verdict.reasons];
  if (verdict.approve) {
    const already = (await gh.listReviews(opts.repo, opts.pr)).find((r) => {
      const m = parseBotMarker(r.body);
      return m?.kind === "approval" && m.sha === headSha.toLowerCase() && r.state.toUpperCase() === "APPROVED";
    });
    const ownersText = (await read(".github/CODEOWNERS")) ?? (await read("CODEOWNERS")) ?? (await read("docs/CODEOWNERS"));
    const owned = ownersText ? ownedPaths(parseCodeowners(ownersText), files.map((f) => f.filename)) : [];
    approvalBody = renderApprovalBody({ version: opts.version, sha: headSha, decision, review, checks: liveChecks, owned, decisionLine });
    if (already) {
      approved = true;
      posted.approvalUrl = already.html_url;
      log.info(`an approval pinned to ${headSha.slice(0, 12)} already exists (${already.html_url})`);
    } else if (opts.dryRun) {
      approved = true;
      log.info("dry run: would approve");
    } else {
      try {
        const r = await gh.createReview(opts.repo, opts.pr, { commit_id: headSha, body: approvalBody, event: "APPROVE" });
        approved = true;
        posted.approvalUrl = r.html_url;
        log.info(`approved: ${r.html_url}`);
      } catch (e) {
        if (e instanceof GitHubError && (e.status === 422 || e.status === 403)) {
          const why = /not permitted|can not approve|cannot approve|approve.*own|GitHub Actions/i.test(e.body ?? "")
            ? "GitHub refused the approval. With the workflow token this means the repository setting “Allow GitHub Actions to create and approve pull requests” is off, or the token belongs to the PR's author"
            : `GitHub refused the approval (${e.status})`;
          approvalReasons.push(`${why}: ${(e.body ?? e.message).slice(0, 300)}`);
          log.warn(approvalReasons.at(-1)!);
        } else throw e;
      }
    }
  } else {
    log.info(`not approving:\n  - ${verdict.reasons.join("\n  - ")}`);
  }

  return { ...base, review, reviewBody, approvalBody, approved, approvalReasons, reused, ...(modelNote ? { modelNote } : {}) };
}

/** A small helper for the entry points: the `.github/review-bot.json` path relative to a checkout. */
export function defaultConfigPath(): string {
  return join(".github", "review-bot.json");
}
