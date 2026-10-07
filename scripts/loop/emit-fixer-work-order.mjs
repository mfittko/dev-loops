#!/usr/bin/env node
/**
 * Fixer role of the work-order pull protocol (ADR 0106): the deterministic
 * producer of the fixer's work order and the `fixer` role adapter that
 * pull-work-order.mjs selects by the ref's `fixer:` prefix. Serializer, envelope,
 * reader and receipt stay in _work-order-protocol.mjs.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadDevLoopConfig } from "@dev-loops/core/config";
import { VALID_SEVERITIES } from "@dev-loops/core/loop/gate-fanin";
import { findRetirementAfter } from "@dev-loops/core/loop/gate-round-retirement";
import { startDeltaSequence, toDeltaActItems, validateDeltaResult } from "@dev-loops/core/loop/pre-push-delta-review";
import { formatCliError, isDirectCliRun, readJsonIfExists as readJson } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, preflightJqFilter } from "../lib/jq-output.mjs";
import { WorkOrderRefusal, buildDispatchPointer, materializationHash, registerWorkOrderRole, workOrderDigest, writeExecutionIndex } from "../github/_work-order-protocol.mjs";
import { repoSlugFor } from "../github/_gate-artifact-paths.mjs";
import { GATE_NAMES } from "../github/_gate-names.mjs";
import { renderRequiredReadLine } from "../github/write-gate-context.mjs";
import { DELTA_CLEARING_NEXT_STEPS, gateDeltaRecordPath, readGateDeltaRecord } from "./_gate-delta-record.mjs";
import { assertTmpRootOutsideLinkedWorktree, gitEnvNoDirOverrides, resolveGateArtifactTmpRoot, resolveRepoRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: emit-fixer-work-order.mjs --harness <claude|pi> --repo <owner/name> --pr <n> --head-sha <sha> --phase <commit_only|full> (--act-list-file <path> --gate <draft_gate|pre_approval_gate> | --threads-file <path>) [--delta-result <path>] [--allowed-path <repo-relative path>]... [--tmp-root <path>]
Derives the fixer's work order from typed sources: the gate act list (judge-pass --out)
or the unresolved review threads (list-review-threads.mjs --unresolved-only), plus the
optional pre-push delta result (dev-loops loop pre-push-delta). --phase full needs a clearing
delta decision for the head: an act-list source passes the clearing --delta-result, a
threads source needs a thread-bound clearing record under <tmp-root>/gate-delta/ (written by
check-pre-push-delta --result), and any non-clearing record for the head refuses; use
--phase commit_only first. The mutation authority is
the PR's own head branch (gh pr view headRefName) and the --allowed-path selectors
(default "." = the whole repository). A PR head other than --head-sha refuses.
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
const FIXER_CONTRACTS = ["agents/fixer.agent.md", "skills/docs/gate-review-sub-loop-contract.md", "skills/docs/validation-policy.md"];
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

async function readSource(kind, filePath) {
  const bytes = await readFile(filePath).catch(() => null);
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

const SKELETON_STATUS = "fixed|skipped";

/**
 * The pre-filled `siteCoverage` of a commit_only handback, one record per act item.
 * The sites are the ones the act item already names (stated surfaces and input forms);
 * the fixer fills each site's `status` (and `reason` for a skip, `test` for a fixed input form).
 * An item with no named site, or no siteQuery, carries a `noSitesReason` the fixer keeps or replaces
 * with `returnedSites` and `sites` after it runs the siteQuery.
 */
export function buildSiteCoverageSkeleton(actList) {
  return toDeltaActItems(actList).map((item) => {
    const fingerprint = item.fingerprint ?? item.ref;
    if (!item.siteQuery) return { fingerprint, noSitesReason: "the act item carries no siteQuery" };
    const sites = [
      ...(item.statedSurfaces ?? []).map((site) => ({ site, status: SKELETON_STATUS, reason: "" })),
      ...[...(item.acceptedForms ?? []), ...(item.rejectedForms ?? [])].map((site) => ({ site, kind: "input_form", status: SKELETON_STATUS, reason: "", test: "" })),
    ];
    if (sites.length === 0) return { fingerprint, noSitesReason: "FILL: run the siteQuery; keep this reason if it returns nothing, else replace it with returnedSites and sites" };
    return { fingerprint, returnedSites: sites.map((s) => s.site), sites };
  });
}

