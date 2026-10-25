/**
 * The whole run against a fake GitHub and a fake model: what gets posted, what
 * gets reused, and when the approval is withheld.
 */
import { describe, expect, test } from "bun:test";
import type { EnvConfig, ProviderConfig } from "../src/config.ts";
import type { GitHub } from "../src/github.ts";
import { GitHubError } from "../src/github.ts";
import type { CompletionRequest, CompletionResult } from "../src/llm.ts";
import { run, type LLM, type RunOptions } from "../src/main.ts";
import { renderReviewBody } from "../src/record.ts";
import { silentLogger } from "../src/types.ts";
import { HEAD, OTHER, clean, decision, finding, withFindings } from "./helpers.ts";

type Review = { id: number; user: { login: string; type: string }; body: string; state: string; commit_id: string; submitted_at: string; html_url: string };

class FakeGitHub {
  pull = {
    number: 7,
    title: "Add the thing",
    body: "Adds the thing.",
    state: "open",
    draft: false,
    user: { login: "someone", type: "User" },
    labels: [] as { name: string }[],
    head: { sha: HEAD, ref: "feature", repo: { fork: false, full_name: "acme/widgets" } },
    base: { sha: OTHER, ref: "main", repo: { full_name: "acme/widgets" } },
    additions: 40,
    deletions: 5,
    changed_files: 2,
    html_url: "https://github.test/acme/widgets/pull/7",
  };
  files = [
    { filename: "src/thing.ts", status: "modified", additions: 30, deletions: 5 },
    { filename: "README.md", status: "modified", additions: 10, deletions: 0 },
  ];
  reviews: Review[] = [];
  comments: { id: number; user: { login: string }; body: string; created_at: string; updated_at: string; html_url: string }[] = [];
  checkRuns: { name: string; status: string; conclusion: string | null; started_at: string; completed_at: string | null; html_url: null }[] = [
    { name: "verified", status: "completed", conclusion: "success", started_at: "2026-10-25T00:00:00Z", completed_at: "2026-10-25T00:01:00Z", html_url: null },
  ];
  contents: Record<string, string> = {
    ".github/review-bot.json": JSON.stringify({ owner: "maropark", protocol: { kind: "adversary-v1", files: ["AGENTS.md"] }, risk: [{ label: "workflows", paths: [".github/workflows/**"] }] }),
    "AGENTS.md": "# Rules\nMinor findings never block.",
    ".github/CODEOWNERS": "/.github/ @maropark\n",
    "src/thing.ts": "export const thing = 1;\n",
    "README.md": "# hi\n",
  };
  created: { kind: "review" | "comment"; input: Record<string, unknown> }[] = [];
  approveError: GitHubError | null = null;
  diff = "diff --git a/src/thing.ts b/src/thing.ts\n+export const thing = 1;\n";
  liveSha = HEAD;

  async getPull() {
    return { ...this.pull, head: { ...this.pull.head, sha: this.liveSha } };
  }
  async listFiles() {
    return this.files;
  }
  async getDiff() {
    return this.diff;
  }
  async listReviews() {
    return this.reviews;
  }
  async listComments() {
    return this.comments;
  }
  async listCheckRuns() {
    return this.checkRuns;
  }
  async listStatuses() {
    return [];
  }
  async getBranchRules() {
    return [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "verified" }] } }];
  }
  async getContent(_repo: string, path: string) {
    return this.contents[path] ?? null;
  }
  async createReview(_repo: string, _n: number, input: { commit_id: string; body: string; event: string }) {
    if (input.event === "APPROVE" && this.approveError) throw this.approveError;
    const r: Review = { id: this.reviews.length + 1, user: { login: "github-actions[bot]", type: "Bot" }, body: input.body, state: input.event === "APPROVE" ? "APPROVED" : "COMMENTED", commit_id: input.commit_id, submitted_at: new Date().toISOString(), html_url: `https://github.test/r/${this.reviews.length + 1}` };
    this.reviews.push(r);
    this.created.push({ kind: "review", input });
    return r;
  }
  async createComment(_repo: string, _n: number, body: string) {
    this.created.push({ kind: "comment", input: { body } });
    return { id: 1, user: { login: "github-actions[bot]" }, body, created_at: "", updated_at: "", html_url: "https://github.test/c/1" };
  }
}

