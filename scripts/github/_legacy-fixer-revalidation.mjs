import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "@dev-loops/core/loop/review-dispatch-plan";
import { findRetirementAfter } from "@dev-loops/core/loop/gate-round-retirement";
import { normalizeFixerDispositionHandoff, siteCoverageGaps } from "@dev-loops/core/loop/fixer-disposition";
import { startDeltaSequence, toDeltaActItems, validateDeltaResult } from "@dev-loops/core/loop/pre-push-delta-review";
import { gitEnvNoDirOverrides, listWorktreeEntries } from "../loop/_repo-root-resolver.mjs";
import { gateDeltaRecordPath } from "../loop/_gate-delta-record.mjs";
import { repoSlugFor } from "./_gate-artifact-paths.mjs";
import { authenticateOriginalPlan } from "./_fixer-emission-evidence.mjs";
import { verifyPulledResult, workOrderDigest } from "./_work-order-protocol.mjs";

const PATTERN = "readValidationEvidence|requireBinding|validationResultsPath|prefix-file";
const HEX = /^[a-f0-9]{64}$/;
const keys = (value, names) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join() === names.split(",").sort().join();
const refuse = (message) => { throw new Error(`legacy revalidation: ${message}`); };
const digest = (bytes) => sha256Hex(bytes).slice(7);

function nativeGit(args, cwd) {
  const result = spawnSync("git", args, { cwd, env: nativeGitEnv(), timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.signal || result.status !== 0 || result.stderr?.length) refuse(`bounded native Git failed (${result.status}, ${result.signal}): ${result.stderr ?? ""}`);
  return result.stdout;
}

function nativeGitEnv() {
  const env = { ...gitEnvNoDirOverrides(), GIT_NO_REPLACE_OBJECTS: "1" };
  for (const key of ["GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]) delete env[key];
  Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "grep.column", GIT_CONFIG_VALUE_0: "false" });
  return env;
}

function queryLegacySites({ repoRoot, candidate, branch }) {
  const cwd = nativeGit(["rev-parse", "--show-toplevel"], repoRoot).toString().trim();
  if (!path.isAbsolute(cwd)) refuse("Git returned no absolute repository root");
  let treeOid;
  const current = () => {
    const head = nativeGit(["rev-parse", "--verify", `refs/heads/${branch}`], cwd).toString().trim();
    const tree = nativeGit(["rev-parse", "--verify", `${candidate}^{tree}`], cwd).toString().trim();
    if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(tree) || head !== candidate || (treeOid && tree !== treeOid)) refuse("authority branch or candidate tree changed");
    treeOid = tree;
  };
  current();
  const bytes = nativeGit(["--no-pager", "-c", "color.ui=never", "grep", "-n", "-E", PATTERN, candidate, "--"], cwd);
  const text = bytes.toString("utf8");
  if (!bytes.length || !text.endsWith("\n") || !Buffer.from(text).equals(bytes)) refuse("incomplete or changed query output bytes");
  const files = new Set();
  for (const row of text.slice(0, -1).split("\n")) {
    const match = /^([a-f0-9]+):([^:\r\n\0]+):([1-9]\d*):[^\r\n]*$/.exec(row);
    const file = match?.[2];
    if (!match || match[1] !== candidate || file.includes("\\") || path.posix.isAbsolute(file)
      || path.posix.normalize(file) !== file || file.split("/").some((part) => part === ".." || part === ".git")) refuse("malformed or unsupported query row");
    files.add(file);
  }
  current();
  return { files, treeOid, queryOutputBytesDigest: digest(bytes) };
}

