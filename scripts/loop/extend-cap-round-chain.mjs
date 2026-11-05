#!/usr/bin/env node
/**
 * extend-cap-round-chain: extend the sealed cap-round clearing chain over later commits that
 * change docs and tests, or code a locally_clear delta covers (GATE-EXEC-ROUND-CAP-CHAIN-EXTEND, ADR 0224). It writes one sealed
 * clearing record bound to the start of the logic range (the chain end E for docs and tests) with candidateHead = the PR head, so
 * `resolveCapRoundFixed` reaches the head again. It needs no fixer plan. A commit in E..HEAD
 * that touches a logic file refuses (`logic_commit_in_range`, `delta_range_mismatch`) and writes nothing, unless a sealed
 * `locally_clear` pre-push delta record is bound to the start of the logic range (the cap-round head for a clean cap round whose cap-head record carries no extension, the end of the extended chain when it carries one, and otherwise the chain end) and the PR head: the tool then seals
 * `extension: "delta_covered"` into that record (ADR 0254, issue 3049). For a clean cap
 * round the range starts at the cap-round head: only a locally_clear record bound to that head seals, never a plain or bounded_out record, nor a later link.
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
import { detectRepoSlug, parseRepoSlug, repoSlugEquals } from "@dev-loops/core/github/repo-slug";
import { isBaseOnlyMergeSince } from "../lib/git-delta.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { capRoundCovers, clearingChainLastCandidates, isCleanCapRound, resolveCapRound, resolveCapRoundFixed } from "../github/write-gate-context.mjs";
import { DELTA_CLEARING_NEXT_STEPS, gateDeltaRecordPath, readGateDeltaRecord, readSealedGateDeltaRecord, writeSealedGateDeltaRecord } from "./_gate-delta-record.mjs";
import { defaultFetchOrigin } from "./standing-authorization.mjs";
import { gitEnvNoDirOverrides, resolveGateArtifactTmpRoot, resolveRepoRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: extend-cap-round-chain.mjs --repo <owner/name> --pr <number> [--worktree <path>]
Extend the sealed cap-round clearing chain over later commits that change docs and tests, or code covered by a locally_clear pre-push delta
(GATE-EXEC-ROUND-CAP-CHAIN-EXTEND, ADR 0254). The PR head must equal HEAD of the worktree (default: cwd).
Commits after the start of the logic range that touch a logic file need a sealed locally_clear pre-push delta record for exactly the start of the logic range..PR head (the cap-round head for a clean cap round whose cap-head record carries no extension, the end of the extended chain when it carries one, and otherwise the chain end; ADR 0254): the tool then seals extension "delta_covered" into that record. It refuses with a typed reason and writes nothing when such commits have no covering delta, when no cap-round chain exists (a clean cap round counts as a chain of length zero ending at the cap-round head), or when the proof does not reach the head afterwards.
Output (stdout, JSON): { "ok": true, "action": "chain_extended" | "already_proven", "chainEnd" (null for already_proven), "candidateHead", "files" }
Refusal (stderr, JSON, exit 1): { "ok": false, "refused": true, "reason": "<code>", "detail": "..." }
Reasons: repo_mismatch, pr_state_unreadable, base_fetch_failed, head_mismatch, no_cap_round_chain, baseline_orphaned,
logic_commit_in_range (no sealed locally_clear pre-push delta covers the code commits: run it for the start of the logic range), delta_range_mismatch (a sealed delta record exists but covers another range or is not locally_clear: rerun it for the start of the logic range..PR head), chain_reaches_head, record_exists, record_changed (the delta record changed on disk after it was validated), record_not_clearing, proof_not_reached; a thrown gh or git failure is "writer_error".
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

const refuse = (reason, detail) => ({ ok: false, refused: true, reason, detail });
const CLI = "node <dev-loops-package-root>/cli/index.mjs";
const defaultGit = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnvNoDirOverrides(), stdio: ["ignore", "pipe", "pipe"] }).trim();
const defaultFetchPr = ({ repo, pr }, { env, ghCommand, runChild }) => ghJson(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid,baseRefName"], { env, ghCommand, runChild });

export async function extendCapRoundChain(options, {
  env = process.env, ghCommand = "gh", runChild, fetchPr = defaultFetchPr, git = defaultGit,
  fetchBaseBranch = defaultFetchOrigin, detectOriginSlug = detectRepoSlug, resolveProof = resolveCapRoundFixed, writeRecord = writeSealedGateDeltaRecord, readRecord = readGateDeltaRecord,
} = {}) {
  const { pr } = options;
  const cwd = options.worktree ?? process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  // The ledger and the record are read from this checkout, keyed by the --repo slug: it must be --repo.
  const originSlug = detectOriginSlug(repoRoot);
  if (!originSlug || !repoSlugEquals(originSlug, options.repo)) return refuse("repo_mismatch", `the checkout origin (${originSlug ?? "unresolved"}) is not ${options.repo}; rerun with --repo ${originSlug ?? "<origin slug>"} from a clone of ${options.repo}`);
  // Every later path (ledger directory, proof, messages) uses the origin slug, so a case variant of --repo cannot miss the ledger on a case-sensitive filesystem.
  const repo = originSlug;
  const state = await fetchPr({ repo, pr }, { env, ghCommand, runChild });
  const prHead = typeof state?.headRefOid === "string" ? state.headRefOid.trim().toLowerCase() : "";
  const baseRefName = state?.baseRefName;
  if (!/^[0-9a-f]{40}$/u.test(prHead) || !baseRefName) return refuse("pr_state_unreadable", `cannot read PR #${pr} head and base; check \`gh auth status\` and rerun with --repo ${repo} --pr ${pr}`);
  const head = git(cwd, ["rev-parse", "HEAD"]).toLowerCase();
  if (head !== prHead) return refuse("head_mismatch", `the worktree HEAD ${head.slice(0, 7)} is not the PR head ${prHead.slice(0, 7)}; check out and push the PR head, then rerun`);

  // The proof, the chain-end discovery and the range all read origin/<base>: fetch it fresh (bounded, prompt-free) first or refuse.
  try {
    fetchBaseBranch(baseRefName, { repoRoot });
  } catch {
    return refuse("base_fetch_failed", `git fetch origin ${baseRefName} failed; cannot trust the local origin/${baseRefName} ref. Run \`git fetch origin ${baseRefName}\` and rerun`);
  }

  const proofArgs = { repo, pr, headSha: head, baseRefName };
  const reached = await resolveProof(proofArgs, { repoRoot });
  if (reached) return { ok: true, action: "already_proven", chainEnd: null, candidateHead: head, files: [] };
  const cap = await resolveCapRound(proofArgs, { repoRoot });
  const tmpRoot = resolveGateArtifactTmpRoot(repoRoot);
  const cleanCap = isCleanCapRound(cap);
  // A clean cap round has no act item to cover: any sealed clearing chain (a thread-route record over a logic commit) ends at the E the extension record binds to, and the proof then accepts the chain through that record.
  const ends = cap ? await clearingChainLastCandidates({ tmpRoot, capHead: cap.log.headSha, repo, pr, baseRefName, repoRoot, covering: cleanCap ? () => true : capRoundCovers(cap, tmpRoot), allowUnsealedEnd: true }) : [];
  const reaches = (from, to) => { try { git(repoRoot, ["merge-base", "--is-ancestor", from, to]); return true; } catch { return false; } };
  const isAncestor = (sha) => sha !== head && reaches(sha, head);
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
  const cleanCapRemedy = (from) => `A clean cap round has no act list, so only the thread-route pre-push delta (${CLI} loop pre-push-delta --threads-file <threads-file> --repo ${repo} --pr ${pr} --baseline ${from} --result <result-file> --invocation <1-3>) can produce a covering record for ${deltaRange(from)}. The command needs at least one unresolved review thread and throws without one. Run it until its outcome is locally_clear, then rerun ${CLI} gate extend-cap-round-chain --repo ${repo} --pr ${pr}. When no unresolved review thread exists, restart on a replacement PR instead. gate-coordination routes this refusal back to this command, so it does not break the cycle; the thread-route delta or the replacement-PR restart does: ${CAP_ROUND_REFUSAL.baseline_orphaned}`;
  const fixerPassRemedy = (from) => `Run the pre-push delta for baseline ${from} at the PR head until its outcome is locally_clear (${CLI} loop pre-push-delta --baseline ${from} --result <result-file> --invocation <1-3> with the act list and fixer files; it writes the sealed record for ${deltaRange(from)}), then rerun ${CLI} gate extend-cap-round-chain --repo ${repo} --pr ${pr}. ${CLI} loop gate-coordination --repo ${repo} --pr ${pr} routes this refusal back to this command, so the pre-push delta breaks the cycle, not gate-coordination. If the baseline is orphaned, restart on a replacement PR: ${CAP_ROUND_REFUSAL.baseline_orphaned}`;
  const deltaRemedy = (from) => cleanCap ? cleanCapRemedy(from) : fixerPassRemedy(from);
  // A sealed clearing record at `from` that did not seal the extension below covers another range or a non-locally_clear outcome: never a cover for from..head.
  const refuseLogic = (from, logic) => {
    const other = sealedClearing(from);
    if (other) return refuse("delta_range_mismatch", `GATE-EXEC-ROUND-CAP-CHAIN-EXTEND: commits after ${from.slice(0, 7)} change logic files: ${logic.join(", ")}, and the sealed delta record for ${from.slice(0, 7)} covers ${String(other.candidateHead).slice(0, 7)} with outcome ${other.outcome}, not locally_clear for exactly ${from.slice(0, 7)}..${head.slice(0, 7)}. ${deltaRemedy(from)}`);
    return refuse("logic_commit_in_range", `GATE-EXEC-ROUND-CAP-CHAIN-EXTEND: commits after ${from.slice(0, 7)} change logic files: ${logic.join(", ")}, and no sealed locally_clear delta record covers them. ${deltaRemedy(from)}`);
  };
  // ADR 0254: only a sealed locally_clear delta record whose baseline is the start of the logic range and whose candidate is the PR head covers that range. A later link never vouches for logic an earlier link did not clear. Seal the extension into that record, then prove; a failed proof restores it if it is still the record this run wrote.
  const onDisk = (base) => { try { return JSON.stringify(readRecord(tmpRoot, base)); } catch { return null; } };
  const sealDeltaCovered = async (start) => {
    const record = sealedClearing(start);
    if (!record || String(record.candidateHead ?? "").toLowerCase() !== head || record.outcome !== "locally_clear") return null;
    // Already sealed with an extension for this head: the proof fails for another condition, so a delta rerun cannot help. Write nothing.
    if (record.extension) return refuse("proof_not_reached", `the delta record for ${start.slice(0, 7)} already carries ${record.extension} for ${head.slice(0, 7)}, but the cap-round-fixed proof does not reach the head; nothing was written. Run ${CLI} loop gate-coordination --repo ${repo} --pr ${pr} for the failed condition`);
    // Compare-before-write: narrows, but does not close, the race with a concurrent delta rerun (no lock, no compare-and-swap); a rerun that lands after this check is still overwritten by this stale copy.
    if (onDisk(start) !== JSON.stringify(record)) return refuse("record_changed", `the delta record for ${start.slice(0, 7)} changed on disk since it was validated; nothing was written. Rerun ${CLI} gate extend-cap-round-chain --repo ${repo} --pr ${pr}`);
    const written = JSON.stringify({ ...record, extension: "delta_covered" });
    writeRecord(tmpRoot, start, JSON.parse(written));
    let reachedAfter = null;
    let proofError;
    try { reachedAfter = await resolveProof(proofArgs, { repoRoot }); } catch (error) { proofError = error; }
    if (!reachedAfter) {
      const ours = onDisk(start) === written;
      if (ours) writeRecord(tmpRoot, start, record);
      if (proofError) throw proofError;
      return refuse("proof_not_reached", `the cap-round-fixed proof does not reach ${head.slice(0, 7)} after sealing delta_covered into the record for ${start.slice(0, 7)}; ${ours ? "the record was restored" : "the record changed since this run wrote it and was left in place"}. Run ${CLI} loop gate-coordination --repo ${repo} --pr ${pr} for the failed condition`);
    }
    return { ok: true, action: "chain_extended", chainEnd: start, candidateHead: head, files: (await classifyRange(start)).files };
  };
  const capHeadValid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(capHeadSha) && isAncestor(capHeadSha);
  if (!chainEnd && cleanCap && ends.includes(head) && readGateDeltaRecord(tmpRoot, capHeadSha) !== null) {
    // Classify cap-round head..HEAD first: a logic commit there makes the pushed-docs remedy below unreachable.
    if (capHeadValid) {
      const { logic } = await classifyRange(capHeadSha);
      if (logic.length > 0) return await sealDeltaCovered(capHeadSha) ?? refuseLogic(capHeadSha, logic);
    }
    return refuse("chain_reaches_head", `the sealed clearing chain from the cap-round head ends at the PR head ${head.slice(0, 7)}, so no extension can bind to it yet. Push one further docs or tests commit, then rerun ${CLI} gate extend-cap-round-chain --repo ${repo} --pr ${pr}; it extends at the chain end and writes nothing now`);
  }
  if (!chainEnd && capHeadValid && cleanCap) chainEnd = capHeadSha;
  if (!chainEnd) {
    // A rebase leaves the cap-round head outside the head's history: no extension can bind, so name the replacement-PR restart.
    // Same probe as resolveCapRoundFixed: only merge-base exit 1 with both commits present proves it; the head itself or an unfetched commit (exit 128) does not.
    const capHead = cap?.log?.headSha;
    const present = (sha) => { try { git(repoRoot, ["cat-file", "-e", `${sha}^{commit}`]); return true; } catch { return false; } };
    const proveOrphan = () => { try { git(repoRoot, ["merge-base", "--is-ancestor", capHead, head]); return false; } catch (error) { return error?.status === 1 && present(capHead) && present(head); } };
    if (capHead && capHead.toLowerCase() !== head && proveOrphan()) return refuse("baseline_orphaned", CAP_ROUND_REFUSAL.baseline_orphaned);
    if (capHead && !present(capHead)) return refuse("no_cap_round_chain", `the cap-round head ${capHead.slice(0, 7)} is not in this clone, so no chain can be read. A cap-round head missing from this clone is outside the PR head's fetched history. Run \`git rev-parse --is-shallow-repository\`: if it prints true, run \`git fetch --unshallow\`, otherwise run \`git fetch origin ${capHead}\`. Then rerun \`${CLI} gate extend-cap-round-chain --repo ${repo} --pr ${pr}\`. If the commit is still absent, restart on a replacement PR`);
    return refuse("no_cap_round_chain", `PR #${pr} has no covering sealed cap-round clearing chain ending at an ancestor of ${head.slice(0, 7)}. Complete the cap round's fixer pass and run check-pre-push-delta.mjs --result for the cap-round baseline, then rerun this command, or restart on a replacement PR. If the PR head already carries a clean current-head draft_gate verdict, no extension is needed. ${CLI} loop gate-coordination --repo ${repo} --pr ${pr} routes this refusal back to this command, so only the pre-push delta or the replacement-PR restart breaks the cycle`);
  }

  // A delta_covered or docs_tests_only record at the clean cap-round head already cleared capHead..its candidate: classify from that candidate, so a later docs commit extends instead of reclassifying cleared logic.
  const capRecord = cleanCap && capHeadValid ? sealedClearing(capHeadSha) : null;
  const capCandidate = String(capRecord?.candidateHead ?? "").toLowerCase();
  const clearedEnd = ["delta_covered", "docs_tests_only"].includes(capRecord?.extension) && /^[0-9a-f]{40}$/u.test(capCandidate) && isAncestor(capCandidate) ? capCandidate : null;
  // A later extension past the cleared end moves the start to the chain end, so the remedy never names a baseline whose record this tool wrote.
  const rangeStart = (clearedEnd && chainEnd !== clearedEnd && reaches(clearedEnd, chainEnd) ? chainEnd : clearedEnd) ?? (cleanCap && capHeadValid ? capHeadSha : chainEnd);
  const { files, logic } = await classifyRange(rangeStart);
  if (logic.length > 0) return await sealDeltaCovered(rangeStart) ?? refuseLogic(rangeStart, logic);
  const recordExists = () => refuse("record_exists", `a delta record for ${chainEnd.slice(0, 7)} already exists and is never overwritten; run ${CLI} loop gate-coordination --repo ${repo} --pr ${pr} for the failed proof condition`);
  if (readGateDeltaRecord(tmpRoot, chainEnd) !== null) {
    let clearing = false;
    try { clearing = DELTA_CLEARING_NEXT_STEPS.includes(readSealedGateDeltaRecord(tmpRoot, chainEnd)?.nextStep); } catch { /* unreadable: not a clearing record */ }
    if (clearing) return recordExists();
    return refuse("record_not_clearing", `the delta record for ${chainEnd.slice(0, 7)} exists but is not a sealed clearing record and is never overwritten; complete its open items, then rerun check-pre-push-delta.mjs --result for baseline ${chainEnd}`);
  }

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
    return refuse("proof_not_reached", `the cap-round-fixed proof does not reach ${head.slice(0, 7)} after the extension for ${chainEnd.slice(0, 7)}; ${ours ? "the record was removed" : "the record changed since this run wrote it and was left in place"}. Run ${CLI} loop gate-coordination --repo ${repo} --pr ${pr} for the failed condition`);
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
  return emitResult(result, { jq: options.jq, fields: options.fields, silent: options.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().then((code) => { process.exitCode = code; });
}
