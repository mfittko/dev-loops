// Minimal REST/GraphQL fallback transport for gh-less sessions (issue #1358):
// gate-evidence reads normally shell out to the `gh` binary. When that binary is
// not on PATH (spawn ENOENT — never an auth/rate-limit/network failure, which must
// still surface as a real error), the read-only evidence detector falls back to
// calling GitHub's REST/GraphQL API directly over a bearer token from GH_TOKEN or
// GITHUB_TOKEN. This lets a remote/MCP session with no gh CLI installed still
// verify gate evidence instead of having no option but to bypass the check.
const GITHUB_API_BASE = "https://api.github.com";

export function isGhBinaryMissing(error) {
  return Boolean(error) && typeof error === "object" && error.code === "ENOENT";
}

function resolveToken(env) {
  const token = env?.GH_TOKEN || env?.GITHUB_TOKEN;
  return typeof token === "string" && token.trim().length > 0 ? token.trim() : null;
}

function authHeaders(env) {
  const token = resolveToken(env);
  if (!token) {
    throw new Error("gh binary not found and no GH_TOKEN/GITHUB_TOKEN set for the REST/GraphQL fallback");
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function parseNextLink(linkHeader) {
  if (typeof linkHeader !== "string" || linkHeader.length === 0) return null;
  const match = /<([^>]+)>;\s*rel="next"/.exec(linkHeader);
  return match ? match[1] : null;
}

export async function restGetJson(path, env, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${GITHUB_API_BASE}/${path}`, { headers: authHeaders(env) });
  if (!res.ok) {
    throw new Error(`GitHub REST fallback GET ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Mirrors `gh api --paginate --slurp`: follows RFC 5988 `Link: rel="next"` and
// flattens every page's array into one list.
export async function restGetPaginatedJson(path, env, { fetchImpl = fetch } = {}) {
  const all = [];
  let url = `${GITHUB_API_BASE}/${path}`;
  while (url) {
    const res = await fetchImpl(url, { headers: authHeaders(env) });
    if (!res.ok) {
      throw new Error(`GitHub REST fallback GET ${url} failed: ${res.status} ${res.statusText}`);
    }
    const page = await res.json();
    if (Array.isArray(page)) {
      all.push(...page);
    }
    url = parseNextLink(res.headers.get("link"));
  }
  return all;
}

export async function restGraphqlJson(query, variables, env, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${GITHUB_API_BASE}/graphql`, {
    method: "POST",
    headers: { ...authHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GitHub GraphQL fallback failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Fetches the fields gate-evidence reads off `gh pr view --json headRefOid` /
// `--json baseRefOid,labels` in one call (`gh pr view` itself always fetches the
// full PR object; requesting a subset is a gh-side projection, not a smaller API
// call), so one REST GET covers both call sites.
export async function restFetchPrView(repo, pr, env, { fetchImpl = fetch } = {}) {
  const data = await restGetJson(`repos/${repo}/pulls/${pr}`, env, { fetchImpl });
  return {
    headRefOid: typeof data?.head?.sha === "string" ? data.head.sha : null,
    baseRefOid: typeof data?.base?.sha === "string" ? data.base.sha : null,
    labels: Array.isArray(data?.labels)
      ? data.labels.map((label) => (typeof label?.name === "string" ? label.name : label))
      : [],
  };
}
