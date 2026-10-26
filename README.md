# review-bot

An automated pull-request reviewer that is not tied to any one AI vendor.

For every PR that is marked ready, and again on every push to it, the bot:

1. **Triages** ("system 1"): from cheap signals alone — which paths changed, how big the diff is, what CI says, who the author is, which labels are on — it decides the review **tier** (`skip`, `light`, `standard`, `adversarial`), which **model** to use and how much **reasoning effort** to spend, and whether it is **allowed to approve** at all. Deterministic rules decide everything they can; a small, cheap model is asked only about the PRs the rules leave open.
2. **Reviews** with that model, against **the repository's own review protocol**, read from the repository at run time (for example `AGENTS.md` and `docs/CODE-REVIEW.md`). The reviewer is cold: it gets the diff, the changed files and the rules, and is told the PR description is a claim to check, not evidence.
3. **Posts** the findings on the PR as a review. The first line is the triage decision, so anyone can see why the PR got the review it got.
4. **Approves** — as a separate review pinned to the same commit — only when the tier allowed it, no blocker or major finding is open, the branch has not moved since the review, and no required check is failing. Otherwise it says exactly which condition failed.

It is written in TypeScript, ships as one bundled file with **no dependencies and no vendor SDK**, and talks to any **OpenAI-compatible** endpoint: OpenAI, OpenRouter, Ollama, vLLM, LM Studio, or a proxy in front of something else. Changing provider is changing one URL.

## Install in a repository

Three things go into the repository that wants reviews.

**1. The workflow** — copy [`examples/review-bot.yml`](examples/review-bot.yml) to `.github/workflows/review-bot.yml` and pin the tag:

```yaml
      - uses: maropark/review-bot@v0.3.0
```

It runs on `pull_request` `ready_for_review` and `synchronize` (drafts, Dependabot and fork PRs are skipped), and can be run by hand from the Actions tab (`workflow_dispatch` with a PR number). The workflow's own token is enough to post a review; see [Approval](#approval-what-counts-on-github) for what it takes to approve.

**2. The repository config** — `.github/review-bot.json`, the governance that belongs with the repo it governs. Two worked examples: [`examples/packmaster.work.review-bot.json`](examples/packmaster.work.review-bot.json) and [`examples/epeptides.review-bot.json`](examples/epeptides.review-bot.json); the full shape is in [`examples/review-bot.schema.json`](examples/review-bot.schema.json). The fields that matter:

| field | what it does |
|---|---|
| `protocol.files` | the files handed to the reviewer as its protocol and domain rules, read at the PR head |
| `protocol.kind` | `adversary-v1` renders the record block packmaster.work's `review-record.ts` parses; `generic` is a plain findings list |
| `risk[]` | path globs that **force** a tier (default `adversarial`) and, unless `approve: true`, forbid approval |
| `skip.labels` / `skip.authors` | a label that waives the review; authors (Dependabot) skipped unless the title reads as a major version bump |
| `tiers.<tier>.effort` / `.model` | reasoning effort per tier (`low`, `medium`, `high`, `xhigh`, `max`), and an optional model per tier; `risk[].model` / `risk[].effort` do the same for the paths a rule names |
| `size.light` / `size.standard` | the line thresholds used when no triage model is configured, or it fails |
| `approval.*` | whether the bot may approve, for which tiers, whether a pending check blocks, whether a blocker requests changes |

**3. Provider settings** — repository **variables** for the names and URLs, a **secret** for the key. Nothing provider-specific is in the workflow file, so switching provider or model is a settings change, not a PR:

```bash
gh variable set REVIEW_BASE_URL --body "https://api.openai.com/v1" -R OWNER/REPO
gh variable set REVIEW_MODEL    --body "<the review model>"           -R OWNER/REPO
gh variable set TRIAGE_MODEL    --body "<the cheap triage model>"     -R OWNER/REPO
gh secret   set REVIEW_API_KEY  -R OWNER/REPO        # prompts for the key; nothing is echoed
```

For the triage there are two kinds of model. An OpenAI-compatible one: `TRIAGE_*` default to the `REVIEW_*` values, so one endpoint and one key cover both. Or **TypeSafe's Jev** (see below): `TRIAGE_PROVIDER=typesafe`, `TRIAGE_MODEL=jev-latest` and a `TRIAGE_API_KEY` secret. With no triage model at all, the triage runs on rules and size only — a fine way to start.

### Which model, at what effort

Every tier can name its own model and effort, and so can every risk rule, so the spend follows the risk. The mapping the two SKO repositories use (Maro's choice, 2026-10-26; the model IDs are OpenAI's, verified against their docs):