class FakeLLM implements LLM {
  calls: CompletionRequest[] = [];
  constructor(
    public model: string,
    private replies: string[],
  ) {}
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.calls.push(req);
    const text = this.replies.shift();
    if (text === undefined) throw new Error("no canned reply left");
    return { text, model: this.model, attempts: 1, droppedParams: [] };
  }
}

const CLEAN_REPLY = JSON.stringify({ verdict: "clean", findings: [], considered: ["shape 1 — nothing leaves", "shape 3 — assertion compares to a literal", "shape 4 — nothing removed"] });
const MAJOR_REPLY = JSON.stringify({ verdict: "findings", findings: [{ id: "F1", severity: "major", where: "src/thing.ts:1", claim: "thing is wrong", scenario: "when used, it breaks" }] });

function env(): EnvConfig {
  const review: ProviderConfig = { provider: "openai", baseUrl: "https://llm.test/v1", apiKey: "k", model: "review-model", api: "chat", timeoutMs: 1000, extraHeaders: {} };
  return { githubToken: "t", githubApi: "https://api.github.test", review, triage: null };
}

function opts(over: Partial<RunOptions> = {}): RunOptions {
  return { repo: "acme/widgets", pr: 7, dryRun: false, force: false, triageOnly: false, waitForChecksMinutes: 0, configPath: ".github/review-bot.json", checkoutDir: null, version: "v0.1.0", ...over };
}

function deps(gh: FakeGitHub, llms: LLM[]) {
  return { gh: gh as unknown as GitHub, env: env(), makeLLM: () => llms.shift()!, log: silentLogger };
}

