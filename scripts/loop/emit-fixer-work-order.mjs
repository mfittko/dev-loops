#!/usr/bin/env node
/**
 * Fixer role of the work-order pull protocol (ADR 0106): the deterministic
 * producer of the fixer's work order and the `fixer` role adapter that
 * pull-work-order.mjs selects by the ref's `fixer:` prefix. Serializer, envelope,
 * reader and receipt stay in _work-order-protocol.mjs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { loadDevLoopConfig } from "@dev-loops/core/config";
import { VALID_SEVERITIES, pastCapBlockers } from "@dev-loops/core/loop/gate-fanin";
import { findRetirementAfter } from "@dev-loops/core/loop/gate-round-retirement";
import { assertFixerReviewBaseline } from "@dev-loops/core/loop/work-order-digest";
import { deltaCoverageBinding, startDeltaSequence, toDeltaActItems, validateDeltaResult } from "@dev-loops/core/loop/pre-push-delta-review";
import { normalizeFixerDispositionHandoff } from "@dev-loops/core/loop/fixer-disposition";
import { writeSequenceMarker } from "@dev-loops/core/loop/fix-push-authority";
import { formatCliError, isDirectCliRun, readJsonIfExists as readJson } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, preflightJqFilter } from "../lib/jq-output.mjs";
import { WorkOrderRefusal, buildDispatchPointer, materializationHash, registerWorkOrderRole, verifyPulledResult, workOrderDigest, writeExecutionIndex } from "../github/_work-order-protocol.mjs";
import { buildLogPath, repoSlugFor } from "../github/_gate-artifact-paths.mjs";
import { GATE_NAMES } from "../github/_gate-names.mjs";
import { fingerprintFinding, readGateFindingsLedger } from "../github/_gate-finding-surface.mjs";
import { renderRequiredReadLine, resolveDraftRoundCap } from "../github/write-gate-context.mjs";
import { DELTA_CLEARING_NEXT_STEPS, gateDeltaRecordPath, readGateDeltaRecord } from "./_gate-delta-record.mjs";
import { assertTmpRootOutsideLinkedWorktree, gitEnvNoDirOverrides, listWorktreeEntries, resolveGateArtifactTmpRoot, resolveRepoRoot } from "./_repo-root-resolver.mjs";
import { authenticateOriginalPlan, beginFixerEmission } from "../github/_fixer-emission-evidence.mjs";
import { captureParsedReviewThreads } from "../github/_review-thread-mutations.mjs";
import { resolveAuthenticatedLogin, runGhJson } from "../github/post-gate-findings.mjs";
import { normalizePrReviewsPayload, prReviewsApiArgs } from "../github/_gate-finding-surface.mjs";
import { summarizeGateReviewCommentMarkers } from "@dev-loops/core/github/copilot-helpers";
import { selectActThreadBinding } from "../github/_fixer-act-thread-bindings.mjs";
import { loadKnownRuleIds } from "../lib/known-rule-ids.mjs";

const USAGE = `Usage: emit-fixer-work-order.mjs --harness <claude|pi|codex> --repo <owner/name> --pr <n> --head-sha <sha> --phase <commit_only|full> (--act-list-file <path> --gate <draft_gate|pre_approval_gate> | --threads-file <path>) [--delta-result <path>] [--allowed-path <repo-relative path>]... [--tmp-root <path>]
Derives the fixer's work order from typed sources: the gate act list (judge-pass --out)
or the unresolved review threads (list-review-threads.mjs --unresolved-only), plus the
optional pre-push delta result (dev-loops loop pre-push-delta). --phase full needs a clearing
delta decision for the head: an act-list source passes the clearing --delta-result, a
threads source needs a thread-bound clearing record under <tmp-root>/gate-delta/ (written by
check-pre-push-delta --result), and any non-clearing record for the head refuses; use
--phase commit_only first. The mutation authority is
the PR's own head branch (gh pr view headRefName) and the --allowed-path selectors
(default "." = the whole repository). A PR head other than --head-sha refuses.
An --act-list-file source also refuses with verdict_not_posted until the --gate verdict review for --head-sha is posted on the PR (GATE-EXEC-POST-BEFORE-FIX; post it with dev-loops gate upsert-verdict --findings-ledger).
It writes the immutable work order under <tmp-root>/gate-fixer/<repo-slug>/pr-<N>/
(default: the main checkout's tmp/; an explicit --tmp-root inside a linked worktree is refused) and prints
{ ok, workOrderRef, workOrderDigest, executionIdentity, dispatchPrompt, dispatchPayload, planPath }.
Each run supersedes the previous emission for this PR. Dispatch the printed
dispatchPayload (the --harness adapter call carrying only dispatchPrompt) unchanged; an
unsupported harness refuses. It accepts no brief, payload or summary input.
Exit codes: 0 emitted, 1 refused (missing or conflicting source or authority), 2 usage/IO error.`;

// ref = fixer:<owner/repo>#<pr>:<headSha>:<executionIdentity>; executionIdentity = f<emit ms>-<8 hex>.
const FIXER_REF_RE = /^fixer:([^/\s#]+\/[^/\s#]+)#(\d+):([0-9a-f]{40}|[0-9a-f]{64}):(f(\d+)-[0-9a-f]{8})$/;
const FIXER_PHASES = ["commit_only", "full"];
const PLAN_FILE = "fixer-emit-plan.json";
// Pinned fixer contracts: the work order digest changes when one changes.
const FIXER_CONTRACTS = ["agents/fixer.agent.md", "skills/docs/gate-review-sub-loop-contract.md", "skills/docs/validation-policy.md", "skills/docs/copilot-loop-operations.md"];
const PACKAGE_ROOT = new URL("../../", import.meta.url);
const VALIDATION_RULE = "Run targeted checks via resolveTargetedValidation(changedPaths) per skills/docs/validation-policy.md VALIDATE-TARGETED-FIRST; a local full-repository run goes only through `dev-loops gate resolve-validation`";
// The mirror trees are the generator output; other .claude/ paths are hand-edited and stay outside this rule.
const REGENERATE_RULE = "When the fix changes a file under `skills/`, `agents/` or `commands/`, run `node scripts/claude/generate-claude-assets.mjs`, commit the regenerated files under `.claude/skills/`, `.claude/agents/` and `.claude/commands/` in the same commit as the fix, run `bun run assets:check`, and never hand-edit a file under those mirror trees";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sortKeys = (value) => (Array.isArray(value) ? value.map(sortKeys)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
    : value);
/** Exact-content digest of parsed JSON (key order only is normalized). */
const jsonContentDigest = (value) => sha256(JSON.stringify(sortKeys(value)));

export function buildFixerDir({ repo, pr, tmpRoot }) {
  if (!/^[1-9]\d*$/.test(String(pr))) throw new Error(`--pr ${JSON.stringify(pr)} is not a positive integer`);
  return path.join(tmpRoot, "gate-fixer", repoSlugFor(repo), `pr-${pr}`);
}

class Refusal extends Error {}

async function readSource(kind, filePath, capture) {
  const bytes = await capture.read(filePath);
  if (bytes === null) throw new Refusal(`required fixer source ${kind} is missing or unreadable: ${filePath}`);
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Refusal(`required fixer source ${kind} is not JSON: ${filePath}`); }
  return { read: { kind, path: filePath, sha256: sha256(bytes), bytes: bytes.length, required: true }, parsed };
}