| what the triage decided | model | effort |
|---|---|---|
| `light` — low-risk, narrow | `gpt-6-luna` | medium |
| `standard` — an ordinary change | `gpt-6.1-sol` | medium |
| `adversarial` — complex or cross-cutting | `gpt-6.1-sol` | high |
| a risk rule for auth, payments, data migrations, inventory | `gpt-6-astra` | high (`xhigh` for the hardest) |

`REVIEW_MODEL` (the repository variable) is the default when a tier names none. When several risk rules match one PR, the rule asking for the most effort decides both model and effort. Effort is sent as its own field (`reasoning_effort` on Chat Completions, `reasoning.effort` on Responses), never appended to the model name.

## Providers

| provider | `REVIEW_BASE_URL` | notes |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `REVIEW_API=responses` if you prefer the Responses API; `chat` (Chat Completions) is the default and works everywhere |
| OpenRouter | `https://openrouter.ai/api/v1` | model names like `vendor/model` |
| Ollama (local) | `http://localhost:11434/v1` | key may be empty |
| vLLM | `http://host:8000/v1` | |
| LM Studio | `http://localhost:1234/v1` | |
| Anthropic | through a compatible proxy or gateway | kept out of the critical path on purpose; it works through the same interface when a proxy speaks OpenAI's API |

Reasoning effort (`low` / `medium` / `high`) is sent as `reasoning_effort` (Chat) or `reasoning.effort` (Responses). A model that has no such dial answers a 400 naming the parameter; the bot drops it and retries, and the posted review says so. JSON mode is handled the same way. `REVIEW_EXTRA_HEADERS` (a JSON object) adds headers to every request — for example a Cloudflare Access service token in front of a tunnel.

### TypeSafe's Jev as the triage model

