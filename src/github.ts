/**
 * The GitHub REST calls the bot makes, over fetch, with no SDK. Everything is
 * read except two writes: a review on the PR, and (optionally) one comment.
 */

import type { ChangedFile } from "./types.ts";

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: string,
  ) {
    super(message);
  }
}

export interface PullResponse {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  user: { login: string; type: string };
  labels: { name: string }[];
  head: { sha: string; ref: string; repo: { fork: boolean; full_name: string } | null };
  base: { sha: string; ref: string; repo: { full_name: string } };
  additions: number;
  deletions: number;
  changed_files: number;
  html_url: string;
}

export interface ReviewResponse {
  id: number;
  user: { login: string; type: string } | null;
  body: string | null;
  state: string;
  commit_id: string;
  submitted_at: string | null;
  html_url: string;
}

export interface CommentResponse {
  id: number;
  user: { login: string } | null;
  body: string | null;
  created_at: string;
  updated_at: string;
  html_url: string;
}

export interface CheckRunResponse {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  html_url: string | null;
  app?: { slug?: string } | null;
}

export interface StatusResponse {
  context: string;
  state: string;
  updated_at: string;
  target_url: string | null;
}

export interface BranchRule {
  type: string;
  parameters?: Record<string, unknown>;
}

type FetchLike = typeof fetch;

export class GitHub {
  constructor(
    private token: string,
    private apiBase = "https://api.github.com",
    private fetchImpl: FetchLike = fetch,
  ) {}

  private async raw(method: string, path: string, opts: { body?: unknown; accept?: string } = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.apiBase}/${path.replace(/^\//, "")}`;
    const headers: Record<string, string> = {
      accept: opts.accept ?? "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "review-bot",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new GitHubError(res.status, `GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, text);
    }
    return res;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, { body });
    return (await res.json()) as T;
  }

  /** Follow `Link: rel="next"` and concatenate; `pick` extracts the array from each page. */
  async paginate<T>(path: string, pick: (page: unknown) => T[] = (p) => p as T[]): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path.includes("?") ? `${path}&per_page=100` : `${path}?per_page=100`;
    let pages = 0;
    while (next && pages < 50) {
      const res = await this.raw("GET", next);
      out.push(...pick(await res.json()));
      next = nextLink(res.headers.get("link"));
      pages++;
    }
    return out;
  }

  getPull(repo: string, n: number) {
    return this.json<PullResponse>("GET", `repos/${repo}/pulls/${n}`);
  }

  listFiles(repo: string, n: number) {
    return this.paginate<ChangedFile>(`repos/${repo}/pulls/${n}/files`);
  }

  async getDiff(repo: string, n: number): Promise<string> {
    const res = await this.raw("GET", `repos/${repo}/pulls/${n}`, { accept: "application/vnd.github.diff" });
    return await res.text();
  }

  listReviews(repo: string, n: number) {
    return this.paginate<ReviewResponse>(`repos/${repo}/pulls/${n}/reviews`);
  }

  listComments(repo: string, n: number) {
    return this.paginate<CommentResponse>(`repos/${repo}/issues/${n}/comments`);
  }

  listCheckRuns(repo: string, sha: string) {
    return this.paginate<CheckRunResponse>(`repos/${repo}/commits/${sha}/check-runs`, (p) => (p as { check_runs: CheckRunResponse[] }).check_runs ?? []);
  }

  async listStatuses(repo: string, sha: string) {
    return this.paginate<StatusResponse>(`repos/${repo}/commits/${sha}/statuses`);
  }

  getBranchRules(repo: string, branch: string) {
    return this.json<BranchRule[]>("GET", `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`);
  }

  createReview(repo: string, n: number, input: { commit_id: string; body: string; event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" }) {
    return this.json<ReviewResponse>("POST", `repos/${repo}/pulls/${n}/reviews`, input);
  }

  createComment(repo: string, n: number, body: string) {
    return this.json<CommentResponse>("POST", `repos/${repo}/issues/${n}/comments`, { body });
  }

  /** A file's text at a ref, or null when it does not exist there. */
  async getContent(repo: string, path: string, ref: string): Promise<string | null> {
    try {
      const res = await this.raw("GET", `repos/${repo}/contents/${encodeURI(path).replace(/^\//, "")}?ref=${encodeURIComponent(ref)}`, {
        accept: "application/vnd.github.raw+json",
      });
      return await res.text();
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return null;
      throw e;
    }
  }

  async whoami(): Promise<string | null> {
    try {
      const me = await this.json<{ login: string }>("GET", "user");
      return me.login;
    } catch {
      return null; // an installation token has no /user
    }
  }
}

export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1]!;
  }
  return null;
}
