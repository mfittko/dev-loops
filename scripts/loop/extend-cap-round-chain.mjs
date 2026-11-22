#!/usr/bin/env node
/**
 * extend-cap-round-chain: extend the sealed cap-round clearing chain over later commits that
 * change docs and tests, or code a locally_clear delta covers (GATE-EXEC-ROUND-CAP-CHAIN-EXTEND, ADR 0224). It writes one sealed
 * clearing record bound to the start of the logic range (the chain end E for docs and tests) with candidateHead = the PR head, so
 * `resolveCapRoundFixed` reaches the head again. It needs no fixer plan. A commit in E..HEAD
 * that touches a logic file refuses (`logic_commit_in_range`, `delta_range_mismatch`) and writes nothing, unless a sealed
 * `locally_clear` pre-push delta record is bound to the start of the logic range (the cap-round head for a clean cap round whose cap-head record is absent or carries no extension, the end of the extended chain when it carries one, and otherwise the chain end) and the PR head: the tool then seals
 * `extension: "delta_covered"` into that record (ADR 0254, issue 3049).
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { shellQuote } from "../lib/checkout-delegation-refusal.mjs";
import { parsePrNumber, requireTokenValue } from "../_cli-primitives.mjs";
import { classifyFile } from "@dev-loops/core/analysis/diff-analyzer";
import { loadDevLoopConfigStrict, resolveClassifyRules } from "@dev-loops/core/config";
import { ghJson } from "@dev-loops/core/github/gh";
import { renderCliText } from "@dev-loops/core/loop/cli-command";
import { CAP_ROUND_REFUSAL, capRoundCoverageDetail, replacementPrOperatorRecovery } from "@dev-loops/core/loop/pr-gate-coordination";
import { detectRepoSlug, parseRepoSlug, repoSlugEquals } from "@dev-loops/core/github/repo-slug";
import { isBaseOnlyMergeSince } from "../lib/git-delta.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { buildLogPath } from "../github/_gate-artifact-paths.mjs";
import { capRoundChainCoverage, capRoundChainStarts, capRoundCovers, clearingChainLastCandidates, coverRunReachesHead, isCleanCapRound, resolveCapRound, resolveCapRoundFixed } from "../github/write-gate-context.mjs";
import { DELTA_CLEARING_NEXT_STEPS, coverRecordBlocker, gateDeltaRecordPath, readGateDeltaRecord, readSealedGateDeltaRecord, writeSealedGateDeltaRecord } from "./_gate-delta-record.mjs";
import { withSequenceLock } from "@dev-loops/core/loop/fix-push-authority";
import { defaultFetchOrigin } from "./standing-authorization.mjs";
import { gitEnvNoDirOverrides, resolveGateArtifactTmpRoot, resolveRepoRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: extend-cap-round-chain.mjs --repo <owner/name> --pr <number> [--worktree <path>]
Extend the sealed cap-round clearing chain over later commits that change docs and tests, or code covered by a locally_clear pre-push delta
(GATE-EXEC-ROUND-CAP-CHAIN-EXTEND, ADR 0254). The PR head must equal HEAD of the worktree (default: cwd).
Commits after the start of the logic range that touch a logic file need a sealed locally_clear pre-push delta record for exactly the start of the logic range..PR head (the cap-round head for a clean cap round whose cap-head record is absent or carries no extension, the end of the extended chain when it carries one, and otherwise the chain end; ADR 0254): the tool then seals extension "delta_covered" into that record. It refuses with a typed reason and writes nothing when such commits have no covering delta, when no cap-round chain exists (a clean cap round counts as a chain of length zero ending at the cap-round head), or when the proof does not reach the head afterwards.
Output (stdout, JSON): { "ok": true, "action": "chain_extended" | "already_proven", "chainEnd" (null for already_proven), "candidateHead", "files" }
Refusal (stderr, JSON, exit 1): { "ok": false, "refused": true, "reason": "<code>", "detail": "...", "recovery": "<the one next command, or operator: <action>>" }
Reasons: repo_mismatch, pr_state_unreadable, base_fetch_failed, head_mismatch, history_unresolved (git could not read a commit of the chain: run \`git -C <worktree> fetch origin <sha>\` and rerun; the replacement PR if the commit stays absent), no_cap_round_chain (for a sealed cap-round record at the cap-round head that leaves act refs uncovered it names the reviewer-only cover run, \`loop pre-push-delta --reviewer-only --cover-uncovered\`, only while the record's candidate is on the head's history (a ready PR also when git proves it off the history), every uncovered ref's cover record can take another run and, on a draft PR, some sealed clearing chain visits the head or ends on its history; the replacement PR otherwise), baseline_orphaned,
logic_commit_in_range (no sealed locally_clear pre-push delta covers the code commits: run it for the start of the logic range), delta_range_mismatch (a sealed delta record exists but covers another range or is not locally_clear: rerun it for the start of the logic range..PR head), chain_reaches_head, record_exists, record_changed (the delta record changed on disk after it was validated, or the cover records changed after a coverage read that ran before the sequence lock: rerun), record_not_clearing, proof_not_reached; a thrown gh or git failure is "writer_error".
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
    if (token.name === "worktree") {
      options.worktree = requireTokenValue(token, parseError).trim();
      if (!options.worktree) throw parseError("--worktree requires a non-empty path");
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.repo || options.pr === undefined) throw parseError("extend-cap-round-chain requires --repo and --pr");
  parseRepoSlug(options.repo);
  return options;
}

// RECOVERY-COMMAND-REQUIRED: `recovery` is the one command to run next, or `operator: <action>` when only the operator may act.
// The one render site: every recovery names CLI calls in the active harness's launcher form, as check-pre-push-delta does.
const refuse = (reason, detail, recovery) => ({ ok: false, refused: true, reason, detail, recovery: renderCliText(recovery) });
// The command that reruns this tool for the PR once its refusal cause is fixed.
// The resolved worktree is part of it: the tool refuses `head_mismatch` from a caller directory whose HEAD is not the PR head.
const rerun = (repo, pr, worktree) => `${CLI} gate extend-cap-round-chain --repo ${repo} --pr ${pr} --worktree ${shellQuote(resolvePath(worktree))}`;
// RECOVERY-COMMAND-REQUIRED: a rerun at an unchanged head refuses again, so a refusal that only a new commit clears names that head-moving step, then the rerun.
const headMovingRecovery = (repo, pr, worktree) => `operator: push one docs or tests commit to the PR branch, then rerun ${rerun(repo, pr, worktree)}`;
// The one gate-coordination command that the proof_not_reached, record_exists and no-cap-round refusals name as their recovery.
const coordinationRecovery = (repo, pr) => `${CLI} loop gate-coordination --repo ${repo} --pr ${pr}`;
const CLI = "node <dev-loops-package-root>/cli/index.mjs";
const HEX_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const defaultGit = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnvNoDirOverrides(), stdio: ["ignore", "pipe", "pipe"] }).trim();
const defaultFetchPr = ({ repo, pr }, { env, ghCommand, runChild }) => ghJson(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,headRefName,baseRefName,isDraft"], { env, ghCommand, runChild });

export async function extendCapRoundChain(options, {
  env = process.env, ghCommand = "gh", runChild, fetchPr = defaultFetchPr, git = defaultGit,
  fetchBaseBranch = defaultFetchOrigin, detectOriginSlug = detectRepoSlug, resolveProof = resolveCapRoundFixed, writeRecord = writeSealedGateDeltaRecord, readRecord = readGateDeltaRecord, withLock = withSequenceLock, baseOnlyMerge = isBaseOnlyMergeSince,
} = {}) {
  const { pr } = options;
  const cwd = options.worktree ?? process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  // The ledger and the record are read from this checkout, keyed by the --repo slug: it must be --repo.
  const originSlug = detectOriginSlug(repoRoot);
  if (!originSlug || !repoSlugEquals(originSlug, options.repo)) return refuse("repo_mismatch", `the checkout origin (${originSlug ?? "unresolved"}) is not ${options.repo}; rerun with --repo ${originSlug ?? "<origin slug>"} from a clone of ${options.repo}`, originSlug ? rerun(originSlug, pr, cwd) : `operator: run from a clone whose origin is ${options.repo}, then rerun`);
  // Every later path (ledger directory, proof, messages) uses the origin slug, so a case variant of --repo cannot miss the ledger on a case-sensitive filesystem.
  const repo = originSlug;
  const again = rerun(repo, pr, cwd);
  // RECOVERY-COMMAND-REQUIRED: every git recovery acts on the repository the tool read (the resolved worktree), never on the caller's cwd.
  const gitC = `git -C ${shellQuote(resolvePath(cwd))}`;
  const state = await fetchPr({ repo, pr }, { env, ghCommand, runChild });
  const prHead = typeof state?.headRefOid === "string" ? state.headRefOid.trim().toLowerCase() : "";
  const baseRefName = state?.baseRefName;
  if (!/^[0-9a-f]{40}$/u.test(prHead) || !baseRefName) return refuse("pr_state_unreadable", `cannot read PR #${pr} head and base; check \`gh auth status\` and rerun with --repo ${repo} --pr ${pr}`, "gh auth status");
  const head = git(cwd, ["rev-parse", "HEAD"]).toLowerCase();
  if (head !== prHead) {
    // `git pull --ff-only` fast-forwards only a worktree HEAD that the PR head contains (or fetches an absent PR head). An ahead or diverged worktree holds local commits: the operator pushes or reconciles them.
    // The pull moves the checked-out branch, so it runs only on the PR branch: on any other branch (often `main` in the primary checkout) or a detached HEAD it would move the wrong ref.
    const onPrBranch = (() => { try { return git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]) === state.headRefName; } catch { return false; } })();
    const checkoutFixes = onPrBranch && (() => { try { git(cwd, ["merge-base", "--is-ancestor", head, prHead]); return true; } catch (error) { return error?.status === 128; } })();
    return refuse("head_mismatch", `the worktree HEAD ${head.slice(0, 7)} is not the PR head ${prHead.slice(0, 7)}; check out and push the PR head, then rerun`, checkoutFixes ? `git -C ${shellQuote(resolvePath(cwd))} pull --ff-only origin ${prHead}` : onPrBranch ? "operator: push the local commits to the PR branch, or reset the worktree to the PR head if they are unwanted, then rerun" : `operator: check out the PR branch ${state.headRefName ?? "<PR branch>"} in a worktree and rerun with --worktree <that worktree>; this checkout is on another branch`);
  }

  // The proof, the chain-end discovery and the range all read origin/<base>: fetch it fresh (bounded, prompt-free) first or refuse.
  try {
    fetchBaseBranch(baseRefName, { repoRoot });
  } catch {
    return refuse("base_fetch_failed", `${gitC} fetch origin ${baseRefName} failed; cannot trust the local origin/${baseRefName} ref. Run \`${gitC} fetch origin ${baseRefName}\` and rerun`, `${gitC} fetch origin ${baseRefName}`);
  }

  const proofArgs = { repo, pr, headSha: head, baseRefName };
  const reached = await resolveProof(proofArgs, { repoRoot });
  if (reached) return { ok: true, action: "already_proven", chainEnd: null, candidateHead: head, files: [] };
  // A ready PR is proven with anyHead (coordination's proof, resolveDraftCapRoundFact): a state that proof accepts is already proven, never a cover run, an extension or a replacement PR. An unreadable draft state reads as a draft.
  const readyProof = { ...proofArgs, anyHead: true };
  if (state.isDraft === false && await resolveProof(readyProof, { repoRoot })) return { ok: true, action: "already_proven", chainEnd: null, candidateHead: head, files: [] };
  const cap =await resolveCapRound(proofArgs, { repoRoot });
  const tmpRoot = resolveGateArtifactTmpRoot(repoRoot);
  // The reviewer-only remedies name the cap-round ledger path when the cap round resolved, so no other log is picked.
  // The path is quoted in every command string: a worktree path with a space must stay one argument.
  const capLog = cap ? shellQuote(buildLogPath({ repo, pr, gate: "draft_gate", headSha: cap.log.headSha, tmpRoot })) : "<cap-round findings log>";
  const cleanCap = isCleanCapRound(cap);
  // A clean cap round has no act item to cover: any sealed clearing chain (a thread-route record over a logic commit) ends at the E the extension record binds to, and the proof then accepts the chain through that record.
  // Only merge-base exit 1 without a signal proves `from` is not an ancestor. Any other failure (exit 128 for a commit this clone never fetched, a signal, a spawn error) leaves the history unresolved:
  // it reads as not an ancestor for this run (fail closed) and is recorded, so the refusal names the fetch and never the replacement PR for a round it could not read.
  const unresolved = new Set();
  const present = (sha) => { try { git(repoRoot, ["cat-file", "-e", `${sha}^{commit}`]); return true; } catch { return false; } };
  // The failure names the commit this clone lacks (`from` or `to`, the PR head included): a fetch of a commit it already holds changes nothing. With both present (a signal, a spawn error) `from` stays the named one.
  let lastUnreadable = false;
  const reaches = (from, to) => {
    try { git(repoRoot, ["merge-base", "--is-ancestor", from, to]); return true; } catch (error) {
      if (!(error?.status === 1 && !error?.signal)) { lastUnreadable = true; const lacking = [to, from].filter((sha) => !present(sha)); for (const sha of lacking.length > 0 ? lacking : [from]) unresolved.add(sha); }
      return false;
    }
  };
  const isAncestor = (sha) => sha !== head && reaches(sha, head);
  // The bound resolveCapRoundFixed applies on a ready PR (anyHead): a later link counts only while its candidate is on the head's history, so the tool and the proof cannot disagree. A cover record counts under the same history bound.
  // A candidate that is not a full hex SHA never reaches git (as the proof's own probe): it is off the history, so a malformed sealed record cannot crash the tool.
  const onHistory = (candidate) => HEX_SHA.test(String(candidate ?? "")) && (candidate === head || reaches(candidate, head));
  const coverBound = { head, onHistory, coverOnHistory: onHistory };
  // Whether any start of the chain covered every act ref in this first read: a second read that covers them all after a first read that covered none shows a cover run that completed in between (`record_changed`).
  let anyStartCovered = false;
  const capCovers = cap && !cleanCap ? capRoundCovers(cap, tmpRoot, coverBound) : null;
  const covering = cleanCap ? () => true : (start, bridge) => { const covered = capCovers(start, bridge); anyStartCovered ||= covered; return covered; };
  const ends = cap ? await clearingChainLastCandidates({ tmpRoot, capHead: cap.log.headSha, repo, pr, baseRefName, repoRoot, baseOnlyMerge, covering, allowUnsealedEnd: true }) : [];
  // The latest end: the ancestor end that every other ancestor end precedes, so the logic check never spans commits a later chain cleared.
  const ancestorEnds = ends.filter(isAncestor);
  let chainEnd = ancestorEnds.find((end) => ancestorEnds.every((other) => reaches(other, end)));
  // ADR 0250: a clean cap round has no fixer pass and no first record: its chain has length zero and the end is the cap-round head.
  const capHeadSha = String(cap?.log?.headSha ?? "").trim().toLowerCase();
  // A sealed clearing chain that already ends at the head leaves no ancestor end. When a record exists at the cap-round head, the cap-head fallback would only hit record_exists: name the runnable exit instead. Without that record the fallback extends at the cap-round head.
  // Only commits that the base does not hold count: a base-only merge brings base commits, not PR logic.
  // A clean cap round has no fixer pass, so the plain record that cleared cap-round head..E is not a review of those commits: classify from the start of the logic range.
  const classifyRange = async (from) => {
    const range = [`${from}..${head}`, `^origin/${baseRefName}`];
    const rules = resolveClassifyRules((await loadDevLoopConfigStrict({ repoRoot })).config);
    const files = [...new Set(git(repoRoot, ["log", "--no-merges", "--no-renames", "--no-relative", "--ignore-submodules=none", "--name-only", "-z", "--format=", ...range]).split("\0").filter(Boolean))];
    const logic = files.filter((f) => !["docs", "test"].includes(classifyFile(f, rules)));
    for (const merge of git(repoRoot, ["rev-list", "--merges", ...range]).split("\n").filter(Boolean)) {
      const fromHead = git(repoRoot, ["rev-parse", `${merge}^1`]);
      if (!await isBaseOnlyMergeSince({ fromHead, head: merge, mainRef: `origin/${baseRefName}`, repoRoot })) logic.push(`(merge ${merge.slice(0, 7)} is not a base-only merge)`);
    }
    return { files, logic };
  };
  const sealedClearing = (base) => { try { const r = readSealedGateDeltaRecord(tmpRoot, base); return r && DELTA_CLEARING_NEXT_STEPS.includes(r.nextStep) ? r : null; } catch { return null; } };
  // ADR 0254: the remedy for a logic commit is a locally_clear pre-push delta bound to the start of the logic range and the PR head, then this command again.
  // Coordination routes no_clearing_record, items_do_not_cover and chain_does_not_reach_head to this command, so a remedy that names gate-coordination alone loops: each remedy names the step that breaks the cycle.
  const deltaRange = (from) => `${from.slice(0, 7)}..${head.slice(0, 7)}`;
  // ADR 0255: the reviewer-only delta needs no fixer plan, coverage record or review thread, so it is the one route that works for a clean and a non-clean cap round after a head move.
  const deltaRemedy = (from) => `Run the reviewer-only pre-push delta over ${deltaRange(from)}: ${CLI} loop pre-push-delta --reviewer-only --repo ${repo} --pr ${pr} --baseline ${from} --pr-head ${head} --findings-log ${capLog} --spec-identity <id> --result-path <result-file> --worktree ${shellQuote(resolvePath(cwd))}, have the reviewer fill and seal the result, then run it again with --result <result-file> --invocation <1-3> until its outcome is locally_clear, then rerun ${again}. ${CLI} loop gate-coordination --repo ${repo} --pr ${pr} routes this refusal back to this command, so the delta breaks the cycle, not gate-coordination. If the baseline is orphaned, restart on a replacement PR: ${CAP_ROUND_REFUSAL.baseline_orphaned}`;
  // A sealed clearing record at `from` that did not seal the extension below covers another range or a non-locally_clear outcome: never a cover for from..head.
  const deltaRecovery = (from) => `${CLI} loop pre-push-delta --reviewer-only --repo ${repo} --pr ${pr} --baseline ${from} --pr-head ${head} --findings-log ${capLog} --spec-identity <id> --result-path <result-file> --worktree ${shellQuote(resolvePath(cwd))}`;
  // The cover run (ADR 0255 amendment, issue 3443): the reviewer-only delta limited to the cap round's uncovered act refs over the cap-round head..PR head.
  // The resolved worktree is part of the command: it runs from any caller directory (the run refuses a worktree whose HEAD is not --pr-head).
  const coverRecovery = (from) => `${CLI} loop pre-push-delta --reviewer-only --cover-uncovered --repo ${repo} --pr ${pr} --baseline ${from} --pr-head ${head} --findings-log ${capLog} --spec-identity <id> --result-path <result-file> --worktree ${shellQuote(resolvePath(cwd))}`;
  const refuseLogic = (from, logic) => {
    const other = sealedClearing(from);
    if (other) return refuse("delta_range_mismatch", `GATE-EXEC-ROUND-CAP-CHAIN-EXTEND: commits after ${from.slice(0, 7)} change logic files: ${logic.join(", ")}, and the sealed delta record for ${from.slice(0, 7)} covers ${String(other.candidateHead).slice(0, 7)} with outcome ${other.outcome}, not locally_clear for exactly ${from.slice(0, 7)}..${head.slice(0, 7)}. ${deltaRemedy(from)}`, deltaRecovery(from));
    return refuse("logic_commit_in_range", `GATE-EXEC-ROUND-CAP-CHAIN-EXTEND: commits after ${from.slice(0, 7)} change logic files: ${logic.join(", ")}, and no sealed locally_clear delta record covers them. ${deltaRemedy(from)}`, deltaRecovery(from));
  };
  // ADR 0254: only a sealed locally_clear delta record whose baseline is the start of the logic range and whose candidate is the PR head covers that range. A later link never vouches for logic an earlier link did not clear. Seal the extension into that record, then prove; a failed proof restores it if it is still the record this run wrote.
  const onDisk = (base) => { try { return JSON.stringify(readRecord(tmpRoot, base)); } catch { return null; } };
  // One sequence lock (the one the reviewer-only run takes) spans compare, seal, proof and restore. The proof takes no sequence lock.
  const sealDeltaCovered = (start) => withLock(tmpRoot, [start], () => sealLocked(start));
  const sealLocked = async (start) => {
    const record = sealedClearing(start);
    if (!record || String(record.candidateHead ?? "").toLowerCase() !== head || record.outcome !== "locally_clear") return null;
    // Already sealed with an extension for this head: the proof fails for another condition, so a delta rerun cannot help. Write nothing.
    if (record.extension) return refuse("proof_not_reached", `the delta record for ${start.slice(0, 7)} already carries ${record.extension} for ${head.slice(0, 7)}, but the cap-round-fixed proof does not reach the head; nothing was written. Run ${CLI} loop gate-coordination --repo ${repo} --pr ${pr} for the failed condition`, coordinationRecovery(repo, pr));
    const written = JSON.stringify({ ...record, extension: "delta_covered" });
    if (onDisk(start) !== JSON.stringify(record)) return refuse("record_changed", `the delta record for ${start.slice(0, 7)} changed on disk since it was validated; nothing was written. Rerun ${again}`, again);
    writeRecord(tmpRoot, start, JSON.parse(written));
    let reachedAfter = null;
    let proofError;
    try { reachedAfter = await resolveProof(proofArgs, { repoRoot }); } catch (error) { proofError = error; }
    if (!reachedAfter) {
      const ours = onDisk(start) === written;
      if (ours) writeRecord(tmpRoot, start, record);
      if (proofError) throw proofError;
      return refuse("proof_not_reached", `the cap-round-fixed proof does not reach ${head.slice(0, 7)} after sealing delta_covered into the record for ${start.slice(0, 7)}; ${ours ? "the record was restored" : "the record changed since this run wrote it and was left in place"}. Run ${CLI} loop gate-coordination --repo ${repo} --pr ${pr} for the failed condition`, coordinationRecovery(repo, pr));
    }
    return { ok: true, action: "chain_extended", chainEnd: start, candidateHead: head, files: (await classifyRange(start)).files };
  };
  const capHeadValid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(capHeadSha) && isAncestor(capHeadSha);
  // A history git could not read (not a proven non-ancestor) never reaches a replacement-PR recovery: fetch the missing commits and rerun.
  // A commit that is still absent after the fetch (amended away, never pushed or pruned) has one exit left: the replacement PR.
  const refuseUnresolved = () => {
    const shas = [...unresolved];
    return refuse("history_unresolved", `git could not prove whether ${shas.map((sha) => sha.slice(0, 7)).join(", ")} is on the history of the PR head ${head.slice(0, 7)} (merge-base failed for a reason other than exit 1: usually a commit this clone has not fetched), so no chain is proven missing and no act ref is proven uncovered. Run ${shas.map((sha) => `\`${gitC} fetch origin ${sha}\``).join(" and ")} (\`${gitC} fetch --unshallow\` for a shallow clone), then rerun \`${again}\`. If a commit is still absent after the fetch, restart on a replacement PR: ${CAP_ROUND_REFUSAL.baseline_orphaned}`, `${gitC} fetch origin ${shas[0]}`);
  };
  if (!chainEnd && cleanCap && ends.includes(head) && readGateDeltaRecord(tmpRoot, capHeadSha) !== null) {
    // Classify cap-round head..HEAD first: a logic commit there makes the pushed-docs remedy below unreachable.
    if (capHeadValid) {
      const { logic } = await classifyRange(capHeadSha);
      if (logic.length > 0) return await sealDeltaCovered(capHeadSha) ?? refuseLogic(capHeadSha, logic);
    }
    return refuse("chain_reaches_head", `the sealed clearing chain from the cap-round head ends at the PR head ${head.slice(0, 7)}, so no extension can bind to it yet. Push one further docs or tests commit, then rerun ${again}; it extends at the chain end and writes nothing now`, headMovingRecovery(repo, pr, cwd));
  }
  // A clean cap round whose sealed record at the cap-round head names a candidate git could not read stays unresolved: the cap-head fallback below would read it as no chain and route back to coordination (RECOVERY-COMMAND-REQUIRED). Exit 1 and no record keep the fallback.
  if (!chainEnd && cleanCap && unresolved.size > 0 && HEX_SHA.test(capHeadSha) && present(capHeadSha) && sealedClearing(capHeadSha)) return refuseUnresolved();
  const capHeadFallback = !chainEnd && capHeadValid && cleanCap;
  if (capHeadFallback) chainEnd = capHeadSha;
  if (!chainEnd) {
    // A rebase leaves the cap-round head outside the head's history: no extension can bind, so name the replacement-PR restart.
    // Same probe as resolveCapRoundFixed: only merge-base exit 1 with both commits present proves it; the head itself or an unfetched commit (exit 128) does not.
    const capHead = cap?.log?.headSha;
    const proveOrphan = () => { try { git(repoRoot, ["merge-base", "--is-ancestor", capHead, head]); return false; } catch (error) { return error?.status === 1 && present(capHead) && present(head); } };
    if (capHead && capHead.toLowerCase() !== head && proveOrphan()) return refuse("baseline_orphaned", CAP_ROUND_REFUSAL.baseline_orphaned, replacementPrOperatorRecovery(pr));
    if (capHead && !present(capHead)) return refuse("no_cap_round_chain", `the cap-round head ${capHead.slice(0, 7)} is not in this clone, so no chain can be read. A cap-round head missing from this clone is outside the PR head's fetched history. Run \`${gitC} rev-parse --is-shallow-repository\`: if it prints true, run \`${gitC} fetch --unshallow\`, otherwise run \`${gitC} fetch origin ${capHead}\`. Then rerun \`${again}\`. If the commit is still absent, restart on a replacement PR: ${CAP_ROUND_REFUSAL.baseline_orphaned}`, `${gitC} fetch origin ${capHead}`);
    if (unresolved.size > 0) return refuseUnresolved();
    // Issue 3437: without a resolved cap round (fewer closed draft_gate rounds than the cap, or an unreadable ledger) no chain exists to extend, and the next draft_gate round is not refused (round > cap): gate-coordination routes to that round or to the ledger repair, never back to this command.
    const coordination = coordinationRecovery(repo, pr);
    if (!cap) return refuse("no_cap_round_chain", `PR #${pr} has no resolved draft_gate cap round (fewer rounds than maxReviewRounds are closed, or the findings ledger is unreadable), so there is no cap-round chain to extend and no extension is needed. Run ${coordination}: it routes to the next draft_gate round, or to the repair of an unreadable ledger.`, coordination);
    // A sealed record at the cap-round head that does not cover the cap round's act set is never overwritten: a plain reviewer-only run at that head refuses.
    const sealedCap = capHeadValid ? sealedClearing(capHeadSha) : null;
    const replacement = replacementPrOperatorRecovery(pr);
    if (sealedCap) {
      // Issue 3443: name the act refs no record on the chain covers and the records that exist, so the operator sees which item is missing. The same shared read the proof uses.
      // The chain starts, the bridges and the reachability are scanned here, before any lock: the lock below reads again only the linked and cover records from this scan, so no directory scan or base-only probe runs under it.
      const chain = cleanCap ? null : await capRoundChainStarts({ tmpRoot, capHead: cap.log.headSha, repo, pr, baseRefName, repoRoot, baseOnlyMerge });
      const coverage = chain ? await capRoundChainCoverage({ capRound: cap, tmpRoot, repo, pr, baseRefName, repoRoot, bound: coverBound, baseOnlyMerge, chain }) : null;
      const { uncovered, records } = coverage ?? { uncovered: [], records: [] };
      // Every ref is covered here but the first proof failed: a cover run that completed after that proof (before the covering read, or between the two reads) changes the state it judged, so no replacement PR is due before the proof runs again.
      // A proof that now passes is already proven (a chain that reaches the head has no ancestor end, so the covering read alone cannot tell). The covering read that computed the chain ends covering no start while this read covers every ref shows a cover run between the two reads: the ends are stale (`record_changed`).
      if (coverage && !cleanCap && uncovered.length === 0 && await resolveProof(state.isDraft === false ? readyProof : proofArgs, { repoRoot })) return { ok: true, action: "already_proven", chainEnd: null, candidateHead: head, files: [] };
      if (coverage && !cleanCap && uncovered.length === 0 && !anyStartCovered) return refuse("record_changed", `the cover records of PR #${pr} changed between this run's two coverage reads (a cover run completed), so the chain ends it computed are stale; nothing was written. Rerun ${again}`, again);
      const named = capRoundCoverageDetail({ uncovered, records });
      const head7 = head.slice(0, 7);
      const prefix = `PR #${pr} has no covering sealed cap-round clearing chain ending at an ancestor of ${head7}: the sealed record at the cap-round head ${capHeadSha.slice(0, 7)} does not cover the cap round's act set or its candidate is off the PR head's history, and it is never overwritten, so a plain reviewer-only run at that head refuses.${named}`;
      // ADR 0255 amendment (issue 3443): an uncovered ref on a cap-round head that the PR head's history holds is covered by the cover run: a fresh reviewer verifies only the uncovered refs over the cap-round head..PR head and seals a separate record keyed by the cap-round head and the ref. It needs no new commit and takes no baseline record slot.
      // The cover run needs the sealed record's candidate on the head's history: exit 1 without a signal proves it is not (replacement PR), any other failure leaves it unresolved (fetch).
      // It also needs every uncovered ref's cover record to accept another run: a sealed locally_clear one coverage ignored (its candidate left the history), an unsealed one and one that used the last invocation never will.
      const sealedCandidate = String(sealedCap.candidateHead ?? "").trim().toLowerCase();
      lastUnreadable = false;
      const onHeadHistory = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sealedCandidate) && (sealedCandidate === head || reaches(sealedCandidate, head));
      // A ready PR keeps the cover run when git proves the first candidate off the history (its anyHead proof accepts the first record whatever its candidate): the one candidate rule the cover run and both refusals apply. A draft PR gets the replacement PR, an unreadable history the fetch.
      const candidateOnHistory = onHeadHistory || (state.isDraft === false && !lastUnreadable);
      // On a draft PR the proof needs a chain that reaches the head: a cover run helps only while some chain visits the head or ends on its history. A ready PR keeps it (its anyHead proof accepts the first record whatever its candidate). An unreadable draft state reads as a draft.
      const chainReaches = !(uncovered.length > 0 && candidateOnHistory) || await coverRunReachesHead({ isDraft: state.isDraft !== false, head, onHistory, tmpRoot, capHead: cap.log.headSha, repo, pr, baseRefName, repoRoot, chain });
      if (!(candidateOnHistory && chainReaches) && unresolved.size > 0) return refuseUnresolved();
      // One read of every uncovered ref's cover record under the sequence lock the cover run writes under: a write in progress (the seal removed, the new one not yet linked) is never read as an unsealed dead end. The detail below reuses it.
      // The coverage read above ran before the lock: a cover run that completed during the wait changes it (a clearing record would read as an off-history blocker), so the coverage is read again under the lock and a changed set returns the rerun.
      const blockers = uncovered.length > 0 && candidateOnHistory && chainReaches ? await withLock(tmpRoot, [capHeadSha], async () => {
        const fresh = await capRoundChainCoverage({ capRound: cap, tmpRoot, repo, pr, baseRefName, repoRoot, bound: coverBound, baseOnlyMerge, chain });
        if ([...(fresh?.uncovered ?? [])].sort().join("\n") !== [...uncovered].sort().join("\n")) return null;
        return new Map(uncovered.map((ref) => [ref, coverRecordBlocker(tmpRoot, capHeadSha, ref)]));
      }) : new Map();
      if (blockers === null) return refuse("record_changed", `the cover records of PR #${pr} changed while this run waited for the sequence lock of the cap-round head ${capHeadSha.slice(0, 7)}, so the coverage read before the lock is stale; nothing was written. Rerun ${again}`, again);
      const blocked = uncovered.find((ref) => blockers.get(ref));
      // The locked reread probes history too: a clearing cover record whose candidate git could not read under the lock is no proven off-history blocker (the uncovered set is unchanged), so ask for the fetch.
      if (blocked !== undefined && unresolved.size > 0) return refuseUnresolved();
      if (uncovered.length > 0 && candidateOnHistory && chainReaches && blocked === undefined) return refuse("no_cap_round_chain", `${prefix} Run the cover run over ${capHeadSha.slice(0, 7)}..${head7}: ${coverRecovery(capHeadSha)} (then --result <result-file> --invocation <1-3>) until it is locally_clear; it seals one cover record per uncovered ref and never overwrites a gate-delta record, then rerun \`${again}\`. A reviewer-only run with a chain-end baseline derives an empty act list and covers no act ref, so the cover run is the route for an uncovered ref. Or restart on a replacement PR: ${CAP_ROUND_REFUSAL.baseline_orphaned}`, coverRecovery(capHeadSha));
      // Every act ref is covered and the record's candidate is off the head's history, or a cover record can take no further run: only a replacement PR remains.
      const blocker = blocked === undefined ? null : blockers.get(blocked);
      const why = blocker ? ` The cover record of act ref ${blocked} is ${blocker === "clearing" ? "sealed locally_clear but its candidate is not on the PR head's history" : blocker === "bounded" ? "sealed with the last invocation used" : "unsealed, hand-edited or unreadable"}, and a cover record is never overwritten or restarted, so no cover run can cover it.`
        : candidateOnHistory && uncovered.length > 0 && !chainReaches ? " This PR is a draft and no sealed clearing chain visits the PR head or ends on its history, so a cover run could not make the chain reach the head." : "";
      return refuse("no_cap_round_chain", `${prefix}${why} Restart on a replacement PR: ${CAP_ROUND_REFUSAL.baseline_orphaned}`, replacement);
    }
    // The cap-round head is the PR head: no commit follows it, and a reviewer-only run with baseline equal to the head is refused. Only a new commit moves the head.
    if (capHeadSha === head) return refuse("no_cap_round_chain", `PR #${pr} has no covering sealed cap-round clearing chain ending at an ancestor of ${head.slice(0, 7)}: the cap-round head is the PR head, so no commit follows it; a reviewer-only delta over an empty range is refused. Push one docs or tests commit to the PR branch (a logic commit also needs its locally_clear pre-push delta), then rerun ${again}. If the PR head already carries a clean current-head draft_gate verdict, no extension is needed`, headMovingRecovery(repo, pr, cwd));
    return refuse("no_cap_round_chain", `PR #${pr} has no covering sealed cap-round clearing chain ending at an ancestor of ${head.slice(0, 7)}. Run ${deltaRecovery(capHeadSha)} (then --result <result-file> --invocation <1-3>) until it is locally_clear, then rerun this command, or restart on a replacement PR. If the PR head already carries a clean current-head draft_gate verdict, no extension is needed. ${coordination} routes this refusal back to this command, so only the pre-push delta or the replacement-PR restart breaks the cycle: ${CAP_ROUND_REFUSAL.baseline_orphaned}`, deltaRecovery(capHeadSha));
  }

  // A delta_covered or docs_tests_only record at the clean cap-round head already cleared capHead..its candidate: classify from that candidate, so a later docs commit extends instead of reclassifying cleared logic.
  const capRecord = cleanCap && capHeadValid ? sealedClearing(capHeadSha) : null;
  const capCandidate = String(capRecord?.candidateHead ?? "").toLowerCase();
  const clearedEnd = ["delta_covered", "docs_tests_only"].includes(capRecord?.extension) && /^[0-9a-f]{40}$/u.test(capCandidate) && isAncestor(capCandidate) ? capCandidate : null;
  // A later extension past the cleared end moves the start to the chain end, so the remedy never names a baseline whose record this tool wrote.
  const rangeStart = (clearedEnd && chainEnd !== clearedEnd && reaches(clearedEnd, chainEnd) ? chainEnd : clearedEnd) ?? (cleanCap && capHeadValid ? capHeadSha : chainEnd);
  const { files, logic } = await classifyRange(rangeStart);
  if (logic.length > 0) return await sealDeltaCovered(rangeStart) ?? refuseLogic(rangeStart, logic);
  const recordExists = () => refuse("record_exists", `a delta record for ${chainEnd.slice(0, 7)} already exists and is never overwritten; run ${CLI} loop gate-coordination --repo ${repo} --pr ${pr} for the failed proof condition`, coordinationRecovery(repo, pr));
  if (readGateDeltaRecord(tmpRoot, chainEnd) !== null) {
    let clearing = false;
    try { clearing = DELTA_CLEARING_NEXT_STEPS.includes(readSealedGateDeltaRecord(tmpRoot, chainEnd)?.nextStep); } catch { /* unreadable: not a clearing record */ }
    // A clean cap round whose sealed chain ends only off the head's history (git proved every end a non-ancestor) has no extension point: the record at the cap-round head is never overwritten and coordination routes back to this command, so only the replacement PR remains.
    if (clearing && capHeadFallback && ends.length > 0 && ancestorEnds.length === 0 && !ends.includes(head)) return refuse("no_cap_round_chain", `the sealed clearing chain from the cap-round head ${capHeadSha.slice(0, 7)} ends at ${ends.map((end) => end.slice(0, 7)).join(", ")}, which ${ends.length > 1 ? "are" : "is"} not on the history of the PR head ${head.slice(0, 7)}, and the record at the cap-round head is never overwritten, so no extension can bind to it. Restart on a replacement PR: ${CAP_ROUND_REFUSAL.baseline_orphaned}`, replacementPrOperatorRecovery(pr));
    if (clearing) return recordExists();
    return refuse("record_not_clearing", `the delta record for ${chainEnd.slice(0, 7)} exists but is not a sealed clearing record and is never overwritten; run ${deltaRecovery(chainEnd)} (then --result <result-file> --invocation <1-3>) until it is locally_clear, then rerun this command`, deltaRecovery(chainEnd));
  }

  // One sequence lock (the one the reviewer-only run takes) spans the exclusive create, the proof and the rollback. The proof takes no sequence lock.
  return withLock(tmpRoot, [chainEnd], () => extendDocsTests({ tmpRoot, chainEnd, head, repo, pr, files, proofArgs, repoRoot, recordExists, resolveProof, writeRecord }));
}