export async function revalidateLegacyCompletion({ completion, plan, planPath, priorBytes, actList, delta, decision, receiptTmpRoot, repoRoot }) {
  const activeBytes = await readFile(planPath);
  if (sha256Hex(JSON.parse(activeBytes)) !== sha256Hex(plan)) refuse("current canonical plan was superseded");
  const legacy = completion.legacyRevalidation;
  if (!keys(legacy, "origin,originalFull,handbackBytesDigest,clearingDecisionBytesDigest,treeOid,queryOutputBytesDigest")
    || legacy.origin !== "legacy_revalidated" || !keys(legacy.originalFull, "workOrderRef,workOrderDigest,executionIdentity,planBytesDigest")
    || ![legacy.handbackBytesDigest, legacy.clearingDecisionBytesDigest, legacy.queryOutputBytesDigest, legacy.originalFull.planBytesDigest].every((value) => typeof value === "string" && HEX.test(value))
    || !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(legacy.treeOid ?? "")) refuse("malformed explicit legacy authority");
  const observed = await validateLegacyCompletion({ completion, plan, planPath, priorBytes, actList, delta, decision, receiptTmpRoot, repoRoot }, activeBytes, legacy);
  if (observed.treeOid !== legacy.treeOid || observed.queryOutputBytesDigest !== legacy.queryOutputBytesDigest) refuse("authority branch or candidate tree changed, or changed query output bytes");
}

export async function prepareLegacyCompletion({ prospectivePlan: plan, originalFullBytes, ...args }) {
  if (!(await readFile(args.planPath)).equals(originalFullBytes)) refuse("original canonical plan was superseded");
  const old = JSON.parse(originalFullBytes);
  const legacy = { origin: "legacy_revalidated", originalFull: { workOrderRef: old.workOrderRef, workOrderDigest: old.workOrderDigest,
    executionIdentity: old.executionIdentity, planBytesDigest: digest(originalFullBytes) }, handbackBytesDigest: digest(args.priorBytes),
    clearingDecisionBytesDigest: digest(await readFile(gateDeltaRecordPath(args.receiptTmpRoot, args.delta.reviewBaselineHead))) };
  const observed = await validateLegacyCompletion({ ...args, plan }, originalFullBytes, legacy);
  return { ...legacy, ...observed };
}