// A typed repo-relative selector; "." is the whole repository.
function normalizeAllowedPath(raw) {
  const value = String(raw).trim();
  if (!value || path.isAbsolute(value) || value.includes("\\")) throw new Refusal(`--allowed-path ${JSON.stringify(raw)} must be a repo-relative path`);
  const normalized = path.posix.normalize(value).replace(/\/+$/u, "") || ".";
  if (normalized.split("/").includes("..")) throw new Refusal(`--allowed-path ${JSON.stringify(raw)} escapes the repository`);
  return normalized;
}

async function defaultFetchPr({ repo, pr }) {
  const out = execFileSync("gh", ["pr", "view", String(pr), "--repo", repo, "--json", "headRefName,headRefOid"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return JSON.parse(out);
}

// The posted verdict markers at `headSha`, keyed by gate: submitted reviews only (GATE-EXEC-POST-BEFORE-FIX); the head filter is summarizeGateReviewCommentMarkers's own.
export async function defaultFetchVerdictMarkers({ repo, pr, headSha, runtime }) {
  const reviews = normalizePrReviewsPayload(await runGhJson(prReviewsApiArgs(repo, pr), runtime));
  return summarizeGateReviewCommentMarkers(reviews, { headSha });
}

const SKELETON_STATUS = "fixed|skipped";

/**
 * The pre-filled `siteCoverage` of a commit_only handback, one record per act item with a siteQuery.
 * It reads the same act list that check-pre-push-delta verifies (`--act-list`, the cumulative list),
 * so its fingerprints and input forms match what the check demands.
 * The sites are the ones the act item already names (stated surfaces and input forms);
 * the fixer fills each site's `status` (and `reason` for a skip, `test` for a fixed input form).
 * Items that share a fingerprint merge into one record, and a site text appears once (an input form wins).
 * `returnedSites` starts empty: the fixer runs the siteQuery, sets `returnedSites` to its output, adds every
 * returned site missing from `sites`, and deletes `noSitesReason`; a query that returns nothing keeps `returnedSites` empty
 * and replaces the `FILL:` `noSitesReason` with the query outcome.
 */
export function buildSiteCoverageSkeleton(actList) {
  const records = new Map();
  for (const item of toDeltaActItems(actList).filter((i) => i.siteQuery)) {
    const fingerprint = item.fingerprint ?? item.ref;
    const rec = records.get(fingerprint) ?? records.set(fingerprint, { fingerprint, sites: new Map() }).get(fingerprint);
    for (const site of item.statedSurfaces ?? []) if (!rec.sites.has(site)) rec.sites.set(site, { site, status: SKELETON_STATUS, reason: "" });
    for (const site of [...(item.acceptedForms ?? []), ...(item.rejectedForms ?? [])]) rec.sites.set(site, { site, kind: "input_form", status: SKELETON_STATUS, reason: "", test: "" });
  }
  return [...records.values()].map(({ fingerprint, sites }) => {
    // returnedSites starts empty: only the fixer's siteQuery run fills it. The declared sites ride in `sites`.
    return { fingerprint, returnedSites: [], sites: [...sites.values()], noSitesReason: "FILL: run the siteQuery; if it returns nothing replace this with the outcome, else list its sites in returnedSites and delete this field" };
  });
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const EDIT_RULE = "Edit rule: write file content only with the Edit and Write tools. Never write file content through Bash (heredoc, redirect, `sed -i`, or cp/mv onto a tracked file). Scripts the order names, such as the asset generator and `--construct`, may write files. Never write `fixer-disposition*.json` (the verifier's --construct writes it; a hand-written report is refused). Only after the verifier refuses this execution's report as hand-written, rm that report and its corresponding stale `.constructed` marker; no other delete is allowed. Preserve accepted construction evidence and unrelated files.";

// The numbered full-phase steps (issue 2787 C1): push, confirm the remote head, wait for CI, --construct, verify, --check.
function fullPhaseSteps(workOrder, verifier, { push }) {
  const root = path.dirname(path.dirname(workOrder.executionRules.contract));
  const { repo, pr } = workOrder.target;
  const { branch } = workOrder.mutationAuthority;
  if (spawnSync("git", ["check-ref-format", "--branch", branch]).status !== 0) throw new Error(`refusing to render a branch name git rejects: ${JSON.stringify(branch)}`);
  const wait = `node ${shellQuote(path.join(root, "scripts/github/wait-pr-checks.mjs"))} --repo ${shellQuote(repo)} --pr ${pr} --timeout 900`;
  return `Do these steps in this order; none may be skipped or reordered:
1. ${push}
2. Confirm the remote head equals the candidate: run \`git ls-remote origin\` with the ref ${JSON.stringify(`refs/heads/${branch}`)}; it must print the pushed candidate SHA. If it does not, stop and report.${verifier.includes("<pushed-head-sha>") ? " Replace `<pushed-head-sha>` in steps 4 to 6 with the confirmed SHA." : ""}
3. Run \`${wait}\` once. If it exits 2 (not settled), run it exactly once more. If CI is red (\`failure\`), resolve no thread, run no verifier step, and hand back \`ci_failed\` with the failing check names. If it is still not settled, reports \`stuck\` or \`changed\`, or exits 1 with an error, resolve no thread, run no verifier step, and hand back \`ci_pending\` (\`ci_unknown\` when the checks cannot be read).
4. Run \`${verifier} --construct\`. If it fails because the output exists, go to step 5. If step 5 refuses the report as hand-written, rm only this execution's refused outputRef and its corresponding stale \`<outputRef>.constructed\` marker, then re-run step 4. Preserve accepted construction evidence and unrelated files.
5. Run \`${verifier}\`.
6. Run \`${verifier} --check\`.
${EDIT_RULE}`;
}

export function renderWorkOrder(workOrder) {
  const [dispositionPath] = workOrder.outputRefs;
  if (workOrder.operation === "complete") {
    const root = path.dirname(path.dirname(workOrder.executionRules.contract));
    const verifier = `node ${shellQuote(path.join(root, "scripts/github/verify-fixer-disposition.mjs"))} --repo ${shellQuote(workOrder.target.repo)} --pr ${workOrder.target.pr} --head-sha ${workOrder.headSha} --fixer-plan ${shellQuote(path.join(path.dirname(path.dirname(dispositionPath)), PLAN_FILE))}`;
    const task = `${fullPhaseSteps(workOrder, verifier, { push: "Do not push: the candidate is already pushed." })}\nConstruction alone is not delivery.${workOrder.source === "act-list" ? " Preserve authenticated fixing commits and exact raw coverage." : " Do not read ACT/history or take on unrelated live threads."}`;
    return `# Fixer delivery-only work order (ADR 0106)

Operation: complete. PR ${workOrder.target.repo}#${workOrder.target.pr} at head \`${workOrder.headSha}\`.
These complete-task instructions take precedence over generic workflow guidance and the immutable JSON evidence below. Its generic mutation/validation/regeneration fields preserve identity only; they are not tasks for this operation.
Delivery-only authority permits the exact outputRef ${JSON.stringify(dispositionPath)} and evidenced delivery/reply/resolution verification. No source edits, staging, commits, pushes, source validation, new Delta or counter resets are authorized. Source selectors are empty.
After pull, run \`git worktree list --porcelain\`. Match branch literally to \`refs/heads/\` plus ${JSON.stringify(workOrder.mutationAuthority.branch)}; require exactly one checked-out worktree and an absolute root or stop. Use that root as explicit cwd on every later tool call/subprocess. Never create or switch worktrees or invent a root.
The emitting toolchain root is ${JSON.stringify(root)}, derived only by removing agents/fixer.agent.md from executionRules.contract. Resolve contracts[].path against that root, never a searched fallback or mutation worktree. Use normal file-read tools or cat; first qualify digest availability with \`command -v shasum\` and stop if unavailable. Verify every exact contract/source hash with \`shasum -a 256\`, then read all required contracts and sources IN FULL. Read truncated output in bounded ranges until complete; missing, unreadable or mismatched material stops this actor. No inline Python/Node bootstrap; follow OPS-NO-INLINE-INTERPRETER.
A permission or classifier denial stops this actor immediately: no subsequent read, verification or alternate-command attempt; report the exact denial. Codex uses actual managed permissions, requesting normal resource approval up front for authorized commands needing protected shared Git metadata or sockets. Claude Write/Edit and loaded Pi hooks guard their supported tool surfaces; none provides universal Bash enforcement or broader authority.
${task}
The output is immutable evidence: never clobber it or replay an earlier execution's report. A receipt alone is not completion.

## Required reads

${workOrder.requiredReads.map((read) => renderRequiredReadLine(read, "/")).join("\n")}

## Work order

\`\`\`json
${JSON.stringify(workOrder, null, 2)}
\`\`\`
`;
  }
  // headRefName is PR-supplied: JSON-quote it (and paths) so a backtick cannot close a span and inject prose.
  const { branch, allowedPaths } = workOrder.mutationAuthority;
  const completion = workOrder.phase === "full" && workOrder.requiredReads.some((read) => read.kind === "completion-input");
  const verifier = workOrder.phase === "full" ? `node ${shellQuote(path.join(path.dirname(path.dirname(workOrder.executionRules.contract)), "scripts/github/verify-fixer-disposition.mjs"))} --repo ${shellQuote(workOrder.target.repo)} --pr ${workOrder.target.pr} --head-sha ${completion ? workOrder.headSha : "<pushed-head-sha>"} --fixer-plan ${shellQuote(path.join(path.dirname(path.dirname(dispositionPath)), PLAN_FILE))}` : null;
  const task = workOrder.phase === "commit_only"
    ? `Apply the fixes the source read names, per agents/fixer.agent.md, and commit them. Hand back the commit SHA unpushed: no push, no thread replies. Write no disposition handoff. Write the site coverage record \`{ headSha, siteCoverage: [{ fingerprint, returnedSites, sites, ruleCitations?, noSitesReason? }] }\` (headSha = your commit) to \`${dispositionPath}\`, one entry per act item that has a siteQuery.${workOrder.siteCoverage ? " Start from the \`siteCoverage\` skeleton in the work order JSON below:" : ""} Set each site's \`status\` to \`fixed\` or \`skipped\`, add a \`reason\` to every skip and a \`test\` to every fixed \`input_form\` site. Run each siteQuery and set \`returnedSites\` to exactly the sites it returns (empty when it returns none), add each returned site missing from \`sites\`, then delete the \`FILL:\` \`noSitesReason\` when the query returned sites, else replace it with the query outcome. Keep fingerprints and \`input_form\` texts unchanged.${workOrder.handbackCheck ? " Before you hand back, run the work order's \`handbackCheck\` command from your worktree and correct the record until it exits 0 (skip it when you made no commit)." : ""}`
    : completion ? `Do not re-fix source or reclassify coverage. Keep every command's cwd at the mutation authority worktree. The authenticated completion-input preserves the original fixing commit and raw site coverage. Construction alone does not complete delivery.\n${fullPhaseSteps(workOrder, verifier, { push: `Push only the reviewed committed candidate \`${workOrder.headSha}\` to branch ${JSON.stringify(workOrder.mutationAuthority.branch)}.` })}`
    : `Make no further commit: the clearing delta record's candidateHead is the delta-reviewed candidate, and --construct requires the pushed head to equal it. The verifier's --construct writes the report from the threads source and the clearing delta record; never write the disposition handoff yourself. Replace \`<pushed-head-sha>\` below with the full 40-character SHA of the pushed head.\n${fullPhaseSteps(workOrder, verifier, { push: `Push exactly the delta-reviewed candidate (the clearing delta record's candidateHead) to branch ${JSON.stringify(workOrder.mutationAuthority.branch)}.` })}`;
  return `# Fixer work order (ADR 0106)

Source: the \`${workOrder.source}\` read${workOrder.gate ? ` (${workOrder.gate} act list)` : ""}. Phase: \`${workOrder.phase}\`. PR ${workOrder.target.repo}#${workOrder.target.pr} at head \`${workOrder.headSha}\`.
${task}
When a \`delta-result\` read is listed, follow agents/fixer.agent.md step 7 for its act-item statuses.
Read every \`required\` entry below IN FULL before any change. If one is missing, unreadable, or its sha256 differs, stop and report which read failed.
Mutation authority: branch ${JSON.stringify(branch)}, paths ${allowedPaths.map((p) => JSON.stringify(p)).join(", ")}. ${workOrder.executionRules.mutation}.
Validation: ${workOrder.executionRules.validation}.${workOrder.executionRules.regenerate ? `\nRegenerate: ${workOrder.executionRules.regenerate}.` : ""}

## Required reads

${workOrder.requiredReads.map((read) => renderRequiredReadLine(read, "/")).join("\n")}

## Work order

\`\`\`json
${JSON.stringify(workOrder, null, 2)}
\`\`\`
`;
}

// The commit_only phase commits unpushed; the delta review then decides whether `full` may push.
// `delta` is the parsed --delta-result (act-list route); `threads` the unresolved threads (thread route).
function assertDeltaClearsFullPhase({ tmpRoot, headSha, delta, threads, candidateHead, coverageBinding }) {
  const recordPath = gateDeltaRecordPath(tmpRoot, headSha);
  const record = readGateDeltaRecord(tmpRoot, headSha);
  const next = "emit --phase commit_only, run the delta review (dev-loops loop pre-push-delta), then emit --phase full";
  if (record && !DELTA_CLEARING_NEXT_STEPS.includes(record.nextStep)) {
    throw new Refusal(`--phase full refused: the delta record ${recordPath} holds nextStep ${JSON.stringify(record.nextStep)}, not ${DELTA_CLEARING_NEXT_STEPS.join(" or ")}; fix and re-run the delta review (${next})`);
  }
  if (!threads) {
    if (!delta) throw new Refusal(`--phase full with --act-list-file needs --delta-result naming a clearing delta result: ${next}`);
    // The decided nextStep in the record for this head clears the push. The record's candidateHead is the worktree
    // HEAD at decision time and may differ from a stale invocation-3 result's, so only the act set binds them.
    const clears = record && record.actSetId === delta.actSetId;
    if (!clears) throw new Refusal(`--phase full refused: no delta record at ${recordPath} holds a clearing nextStep for the --delta-result's act set; ${next}`);
    // The result must be the one the decision used: an earlier non-clearing result of the same sequence shares the act set
    // but not the record's item statuses, and the fixer reads those statuses (step 7 bounded_out rule).
    const pairs = (items) => [...new Set((Array.isArray(items) ? items : []).map((item) => `${JSON.stringify(item?.ref)}:${JSON.stringify(item?.status)}`))].sort().join("\n");
    if (pairs(delta.actionableItems) !== pairs(record.items)) {
      throw new Refusal(`--phase full refused: the --delta-result's item statuses differ from the delta record ${recordPath}, so it is not the result that decision used; pass the clearing result (${next})`);
    }
    if (candidateHead) {
      if (record.reviewBaselineHead !== headSha || record.candidateHead !== candidateHead
        || !(record.outcome === "bounded_out" && record.nextStep === "push_to_gate" && record.invocation === 3)
          && !(record.outcome === "locally_clear" && record.nextStep === "push" && delta.outcome === "locally_clear"
            && delta.candidateHead === candidateHead && Number.isInteger(record.invocation) && record.invocation >= 1 && record.invocation <= 3)) {
        throw new Refusal("--phase full refused: Delta decision does not clear the actual candidate and reviewed baseline");
      }
      deltaCoverageBinding(delta, coverageBinding);
      deltaCoverageBinding(record, coverageBinding);
    }
    return;
  }
  if (!record) throw new Refusal(`--phase full with --threads-file needs a delta record at ${recordPath} from a thread-route delta review: ${next}`);
  const threadIds = new Set(threads.map((thread) => thread.threadId));
  const refs = (Array.isArray(record.items) ? record.items : []).map((item) => item?.ref);
  const unbound = refs.filter((ref) => !threadIds.has(ref));
  if (unbound.length > 0) {
    throw new Refusal(`--phase full refused: the delta record ${recordPath} covers refs that are not threads in the threads file (${unbound.map((ref) => JSON.stringify(ref)).join(", ")}); review the current threads (${next})`);
  }
  const uncovered = [...threadIds].filter((id) => !refs.includes(id));
  if (uncovered.length > 0) {
    throw new Refusal(`--phase full refused: the threads file holds threads the delta record ${recordPath} never reviewed (${uncovered.map((id) => JSON.stringify(id)).join(", ")}); review the current threads (${next})`);
  }
}

/**
 * Emit one fixer work order. Returns the plan record written beside it. Throws
 * Refusal on a missing or conflicting source or authority. `executionIdentity`
 * and `fetchPr` are injectable for tests.
 */
export async function emitFixerWorkOrder({
  repo, pr, headSha, phase, actListFile, gate, threadsFile, deltaResult, allowedPaths = [], cwd = process.cwd(), tmpRoot,
  fetchPr = defaultFetchPr, fetchVerdictMarkers = defaultFetchVerdictMarkers, executionIdentity = `f${Date.now()}-${randomBytes(4).toString("hex")}`,
  env = process.env, ghCommand = "gh", runChild,
}) {
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) throw new Refusal(`--head-sha must be a full 40- or 64-char lowercase SHA, got ${headSha}`);
  if (!FIXER_PHASES.includes(phase)) throw new Refusal(`--phase must be one of ${FIXER_PHASES.join(", ")}, got ${phase}`);
  if (Boolean(actListFile) === Boolean(threadsFile)) throw new Refusal("pass exactly one of --act-list-file and --threads-file");
  if (actListFile && !GATE_NAMES.includes(gate)) throw new Refusal(`--act-list-file needs --gate ${GATE_NAMES.join("|")}, got ${gate}`);
  if (threadsFile && gate) throw new Refusal("--gate applies only to an --act-list-file source");
  tmpRoot ??= resolveGateArtifactTmpRoot(cwd);
  const dir = path.resolve(buildFixerDir({ repo, pr, tmpRoot }));
  const paths = [...new Set((allowedPaths.length > 0 ? allowedPaths : ["."]).map(normalizeAllowedPath))].sort();
  const abs = (p) => path.resolve(cwd, p);
  const capture = await beginFixerEmission(dir);
  try {
  const planPath = path.join(dir, PLAN_FILE);
  const originalBytes = await capture.read(planPath);
  await capture.preserve(planPath, path.resolve(tmpRoot), resolveGateArtifactTmpRoot(cwd));

  const source = actListFile ? await readSource("act-list", abs(actListFile), capture) : await readSource("threads", abs(threadsFile), capture);
  const isActItem = (f) => f?.judgeDisposition === "act" && VALID_SEVERITIES.has(f.severity) && typeof f.summary === "string" && f.summary.trim() !== "";
  if (actListFile && !(Array.isArray(source.parsed) && source.parsed.length > 0 && source.parsed.every(isActItem))) {
    throw new Refusal(`act list ${actListFile} is not a non-empty judge-pass --out array of { judgeDisposition: "act", severity, summary } findings`);
  }
  // ADR 0188: at or past the draft_gate round cap, low and nit findings never reach the fixer (backstop for hand-built or legacy ledgers). Below the cap a low act is fixed.
  // A nit-only list is fixable in draft round 1 only; any other round, and any gate without a round count, refuses it (the judge pass would have rejected it).
  // A deduped cluster carries every member severity in `clusterSeverities`; the guard reads those, not the representative's.
  const badCluster = actListFile ? source.parsed.find((f) => f.clusterSeverities !== undefined && !(Array.isArray(f.clusterSeverities) && f.clusterSeverities.length > 0 && f.clusterSeverities.every((s) => VALID_SEVERITIES.has(s)))) : undefined;
  if (badCluster) throw new WorkOrderRefusal("invalid_cluster_severities", `invalid_cluster_severities: act item ${JSON.stringify(badCluster.summary)} has clusterSeverities that is not a non-empty array of known severities; re-run judge-pass to regenerate the act list`);
  const actSeverities = actListFile ? source.parsed.flatMap((f) => (Array.isArray(f.clusterSeverities) && f.clusterSeverities.length > 0 ? f.clusterSeverities : [f.severity])) : [];
  const lowNitOnly = actSeverities.every((s) => s === "low" || s === "nit");
  if (actListFile && (gate === "draft_gate" || lowNitOnly)) {
    // The round state comes from the same --tmp-root as the ledger writer, judge-pass and the verdict poster.
    const { lowFixCapped, round, cap } = await resolveDraftRoundCap({ repo, pr, gate, headSha, tmpRoot },{ repoRoot: resolveRepoRoot(cwd) });
    // GATE-EXEC-ROUND-CAP: a round after the cap round composes blocked on any act item (a blocked ledger does not count, so a further round is again cap+1); no fixer order follows it.
    if (cap > 0 && round > cap) {
      throw new WorkOrderRefusal("round_cap_reached", `round_cap_reached (GATE-EXEC-ROUND-CAP): act list ${actListFile} belongs to draft_gate round ${round}, after the cap round (cap ${cap}); the verdict is blocked and no fixer order follows it`);
    }
    // At the cap round the current-head round can still compose blocked (a failOpen finding the judge rejected, a question-severity act item): no fixer order follows a blocked verdict. An unreadable ledger fails closed.
    if (cap > 0 && round === cap) {
      const repoRoot = resolveRepoRoot(cwd);
      const ledgerFile = path.resolve(repoRoot, buildLogPath({ repo, pr, gate, headSha, tmpRoot: tmpRoot || resolveGateArtifactTmpRoot(repoRoot) }));
      if (!existsSync(ledgerFile)) throw new WorkOrderRefusal("round_cap_reached", `round_cap_reached (GATE-EXEC-ROUND-CAP): the draft_gate findings log ${ledgerFile} does not exist; failing closed at the cap round`);
      const { findings: ledgerFindings } = await readGateFindingsLedger(ledgerFile, { errorFactory: (m) => new WorkOrderRefusal("round_cap_reached", `round_cap_reached (GATE-EXEC-ROUND-CAP): ${m}; failing closed at the cap round`) });
      const blockers = pastCapBlockers([...ledgerFindings, ...source.parsed], { pr: Number(pr), round, cap }); // Number(pr): the CLI pr is a string; a non-integer yields NaN and fails closed in pastCapBlockers.
      if (blockers.length > 0) {
        throw new WorkOrderRefusal("round_cap_reached", `round_cap_reached (GATE-EXEC-ROUND-CAP): the cap round (cap ${cap}) composes blocked (${blockers.map((b) => b.item).join("; ")}); the verdict is blocked and no fixer order follows it`);
      }
    }
    if (lowNitOnly && (lowFixCapped || (actSeverities.every((s) => s === "nit") && round !== 1))) {
      throw new WorkOrderRefusal("low_fix_until_cap", `low_fix_until_cap (GATE-EXEC-LOW-FIX-UNTIL-CAP): act list ${actListFile} holds only low or nit items ${lowFixCapped ? "at or past the draft_gate round cap or at pre_approval_gate" : "outside draft_gate round 1"}; low and nit findings no longer reach the fixer`);
    }
  }
  // The verify-time act-thread guard matches open gate threads by fingerprint, so a missing or wrong one would let a matching thread pass as threadless.
  const badFingerprint = actListFile ? source.parsed.find((f) => f.fingerprint !== fingerprintFinding(f)) : undefined;
  if (badFingerprint) {
    throw new Refusal(`act list ${actListFile} has an act item (${JSON.stringify(badFingerprint.summary)}) whose fingerprint is ${badFingerprint.fingerprint === undefined ? "missing" : "not the canonical fingerprintFinding value"}; re-run judge-pass to regenerate it`);
  }
  if (threadsFile && (source.parsed?.ok !== true || !Array.isArray(source.parsed.threads) || source.parsed.repo !== repo || Number(source.parsed.pr) !== Number(pr)
    || !source.parsed.threads.every((thread) => thread?.isResolved === false))) {
    throw new Refusal(`threads file ${threadsFile} is not successful list-review-threads --unresolved-only output for ${repo}#${pr}`);
  }
  if (deltaResult && !actListFile) throw new Refusal("--delta-result applies only to an --act-list-file source");
  // A thread source reads the record the thread-route delta review wrote for this head (step 7 bounded_out rule), never a flag.
  const threadRecordPath = threadsFile ? gateDeltaRecordPath(tmpRoot, headSha) : null;
  const delta = deltaResult ? await readSource("delta-result", abs(deltaResult), capture) : threadRecordPath && existsSync(threadRecordPath) ? await readSource("delta-result", threadRecordPath, capture) : null;
  if (delta && deltaResult) {
    // The delta result must belong to this act list and this head (its pinned review baseline).
    const errors = validateDeltaResult(delta.parsed, { sequence: startDeltaSequence({ reviewBaselineHead: headSha, actList: source.parsed }), membershipOnly: true });
    if (errors.length > 0) throw new Refusal(`delta result ${deltaResult} does not belong to this act list at ${headSha}: ${errors.join("; ")}`);
  }
  await capture.read(gateDeltaRecordPath(tmpRoot, headSha));
  if (phase === "full") assertDeltaClearsFullPhase({ tmpRoot, headSha, delta: delta?.parsed, threads: threadsFile ? source.parsed.threads : null });

  // Mutation authority comes from the PR itself, never from the caller.
  const prState = await fetchPr({ repo, pr });
  if (typeof prState?.headRefName !== "string" || !prState.headRefName) throw new Refusal(`PR ${repo}#${pr} reports no headRefName; mutation authority is missing`);
  if (String(prState.headRefOid ?? "").toLowerCase() !== headSha) throw new Refusal(`PR ${repo}#${pr} head is ${prState.headRefOid}, not --head-sha ${headSha}; conflicting authority, refresh and re-emit`);
  // GATE-EXEC-POST-BEFORE-FIX: an act list is fixed only after its round's verdict review is on the PR at this head.
  if (actListFile) {
    const upsert = `dev-loops gate upsert-verdict --repo ${repo} --pr ${pr} --head-sha ${headSha} --gate ${gate} --findings-ledger <this round's findings ledger>`;
    let markers;
    try { markers = await fetchVerdictMarkers({ repo, pr, headSha, gate, runtime: { env, ghCommand, runChild } }); } catch (error) {
      throw new Refusal(`verdict_not_posted: could not read the PR's posted verdicts (${error?.message ?? error}); post the ${gate} verdict review at ${headSha} before fixing: ${upsert}`);
    }
    if (!(markers?.[gate]?.visible && markers[gate].contractComplete === true)) throw new Refusal(`verdict_not_posted: no ${gate} verdict review is posted on ${repo}#${pr} at ${headSha}; post it before fixing (GATE-EXEC-POST-BEFORE-FIX): ${upsert}`);
  }

  let completion, completionRead, candidateHead = headSha, recheckCandidate = () => {}, rejectOriginalRetirement = () => {};
  if (phase === "full" && actListFile) {
    if (!originalBytes) throw new Refusal("--phase full requires the immediate original pulled commit_only plan");
    const original = JSON.parse(originalBytes), prior = original.workOrder;
    const receiptTmpRoot = resolveGateArtifactTmpRoot(cwd);
    const origin = { workOrderRef: original.workOrderRef, workOrderDigest: original.workOrderDigest, executionIdentity: original.executionIdentity };
    if (prior?.phase !== "commit_only" || prior.source !== "act-list" || prior.headSha !== headSha || prior.gate !== gate
      || prior.target?.repo !== repo || prior.target.pr !== Number(pr) || prior.authority?.sourceDigest !== jsonContentDigest(source.parsed)
      || prior.mutationAuthority?.branch !== prState.headRefName || prior.mutationAuthority.repo !== repo || prior.mutationAuthority.pr !== Number(pr)
      || JSON.stringify(prior.mutationAuthority.allowedPaths) !== JSON.stringify(paths)) throw new Refusal("original commit_only source or mutation authority differs");
    await authenticateOriginalPlan({ plan: original, canonical: planPath, emissionTmpRoot: path.resolve(tmpRoot), receiptTmpRoot, requireReceipt: true,
      read: async (file) => { const bytes = await capture.read(file); if (!bytes) throw Object.assign(new Error(`missing ${file}`), { code: "ENOENT" }); return bytes; } });
    for (const read of prior.requiredReads) {
      const bytes = await capture.read(read.path);
      if (read.required !== true || !bytes || sha256(bytes) !== read.sha256 || bytes.length !== read.bytes) throw new Refusal(`original required read differs: ${read.kind}`);
    }
    const actReads = prior.requiredReads.filter((read) => read.kind === "act-list");
    if (actReads.length !== 1 || actReads[0].sha256 !== source.read.sha256 || path.resolve(actReads[0].path) !== source.read.path) throw new Refusal("original ACT source is not the current exact read");
    const reportPath = prior.outputRefs[0], reportBytes = await capture.read(reportPath);
    const pulled = await verifyPulledResult({ resultPath: reportPath, receiptTmpRoot, role: "fixer", ...origin });
    if (!pulled.ok) throw new Refusal(`original pull/result failed: ${pulled.reason}`);
    const raw = JSON.parse(reportBytes);
    normalizeFixerDispositionHandoff(raw, { ruleIds: loadKnownRuleIds() });
    if (raw.headSha !== delta.parsed.candidateHead) throw new Refusal("Delta candidate differs from the original filled handback");
    const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnvNoDirOverrides(), timeout: 10000, maxBuffer: 1024 * 1024 }).trim();
    candidateHead = git("rev-parse", "HEAD");
    recheckCandidate = () => {
      const entries = listWorktreeEntries(cwd, { timeout: 10000, maxBuffer: 1024 * 1024 }).filter((entry) => entry.branch === `refs/heads/${prState.headRefName}`);
      if (entries.length !== 1 || !path.isAbsolute(entries[0].path) || entries[0].path !== resolveRepoRoot(cwd)
        || git("symbolic-ref", "HEAD") !== `refs/heads/${prState.headRefName}` || git("rev-parse", "HEAD") !== candidateHead
        || git("rev-parse", `refs/heads/${prState.headRefName}`) !== candidateHead || git("status", "--porcelain")) throw new Refusal("candidate branch, HEAD or clean committed authority changed");
      for (const [from, to] of [[headSha, raw.headSha], [raw.headSha, candidateHead]]) git("merge-base", "--is-ancestor", from, to);
    };
    recheckCandidate();
    rejectOriginalRetirement = () => {
      for (const root of new Set([path.resolve(tmpRoot), receiptTmpRoot, path.join(resolveRepoRoot(cwd), "tmp")])) {
        if (findRetirementAfter(root, gate, headSha, emittedAt(original.executionIdentity))) throw new Refusal("original reviewed source round was retired");
      }
    };
    rejectOriginalRetirement();
    const coverageBinding = { coverageProtocol: "pulled_commit_only_v1", siteCoverageDigest: jsonContentDigest(raw.siteCoverage), handbackBytesDigest: sha256(reportBytes), origin };
    assertDeltaClearsFullPhase({ tmpRoot, headSha, delta: delta.parsed, candidateHead, coverageBinding });
    const runtime = { env, ghCommand, runChild };
    const parsed = await captureParsedReviewThreads({ repo, pr }, runtime), login = await resolveAuthenticatedLogin(runtime);
    const actFingerprints = new Set(source.parsed.map((item) => item.fingerprint));
    const threadBindings = [...new Set([...parsed.threads.map((thread) => thread.id), ...parsed.comments.map((comment) => comment.threadId)])].flatMap((threadId) => {
      const { members } = selectActThreadBinding(parsed, threadId, login, actFingerprints);
      return members.length ? [{ threadId, fingerprints: members }] : [];
    });
    completion = { headSha: candidateHead, fixingCommitSha: raw.headSha, siteCoverage: raw.siteCoverage, threadBindings, origin };
    const inputPath = path.join(dir, executionIdentity, "completion-input.json"), bytes = Buffer.from(`${JSON.stringify(completion, null, 2)}\n`);
    await capture.write(inputPath, bytes);
    completionRead = { kind: "completion-input", path: inputPath, required: true, sha256: sha256(bytes), bytes: bytes.length };
  }

  const contracts = await Promise.all(FIXER_CONTRACTS.map(async (rel) => ({ path: rel, digest: sha256(await readFile(new URL(rel, PACKAGE_ROOT))) })));
  const { config, errors } = await loadDevLoopConfig({ repoRoot: resolveRepoRoot(cwd) });
  if (errors?.length > 0) throw new Refusal(`dev-loops config is invalid; fix it before emitting: ${errors.map((e) => e?.message ?? String(e)).join("; ")}`);
  const outputRef = path.join(dir, executionIdentity, "fixer-disposition.json");
  const workOrder = {
    role: "fixer",
    target: { repo, pr: Number(pr) },
    operation: "fix",
    headSha: candidateHead,
    phase,
    source: source.read.kind,
    gate: actListFile ? gate : undefined,
    configSha256: sha256(JSON.stringify(config ?? {})),
    authority: { sourceDigest: jsonContentDigest(source.parsed), deltaResultDigest: delta ? jsonContentDigest(delta.parsed) : undefined,
      ...(completion ? { reviewBaselineHead: headSha, completionInputDigest: jsonContentDigest(completion), completionInputBytesDigest: completionRead.sha256 } : {}) },
    mutationAuthority: { repo, pr: Number(pr), branch: prState.headRefName, allowedPaths: paths },
    contracts,
    requiredReads: [source.read, ...(delta ? [delta.read] : []), ...(completionRead ? [completionRead] : [])],
    outputRefs: [outputRef],
    siteCoverage: actListFile && !completion ? buildSiteCoverageSkeleton(source.parsed) : undefined,
    handbackCheck: phase === "commit_only" && actListFile
      ? `dev-loops-run scripts/loop/check-pre-push-delta.mjs --act-list ${JSON.stringify(abs(actListFile))} --baseline ${headSha} --spec-identity fixer-handback --handback --site-coverage ${JSON.stringify(outputRef)}`
      : undefined,
    executionRules: {
      contract: fileURLToPath(new URL("agents/fixer.agent.md", PACKAGE_ROOT)),
      phase,
      validation: VALIDATION_RULE,
      mutation: "After a successful pull, before reading any relative contract or source path, run `git worktree list --porcelain` in the current repository. Match a `branch` record literally to `refs/heads/` plus mutationAuthority.branch (no pattern or shell evaluation); require exactly one matching checked-out worktree and an absolute `worktree` root, otherwise stop and report the refusal. Use that absolute root as the explicit cwd of every subsequent tool call/subprocess (or resolve each repo-relative source path against it); the pull subprocess does not change later tool-call cwd. Do not create or switch worktrees or invent a root. A permission or classifier denial stops this actor immediately: no subsequent read, verification or alternate-command attempt; report the denial. Before verification, use normal file-read tools or `cat`; qualify digest-tool availability with `command -v shasum` and stop if unavailable. Follow OPS-NO-INLINE-INTERPRETER in skills/docs/copilot-loop-operations.md: no inline Python or Node for this bootstrap. Derive the emitting toolchain root from the absolute `executionRules.contract` by removing its `agents/fixer.agent.md` suffix; resolve `contracts[].path` only against that emitting toolchain root, never the mutation worktree or a searched fallback. The root is local material bound by the pull's rendered-byte integrity check; relative contract paths and digests retain semantic identity. Verify every contract/source digest with direct `shasum -a 256` on those exact paths, then read every required contract/source in full. If tool output is truncated, read bounded ranges separately and do not proceed until every required read is complete. Under Codex, after the pinned contracts are verified and read, apply OPS-CODEX-RUNTIME-SETUP in skills/docs/copilot-loop-operations.md from that emitting toolchain root. Keep every contract/source hash, branch, allowed-path and phase check. Mutate only files under mutationAuthority.allowedPaths on mutationAuthority.branch",
      regenerate: existsSync(path.join(resolveRepoRoot(cwd), "scripts/claude/generate-claude-assets.mjs")) ? REGENERATE_RULE : undefined,
    },
  };
  const identityTriple = {
    workOrderRef: `fixer:${repo}#${pr}:${candidateHead}:${executionIdentity}`,
    workOrderDigest: workOrderDigest(workOrder),
    executionIdentity,
  };
  const dispatchPrompt = buildDispatchPointer(identityTriple);
  if (completion) assertFixerReviewBaseline(workOrder, new Map(await Promise.all(workOrder.requiredReads.map(async (read) => [read, await capture.read(read.path)]))));
  const text = renderWorkOrder(workOrder);
  const promptPath = path.join(dir, "work-orders", `${executionIdentity}.md`);
  await capture.write(promptPath, text);
  await writeExecutionIndex(tmpRoot, identityTriple);
  const plan = { ...identityTriple, materializationHash: materializationHash(text), promptPath, dispatchPrompt, workOrder };
  // Atomic: a concurrent pull never reads a half-written plan. One plan per PR names the only current unit.
  const tempPath = `${planPath}.tmp-${executionIdentity}`;
  await capture.write(tempPath, `${JSON.stringify(plan, null, 2)}\n`);
  await capture.recheck();
  rejectOriginalRetirement();
  recheckCandidate();
  await rename(tempPath, planPath);
  // PRE-PUSH-DELTA-PUSH-AUTHORITY: written last so a refused emit never grants the push; only a full work order grants the fixer.
  // Always under the canonical gate-artifact root (the location the push-authority check reads), whatever --tmp-root says.
  writeSequenceMarker({ tmpRoot: resolveGateArtifactTmpRoot(cwd), baselineHead: headSha, fullGranted: phase === "full", branch: prState.headRefName });
  return { ...plan, planPath };
  } finally { await capture.release(); }
}