async function extendDocsTests({ tmpRoot, chainEnd, head, repo, pr, files, proofArgs, repoRoot, recordExists, resolveProof, writeRecord }) {
  const record = { reviewBaselineHead: chainEnd, candidateHead: head, outcome: "locally_clear", nextStep: "push_to_gate", items: [], extension: "docs_tests_only" };
  // Exclusive create: a record another writer lands between the read above and this write is never replaced.
  try {
    writeRecord(tmpRoot, chainEnd, record, { exclusive: true });
  } catch (error) {
    if (error?.code === "EEXIST") return recordExists();
    throw error;
  }
  let reachedAfter = null;
  let proofError;
  try {
    reachedAfter = await resolveProof(proofArgs, { repoRoot });
  } catch (error) {
    proofError = error;
  }
  if (!reachedAfter) {
    // Remove the pair only while it is still the record this run wrote: a replacement belongs to another writer.
    const recordPath = gateDeltaRecordPath(tmpRoot, chainEnd);
    let ours = false;
    try { ours = JSON.stringify(readGateDeltaRecord(tmpRoot, chainEnd)) === JSON.stringify(record); } catch { /* unreadable: not ours to remove */ }
    if (ours) {
      rmSync(recordPath, { force: true });
      rmSync(`${recordPath}.seal`, { force: true });
    }
    if (proofError) throw proofError;
    return refuse("proof_not_reached", `the cap-round-fixed proof does not reach ${head.slice(0, 7)} after the extension for ${chainEnd.slice(0, 7)}; ${ours ? "the record was removed" : "the record changed since this run wrote it and was left in place"}. Run ${CLI} loop gate-coordination --repo ${repo} --pr ${pr} for the failed condition`, coordinationRecovery(repo, pr));
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
    stderr.write(`${JSON.stringify(refuse("writer_error", error instanceof Error ? error.message : String(error), rerun(options.repo, options.pr, options.worktree ?? process.cwd())))}\n`);
    return 1;
  }
  if (!result.ok) {
    stderr.write(`${JSON.stringify(result)}\n`);
    return 1;
  }
  return emitResult(result, { jq: options.jq, fields: options.fields, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
