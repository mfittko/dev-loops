/**
 * The stale-surface sweep of the full pre-PR review (PRE-PR-STALE-SURFACE-SWEEP): the delta review's
 * deterministic scan over `base...HEAD`, plus the PR body versus linked issue comparison. The scan
 * writes nothing. The record gate refuses while a hit is neither fixed nor skipped with a reason.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { detectRepoSlug } from "@dev-loops/core/github/repo-slug";
import { diffPrBodyAgainstIssue } from "@dev-loops/core/loop/issue-refinement-artifact";
import { staleSurfaceTruncatedHit, unaddressedStaleSurfaceHits } from "@dev-loops/core/loop/pre-push-delta-review";
import { fetchIssueBody } from "./detect-issue-refinement-artifact.mjs";
import { gitStaleSurfaceHits } from "./check-pre-push-delta.mjs";
import { gitEnvNoDirOverrides } from "./_repo-root-resolver.mjs";

export const PRE_PR_STALE_SURFACE_UNADDRESSED = "pre_pr_stale_surface_unaddressed";

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
export async function scanPrePrStaleSurface({ cwd, base, bodyFile, issue, staleSurface = gitStaleSurfaceHits, readIssueBody = readIssueBodyFromGitHub }) {
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const baseline = git(cwd, ["merge-base", base, "HEAD"]);
  const found = staleSurface(cwd, baseline, head);
  const staleSurfaceHits = [...found.hits];
  if (bodyFile) {
    const issueBody = await readIssueBody({ cwd, issue });
    staleSurfaceHits.push(...diffPrBodyAgainstIssue({ prBody: readFileSync(bodyFile, "utf8"), issueBody }));
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