/**
 * The Claude fixer agent type for the checkout at `cwd`. A dev-loops source checkout
 * (the `.claude/bin/dev-loops-run` isCheckout rule: package.json name "dev-loops" plus a
 * sibling scripts/) resolves its repo-local `fixer`; any other repo resolves the plugin
 * install's `dev-loops:fixer`. The hooks accept both through normalizeAgentType.
 */
export function claudeFixerAgentType(cwd = process.cwd(), env = process.env) {
  // A launcher-rendered `fixer` replaces only the bare name; the hooks deny the namespaced type then.
  if ((env.DEVLOOPS_AGENT_OVERRIDES ?? "").split(",").map((role) => role.trim()).includes("fixer")) return "fixer";
  const root = resolveRepoRoot(cwd);
  try {
    if (existsSync(path.join(root, "scripts")) && JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).name === "dev-loops") return "fixer";
  } catch { /* no readable package.json: not a source checkout */ }
  return "dev-loops:fixer";
}

// Each adapter carries the fixed pointer and its tool's required routing fields.
const FIXER_DISPATCH_ADAPTERS = {
  claude: (prompt, cwd) => ({ subagent_type: claudeFixerAgentType(cwd), description: "fixer work order", prompt }),
  pi: (prompt) => ({ agent: "fixer", task: prompt }),
  codex: (message, _cwd, executionIdentity) => {
    if (typeof executionIdentity !== "string" || !/^f\d+-[0-9a-f]{8}$/.test(executionIdentity) || executionIdentity.trim() !== executionIdentity) {
      throw new WorkOrderRefusal("invalid_execution_identity", "Codex fixer execution identity must be f<digits>-<8 lowercase hex>");
    }
    return { task_name: `fixer_${executionIdentity.replaceAll("-", "_")}`, message, fork_turns: "none" };
  },
};