describe("run", () => {
  test("clean review on a green head: posts a COMMENT review, then an APPROVE pinned to the head", async () => {
    const gh = new FakeGitHub();
    const llm = new FakeLLM("review-model", [CLEAN_REPLY]);
    const out = await run(opts(), deps(gh, [llm]));
    expect(out.decision.tier).toBe("light"); // 45 lines, rules only
    expect(out.review?.verdict).toBe("clean");
    expect(gh.created.map((c) => c.input.event)).toEqual(["COMMENT", "APPROVE"]);
    expect(gh.created[0]!.input.commit_id).toBe(HEAD);
    expect(String(gh.created[0]!.input.body).split("\n")[0]).toMatch(/^review-bot v0\.1\.0 · tier=light · model=review-model/);
    expect(String(gh.created[1]!.input.body)).toContain(`kind=approval`);
    expect(out.approved).toBe(true);
    // the reviewer got the repo's protocol file and the diff, not the bot's opinion
    expect(llm.calls[0]!.system).toContain("Minor findings never block.");
    expect(llm.calls[0]!.user).toContain("export const thing = 1;");
    expect(llm.calls[0]!.effort).toBe("low");
  });

  test("an open major: review posted, approval withheld and the reason says so", async () => {
    const gh = new FakeGitHub();
    const out = await run(opts(), deps(gh, [new FakeLLM("review-model", [MAJOR_REPLY])]));
    expect(gh.created.map((c) => c.input.event)).toEqual(["COMMENT"]);
    expect(out.approved).toBe(false);
    expect(out.approvalReasons.join()).toMatch(/1 major/);
  });

  test("a blocker requests changes only when the repo asks for it", async () => {
    const gh = new FakeGitHub();
    gh.contents[".github/review-bot.json"] = JSON.stringify({ approval: { requestChangesOnBlocker: true } });
    const reply = JSON.stringify({ findings: [{ id: "F1", severity: "blocker", where: "src/thing.ts:1", claim: "c", scenario: "s" }] });
    await run(opts(), deps(gh, [new FakeLLM("review-model", [reply])]));
    expect(gh.created[0]!.input.event).toBe("REQUEST_CHANGES");
  });

  test("a workflow change forces adversarial, never calls the triage model, and never approves even when clean", async () => {
    const gh = new FakeGitHub();
    gh.files = [{ filename: ".github/workflows/ci.yml", status: "modified", additions: 3, deletions: 1 }];
    const out = await run(opts(), deps(gh, [new FakeLLM("review-model", [CLEAN_REPLY])]));
    expect(out.decision.tier).toBe("adversarial");
    expect(out.decision.may_approve).toBe(false);
    expect(gh.created.map((c) => c.input.event)).toEqual(["COMMENT"]);
    expect(out.approvalReasons.join()).toMatch(/may_approve=no/);
  });

  test("a review already pinned to the head is reused: no model call, straight to the gate", async () => {
    const gh = new FakeGitHub();
    gh.reviews.push({
      id: 9,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: renderReviewBody({ version: "v0.1.0", decisionLine: "line", decision: decision({ tier: "light", may_approve: true }), review: clean(), sha: HEAD, diffBytes: 10, files: 2, kind: "adversary-v1" }),
      state: "COMMENTED",
      commit_id: HEAD,
      submitted_at: "2026-10-25T00:00:00Z",
      html_url: "https://github.test/r/9",
    });
    const llm = new FakeLLM("review-model", []);
    const out = await run(opts(), deps(gh, [llm]));
    expect(out.reused).toBe(true);
    expect(llm.calls.length).toBe(0);
    expect(gh.created.map((c) => c.input.event)).toEqual(["APPROVE"]);
  });

  test("round two: prior findings and the next id are handed to the reviewer", async () => {
    const gh = new FakeGitHub();
    gh.reviews.push({
      id: 9,
      user: { login: "github-actions[bot]", type: "Bot" },
      body: renderReviewBody({ version: "v0.1.0", decisionLine: "line", decision: decision(), review: withFindings(finding("F1", "major"), finding("F2", "minor")), sha: OTHER, diffBytes: 10, files: 2, kind: "adversary-v1" }),
      state: "COMMENTED",
      commit_id: OTHER,
      submitted_at: "2026-10-25T00:00:00Z",
      html_url: "https://github.test/r/9",
    });
    gh.comments.push({ id: 1, user: { login: "someone" }, body: "F1 fixed in abc123", created_at: "2026-10-25T01:00:00Z", updated_at: "2026-10-25T01:00:00Z", html_url: "" });
    const reply = JSON.stringify({ findings: [{ id: "F1", severity: "major", where: "src/thing.ts:1", claim: "F1 is wrong", scenario: "s", status: "fixed", note: "abc123" }, { id: "F2", severity: "minor", where: "a", claim: "c", scenario: "s", status: "open" }, { id: "F3", severity: "minor", where: "b", claim: "c", scenario: "s" }] });
    const llm = new FakeLLM("review-model", [reply]);
    const out = await run(opts(), deps(gh, [llm]));
    expect(llm.calls[0]!.user).toContain("Prior findings on this PR");
    expect(llm.calls[0]!.user).toContain("F1 fixed in abc123");
    expect(llm.calls[0]!.system).toContain("new findings start at F3");
    expect(out.approved).toBe(true); // F1 fixed, two open minors
  });

  test("a reply that does not parse is re-prompted once with the problems, then fails loudly", async () => {
    const gh = new FakeGitHub();
    const llm = new FakeLLM("review-model", ['{"verdict":"clean","considered":["only one"]}', "still not json"]);
    await expect(run(opts(), deps(gh, [llm]))).rejects.toThrow(/did not parse after two attempts/);
    expect(llm.calls.length).toBe(2);
    expect(llm.calls[1]!.system).toContain("Your previous reply did not parse");
    expect(llm.calls[1]!.system).toContain('three "considered"');
    expect(gh.created.length).toBe(0);
  });

  test("the head moved during the review: the review is posted pinned to the old head, nothing is approved", async () => {
    const gh = new FakeGitHub();
    const llm: LLM = {
      model: "review-model",
      async complete() {
        gh.liveSha = OTHER; // a push lands while the model thinks
        return { text: CLEAN_REPLY, model: "review-model", attempts: 1, droppedParams: [] };
      },
    };
    const out = await run(opts(), deps(gh, [llm]));
    expect(gh.created.map((c) => c.input.event)).toEqual(["COMMENT"]);
    expect(out.approved).toBe(false);
    expect(out.approvalReasons.join()).toMatch(/head moved/);
  });

  test("red CI: adversarial, posted, not approved", async () => {
    const gh = new FakeGitHub();
    gh.checkRuns[0]!.conclusion = "failure";
    const out = await run(opts(), deps(gh, [new FakeLLM("review-model", [CLEAN_REPLY])]));
    expect(out.decision.tier).toBe("adversarial");
    expect(out.approved).toBe(false);
    expect(out.approvalReasons.join()).toMatch(/failing/);
  });

  test("GitHub refusing the approval is explained, not thrown", async () => {
    const gh = new FakeGitHub();
    gh.approveError = new GitHubError(422, "422", JSON.stringify({ message: "Unprocessable Entity", errors: ["GitHub Actions is not permitted to approve pull requests."] }));
    const out = await run(opts(), deps(gh, [new FakeLLM("review-model", [CLEAN_REPLY])]));
    expect(out.approved).toBe(false);
    expect(out.approvalReasons.join()).toMatch(/Allow GitHub Actions to create and approve/);
    expect(gh.created.map((c) => c.input.event)).toEqual(["COMMENT"]);
  });

  test("a TypeSafe triage: Jev's choice sets the tier and its flags reach the reviewer as a worry", async () => {
    const gh = new FakeGitHub();
    const llm = new FakeLLM("review-model", [CLEAN_REPLY]);
    const e = env();
    e.triage = { provider: "typesafe", baseUrl: "https://api.typesafe.test", apiKey: "ts", model: "jev-latest", api: "chat", timeoutMs: 1000, extraHeaders: {} };
    let seen: unknown = null;
    const fakeTypeSafe = {
      model: "jev-latest",
      async systemOne(req: { state: unknown; questions: Record<string, unknown> }) {
        seen = req;
        return { model: "jev-1.14.0", answers: { tier: { type: "choice", choice: "adversarial", confidence: 0.8, probabilities: { light: 0.05, standard: 0.15, adversarial: 0.8 } }, money: { type: "noul", noul: 0.9 }, auth: { type: "noul", noul: 0.1 } } };
      },
    };
    const out = await run(opts(), { gh: gh as unknown as GitHub, env: e, makeLLM: () => llm, makeTypeSafe: () => fakeTypeSafe as never, log: silentLogger });
    expect(out.decision.tier).toBe("adversarial");
    expect(out.decision.classifier).toBe("model");
    expect(out.decision.reasons.join()).toContain("Jev chose adversarial");
    expect((seen as { state: { title: string; risk_areas: string[] } }).state.title).toBe("Add the thing");
    expect((seen as { state: { risk_areas: string[] } }).state.risk_areas).toEqual(["workflows"]);
    expect(Object.keys((seen as { questions: Record<string, unknown> }).questions)).toContain("tier");
    expect(llm.calls[0]!.system).toContain("flagged this change as likely touching: money (0.90)");
    expect(llm.calls[0]!.effort).toBe("high");
  });

  test("dry run posts nothing and returns the bodies", async () => {
    const gh = new FakeGitHub();
    const out = await run(opts({ dryRun: true }), deps(gh, [new FakeLLM("review-model", [CLEAN_REPLY])]));
    expect(gh.created.length).toBe(0);
    expect(out.reviewBody).toContain("kind=review");
    expect(out.approvalBody).toContain("kind=approval");
    expect(out.approved).toBe(true);
  });

  test("a draft is skipped before any model call", async () => {
    const gh = new FakeGitHub();
    gh.pull.draft = true;
    const out = await run(opts(), deps(gh, [new FakeLLM("review-model", [])]));
    expect(out.skipped).toBe(true);
    expect(gh.created.length).toBe(0);
  });

  test("the record comment is posted when the repo asks, with the adversary marker", async () => {
    const gh = new FakeGitHub();
    gh.contents[".github/review-bot.json"] = JSON.stringify({ protocol: { kind: "adversary-v1", files: ["AGENTS.md"] }, post: { recordComment: true } });
    await run(opts(), deps(gh, [new FakeLLM("review-model", [CLEAN_REPLY])]));
    const comment = gh.created.find((c) => c.kind === "comment");
    expect(String(comment?.input.body).startsWith("<!-- adversary:v1 -->\n")).toBe(true);
    expect(String(gh.created[0]!.input.body)).not.toContain("<!-- adversary:v1 -->");
  });
});
