/**
 * The stale-surface sweep of the full pre-PR review (PRE-PR-STALE-SURFACE-SWEEP): the deterministic scan over `base...HEAD`, plus the PR body versus linked issue comparison. The scan
 * writes nothing. The record gate refuses while a hit is neither fixed nor skipped with a reason.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { detectRepoSlug } from "@dev-loops/core/github/repo-slug";
import { diffPrBodyAgainstIssue } from "@dev-loops/core/loop/issue-refinement-artifact";
import { collectStaleSurface, staleSurfaceTruncatedHit, unaddressedStaleSurfaceHits } from "@dev-loops/core/loop/stale-surface-hits";
import { fetchIssueBody } from "./detect-issue-refinement-artifact.mjs";
import { gitEnvNoDirOverrides } from "./_repo-root-resolver.mjs";
import { pathsMissingFromMatrix } from "../github/waive-adr-tripwire.mjs";
import { CONTRACT_DOC_RE, parseNameStatus } from "./check-adr-tripwire.mjs";

export const PRE_PR_STALE_SURFACE_UNADDRESSED = "pre_pr_stale_surface_unaddressed";

// `git diff baseline..head`; with `ownPaths` the cumulative diff limited to those paths.
const rangeCommand = (flags, baseline, head, ownPaths) => ["diff", ...flags, `${baseline}..${head}`, ...(ownPaths ? ["--", ...ownPaths.map((file) => `:(top,literal)${file}`)] : [])];

// Tracked-file hits of the sentences and identifiers the range removed, grepped at the candidate head.
// A git failure throws (fail closed), including a missing baseline or head object. The diff and grep
// formats are pinned so operator git config (prefix, color, external diff, textconv, algorithm, renames, path quoting, submodules, diff.orderFile via -O/dev/null, relative paths via --no-relative, hunk merging via --inter-hunk-context=0) cannot blank the check.
export function gitStaleSurfaceHits(worktreeArg, baseline, head, ownPaths) {
  // Run from the top level so a subdirectory --worktree cannot scope the diff or grep to that subtree.
  const top = spawnSync("git", ["-C", worktreeArg, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: gitEnvNoDirOverrides() });
  if (top.status !== 0 || !top.stdout.trim()) throw new Error(`git rev-parse --show-toplevel failed in ${worktreeArg}: ${top.stderr.trim()}; the stale-surface check cannot locate the repository`);
  const worktree = top.stdout.trim();
  const git = (...args) => spawnSync("git", ["-C", worktree, "-c", "core.quotePath=false", ...args], { encoding: "utf8", env: gitEnvNoDirOverrides(), maxBuffer: 64 * 1024 * 1024 });
  for (const rev of [baseline, head]) {
    const exists = git("cat-file", "-e", `${rev}^{commit}`);
    if (exists.status !== 0) throw new Error(`git cat-file ${rev} failed in ${worktree}: ${exists.stderr.trim()}; the stale-surface check cannot read the delta range`);
  }
  const diff = git(...rangeCommand(["-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--diff-algorithm=myers", "--no-renames", "-O/dev/null", "--no-relative", "--ignore-submodules=none", "--submodule=short", "--inter-hunk-context=0"], baseline, head, ownPaths));
  if (diff.status !== 0) throw new Error(`git diff ${baseline}..${head} failed in ${worktree}: ${diff.stderr.trim()}; the stale-surface check cannot read the delta range`);
  const grep = (needle, { word }) => {
    const out = git("grep", "-n", "-I", "--full-name", "-F", "--no-color", "--no-recurse-submodules", ...(word ? ["-w"] : []), "-e", needle, head);
    if (out.status === 1) return [];
    if (out.status !== 0) throw new Error(`git grep failed in ${worktree} (exit ${out.status}): ${out.stderr.trim()}`);
    const rows = out.stdout.split("\n").filter(Boolean);
    const hits = rows.flatMap((row) => {
      const match = /^[^:]*:(.+?):(\d+):/u.exec(row);
      return match ? [{ file: match[1], line: Number(match[2]) }] : [];
    });
    if (rows.length > 0 && hits.length === 0) throw new Error(`git grep output could not be parsed in ${worktree}: the stale-surface check fails closed`);
    return hits;
  };
  return collectStaleSurface({ diffText: diff.stdout, grep });
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnvNoDirOverrides() }).trim();

function readIssueBodyFromGitHub({ cwd, issue }) {
  const repo = detectRepoSlug(cwd);
  if (!repo) throw new Error("cannot resolve the repository slug for --issue; the PR body comparison fails closed");
  return fetchIssueBody({ repo, issue });
}

/**
 * Scan `merge-base(base, HEAD)..HEAD` and, with a linked issue, compare the PR body file with the issue body.
 * Any git or read error throws (fail closed).
 */