function fixerDispatchAdapter(harness) {
  const adapter = Object.hasOwn(FIXER_DISPATCH_ADAPTERS, harness) ? FIXER_DISPATCH_ADAPTERS[harness] : null;
  if (!adapter) throw new WorkOrderRefusal("unsupported_adapter", `harness ${JSON.stringify(harness)} has no fixer dispatch adapter; supported: ${Object.keys(FIXER_DISPATCH_ADAPTERS).join(", ")}`);
  return adapter;
}

/** The harness adapter payload for a fixer dispatch; any other harness refuses (never legacy prose). */
export function buildFixerDispatchPayload({ harness, plan, cwd = process.cwd() }) {
  return fixerDispatchAdapter(harness)(plan.dispatchPrompt, cwd, plan.executionIdentity);
}

/** Refuses a payload that is not exactly the harness adapter payload for the plan's pointer (same keys, same values). */
export function assertFixerDispatchPayload({ harness, payload, plan, cwd = process.cwd() }) {
  const expected = buildFixerDispatchPayload({ harness, plan: { executionIdentity: plan.executionIdentity, dispatchPrompt: buildDispatchPointer(plan) }, cwd });
  const keys = Object.keys(expected);
  if (Object.keys(payload ?? {}).length !== keys.length || keys.some((key) => !Object.hasOwn(payload, key) || payload[key] !== expected[key])) {
    throw new WorkOrderRefusal("dispatch_payload_mismatch", `the ${harness} fixer dispatch must be ${JSON.stringify(expected)} unchanged`);
  }
}

