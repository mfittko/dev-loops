#!/usr/bin/env node
/**
 * extend-cap-round-chain: extend the sealed cap-round clearing chain over later commits that
 * change docs and tests only (GATE-EXEC-ROUND-CAP-CHAIN-EXTEND, ADR 0223). It writes one sealed
 * clearing record bound to the chain end E with candidateHead = the PR head, so
 * `resolveCapRoundFixed` reaches the head again. It needs no fixer plan. Any commit in E..HEAD
 * that touches a logic file refuses (`logic_commit_in_range`) and writes nothing.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { parseArgs } from "node:util";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { classifyFile } from "@dev-loops/core/analysis/diff-analyzer";
import { loadDevLoopConfigStrict, resolveClassifyRules } from "@dev-loops/core/config";
import { ghJson } from "@dev-loops/core/github/gh";
import { CAP_ROUND_REFUSAL } from "@dev-loops/core/loop/pr-gate-coordination";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { isBaseOnlyMergeSince } from "../lib/git-delta.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { capRoundCovers, clearingChainLastCandidates, resolveCapRound, resolveCapRoundFixed } from "../github/write-gate-context.mjs";
import { gateDeltaRecordPath, readGateDeltaRecord, writeSealedGateDeltaRecord } from "./_gate-delta-record.mjs";
import { gitEnvNoDirOverrides, resolveGateArtifactTmpRoot, resolveRepoRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: extend-cap-round-chain.mjs --repo <owner/name> --pr <number> [--worktree <path>]
Extend the sealed cap-round clearing chain over later commits that change docs and tests only
(GATE-EXEC-ROUND-CAP-CHAIN-EXTEND). The PR head must equal HEAD of the worktree (default: cwd).
Refuses with a typed reason and writes nothing when any commit after the chain end touches a
logic file, when no cap-round chain exists, or when the proof does not reach the head afterwards.
Output (stdout, JSON): { "ok": true, "action": "chain_extended" | "already_proven", "chainEnd", "candidateHead", "files" }
Refusal (stderr, JSON, exit 1): { "ok": false, "refused": true, "reason": "<code>", "detail": "..." }
${JQ_OUTPUT_USAGE}`.trim();
const parseError = buildParseError(USAGE);

export function parseExtendCapRoundChainCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: { help: { type: "boolean", short: "h" }, repo: { type: "string" }, pr: { type: "string" }, worktree: { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  const options = { help: false, repo: undefined, pr: undefined, worktree: undefined, jq: undefined, silent: false };
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "repo") { options.repo = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "pr") { options.pr = parsePrNumber(requireTokenValue(token, parseError), parseError); continue; }
    if (token.name === "worktree") { options.worktree = requireTokenValue(token, parseError).trim(); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.repo || options.pr === undefined) throw parseError("extend-cap-round-chain requires --repo and --pr");
  parseRepoSlug(options.repo);
  return options;
}

const refuse = (reason, detail) => ({ ok: false, refused: true, reason, detail });
const defaultGit = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnvNoDirOverrides(), stdio: ["ignore", "pipe", "pipe"] }).trim();
const defaultFetchPr = ({ repo, pr }, { env, ghCommand, runChild }) => ghJson(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,baseRefName"], { env, ghCommand, runChild });

export async function extendCapRoundChain(options, { env = process.env, ghCommand = "gh", runChild, fetchPr = defaultFetchPr, git = defaultGit } = {}) {
  const { repo, pr } = options;
  const cwd = options.worktree ?? process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  const state = await fetchPr({ repo, pr }, { env, ghCommand, runChild });
  const prHead = typeof state?.headRefOid === "string" ? state.headRefOid.trim().toLowerCase() : "";
  const baseRefName = state?.baseRefName;
  if (!/^[0-9a-f]{40}$/u.test(prHead) || !baseRefName) return refuse("pr_state_unreadable", `cannot read PR #${pr} head and base`);
  const head = git(cwd, ["rev-parse", "HEAD"]).toLowerCase();
  if (head !== prHead) return refuse("head_mismatch", `the worktree HEAD ${head.slice(0, 7)} is not the PR head ${prHead.slice(0, 7)}; check out and push the PR head, then rerun`);

  const proofArgs = { repo, pr, headSha: head, baseRefName };
  const reached = await resolveCapRoundFixed(proofArgs, { repoRoot });
  if (reached) return { ok: true, action: "already_proven", chainEnd: head, candidateHead: head, files: [] };
  const cap = await resolveCapRound(proofArgs, { repoRoot });
  const tmpRoot = resolveGateArtifactTmpRoot(repoRoot);
  const ends = cap ? await clearingChainLastCandidates({ tmpRoot, capHead: cap.log.headSha, repo, pr, baseRefName, repoRoot, covering: capRoundCovers(cap) }) : [];
  const isAncestor = (sha) => { try { git(repoRoot, ["merge-base", "--is-ancestor", sha, head]); return sha !== head; } catch { return false; } };
  const chainEnd = ends.find(isAncestor);
  if (!chainEnd) {
    // A rebase leaves the cap-round head outside the head's history: no extension can bind, so name the replacement-PR restart.
    if (cap && !isAncestor(cap.log.headSha)) return refuse("baseline_orphaned", CAP_ROUND_REFUSAL.baseline_orphaned);
    return refuse("no_cap_round_chain", `PR #${pr} has no covering sealed cap-round clearing chain ending at an ancestor of ${head.slice(0, 7)}. Complete the cap round's fixer pass and run check-pre-push-delta.mjs --result for the cap-round baseline, or run dev-loops loop gate-coordination --repo ${repo} --pr ${pr} and follow its next action`);
  }

  // Only commits in E..HEAD that the base does not hold count: a base-only merge after E brings base commits, not PR logic.
  const range = [`${chainEnd}..${head}`, `^origin/${baseRefName}`];
  const rules = resolveClassifyRules((await loadDevLoopConfigStrict({ repoRoot })).config);
  const files = [...new Set(git(repoRoot, ["log", "--no-merges", "--no-renames", "--no-relative", "--name-only", "--format=", ...range]).split("\n").filter(Boolean))];
  const logic = files.filter((f) => !["docs", "test"].includes(classifyFile(f, rules)));
  for (const merge of git(repoRoot, ["rev-list", "--merges", ...range]).split("\n").filter(Boolean)) {
    const fromHead = git(repoRoot, ["rev-parse", `${merge}^1`]);
    if (!await isBaseOnlyMergeSince({ fromHead, head: merge, mainRef: `origin/${baseRefName}`, repoRoot })) logic.push(`(merge ${merge.slice(0, 7)} is not a base-only merge)`);
  }
  if (logic.length > 0) {
    return refuse("logic_commit_in_range", `GATE-EXEC-ROUND-CAP-CHAIN-EXTEND: commits after the chain end ${chainEnd.slice(0, 7)} change logic files: ${logic.join(", ")}. Run the fixer plan and the pre-push delta route for them, since no draft_gate round runs past the cap: dev-loops loop gate-coordination --repo ${repo} --pr ${pr} names the next action. If the baseline is orphaned, restart on a replacement PR: ${CAP_ROUND_REFUSAL.baseline_orphaned}`);
  }
  if (readGateDeltaRecord(tmpRoot, chainEnd) !== null) return refuse("record_exists", `a delta record for ${chainEnd.slice(0, 7)} already exists and is never overwritten; run dev-loops loop gate-coordination --repo ${repo} --pr ${pr} for the failed proof condition`);

  writeSealedGateDeltaRecord(tmpRoot, chainEnd, {
    reviewBaselineHead: chainEnd, candidateHead: head, outcome: "locally_clear", nextStep: "push_to_gate", items: [], extension: "docs_tests_only",
  });
  if (!await resolveCapRoundFixed(proofArgs, { repoRoot })) {
    const recordPath = gateDeltaRecordPath(tmpRoot, chainEnd);
    rmSync(recordPath, { force: true });
    rmSync(`${recordPath}.seal`, { force: true });
    return refuse("proof_not_reached", `the cap-round-fixed proof does not reach ${head.slice(0, 7)} after the extension for ${chainEnd.slice(0, 7)}; the record was removed. Run dev-loops loop gate-coordination --repo ${repo} --pr ${pr} for the failed condition`);
  }
  return { ok: true, action: "chain_extended", chainEnd, candidateHead: head, files };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, ...runtime } = {}) {
  let options;
  try {
    options = parseExtendCapRoundChainCliArgs(argv);
  } catch (error) {
    stderr.write(`${formatCliError(error)}\n`);
    return 1;
  }
  if (options.help) { stdout.write(`${USAGE}\n`); return 0; }
  let result;
  try {
    result = await extendCapRoundChain(options, runtime);
  } catch (error) {
    stderr.write(`${JSON.stringify(refuse("writer_error", error instanceof Error ? error.message : String(error)))}\n`);
    return 1;
  }
  if (!result.ok) {
    stderr.write(`${JSON.stringify(result)}\n`);
    return 1;
  }
  return emitResult(result, { jq: options.jq, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
