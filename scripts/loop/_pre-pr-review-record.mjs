/**
 * The pre-PR review record (PRE-PR-BEFORE-FIRST-PUSH): local evidence at
 * `<main-tmp-root>/pre-pr-review/<head>.json`, written only by
 * `dev-loops loop pre-pr-review` and checked by `pr create`. The writer reads the
 * head from git. The `integrity` field is a digest of the other fields, so a
 * hand-built file without it fails validation.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyFile } from "@dev-loops/core/analysis/diff-analyzer";
import { loadDevLoopConfigStrict, resolveClassifyRules } from "@dev-loops/core/config";
import { gitEnvNoDirOverrides, resolveGateArtifactTmpRoot, resolveRepoRoot } from "./_repo-root-resolver.mjs";

export const PRE_PR_REVIEW_VERDICTS = Object.freeze(["clean", "findings_fixed"]);
export const PRE_PR_REVIEW_DISPOSITIONS = Object.freeze(["none", "all_applied", "rationale_recorded"]);
export const PRE_PR_REVIEW_MISSING = "pre_pr_review_missing";
export const RECORD_COMMAND = "node <dev-loops-package-root>/cli/index.mjs loop pre-pr-review --verdict <clean|findings_fixed> --disposition <none|all_applied|rationale_recorded>";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: gitEnvNoDirOverrides() }).trim();
const recordDir = (cwd) => path.join(resolveGateArtifactTmpRoot(cwd), "pre-pr-review");
// ponytail: an unkeyed digest stops accidental hand-built files, not a determined forger; add a signing key if that matters
const integrityOf = ({ head, verdict, disposition }) =>
  createHash("sha256").update(`dev-loops/pre-pr-review/v1\n${head}\n${verdict}\n${disposition}`).digest("hex");

function parseValid(file) {
  try {
    const r = JSON.parse(readFileSync(file, "utf8"));
    if (r?.head && PRE_PR_REVIEW_VERDICTS.includes(r.verdict) && PRE_PR_REVIEW_DISPOSITIONS.includes(r.disposition) && r.integrity === integrityOf(r)) return r;
  } catch { /* unreadable or malformed: no record */ }
  return null;
}

/** Write the record for the current git HEAD of `cwd`. Returns the record and its path. */
export function writePrePrReviewRecord({ cwd = process.cwd(), verdict, disposition }) {
  if (!PRE_PR_REVIEW_VERDICTS.includes(verdict)) throw new Error(`--verdict must be one of ${PRE_PR_REVIEW_VERDICTS.join(", ")}`);
  if (!PRE_PR_REVIEW_DISPOSITIONS.includes(disposition)) throw new Error(`--disposition must be one of ${PRE_PR_REVIEW_DISPOSITIONS.join(", ")}`);
  const head = git(cwd, ["rev-parse", "HEAD"]);
  const record = { head, verdict, disposition, integrity: integrityOf({ head, verdict, disposition }) };
  const file = path.join(recordDir(cwd), `${head}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  renameSync(temp, file);
  return { record, file };
}

/**
 * Validate that a pre-PR review record covers the PR content. Head resolution: `head` (a branch name,
 * default: HEAD of `cwd`) resolves to the local ref and to `origin/<head>`. When both exist and name
 * different commits, the guard refuses (the PR opens at the pushed branch, not the local one); when
 * only one exists, that one is used. A record for that head covers it, as does a record for an ancestor
 * head when every file changed since classifies as docs or tests under the repository classify rules.
 * With a bare `base` name, only records reachable in `base..head` count as ancestors, and a branch whose
 * whole `base...head` diff is `.md` files under `docs/phases/` (a plan-doc promotion) needs no record; contract
 * and skill prose under `skills/` always needs one. Returns `{ ok: true }` or
 * `{ ok: false, code: "pre_pr_review_missing", detail }`.
 */
export async function validatePrePrReview({ cwd = process.cwd(), head: wanted, base, rules } = {}) {
  const missing = (detail) => ({ ok: false, code: PRE_PR_REVIEW_MISSING, detail: `${detail}. Record the review with: ${RECORD_COMMAND}` });
  const resolve = (ref) => { try { return git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]); } catch { return null; } };
  let branch = wanted;
  if (!branch) { try { branch = git(cwd, ["symbolic-ref", "--short", "HEAD"]); } catch { /* detached HEAD: compare HEAD only */ } }
  const heads = (branch ? [resolve(branch), resolve(`origin/${branch}`)] : [resolve("HEAD")]).filter(Boolean);
  if (!heads.length) return missing(`cannot resolve the branch head ${branch ?? "HEAD"} from git`);
  if (new Set(heads).size > 1) return missing(`local ${branch} and origin/${branch} name different commits, so the PR content is not the reviewed local head`);
  const [head] = heads;
  const direct = parseValid(path.join(recordDir(cwd), `${head}.json`));
  if (direct && direct.head === head) return { ok: true, head };
  if (rules === undefined) rules = resolveClassifyRules((await loadDevLoopConfigStrict({ repoRoot: resolveRepoRoot(cwd) })).config);
  const docsTest = (f) => ["docs", "test"].includes(classifyFile(f, rules));
  let reachable = null;
  for (const ref of base ? [`origin/${base}`, base] : []) {
    try {
      const set = new Set(git(cwd, ["rev-list", `${ref}..${head}`]).split("\n").filter(Boolean));
      reachable = set;
      // A plan-doc promotion changes only docs-tree markdown; skills/** prose never qualifies.
      const files = git(cwd, ["diff", "--name-only", "--no-renames", `${ref}...${head}`]).split("\n").filter(Boolean);
      if (files.length > 0 && files.every((f) => f.startsWith("docs/phases/") && f.endsWith(".md") && classifyFile(f, rules) === "docs")) return { ok: true, head, planDocOnly: true };
      break;
    } catch { /* base ref unresolvable: try the next */ }
  }
  let names = [];
  try { names = readdirSync(recordDir(cwd)).filter((n) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})\.json$/u.test(n)); } catch { /* no records */ }
  for (const name of names) {
    const record = parseValid(path.join(recordDir(cwd), name));
    if (!record || record.head !== name.slice(0, -5) || (reachable && !reachable.has(record.head))) continue;
    try {
      git(cwd, ["merge-base", "--is-ancestor", record.head, head]);
      const changed = git(cwd, ["diff", "--name-only", "--no-renames", `${record.head}..${head}`]).split("\n").filter(Boolean);
      if (changed.every(docsTest)) return { ok: true, head, reviewedHead: record.head };
    } catch { /* not an ancestor, or git failed: not usable */ }
  }
  return missing(`no pre-pr-review record covers branch head ${head.slice(0, 7)} (a record for an older head counts only when later changes touch docs and tests only)`);
}
