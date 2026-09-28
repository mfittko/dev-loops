#!/usr/bin/env node
/**
 * Judge role of the work-order pull protocol (ADR 0106): the deterministic
 * producer of the judge's work order and the `judge` role adapter that
 * pull-work-order.mjs selects by the ref's `judge:` prefix. Serializer, envelope,
 * reader and receipt stay in _work-order-protocol.mjs.
 */
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadDevLoopConfig } from "@dev-loops/core/config";
import { computeSpecDigest } from "@dev-loops/core/loop/spec-authority";
import { formatCliError, isDirectCliRun, readJsonIfExists as readJson } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, preflightJqFilter } from "../lib/jq-output.mjs";
import { WorkOrderRefusal, buildDispatchPointer, materializationHash, registerWorkOrderRole, workOrderDigest } from "../github/_work-order-protocol.mjs";
import { buildGateArtifactPath, buildGateContextPath } from "../github/_gate-artifact-paths.mjs";
import { renderRequiredReadLine } from "../github/write-gate-context.mjs";
import { findRetirementAfter } from "../github/pull-work-order.mjs";
import { resolveLedgerCheckouts, resolveRepoRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: emit-judge-work-order.mjs --repo <owner/name> --pr <n> --gate <gate> --head-sha <sha> --findings-file <ledger> --spec-file <spec> --identity-file <identity> [--prior-verdict <path>]... [--tmp-root <path>]
Derives the judge's work order from the round's authoritative inputs: the consolidated
ledger (consolidate-fanin --ledger-out), the structured spec and identity stamp
(spec-context.mjs --spec-out/--identity-out), the gate-context evidence read and the
prior-round judge verdicts. It writes the immutable work order under
<tmp-root>/gate-judge/<repo-slug>/pr-<N>/<gate>-<headSha>/ and prints
{ ok, workOrderRef, workOrderDigest, executionIdentity, dispatchPrompt, planPath }.
The work order's two verdict outputRefs sit under that directory's <roundId>/ segment.
--tmp-root must be a listed checkout's tmp directory (the default is <checkout root>/tmp).
Dispatch the judge with the compact dispatchPrompt only; each run supersedes the
previous emission for this PR and gate at any head. It accepts no brief or summary input.
Exit codes: 0 emitted, 1 refused (missing or inconsistent source), 2 usage/IO error.`;

// ref = judge:<owner/repo>#<pr>:<gate>:<headSha>:<roundId>; executionIdentity = roundId.
const JUDGE_REF_RE = /^judge:([^/\s#]+\/[^/\s#]+)#(\d+):([a-z_]+):([0-9a-f]{40}|[0-9a-f]{64}):(j(\d+)-[0-9a-f]+)$/;
const JUDGE_WIDENING_RULE = "requiredReads are the default context, not a ceiling. You MAY read further code, spec, contracts or prior ledgers when a concrete dependency or ambiguity requires it";
// Pinned judge contracts: the work order digest changes when either changes.
const JUDGE_CONTRACTS = ["agents/judge.agent.md", "skills/docs/spec-authority-contract.md"];
const PACKAGE_ROOT = new URL("../../", import.meta.url);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const judgeDir = ({ repo, pr, gate, headSha, tmpRoot }) => buildGateArtifactPath({ repo, pr, gate, headSha, tmpRoot, dir: "gate-judge" });
const sortKeys = (value) => (Array.isArray(value) ? value.map(sortKeys)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]))
    : value);
/** Exact-content digest of parsed JSON (key order only is normalized); pins the ledger and prior verdicts. */
export const jsonContentDigest = (value) => sha256(JSON.stringify(sortKeys(value)));

class Refusal extends Error {}

async function readSource(kind, filePath) {
  const bytes = await readFile(filePath).catch(() => null);
  if (bytes === null) throw new Refusal(`required judge source ${kind} is missing or unreadable: ${filePath}`);
  return { read: { kind, path: filePath, sha256: sha256(bytes), bytes: bytes.length, required: true }, bytes };
}

function parseSource({ read, bytes }) {
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Refusal(`required judge source ${read.kind} is not JSON: ${read.path}`); }
}

export function renderWorkOrder(workOrder) {
  const [verdictPath, specVerdictPath] = workOrder.outputRefs;
  return `# Judge work order (ADR 0106)

Adjudicate every finding in the \`findings\` read per agents/judge.agent.md, against the COMPLETE spec in the \`spec\` read.
Read every \`required\` entry below IN FULL before any judgment. If one is missing, unreadable, or its sha256 differs, stop and report which read failed; never write a verdict.
Write exactly two artifacts: the relevance verdict to \`${verdictPath}\` and the spec-authority verdict to \`${specVerdictPath}\`.
Widening: ${JUDGE_WIDENING_RULE}.

## Required reads

${workOrder.requiredReads.map((read) => renderRequiredReadLine(read, "/")).join("\n")}

## Work order

\`\`\`json
${JSON.stringify(workOrder, null, 2)}
\`\`\`
`;
}