const emittedAt = (executionIdentity) => Number(/^f(\d+)-/.exec(executionIdentity ?? "")?.[1]) || 0;

function completeAdmissionError(order) {
  const reads = Array.isArray(order.requiredReads) ? order.requiredReads : [];
  const ofKind = (kind) => reads.filter((read) => read?.kind === kind);
  const required = (kind) => ofKind(kind).length === 1 && ofKind(kind)[0].required === true;
  const digest = (key) => /^[a-f0-9]{64}$/.test(order.authority?.[key] ?? "");
  if (order.phase !== "full" || !Array.isArray(order.mutationAuthority?.allowedPaths) || order.mutationAuthority.allowedPaths.length) return "complete requires full phase and empty source selectors";
  if (typeof order.mutationAuthority.branch !== "string" || !order.mutationAuthority.branch.trim()
    || !Array.isArray(order.outputRefs) || order.outputRefs.length !== 1 || typeof order.outputRefs[0] !== "string"
    || typeof order.executionRules?.contract !== "string" || typeof order.executionRules.validation !== "string") return "complete requires branch, single output and execution rules";
  if (!["act-list", "threads"].includes(order.source) || !required(order.source)
    || ofKind(order.source === "act-list" ? "threads" : "act-list").length || !digest("sourceDigest")) return "complete requires exactly one authenticated ACT or THREAD source";
  if (order.source === "act-list") {
    if (!required("delta-result") || !digest("deltaResultDigest") || !required("completion-input")
      || !digest("completionInputDigest") || !digest("completionInputBytesDigest")) return "complete ACT requires required Delta/completion input and semantic/byte authorities";
  } else if (ofKind("completion-input").length || ["completionInputDigest", "completionInputBytesDigest", "reviewBaselineHead"].some((key) => Object.hasOwn(order.authority ?? {}, key))) return "complete THREAD refuses ACT/completion-input authority";
  return null;
}