[Jev](https://docs.typesafe.ai/concepts/system-one.md) is a "System One" model: it does not write text, it answers typed questions over a `state` with calibrated probabilities and a confidence. That is exactly the shape of a system-1 router, so the bot has a native adapter (`src/typesafe.ts`) for `POST /v1/systemone`. Set `TRIAGE_PROVIDER=typesafe` (inferred when `TRIAGE_MODEL` starts with `jev` or `TRIAGE_BASE_URL` is TypeSafe's), `TRIAGE_MODEL=jev-latest` (or a pinned `jev-1.14.0`), and the secret `TRIAGE_API_KEY`. The review key is never sent to TypeSafe. If the key is missing or the endpoint cannot be reached, the triage falls back to the size rules and the decision line says why; the review still happens.

One request carries the PR summary as named fields (title, author, labels, sizes, the file list, the description, the repo's risk labels — never the diff) and six questions: a **Choice** for the tier (`light` / `standard` / `adversarial`, each with the criteria that define it) and five speculative **Nouls** (does this touch money, auth, stored data, an external contract, or weaken a test). Code owns the policy: a `light` answer with confidence below 0.5 becomes `standard`; a flag at or above 0.75 lifts `light` to `standard`; flags at or above 0.6 are written into the decision line and handed to the reviewer as its worry. Jev's answers, probabilities and confidence are in the "Why this tier" list of the posted review. Jev cannot write the review itself; `REVIEW_*` must point at a text model.

### A local or self-hosted model

GitHub's hosted runners cannot reach a machine in your office. Two ways in, neither needing a code change:

- **A self-hosted runner** on (or next to) the machine serving the model: set the job's `runs-on` to its label and `REVIEW_BASE_URL` to `http://localhost:11434/v1` (or wherever the server listens).
- **A tunnel** (Cloudflare Tunnel, Tailscale Funnel, ngrok) that exposes the model server at a public URL, protected by an access token: set `REVIEW_BASE_URL` to that URL and put the token in `REVIEW_EXTRA_HEADERS` as a repository secret.

Either way the switch is `REVIEW_BASE_URL` (plus `REVIEW_MODEL`), set as repository variables. The bot does not know or care where the model runs.

## The triage, in order

1. The PR is **closed, merged or a draft** → `skip`.
2. A label in `skip.labels` (`review:waived` by default) → `skip`.
3. Any changed path matches a **risk rule** → the strongest matched tier (default `adversarial`), and **no approval** unless the rule says `approve: true`. No model is consulted. Renamed files are matched by their old name too.
4. The author is in `skip.authors` (Dependabot) → `skip`, unless the title reads as a **major** version bump (`from 9.x to 10.x`), which gets `standard`.
5. The diff is **documentation only** and small → `light`, no model call.
6. Otherwise the **triage model** classifies `light` / `standard` / `adversarial` from the title, description, file list and sizes (it never sees the diff). No model, no answer, or an error → fall back to the **size thresholds**.
7. **CI**: a failing required check forces `adversarial` and forbids approval. Required checks that cannot be read forbid approval (inability to compare is itself an alarm). Pending checks change nothing at triage time; the approval step re-reads them.
8. `approval.enabled` and `approval.tiers` may still forbid approval.

Which checks are "required" is read from the base branch's **ruleset** (`GET /repos/{owner}/{repo}/rules/branches/main`), or from `requiredChecks` in the config. A `skipped` check is not a pass.

The decision is the first line of everything the bot posts:

```
review-bot v0.1.0 · tier=adversarial · model=… · effort=high · may_approve=no · classifier=rules · forced=the gate and the deploys · ci=pending · 3 files +41/−8 · author=maropark (owner) · labels=none
```

Why it was decided that way is listed under "Why this tier" in the review, and the full decision is embedded (base64) in the review body for machines.

## The review

The system prompt is: the reviewer's stance (cold, adversarial, falsifiable claims only, severity by likelihood, minors never block), the tier, **the repository's protocol files verbatim**, and the one output shape the bot can parse. The user prompt is the PR metadata, the description (labelled as a claim), the file list, the diff, and the full post-change contents of the changed files as far as the size budget allows. With no protocol files in the repo, a short built-in generic protocol applies (the five failure shapes that survive automated checks).

**Round two.** When the bot has reviewed this PR before, every prior finding is handed back as a *claim to re-check at this head* with its last status, together with the comments posted since, and new finding ids continue from the last one used. The model must say what each prior finding is now: `open`, `fixed` (with evidence), `rebutted` (only if the thread's rebuttal holds) or `deferred`.

The reply must be one JSON object. A reply that does not validate (a clean verdict with fewer than three `considered` lines, a finding without a scenario, a reused id, …) is re-prompted once with the exact problems; if it still fails, nothing is posted and the job fails loudly with the model's reply in the log.

### What gets posted

- **One review per head commit**, event `COMMENT` (or `REQUEST_CHANGES` when a blocker is open and the repo set `approval.requestChangesOnBlocker`). It carries the decision line, the findings in prose, and the record block in the repo's format. Re-running on the same head reuses it instead of asking the model again.
- For `adversary-v1` repos, optionally (`post.recordComment`) the record as an **issue comment** too, in exactly the form `/adversary` posts, so a comment-reading status such as packmaster.work's `review-record` can see it. Off by default: with the workflow's own token the comment's author has no write permission, so that status would refuse it anyway.
- **An approval**, as a second review pinned to the same commit, when the gate below passes.

## Trust model: what a PR can and cannot change about its own review

These came out of the bot's own first two rounds on the PRs that installed it, and each is pinned by a test or by packmaster.work's workflow lint:

- **The workflow runs from the base branch.** The example workflow uses `pull_request_target`, not `pull_request`, so a PR cannot edit the steps that judge it; a change to the workflow is reviewed first, lands, and only then applies. The price is a write token next to a checkout of untrusted code, which is why the job is exactly two steps — the checkout (credentials not persisted) and the pinned action — and nothing from the checkout runs. A consequence: the PR that *adds* the workflow cannot trigger it; use `workflow_dispatch` until it merges.
- **The policy is read from the base branch.** `review-bot.json`, the protocol files and CODEOWNERS are read at the PR's base commit (`policy-ref: base`, the default), so a PR that rewrites the risk rules to drop the rule that would veto it is still judged by the base's rules. The diff and the changed files are, of course, the head's.
- **What only GitHub can close.** With "Allow GitHub Actions to create and approve pull requests" on, *any* workflow in the repository can approve, and a PR can add one, or a contributor can dispatch a modified copy on their branch. The bot cannot prevent that; a ruleset can: **require review from code owners** for `.github/` and the other protected paths, so a bot approval never satisfies a PR that touches them, while it still counts for every PR that does not. The bot's risk rules withhold its own approval on exactly those paths, so nothing is lost.

## Where the bot repository can live

GitHub lets a *private* repository's action be used only by repositories of the **same owner**. So for an owner that is not the consuming organization (this bot under `maropark/`, used by `xpepTechnology/*`), there are two ways:

- **Public repository** (recommended): `uses: maropark/review-bot@v0.3.0` works everywhere, no token. The bot holds no secrets, so there is nothing to hide; pinning to a tag means the consuming repo decides when to move.
- **Private repository plus a read token**: a fine-grained personal access token with read access to that one repository, stored in each consuming repo as a secret, and a checkout step before the action:

  ```yaml
      - uses: actions/checkout@v7
        with:
          repository: maropark/review-bot
          ref: v0.1.0
          token: ${{ secrets.REVIEW_BOT_TOKEN }}
          path: .review-bot
      - uses: ./.review-bot
  ```

  One more secret per repo, and a token that expires (a year at most) and has to be rotated.

A repository owned by the consuming organization (`xpepTechnology/review-bot`) can stay private and be shared with Settings → Actions → General → Access → "Accessible from repositories in the organization".

## Approval: what counts on GitHub

The gate mirrors the `/rpa` skill: approve only if **all** hold — the triage allowed it; no `blocker` or `major` is open (fixed, rebutted and deferred findings, and minors, do not block); the live head equals the reviewed head; no required check is failing (pending does not block unless `approval.requireGreenChecks`). Every failed condition is named in the job log and summary.

Two facts about GitHub decide what an approval is worth:

- A review posted with the workflow's token appears as `github-actions[bot]`. It can approve only if the repository setting **"Allow GitHub Actions to create and approve pull requests"** is on (Settings → Actions → General; an organization-level switch of the same name may also apply). Off, GitHub answers 422 and the bot reports that in plain words instead of failing.
- **A bot's approval never satisfies a "require review from code owners" rule.** Only a user named in `CODEOWNERS` can do that. The approval body therefore lists the code-owner paths in the diff and says so.

So there are three ways to run it:

| option | what changes | what the approval means |
|---|---|---|
| **Post-only / advisory** | nothing on GitHub beyond the Actions setting, if you want the green tick | a visible verdict; a human code owner still approves |
| **Bot account as code owner** | a dedicated GitHub user with write access, named in `CODEOWNERS`, posting with its own token (`github-token` input) | counts for the code-owner rule — a bot alone can unlock protected paths |
| **Plain approval count** (what the two SKO repos chose, 2026-10-25) | the ruleset's `require_code_owner_review` turned off, `required_approving_review_count` 1, the Actions setting on | the workflow's approval counts; any write-access approval does too. The code-owner intent is carried by the risk rules instead: on those paths the bot withholds its approval, so a person's is still needed |

The bot never changes rulesets, CODEOWNERS or repository settings. Those are decisions for a person — packmaster.work keeps its desired state in `scripts/repo-settings.ts`, which asserts and applies them.

## Dry run and the command line

```bash
# print the decision and the review it would post; post nothing
GITHUB_TOKEN=$(gh auth token) REVIEW_MODEL=... REVIEW_API_KEY=... \
  bun run src/cli.ts run --repo OWNER/REPO --pr 123 --dry-run

# the decision only, no model call
bun run src/cli.ts triage --repo OWNER/REPO --pr 123

# with a local checkout of the PR head (protocol and changed files read from disk)
bun run src/cli.ts run --repo OWNER/REPO --pr 123 --checkout ../repo--pr-123 --dry-run --worry "the migration"
```

Or from the bundle: `node dist/cli.js …`. The GitHub token falls back to `gh auth token`. In a workflow, `dry-run: "true"` does the same and writes the would-be review to the job summary.

## Development

```bash
bun install
bun run typecheck
bun test                 # triage rules, approval gate, record format, model client, checks, an end-to-end run with fakes
bun run build            # dist/index.js (the action) and dist/cli.js, committed
bun run check            # all of the above, and dist must match the source
```

`dist/` is committed because consumers run the action straight from the tag, with no install step. CI fails when it is stale.

**Releasing**: bump `VERSION` in `src/version.ts` and `version` in `package.json`, `bun run build`, commit, then `git tag v0.x.y && git push --tags`. Consumers move by editing the `@v0.x.y` in their workflow — a one-line PR their own gate reviews.

## Costs and limits

- The job sits on a runner while the model thinks. On a private repository those minutes are billed; a slow reasoning model on a large diff can take ten minutes. The workflow's `timeout-minutes` and `concurrency` (a new push cancels the previous review) bound it.
- The reviewer sees the diff and the changed files, not the whole tree. A finding that needs the whole system in view may be missed; the protocol files are where that knowledge is supposed to be written down.
- The record's `fixed` / `rebutted` statuses are the model's reading of the thread. The ledger that counts is the PR conversation.

## Licence

© Maro Park. The repository is public so that other repositories can run it as a pinned action; no further licence is granted. Only its owner can push to it, so a consuming repository's pin to a tag is a pin to code only that owner can change.