/**
 * Emit one judge work order. Returns the plan record written beside it. Throws
 * Refusal on a missing or inconsistent source. `roundId` is injectable for tests.
 */
export async function emitJudgeWorkOrder({ repo, pr, gate, headSha, findingsFile, specFile, identityFile, priorVerdicts = [], cwd = process.cwd(), tmpRoot, roundId = `j${Date.now()}-${randomBytes(4).toString("hex")}` }) {
  if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(headSha)) throw new Refusal(`--head-sha must be a full 40- or 64-char lowercase SHA, got ${headSha}`);
  // Anchor at the checkout root, never a cwd subdirectory the pull and write guard never scan.
  const checkoutRoot = resolveRepoRoot(cwd);
  tmpRoot ??= path.join(checkoutRoot, "tmp");
  const abs = (p) => path.resolve(cwd, p);
  const dir = path.resolve(judgeDir({ repo, pr, gate, headSha, tmpRoot }));
  const findings = await readSource("findings", abs(findingsFile));
  const spec = await readSource("spec", abs(specFile));
  const identitySource = await readSource("spec-identity", abs(identityFile));
  const identity = parseSource(identitySource);
  const specDigest = computeSpecDigest(parseSource(spec));
  if (identity?.specDigest !== specDigest) throw new Refusal(`spec identity ${identityFile} pins specDigest ${identity?.specDigest}, but the spec file digests to ${specDigest}; re-run spec-context.mjs`);
  if (String(identity.headSha ?? "").toLowerCase() !== headSha.toLowerCase()) throw new Refusal(`spec identity ${identityFile} is for head ${identity.headSha}, not ${headSha}; re-run spec-context.mjs at the current head`);
  // The PR declared scope and the diff reach the judge through the round's evidence read.
  const context = await readJson(abs(buildGateContextPath({ repo, pr, gate, headSha, tmpRoot })));
  const evidenceRead = context?.requiredReads?.find((read) => read?.kind === "evidence");
  if (!evidenceRead) throw new Refusal(`no gate-context evidence read for ${gate} at ${headSha}; pass the --tmp-root the round's context was written with, or run write-gate-context.mjs for this round first`);
  // write-gate-context records the evidence path relative to the checkout that owns tmpRoot (<checkout>/tmp).
  const evidence = await readSource("evidence", path.resolve(path.dirname(abs(tmpRoot)), evidenceRead.path));
  if (evidence.read.sha256 !== evidenceRead.sha256) throw new Refusal(`gate-context evidence ${evidenceRead.path} changed since the round was built; rebuild the round context`);
  const priors = [];
  for (const prior of priorVerdicts) priors.push(await readSource("prior-judge-verdict", abs(prior)));
  const contracts = await Promise.all(JUDGE_CONTRACTS.map(async (rel) => ({ path: rel, digest: sha256(await readFile(new URL(rel, PACKAGE_ROOT))) })));
  const { config } = await loadDevLoopConfig({ repoRoot: checkoutRoot });

  const workOrder = {
    role: "judge",
    target: { repo, pr: Number(pr) },
    operation: "judge",
    roundIdentity: { gate, headSha },
    headSha,
    configSha256: sha256(JSON.stringify(config ?? {})),
    authority: {
      specDigest,
      contentDigest: identity.contentDigest,
      checkedCriteria: identity.checkedCriteria,
      findingsDigest: jsonContentDigest(parseSource(findings)),
      priorVerdictDigests: priors.map((prior) => jsonContentDigest(parseSource(prior))),
    },
    contracts,
    requiredReads: [findings.read, spec.read, identitySource.read, evidence.read, ...priors.map((prior) => prior.read)],
    // Per-round paths: a superseded round's late verdict never lands where this round's is read.
    outputRefs: [path.join(dir, roundId, "judge-verdict.json"), path.join(dir, roundId, "spec-authority-verdict.json")],
    executionRules: { widening: JUDGE_WIDENING_RULE, contract: "agents/judge.agent.md" },
  };
  const identityTriple = {
    workOrderRef: `judge:${repo}#${pr}:${gate}:${headSha}:${roundId}`,
    workOrderDigest: workOrderDigest(workOrder),
    executionIdentity: roundId,
  };
  const dispatchPrompt = buildDispatchPointer(identityTriple);
  const text = renderWorkOrder(workOrder);
  const promptPath = path.join(dir, "work-orders", `${roundId}.md`);
  await mkdir(path.dirname(promptPath), { recursive: true });
  // Immutable per ref: a different payload never replaces an emitted work order.
  try {
    await writeFile(promptPath, text, { flag: "wx" });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    if (await readFile(promptPath, "utf8") !== text) throw new Refusal(`work order ${identityTriple.workOrderRef} already exists with different content; emit a new reference instead`);
  }
  const plan = { ...identityTriple, roundId, materializationHash: materializationHash(text), promptPath, dispatchPrompt, workOrder };
  const planPath = path.join(dir, "judge-emit-plan.json");
  // Atomic: a concurrent pull never reads a half-written plan.
  const tempPath = `${planPath}.tmp-${roundId}`;
  await writeFile(tempPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await rename(tempPath, planPath);
  return { ...plan, planPath };
}