// Fixer adapter. The PR's one plan names the current unit; an older ref is superseded.
// A changed or vanished required read, a retired gate round (act-list source), or an
// authority branch that no longer contains the head makes the unit stale.
/** The emit plan path for a fixer ref under `tmpRoot`, or null when the ref is not a fixer ref. */
export function fixerPlanPath(ref, tmpRoot) {
  const match = FIXER_REF_RE.exec(ref);
  return match ? path.join(buildFixerDir({ repo: match[1], pr: match[2], tmpRoot }), PLAN_FILE) : null;
}

export async function locateFixerUnit({ ref, cwd, tmpRoots }) {
  const match = FIXER_REF_RE.exec(ref);
  if (!match) return null;
  const [, repo, pr, headSha, executionIdentity] = match;
  try { buildFixerDir({ repo, pr, tmpRoot: "tmp" }); } catch { return null; }
  let own = null;
  let newest = null;
  for (const tmpRoot of tmpRoots) {
    const planPath = path.join(buildFixerDir({ repo, pr, tmpRoot }), PLAN_FILE);
    const plan = await readJson(planPath).catch((err) => {
      if (!(err instanceof SyntaxError)) throw err;
      throw new WorkOrderRefusal("local_materialization_integrity_failure", `fixer emit plan ${planPath} is not valid JSON; re-emit the fixer work order, never hand-repair the plan`);
    });
    if (!plan) continue;
    if (!newest || emittedAt(plan.executionIdentity) > emittedAt(newest.executionIdentity)) newest = plan;
    if (plan.workOrderRef === ref) own ??= { plan, planPath };
  }
  if (!own) {
    return newest && emittedAt(executionIdentity) <= emittedAt(newest.executionIdentity)
      ? { stale: `fixer ref ${ref} was superseded by ${newest.workOrderRef}` } : null;
  }
  const { plan, planPath } = own;
  if (newest.workOrderRef !== ref) return { stale: `fixer ref ${ref} was superseded by ${newest.workOrderRef}` };
  const order = plan.workOrder ?? {};
  if (order.operation === "complete") {
    const error = completeAdmissionError(order);
    if (error) return { stale: error };
  }
  const changed = [];
  const bytesByRead = new Map();
  for (const read of order.requiredReads ?? []) {
    const bytes = await readFile(read.path).catch(() => null);
    bytesByRead.set(read, bytes);
    if (bytes === null || sha256(bytes) !== read.sha256) changed.push(read.kind);
  }
  if (order.operation === "complete") {
    try {
      for (const [kind, authority] of [[order.source, "sourceDigest"], ...(order.source === "act-list" ? [["delta-result", "deltaResultDigest"], ["completion-input", "completionInputDigest"]] : [])]) {
        const read = order.requiredReads.find((entry) => entry.kind === kind), bytes = bytesByRead.get(read);
        if (!bytes || sha256(bytes) !== read.sha256 || bytes.length !== read.bytes
          || jsonContentDigest(JSON.parse(bytes)) !== order.authority[authority]
          || kind === "completion-input" && sha256(bytes) !== order.authority.completionInputBytesDigest) return { stale: `complete ${kind} differs from its semantic or exact-byte authority` };
      }
    } catch { return { stale: "complete source is unreadable or invalid JSON" }; }
  }
  let baseline;
  try { baseline = assertFixerReviewBaseline(order, bytesByRead); }
  catch (error) { return { stale: error.message }; }
  let retired = null;
  if (order.source === "act-list") {
    for (const head of new Set([headSha, ...(baseline ? [baseline.reviewBaselineHead] : [])])) {
      for (const tmpRoot of tmpRoots) retired ??= await findRetirementAfter(tmpRoot, order.gate, head, emittedAt(executionIdentity));
    }
  }
  const branch = order.mutationAuthority?.branch;
  let contained = false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", headSha, `refs/heads/${branch}`], { cwd, stdio: "ignore", env: gitEnvNoDirOverrides() });
    contained = true;
  } catch { /* missing branch or head, or a reset/rewritten branch: stale authority */ }
  const stale = (changed.length > 0 && `required fixer source(s) ${changed.join(", ")} changed or vanished since emission; re-emit against current authority`)
    || (retired && `fixer execution ${executionIdentity} belongs to a ${order.gate} round at ${headSha} retired as ${retired}`)
    || (!contained && `authority branch ${branch} no longer contains head ${headSha}; refresh the PR state and re-emit`);
  // The integrity hash is recomputed from the order, never the plan's copied field (as the judge adapter does).
  let rendered = null;
  try { rendered = materializationHash(renderWorkOrder(order)); } catch { /* malformed order: fails the integrity check */ }
  return {
    ...plan,
    materializationHash: rendered,
    materializationPath: plan.promptPath,
    subject: { repo, pr: Number(pr), headSha, branch, phase: order.phase, planPath },
    stale: stale || undefined,
  };
}