async function validateLegacyCompletion({ completion, plan, planPath, priorBytes, actList, delta, decision, receiptTmpRoot, repoRoot }, activeBytes, legacy) {
  if ([delta, decision].some((value) => ["siteCoverageDigest", "coverageProtocol", "handbackBytesDigest", "origin"].some((key) => Object.hasOwn(value, key)))) refuse("partial or current coverage binding cannot downgrade");
  if (delta.outcome !== "locally_clear" || decision.outcome !== "locally_clear" || decision.nextStep !== "push"
    || delta.candidateHead !== completion.headSha || delta.actionableItems.some((item) => item.status !== "resolved")) refuse("legacy requires fresh locally clear unchanged candidate and resolved members");
  const sequence = startDeltaSequence({ reviewBaselineHead: delta.reviewBaselineHead, actList });
  const pairs = (items) => items.map(({ ref, status }) => JSON.stringify([ref, status])).sort().join("\n");
  if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(delta.reviewBaselineHead ?? "") || validateDeltaResult(delta, { sequence, membershipOnly: true }).length
    || decision.reviewBaselineHead !== delta.reviewBaselineHead || decision.actSetId !== sequence.actSetId
    || decision.candidateHead !== completion.headSha || !Array.isArray(decision.items)
    || pairs(decision.items) !== pairs(delta.actionableItems)) refuse("clearing decision baseline, act set, candidate or statuses changed");
  const order = plan.workOrder;
  if (order?.role !== "fixer" || order.phase !== "full" || order.headSha !== completion.headSha
    || !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(order.headSha ?? "") || typeof order.mutationAuthority?.branch !== "string" || !order.mutationAuthority.branch.trim()
    || workOrderDigest(order) !== plan.workOrderDigest
    || plan.workOrderRef !== `fixer:${order.target?.repo}#${order.target?.pr}:${order.headSha}:${plan.executionIdentity}`) refuse("prospective full identity or digest mismatch");
  const canonical = path.join(await realpath(receiptTmpRoot), "gate-fixer", repoSlugFor(order.target.repo), `pr-${order.target.pr}`, "fixer-emit-plan.json");
  if (await realpath(planPath) !== canonical) refuse("current plan is not the canonical main plan");
  const output = order.outputRefs?.[0];
  if (order.outputRefs?.length !== 1 || typeof output !== "string"
    || path.relative(path.dirname(path.dirname(output)), output) !== path.join(plan.executionIdentity, "fixer-disposition.json")
    || await realpath(path.dirname(path.dirname(output))) !== path.dirname(canonical)) refuse("prospective output is not execution-derived");
  if (!(await readFile(canonical)).equals(activeBytes)) refuse("current canonical plan was superseded");
  const original = legacy.originalFull;
  if (!keys(completion.origin, "workOrderRef,workOrderDigest,executionIdentity")) refuse("original commit-only identity must retain its exact triple");
  const emitted = (identity) => Number(/^f(\d+)-[a-f0-9]{8}$/.exec(identity)?.[1]);
  if (!Number.isSafeInteger(emitted(original.executionIdentity)) || !Number.isSafeInteger(emitted(plan.executionIdentity))
    || emitted(original.executionIdentity) >= emitted(plan.executionIdentity) || original.executionIdentity === completion.origin.executionIdentity
    || original.workOrderRef !== `fixer:${order.target.repo}#${order.target.pr}:${delta.reviewBaselineHead}:${original.executionIdentity}`
    || !/^sha256:[a-f0-9]{64}$/.test(original.workOrderDigest ?? "")) refuse("original full identity is not distinct and older");
  const directory = path.dirname(canonical);
  const archive = await readFile(path.join(directory, original.executionIdentity, "original-fixer-emit-plan.json"));
  if (digest(archive) !== original.planBytesDigest) refuse("original full archive bytes changed");
  if (sha256Hex(JSON.parse(activeBytes)) !== sha256Hex(plan) && !archive.equals(activeBytes)) refuse("original full archive differs from captured active bytes");
  const old = JSON.parse(archive);
  const oldOrder = old.workOrder;
  if (["workOrderRef", "workOrderDigest", "executionIdentity"].some((key) => old[key] !== original[key])
    || oldOrder?.role !== "fixer" || oldOrder.phase !== "full"
    || oldOrder.source !== "act-list" || order.source !== "act-list" || oldOrder.gate !== order.gate
    || oldOrder.target?.repo !== order.target.repo || oldOrder.target?.pr !== order.target.pr
    || oldOrder.headSha !== delta.reviewBaselineHead || oldOrder.mutationAuthority?.branch !== order.mutationAuthority?.branch) refuse("original full archive identity or authority mismatch");
  await authenticateOriginalPlan({ plan: old, canonical, receiptTmpRoot: await realpath(receiptTmpRoot), requireReceipt: true });
  const origin = completion.origin;
  const originDir = path.join(directory, origin.executionIdentity);
  const originPath = path.join(originDir, "fixer-disposition.json");
  if (!/^f\d+-[a-f0-9]{8}$/.test(origin.executionIdentity) || origin.executionIdentity === plan.executionIdentity
    || origin.workOrderRef !== `fixer:${order.target.repo}#${order.target.pr}:${delta.reviewBaselineHead}:${origin.executionIdentity}`
    || !/^sha256:[a-f0-9]{64}$/.test(origin.workOrderDigest ?? "")
    || !(await lstat(originDir)).isDirectory() || await realpath(originDir) !== originDir
    || !(await lstat(originPath)).isFile()) refuse("original commit-only output is not execution-derived");
  const prior = await verifyPulledResult({ resultPath: originPath, receiptTmpRoot, role: "fixer", ...origin });
  const subject = prior.receipt?.subject;
  if (!prior.ok || subject?.repo !== order.target.repo || subject.pr !== order.target.pr || subject.headSha !== delta.reviewBaselineHead
    || subject.branch !== order.mutationAuthority.branch || subject.phase !== "commit_only"
    || typeof subject.planPath !== "string" || await realpath(subject.planPath) !== canonical) refuse("original commit-only pull/result authority mismatch");
  const priorRaw = JSON.parse(priorBytes);
  normalizeFixerDispositionHandoff(priorRaw);
  if (!(await readFile(originPath)).equals(priorBytes) || !/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(completion.fixingCommitSha ?? "")
    || priorRaw.headSha !== completion.fixingCommitSha || sha256Hex(priorRaw.siteCoverage) !== sha256Hex(completion.siteCoverage)) refuse("original raw fixing head/coverage changed");
  for (const [kind, authority, current] of [["act-list", "sourceDigest", actList], ["delta-result", "deltaResultDigest", delta]]) {
    const originals = oldOrder.requiredReads?.filter((read) => read.kind === kind) ?? [];
    const currents = order.requiredReads?.filter((read) => read.kind === kind) ?? [];
    if (originals.length !== 1 || currents.length !== 1) refuse(`original/current ${kind} read must be unique`);
    const bytes = await readFile(originals[0].path);
    const currentReadBytes = await readFile(currents[0].path);
    if (!bytes.equals(currentReadBytes) || [originals[0], currents[0]].some((read) => read.required !== true || read.sha256 !== digest(bytes) || read.bytes !== bytes.length)
      || sha256Hex(JSON.parse(bytes)).slice(7) !== oldOrder.authority?.[authority]
      || oldOrder.authority[authority] !== order.authority[authority] || sha256Hex(JSON.parse(bytes)) !== sha256Hex(current)) refuse(`original/current ${kind} raw or semantic authority mismatch`);
  }
  const checkouts = listWorktreeEntries(repoRoot, { env: nativeGitEnv(), timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 });
  if (!checkouts.length || checkouts.some((entry) => !path.isAbsolute(entry.path))) refuse("retirement checkout discovery returned no valid absolute roots");
  for (const tmpRoot of new Set([receiptTmpRoot, ...checkouts.map((entry) => path.join(entry.path, "tmp"))])) {
    if ([[oldOrder.headSha, emitted(original.executionIdentity)], [order.headSha, emitted(plan.executionIdentity)]]
      .some(([head, time]) => findRetirementAfter(tmpRoot, order.gate, head, time))) refuse("source round was retired");
  }
  const decisionBytes = await readFile(gateDeltaRecordPath(receiptTmpRoot, delta.reviewBaselineHead));
  if (digest(decisionBytes) !== legacy.clearingDecisionBytesDigest || sha256Hex(JSON.parse(decisionBytes)) !== sha256Hex(decision)
    || digest(priorBytes) !== legacy.handbackBytesDigest) refuse("clearing decision or original raw handback bytes changed");
  if (actList.length !== 1 || actList[0].siteQuery !== PATTERN) refuse("unsupported legacy query scope or literal");
  const raw = completion.siteCoverage;
  const item = actList[0];
  const forms = [...(item.acceptedForms ?? []), ...(item.rejectedForms ?? [])];
  const { files, ...observed } = queryLegacySites({ repoRoot, candidate: completion.headSha, branch: order.mutationAuthority.branch });
  const expected = new Set([...files, ...forms]);
  if (raw.length !== 1 || raw[0].fingerprint !== item.fingerprint || new Set(forms).size !== forms.length
    || !Array.isArray(raw[0].returnedSites) || raw[0].returnedSites.length !== files.size || new Set(raw[0].returnedSites).size !== files.size
    || raw[0].returnedSites.some((file) => !files.has(file)) || raw[0].sites?.length !== expected.size
    || raw[0].sites.some((site) => !expected.has(site.site) || site.kind !== (forms.includes(site.site) ? "input_form" : "site"))) refuse("raw query file/form coverage is incomplete, extra or duplicated");
  const normalized = normalizeFixerDispositionHandoff(JSON.parse(priorBytes));
  if (siteCoverageGaps(toDeltaActItems(actList), normalized.siteCoverage).length) refuse("legacy prescribed form coverage has gaps");
  if (!(await readFile(canonical)).equals(activeBytes)) refuse("current canonical plan was superseded during query");
  return observed;
}