export function renderWorkOrder(workOrder) {
  const [dispositionPath] = workOrder.outputRefs;
  // headRefName is PR-supplied: JSON-quote it (and paths) so a backtick cannot close a span and inject prose.
  const { branch, allowedPaths } = workOrder.mutationAuthority;
  const task = workOrder.phase === "commit_only"
    ? `Apply the fixes the source read names, per agents/fixer.agent.md, and commit them. Hand back the commit SHA unpushed: no push, no thread replies. Write no disposition handoff. Write the site coverage record \`{ headSha, siteCoverage: [{ fingerprint, returnedSites, sites, ruleCitations?, noSitesReason? }] }\` (headSha = your commit) to \`${dispositionPath}\`, one entry per act item that has a siteQuery. Start from the \`siteCoverage\` skeleton in the work order JSON below: set each site's \`status\` to \`fixed\` or \`skipped\`, add a \`reason\` to every skip and a \`test\` to every fixed \`input_form\` site, and change nothing else except replacing each \`FILL:\` noSitesReason with the outcome of running that act item's siteQuery.`
    : `Apply and commit any fixes not yet committed, then push, reply to and resolve the addressed threads per agents/fixer.agent.md (pass \`--disposition fixed\` and the full 40-character SHA of the fixing commit in each fixed reply), then write the disposition handoff \`{ headSha, dispositions: [...] }\` (headSha = the pushed PR head) to \`${dispositionPath}\`. Also write \`siteCoverage: [{ fingerprint, returnedSites, sites, ruleCitations?, noSitesReason? }]\` in that handoff, one entry per act item that has a siteQuery (threadless items included): verify-fixer-disposition refuses a handoff without it. A threadless act item gets no disposition handoff entry; every entry's \`threadId\` is a review-thread node id.`;
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
function assertDeltaClearsFullPhase({ tmpRoot, headSha, delta, threads }) {
  const recordPath = gateDeltaRecordPath(tmpRoot, headSha);
  const record = readGateDeltaRecord(tmpRoot, headSha);
  const next = "emit --phase commit_only, run the delta review (dev-loops loop pre-push-delta), then emit --phase full";
  if (record && !DELTA_CLEARING_NEXT_STEPS.includes(record.nextStep)) {
    throw new Refusal(`--phase full refused: the delta record ${recordPath} holds nextStep ${JSON.stringify(record.nextStep)}, not ${DELTA_CLEARING_NEXT_STEPS.join(" or ")}; fix and re-run the delta review (${next})`);
  }
  if (!threads) {
    if (!delta) throw new Refusal(`--phase full with --act-list-file needs --delta-result naming a clearing delta result: ${next}`);
    // The decided nextStep in the record for this head clears the push, not the result file's outcome.
    const clears = record && record.candidateHead === delta.candidateHead && record.actSetId === delta.actSetId;
    if (!clears) throw new Refusal(`--phase full refused: no delta record at ${recordPath} holds a clearing nextStep for the --delta-result's candidate and act set; ${next}`);
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
  fetchPr = defaultFetchPr, executionIdentity = `f${Date.now()}-${randomBytes(4).toString("hex")}`,
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

  const source = actListFile ? await readSource("act-list", abs(actListFile)) : await readSource("threads", abs(threadsFile));
  const isActItem = (f) => f?.judgeDisposition === "act" && VALID_SEVERITIES.has(f.severity) && typeof f.summary === "string" && f.summary.trim() !== "";
  if (actListFile && !(Array.isArray(source.parsed) && source.parsed.length > 0 && source.parsed.every(isActItem))) {
    throw new Refusal(`act list ${actListFile} is not a non-empty judge-pass --out array of { judgeDisposition: "act", severity, summary } findings`);
  }
  if (threadsFile && (source.parsed?.ok !== true || !Array.isArray(source.parsed.threads) || source.parsed.repo !== repo || Number(source.parsed.pr) !== Number(pr)
    || !source.parsed.threads.every((thread) => thread?.isResolved === false))) {
    throw new Refusal(`threads file ${threadsFile} is not successful list-review-threads --unresolved-only output for ${repo}#${pr}`);
  }
  if (deltaResult && !actListFile) throw new Refusal("--delta-result applies only to an --act-list-file source");
  const delta = deltaResult ? await readSource("delta-result", abs(deltaResult)) : null;
  if (delta) {
    // The delta result must belong to this act list and this head (its pinned review baseline).
    const errors = validateDeltaResult(delta.parsed, { sequence: startDeltaSequence({ reviewBaselineHead: headSha, actList: source.parsed }), membershipOnly: true });
    if (errors.length > 0) throw new Refusal(`delta result ${deltaResult} does not belong to this act list at ${headSha}: ${errors.join("; ")}`);
  }
  if (phase === "full") assertDeltaClearsFullPhase({ tmpRoot, headSha, delta: delta?.parsed, threads: threadsFile ? source.parsed.threads : null });

  // Mutation authority comes from the PR itself, never from the caller.
  const prState = await fetchPr({ repo, pr });
  if (typeof prState?.headRefName !== "string" || !prState.headRefName) throw new Refusal(`PR ${repo}#${pr} reports no headRefName; mutation authority is missing`);
  if (String(prState.headRefOid ?? "").toLowerCase() !== headSha) throw new Refusal(`PR ${repo}#${pr} head is ${prState.headRefOid}, not --head-sha ${headSha}; conflicting authority, refresh and re-emit`);

  const contracts = await Promise.all(FIXER_CONTRACTS.map(async (rel) => ({ path: rel, digest: sha256(await readFile(new URL(rel, PACKAGE_ROOT))) })));
  const { config, errors } = await loadDevLoopConfig({ repoRoot: resolveRepoRoot(cwd) });
  if (errors?.length > 0) throw new Refusal(`dev-loops config is invalid; fix it before emitting: ${errors.map((e) => e?.message ?? String(e)).join("; ")}`);
  const workOrder = {
    role: "fixer",
    target: { repo, pr: Number(pr) },
    operation: "fix",
    headSha,
    phase,
    source: source.read.kind,
    gate: actListFile ? gate : undefined,
    configSha256: sha256(JSON.stringify(config ?? {})),
    authority: { sourceDigest: jsonContentDigest(source.parsed), deltaResultDigest: delta ? jsonContentDigest(delta.parsed) : undefined },
    mutationAuthority: { repo, pr: Number(pr), branch: prState.headRefName, allowedPaths: paths },
    contracts,
    requiredReads: [source.read, ...(delta ? [delta.read] : [])],
    outputRefs: [path.join(dir, executionIdentity, "fixer-disposition.json")],
    siteCoverage: phase === "commit_only" && actListFile ? buildSiteCoverageSkeleton(source.parsed) : undefined,
    executionRules: {
      contract: "agents/fixer.agent.md",
      phase,
      validation: VALIDATION_RULE,
      mutation: "Mutate only files under mutationAuthority.allowedPaths on mutationAuthority.branch",
      regenerate: existsSync(path.join(resolveRepoRoot(cwd), "scripts/claude/generate-claude-assets.mjs")) ? REGENERATE_RULE : undefined,
    },
  };
  const identityTriple = {
    workOrderRef: `fixer:${repo}#${pr}:${headSha}:${executionIdentity}`,
    workOrderDigest: workOrderDigest(workOrder),
    executionIdentity,
  };
  const dispatchPrompt = buildDispatchPointer(identityTriple);
  const text = renderWorkOrder(workOrder);
  const promptPath = path.join(dir, "work-orders", `${executionIdentity}.md`);
  await mkdir(path.dirname(promptPath), { recursive: true });
  // Immutable per ref: a different payload never replaces an emitted work order.
  try {
    await writeFile(promptPath, text, { flag: "wx" });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    if (await readFile(promptPath, "utf8") !== text) throw new Refusal(`work order ${identityTriple.workOrderRef} already exists with different content; emit a new reference instead`);
  }
  await writeExecutionIndex(tmpRoot, identityTriple);
  const plan = { ...identityTriple, materializationHash: materializationHash(text), promptPath, dispatchPrompt, workOrder };
  const planPath = path.join(dir, PLAN_FILE);
  // Atomic: a concurrent pull never reads a half-written plan. One plan per PR names the only current unit.
  const tempPath = `${planPath}.tmp-${executionIdentity}`;
  await writeFile(tempPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await rename(tempPath, planPath);
  return { ...plan, planPath };
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

// The checked dispatch seam per harness: the adapter payload carries the fixed pointer only
// (plus the fixed `description` the Claude Agent tool requires).
const FIXER_DISPATCH_ADAPTERS = {
  claude: (prompt, cwd) => ({ subagent_type: claudeFixerAgentType(cwd), description: "fixer work order", prompt }),
  pi: (prompt) => ({ agent: "fixer", task: prompt }),
};

/** The harness adapter payload for a fixer dispatch; any other harness refuses (never legacy prose). */
export function buildFixerDispatchPayload({ harness, plan, cwd = process.cwd() }) {
  const adapter = Object.hasOwn(FIXER_DISPATCH_ADAPTERS, harness) ? FIXER_DISPATCH_ADAPTERS[harness] : null;
  if (!adapter) throw new WorkOrderRefusal("unsupported_adapter", `harness ${JSON.stringify(harness)} has no fixer dispatch adapter; supported: ${Object.keys(FIXER_DISPATCH_ADAPTERS).join(", ")}`);
  return adapter(plan.dispatchPrompt, cwd);
}

/** Refuses a payload that is not exactly the harness adapter payload for the plan's pointer (same keys, same values). */
export function assertFixerDispatchPayload({ harness, payload, plan, cwd = process.cwd() }) {
  const expected = buildFixerDispatchPayload({ harness, plan: { dispatchPrompt: buildDispatchPointer(plan) }, cwd });
  const keys = Object.keys(expected);
  if (Object.keys(payload ?? {}).length !== keys.length || keys.some((key) => payload[key] !== expected[key])) {
    throw new WorkOrderRefusal("dispatch_payload_mismatch", `the ${harness} fixer dispatch must be ${JSON.stringify({ ...expected, [keys.at(-1)]: "<the compact pointer>" })} unchanged`);
  }
}

const emittedAt = (executionIdentity) => Number(/^f(\d+)-/.exec(executionIdentity ?? "")?.[1]) || 0;

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
  const changed = [];
  for (const read of order.requiredReads ?? []) {
    const bytes = await readFile(read.path).catch(() => null);
    if (bytes === null || sha256(bytes) !== read.sha256) changed.push(read.kind);
  }
  let retired = null;
  if (order.source === "act-list") {
    for (const tmpRoot of tmpRoots) retired ??= await findRetirementAfter(tmpRoot, order.gate, headSha, emittedAt(executionIdentity));
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
    buildFixerDispatchPayload({ harness: values.harness, plan: {} }); // refuse an unknown harness before emitting
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