// Judge adapter. The newest emission for the PR and gate, at ANY head and across
// ALL checkouts, is current; an older ref (including an old head's) is superseded. A retired gate round, or a required
// source whose bytes changed since emission (spec, identity, ledger), makes the unit stale.
const emissionOrder = (plan) => [Number(/^j(\d+)-/.exec(plan.roundId ?? "")?.[1]) || 0, String(plan.roundId ?? "")];
const isNewer = (a, b) => {
  const [[aMs, aId], [bMs, bId]] = [emissionOrder(a), emissionOrder(b)];
  return aMs !== bMs ? aMs > bMs : aId > bId;
};

export async function locateJudgeUnit({ ref, tmpRoots }) {
  const match = JUDGE_REF_RE.exec(ref);
  if (!match) return null;
  const [, repo, pr, gate, headSha, roundId, emittedAtMs] = match;
  // A typed gate/pr/repo the path builder rejects is a retryable typo, never an IO error.
  try { judgeDir({ repo, pr, gate, headSha }); } catch { return null; }
  let newest = null;
  let own = null;
  const headDirRe = new RegExp(`^${gate}-(?:[0-9a-f]{40}|[0-9a-f]{64})$`);
  for (const tmpRoot of tmpRoots) {
    const prDir = path.dirname(judgeDir({ repo, pr, gate, headSha, tmpRoot }));
    for (const name of (await readdir(prDir).catch(() => [])).filter((entry) => headDirRe.test(entry))) {
      const planPath = path.join(prDir, name, "judge-emit-plan.json");
      // A corrupt plan at another head is absent; at the ref's own head it is a named refusal.
      const plan = await readJson(planPath).catch((err) => {
        if (!(err instanceof SyntaxError)) throw err;
        if (name === `${gate}-${headSha}`) throw new WorkOrderRefusal("local_materialization_integrity_failure", `judge emit plan ${planPath} is not valid JSON; re-emit the judge work order, never hand-repair the plan`);
        return undefined;
      });
      if (!plan) continue;
      if (!newest || isNewer(plan, newest)) newest = plan;
      if (plan.workOrderRef === ref) own ??= { plan, tmpRoot };
    }
  }
  if (!newest) return null;
  if (!own || newest.workOrderRef !== ref) return { stale: `judge ref ${ref} was superseded by ${newest.workOrderRef}` };
  const { plan } = own;
  // retire-gate-round writes under the checkout it ran in, so every checkout's record counts.
  let retired = null;
  for (const tmpRoot of tmpRoots) retired ??= await findRetirementAfter(tmpRoot, gate, headSha, Number(emittedAtMs));
  const changed = [];
  for (const read of plan.workOrder?.requiredReads ?? []) {
    const bytes = await readFile(read.path).catch(() => null);
    if (bytes === null || sha256(bytes) !== read.sha256) changed.push(read.kind);
  }
  const stale = (retired && `judge execution ${roundId} belongs to a ${gate} round at ${headSha} retired as ${retired}`)
    || (changed.length > 0 && `required judge source(s) ${changed.join(", ")} changed or vanished since emission; re-emit against current authority`);
  return {
    ...plan,
    materializationPath: plan.promptPath,
    subject: { repo, pr: Number(pr), gate, headSha, roundId },
    stale: stale || undefined,
  };
}

