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
import { gitEnvNoDirOverrides, resolveGateArtifactTmpRoot } from "./_repo-root-resolver.mjs";

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
 * Validate that a pre-PR review record covers `head` (a branch name, default: HEAD of `cwd`; `origin/<name>` is the fallback): a record for that
 * head, or for an ancestor head when every file changed since is docs or tests. With a bare `base` name, only
 * records reachable in `base..head` count as ancestors, and a branch that changes docs and tests only
 * needs no record. Returns `{ ok: true }` or
 * `{ ok: false, code: "pre_pr_review_missing", detail }`.
 */
export function validatePrePrReview({ cwd = process.cwd(), head: wanted, base } = {}) {
  const missing = (detail) => ({ ok: false, code: PRE_PR_REVIEW_MISSING, detail: `${detail}. Record the review with: ${RECORD_COMMAND}` });
  let head;
  for (const ref of wanted ? [wanted, `origin/${wanted}`] : ["HEAD"]) {
    try { head = git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]); break; } catch { /* try the next ref */ }
  }
  if (!head) return missing(`cannot resolve the branch head ${wanted ?? "HEAD"} from git`);
  const direct = parseValid(path.join(recordDir(cwd), `${head}.json`));
  if (direct && direct.head === head) return { ok: true, head };
  const docsTestOnly = (files) => files.length > 0 && files.every((f) => ["docs", "test"].includes(classifyFile(f)));
  let reachable = null;
  for (const ref of base ? [`origin/${base}`, base] : []) {
    try {
      const set = new Set(git(cwd, ["rev-list", `${ref}..${head}`]).split("\n").filter(Boolean));
      reachable = set;
      // A branch that changes only docs and tests has no logic to review (a plan-doc promotion).
      if (docsTestOnly(git(cwd, ["diff", "--name-only", "--no-renames", `${ref}...${head}`]).split("\n").filter(Boolean))) return { ok: true, head, docsTestOnly: true };
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
      if (changed.every((f) => ["docs", "test"].includes(classifyFile(f)))) return { ok: true, head, reviewedHead: record.head };
    } catch { /* not an ancestor, or git failed: not usable */ }
  }
  return missing(`no pre-pr-review record covers branch head ${head.slice(0, 7)} (a record for an older head counts only when later changes touch docs and tests only)`);
}