export async function scanPrePrStaleSurface({ cwd, base, bodyFile, issue, staleSurface = gitStaleSurfaceHits, readIssueBody = readIssueBodyFromGitHub, head = git(cwd, ["rev-parse", "HEAD"]) }) {
  const baseline = git(cwd, ["merge-base", base, head]);
  if (baseline === head) throw new Error(`empty scan range: merge-base of ${base} and HEAD is HEAD, nothing to scan (PRE-PR-STALE-SURFACE-SWEEP fails closed)`);
  const found = staleSurface(cwd, baseline, head);
  const staleSurfaceHits = [...found.hits];
  if (bodyFile) {
    const issueBody = await readIssueBody({ cwd, issue });
    staleSurfaceHits.push(...diffPrBodyAgainstIssue({ prBody: readFileSync(bodyFile, "utf8"), issueBody }));
    // ADR 0301: a touched contract doc the matrix does not name fails the waiver later; flag it before the first gate round.
    // Pick the path the tripwire reports: a rename out of the surface names the original path.
    const contractDocs = parseNameStatus(git(cwd, ["diff", "--name-status", baseline, head]))
      .map((f) => (f.origPath && CONTRACT_DOC_RE.test(f.origPath) ? f.origPath : f.path))
      .filter((p) => CONTRACT_DOC_RE.test(p));
    const { matrixInvalid, missing } = pathsMissingFromMatrix(contractDocs, issueBody);
    // An invalid matrix is already one issue-body/issue-matrix hit from the comparison above.
    if (!matrixInvalid) {
      for (const p of missing) staleSurfaceHits.push({ kind: "pr-body", side: "issue", needle: `${p} is changed but no row of the issue's AC / DoD matrix names it in backticks`, file: `issue-body/issue-matrix:${p}`, line: 0, site: `issue-body/issue-matrix:${p}` });
    }
  }
  return { ok: true, head, base, staleSurfaceHits, staleSurfaceTruncated: found.truncated === true, truncatedNeedles: found.truncatedNeedles ?? [] };
}

/** Read `[{ site, reason }]` skips and shape them for `unaddressedStaleSurfaceHits`. */
export function readSkipsFile(file) {
  if (!file) return [];
  const skips = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(skips)) throw new Error("--skips-file must hold a JSON array of { site, reason }");
  return [{ sites: skips.map(({ site, reason }) => ({ site, status: "skipped", reason })) }];
}

/** Throw the typed refusal unless every scan hit is fixed (absent from the scan) or skipped with a reason. */
export function requireStaleSurfaceAddressed(scan, siteCoverage) {
  const hits = scan.staleSurfaceTruncated ? [...scan.staleSurfaceHits, staleSurfaceTruncatedHit()] : scan.staleSurfaceHits;
  const open = unaddressedStaleSurfaceHits(hits, { siteCoverage });
  if (open.length === 0) return;
  throw Object.assign(
    new Error(`${PRE_PR_STALE_SURFACE_UNADDRESSED}: ${open.length} stale-surface hit(s) are neither fixed nor skipped with a reason (PRE-PR-STALE-SURFACE-SWEEP): ${open.map((h) => h.site).join(", ")}. Fix them, or pass --skips-file with { site, reason } entries.`),
    { code: PRE_PR_STALE_SURFACE_UNADDRESSED, sites: open.map((h) => h.site) },
  );
}