registerWorkOrderRole("judge", {
  locate: locateJudgeUnit,
  validate: (order) => {
    const kinds = new Set((Array.isArray(order.requiredReads) ? order.requiredReads : []).map((read) => read?.kind));
    const missing = ["findings", "spec", "spec-identity", "evidence"].filter((kind) => !kinds.has(kind));
    return missing.length > 0 ? `judge work order is missing required read(s) ${missing.join(", ")}`
      : typeof order.authority?.specDigest !== "string" || typeof order.authority?.findingsDigest !== "string" ? "judge work order pins no spec or findings digest"
        : !Array.isArray(order.outputRefs) || order.outputRefs.length !== 2 ? "judge work order names no two verdict outputRefs"
          : typeof order.executionRules?.widening !== "string" ? "judge work order states no widening rule"
            : null;
  },
});

export async function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  const { values } = parseArgs({ args: argv, options: {
    repo: { type: "string" }, pr: { type: "string" }, gate: { type: "string" }, "head-sha": { type: "string" },
    "findings-file": { type: "string" }, "spec-file": { type: "string" }, "identity-file": { type: "string" },
    "prior-verdict": { type: "string", multiple: true }, "tmp-root": { type: "string" }, help: { type: "boolean", short: "h" },
    ...JQ_OUTPUT_PARSE_OPTIONS,
  } });
  if (values.help) {
    process.stdout.write(`${USAGE}\n\n${JQ_OUTPUT_USAGE}\n`);
    return 0;
  }
  const required = ["repo", "pr", "gate", "head-sha", "findings-file", "spec-file", "identity-file"].filter((key) => !values[key]);
  if (required.length > 0) {
    process.stderr.write(`missing --${required.join(", --")}\n${USAGE}\n`);
    return 2;
  }
  const emit = (payload) => emitResult(payload, { jq: values.jq, silent: values.silent, fields: values.fields });
  const jqSyntaxError = preflightJqFilter(values.jq);
  if (jqSyntaxError !== undefined) return jqSyntaxError;
  const tmpRoot = values["tmp-root"] ? path.resolve(cwd, values["tmp-root"]) : undefined;
  if (tmpRoot) {
    // The judge write guard allows verdicts only under a listed checkout's tmp/gate-judge,
    // and the pull scans only those checkouts, so any other tmp root strands the round.
    const canonical = (p) => { try { return realpathSync(p); } catch { return p; } };
    const allowed = resolveLedgerCheckouts(cwd).map((root) => canonical(path.join(root, "tmp")));
    if (!allowed.includes(canonical(tmpRoot))) {
      return emit({ ok: false, error: `--tmp-root ${tmpRoot} is not a checkout's tmp root (${allowed.join(", ")}); the judge may write verdicts only under <checkout>/tmp/gate-judge, so omit --tmp-root or pass one of these` });
    }
  }
  try {
    const plan = await emitJudgeWorkOrder({
      repo: values.repo, pr: values.pr, gate: values.gate, headSha: values["head-sha"].toLowerCase(),
      findingsFile: values["findings-file"], specFile: values["spec-file"], identityFile: values["identity-file"],
      priorVerdicts: values["prior-verdict"] ?? [], cwd, ...(tmpRoot ? { tmpRoot } : {}),
    });
    const { workOrderRef, workOrderDigest: digest, executionIdentity, dispatchPrompt, planPath } = plan;
    return emit({ ok: true, workOrderRef, workOrderDigest: digest, executionIdentity, dispatchPrompt, planPath });
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    return emit({ ok: false, error: err.message });
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