registerWorkOrderRole("fixer", {
  locate: locateFixerUnit,
  validate: (order) => {
    if (order.operation === "complete") return completeAdmissionError(order);
    const kinds = new Set((Array.isArray(order.requiredReads) ? order.requiredReads : []).map((read) => read?.kind));
    return !kinds.has("act-list") && !kinds.has("threads") ? "fixer work order has no act-list or threads required read"
      : typeof order.mutationAuthority?.branch !== "string" ? "fixer work order names no mutation authority branch"
        : !Array.isArray(order.mutationAuthority.allowedPaths) || order.mutationAuthority.allowedPaths.length === 0 ? "fixer work order names no allowed paths"
          : !Array.isArray(order.outputRefs) || order.outputRefs.length !== 1 ? "fixer work order names no single disposition outputRef"
            : typeof order.executionRules?.validation !== "string" ? "fixer work order states no validation rule"
              : null;
  },
});

export async function main(argv = process.argv.slice(2), { cwd = process.cwd(), fetchPr } = {}) {
  const { values } = parseArgs({ args: argv, options: {
    repo: { type: "string" }, pr: { type: "string" }, "head-sha": { type: "string" }, phase: { type: "string" },
    "act-list-file": { type: "string" }, gate: { type: "string" }, "threads-file": { type: "string" },
    "delta-result": { type: "string" }, "allowed-path": { type: "string", multiple: true },
    "tmp-root": { type: "string" }, harness: { type: "string" }, help: { type: "boolean", short: "h" },
    ...JQ_OUTPUT_PARSE_OPTIONS,
  } });
  if (values.help) {
    process.stdout.write(`${USAGE}\n\n${JQ_OUTPUT_USAGE}\n`);
    return 0;
  }
  const required = ["repo", "pr", "head-sha", "phase", "harness"].filter((key) => !values[key]);
  if (required.length > 0) {
    process.stderr.write(`missing --${required.join(", --")}\n${USAGE}\n`);
    return 2;
  }
  const jqSyntaxError = preflightJqFilter(values.jq);
  if (jqSyntaxError !== undefined) return jqSyntaxError;
  if (values["tmp-root"]) assertTmpRootOutsideLinkedWorktree(path.resolve(cwd, values["tmp-root"]), resolveRepoRoot(cwd));
  const emit = (payload) => emitResult(payload, { jq: values.jq, silent: values.silent, fields: values.fields });
  try {
    fixerDispatchAdapter(values.harness); // refuse an unknown harness before emitting
    const plan = await emitFixerWorkOrder({
      repo: values.repo, pr: values.pr, headSha: values["head-sha"].toLowerCase(), phase: values.phase,
      actListFile: values["act-list-file"], gate: values.gate, threadsFile: values["threads-file"],
      deltaResult: values["delta-result"], allowedPaths: values["allowed-path"] ?? [], cwd,
      ...(values["tmp-root"] ? { tmpRoot: path.resolve(cwd, values["tmp-root"]) } : {}),
      ...(fetchPr ? { fetchPr } : {}),
    });
    const { workOrderRef, workOrderDigest: digest, executionIdentity, dispatchPrompt, planPath } = plan;
    const dispatchPayload = buildFixerDispatchPayload({ harness: values.harness, plan, cwd });
    return emit({ ok: true, workOrderRef, workOrderDigest: digest, executionIdentity, dispatchPrompt, dispatchPayload, planPath });
  } catch (err) {
    if (!(err instanceof Refusal || err instanceof WorkOrderRefusal)) throw err;
    return emit({ ok: false, ...(err.refusal ? { refusal: err.refusal } : {}), error: err.message });
  }
}

if (isDirectCliRun(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 2;
  }
}
