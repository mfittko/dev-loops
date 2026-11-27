import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { listOpenActItems, validateAngleResult } from "@dev-loops/core/loop/gate-fanin";
import { isDeltaBodyItem } from "@dev-loops/core/loop/pre-push-delta-review";
import { claimRetainedRound, readSealed } from "./_gate-artifact-seal.mjs";
import { retireGateRound } from "./retire-gate-round.mjs";
import { CHECKPOINT_SENTINEL_PREFIX } from "./verify-fresh-review-context.mjs";
import { gateScopePrefix } from "./_gate-names.mjs";
import { sanitizeScopeSegment } from "./_dispatch-units.mjs";
import { HUMAN_SPEC_DECISION_OUTCOME } from "@dev-loops/core/loop/spec-authority";
import { buildGateArtifactPath, buildGateEmitPlanPath,buildGateReviewsDir, buildLogPath } from "./_gate-artifact-paths.mjs";

// Only a missing path is absent. Any other error (EACCES, ENOTDIR, EIO) could hide a verdict or a live round, so it propagates and the caller fails closed.
const exists = (file) => access(file).then(() => true, (err) => {
  if (err?.code === "ENOENT") return false;
  throw err;
});
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * An artifact proves its unit finished only when it is newer than the sentinel (an older one belongs to an earlier round)
 * and parses as findings JSON that names this head and an accepted angle; a truncated or foreign file is still in flight.
 * `sameAngle(parsedAngle)` decides whether the artifact belongs to the unit. Shared by the body-only rerun in-flight test.
 */
export async function isFinishedArtifact({ file, sentinelFile, wantHead, sameAngle }) {
  try {
    if ((await stat(file)).mtimeMs < (await stat(sentinelFile)).mtimeMs) return false;
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const head = String(parsed?.headSha ?? "").trim().toLowerCase();
    // The artifact must stamp a full SHA; only an abbreviated --head-sha may match by prefix.
    // A reviewer that exited through emit-reviewer-blocked.mjs writes verdict "blocked" with no findings; it is a finished unit.
    const wellFormed = validateAngleResult(parsed?.verdict === "blocked" && Array.isArray(parsed.findings) && parsed.findings.length === 0 ? { ...parsed, verdict: "clean" } : parsed) === null;
    return wellFormed && FULL_SHA_RE.test(head) && (FULL_SHA_RE.test(wantHead) ? head === wantHead : wantHead.length > 0 && head.startsWith(wantHead)) && sameAngle(String(parsed.angle));
  } catch {
    return false;
  }
}

// The first 12 hex chars of a `sha256:<hex>` digest.
const shortDigest = (digest) => String(digest).replace(/^sha256:/, "").slice(0, 12);

// POSIX single quotes keep $, backticks and ! literal; an embedded single quote closes, escapes and reopens the quoting.
const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

/**
 * The runnable retire-gate-round command for one round: the launcher, the full head, a fixed reason and every path
 * single-quoted for a POSIX shell (a checkout path with a space or a `$` stays one literal argument). `findingsDir` null names the round by --repo and --pr.
 */
export function buildRetireCommand({ gate, headSha, tmpRoot, findingsDir = null, repo, pr, reason }) {
  return `dev-loops-run scripts/github/retire-gate-round.mjs --gate ${gate} --head-sha ${headSha} --reason ${shellQuote(reason)} --tmp-root ${shellQuote(tmpRoot)} ${findingsDir ? `--findings-dir ${shellQuote(findingsDir)}` : `--repo ${repo} --pr ${pr}`}`;
}

/**
 * Retire the undispatched or finished round of one gate at one head, through retire-gate-round's logic, so a rebuilt
 * context or a re-emission mints a fresh round (GATE-EXEC-ROUND-RETIREMENT). A round with a posted verdict (a findings
 * log at that head) is never retired: the result is a refusal with a `recovery` field. So is a round
 * with a live sentinel (no valid artifact for its unit newer than it): its reviewer may still be running. An error other
 * than ENOENT while probing the round throws, so the guards fail closed.
 *
 * `tmpRoot` holds the sentinels, dispatch records and the round's artifacts; `verdictRoots` lists the roots whose
 * findings log marks a posted verdict (they may live under the main worktree's tmp).
 * `findingsTmpRoot` (default `tmpRoot`) is the root the round's findings directory and emit plan live under;
 * `recordsTmpRoot` (default `tmpRoot`) is the root the emitter wrote the dispatch records under (--tmp-root). `liveOnly` counts a
 * round as live only when it has sentinels or dispatch records, so a findings directory alone is left in place.
 * `currentSpecDigest` is the digest of the spec the builder just loaded (null when no single spec source exists): with it, a
 * round that stopped for a human spec decision (see findSpecDecisionStop) retires. The stop also needs the
 * judge plan newer than every sentinel and dispatch record of the round, and the pinned digest to differ from the issue body and
 * the PR body digest (`currentSpecDigest` and `otherSpecDigests`); the retirement reason names every candidate as the new digest. `specDecisionOnly`
 * returns `{ retiredRound: null }` for every other round, so an unchanged rebuild never refuses on an ordinary posted verdict.
 * Returns `{ retiredRound }` (null when nothing was live) or `{ refusal: { error, recovery } }`.
 */
export async function retireStaleRound(args) {
  // A probe error proves nothing for a specDecisionOnly caller (an unchanged-byte rebuild never needed the scan), so it means no retirement.
  // Once the stop is known every error propagates, so a failed move surfaces and the next rebuild finishes it.
  const state = { stopped: false };
  try {
    return await retireStaleRoundProbed(args, state);
  } catch (err) {
    if (args.specDecisionOnly && !state.stopped) return { retiredRound: null };
    throw err;
  }
}

/**
 * The body digest a posted ledger read when the round is superseded by a PR-body edit (issue 3604): the ledger has at least one open act item,
 * every one a PR-body item, and its `prBodySha256` is a digest that differs from `currentPrBodySha256`. Null otherwise, and for an unreadable ledger, so every other case keeps the refusal.
 */
async function readBodyOnlySupersededDigest(ledgerPath, currentPrBodySha256) {
  try {
    return bodyOnlySupersededDigest(JSON.parse(await readSealed(ledgerPath)), currentPrBodySha256);
  } catch {
    return null;
  }
}

/** {@link readBodyOnlySupersededDigest} over a parsed ledger. The context writer, the detector and the retirement all read the condition here. */
export function bodyOnlySupersededDigest(log, currentPrBodySha256) {
  if (!/^[0-9a-f]{64}$/.test(String(currentPrBodySha256)) || !/^[0-9a-f]{64}$/.test(String(log?.prBodySha256)) || log.prBodySha256 === currentPrBodySha256) return null;
  const open = listOpenActItems(log.findings);
  return open.length > 0 && open.every(isDeltaBodyItem) ? log.prBodySha256 : null;
}

// The next free `<gate>-<sha>.round-<n>.json` beside the live ledger, as the writer names a retained round.
function nextRetainedPath(ledgerPath, siblings) {
  const stem = path.basename(ledgerPath, ".json");
  const taken = siblings.map((name) => (name.startsWith(`${stem}.round-`) ? Number(/\.round-(\d+)\.json$/.exec(name)?.[1] ?? 0) : 0));
  return path.join(path.dirname(ledgerPath), `${stem}.round-${Math.max(0, ...taken) + 1}.json`);
}

// `otherSpecDigests` are further digests the spec source could have; the stop needs the pinned digest to differ from all of them and from `currentSpecDigest`.
async function retireStaleRoundProbed({ repo, pr, gate, headSha, tmpRoot, verdictRoots = [tmpRoot], findingsTmpRoot = tmpRoot, recordsTmpRoot = tmpRoot, liveOnly = false, currentSpecDigest = null, otherSpecDigests = [], specDecisionOnly = false, currentPrBodySha256 = null, bodyReadingUnits = null }, state) {
  const head = String(headSha).trim().toLowerCase();
  if (!FULL_SHA_RE.test(head)) return { retiredRound: null };
  const findingsDir = buildGateReviewsDir({ repo, pr, gate, headSha: head, tmpRoot: findingsTmpRoot });
  const hasFindings = await exists(findingsDir);
  // A verdict marker alone is not a live round: a manual retirement leaves the log in place.
  const names = await readdir(tmpRoot).catch((err) => {
    if (err?.code === "ENOENT") return [];
    throw err;
  });
  const suffix = `-${head}.json`;
  const sentinelPrefix = `${CHECKPOINT_SENTINEL_PREFIX}${gateScopePrefix(gate)}`;
  const recordPrefix = `checkpoint-dispatch-prompt-${gateScopePrefix(gate)}`;
  const recordNames = recordsTmpRoot === tmpRoot ? names : await readdir(recordsTmpRoot).catch((err) => {
    if (err?.code === "ENOENT") return [];
    throw err;
  });
  const hasRecords = names.some((n) => n.endsWith(suffix) && n.startsWith(sentinelPrefix))
    || recordNames.some((n) => n.endsWith(suffix) && n.startsWith(recordPrefix));
  if (!hasRecords && (liveOnly || !hasFindings)) {
    return { retiredRound: null };
  }
  const roundFiles = [
    ...names.filter((n) => n.endsWith(suffix) && n.startsWith(sentinelPrefix)).map((n) => path.join(tmpRoot, n)),
    ...recordNames.filter((n) => n.endsWith(suffix) && n.startsWith(recordPrefix)).map((n) => path.join(recordsTmpRoot, n)),
  ];
  const stopped = currentSpecDigest ? await findSpecDecisionStop({ repo, pr, gate, head, verdictRoots, specDigests: [currentSpecDigest, ...otherSpecDigests], roundFiles }) : null;
  if (specDecisionOnly && !stopped) return { retiredRound: null };
  state.stopped = stopped !== null;
  const supersededBodies = [];
  for (const root of verdictRoots) {
    const key = { repo, pr, gate, headSha: head, tmpRoot: root };
    // Only the findings log marks a posted verdict: the verdict comment renders only from it (ADR 0336).
    const marker = buildLogPath(key);
    if (await exists(marker)) {
      // GATE-EXEC-ROUND-RETIREMENT: a round whose open act items are all PR-body items and whose body digest is stale retires; the ledger stays as a retained round.
      // The scoped rerun needs the caller's body-reading units; a caller that names none keeps the refusal.
      const priorBody = Array.isArray(bodyReadingUnits) ? await readBodyOnlySupersededDigest(marker, currentPrBodySha256) : null;
      if (priorBody !== null) {
        supersededBodies.push({ marker, priorBody });
        continue;
      }
      return {
        refusal: {
          error: `GATE-EXEC-ROUND-RETIREMENT: refusing to retire the ${gate} round at head ${head}: a verdict is already recorded at ${marker}. A posted verdict is never retired automatically.`,
          recovery: `operator: confirm the verdict at ${marker} is superseded, then run \`${buildRetireCommand({ gate, headSha: head, tmpRoot, findingsDir: hasFindings ? findingsDir : null, repo, pr, reason: `operator confirmed the verdict at ${head} is superseded` })}\``,
        },
      };
    }
  }
  // A sentinel is live when no valid artifact for its unit is newer than it: that reviewer is still running, and moving
  // its round would orphan it. Undispatched (records only) and finished rounds retire as before.
  const liveSentinels = await findUnfinishedSentinels({ repo, pr, gate, tmpRoot, findingsTmpRoot, names: names.filter((n) => n.endsWith(suffix) && n.startsWith(sentinelPrefix)) });
  if (liveSentinels.length > 0) {
    return {
      refusal: {
        error: `GATE-EXEC-ROUND-RETIREMENT: refusing to retire the ${gate} round at head ${head}: ${liveSentinels.length} reviewer sentinel(s) have no findings artifact newer than them, so their reviewers may still be running (${liveSentinels.sort().join(", ")}). Retiring now would orphan them.`,
        recovery: buildLiveRoundRecovery({ gate, headSha: head, tmpRoot, findingsDir: hasFindings ? findingsDir : null, repo, pr }),
      },
    };
  }
  // The ledger moves first: a crash after it leaves a round with no live ledger, which the next rebuild retires as an ordinary stale round.
  for (const { marker } of supersededBodies) await claimRetainedRound(marker, nextRetainedPath(marker, await readdir(path.dirname(marker))));
  const reason = supersededBodies.length > 0
    ? `automatic: GATE-EXEC-BODY-ONLY-RERUN, every open act item is a PR-body item and the PR body changed (prBodySha256 ${shortDigest(supersededBodies[0].priorBody)} to ${shortDigest(currentPrBodySha256)}); the ledger is kept as a retained round`
    : stopped
    ? `automatic: SPEC-AUTHORITY-HUMAN-DECISION-LAST-RESORT stopped the round and the spec changed (specDigest ${shortDigest(stopped.pinnedDigest)} to ${[currentSpecDigest, ...otherSpecDigests].map(shortDigest).join(" or ")}); no verdict was posted`
    : "automatic: the gate context was rebuilt or the round re-emitted at the same head before any verdict was recorded";
  const distinctRecords = recordsTmpRoot !== tmpRoot && recordNames.some((n) => n.endsWith(suffix) && n.startsWith(recordPrefix));
  // A body-only round retires only the units that hold a body-reading angle (GATE-EXEC-BODY-ONLY-RERUN): their sentinels, dispatch records and artifacts move; every other unit keeps its own.
  const bodyOnlyScopes = supersededBodies.length > 0 ? bodyReadingUnits.map((unit) => unit.scope) : null;
  let findingsOpt = hasFindings ? { findingsDir } : { noFindingsArtifacts: true };
  let scopedOpt = {};
  if (bodyOnlyScopes) {
    const artifacts = bodyReadingUnits.flatMap((unit) => unit.angles).map((angle) => path.join(findingsDir, `${sanitizeScopeSegment(angle) || "angle"}.json`));
    const findingsFiles = [];
    for (const file of artifacts) if (await exists(file)) findingsFiles.push(file);
    findingsOpt = { noFindingsArtifacts: true, findingsFiles };
    scopedOpt = { scopes: bodyOnlyScopes };
  }
  let result = { noop: true };
  let recordsResult = null;
  if (await exists(tmpRoot)) {
    result = await retireGateRound({ // the findings dir may live under another root than the sentinels
      gate, headSha: head, tmpRoot, repo, pr, reason, ...findingsOpt, ...scopedOpt,
    });
    // The dispatch records follow --tmp-root, so a distinct records root retires them in a second audited move.
    if (distinctRecords) recordsResult = await retireGateRound({ gate, headSha: head, tmpRoot: recordsTmpRoot, reason, noFindingsArtifacts: true, ...scopedOpt });
  } else if (distinctRecords || hasFindings) {
    // The sentinel root is missing, so it holds no sentinels and retireGateRound would refuse it; retire the records and findings through the roots that hold them.
    result = await retireGateRound({ gate, headSha: head, tmpRoot: distinctRecords ? recordsTmpRoot : findingsTmpRoot, repo, pr, reason, ...findingsOpt, ...scopedOpt });
  }
  if (result.noop && !recordsResult) return { retiredRound: null, bodyOnlyScopes };
  const base = result.noop ? recordsResult : result;
  return { bodyOnlyScopes, retiredRound: { retirementDir: path.resolve(base.retirementDir), retired: result.retired, sentinels: result.sentinels, dispatchPromptRecords: [...result.dispatchPromptRecords, ...(recordsResult?.dispatchPromptRecords ?? [])], findingsDirRetired: result.findingsDirRetired } };
}

/**
 * The round stopped at the human-spec-decision state and the spec has changed since: no findings log in any verdict root
 * (the verdict comment renders only from it), a judge plan whose spec-authority verdict holds a `spec_cannot_decide`
 * decision, and a plan-pinned spec digest that differs from `currentSpecDigest`. The plan must be newer than every sentinel and
 * dispatch record in `roundFiles`: a newer fan-out that has not replaced the plan yet leaves the stopped round's plan stale. Returns `{ pinnedDigest }` or null; any
 * missing or unreadable file is null, so the check never fails open.
 */
async function findSpecDecisionStop({ repo, pr, gate, head, verdictRoots, specDigests, roundFiles }) {
  for (const root of verdictRoots) {
    if (await exists(buildLogPath({ repo, pr, gate, headSha: head, tmpRoot: root }))) return null;
  }
  for (const root of verdictRoots) {
    try {
      const dir = buildGateArtifactPath({ repo, pr, gate, headSha: head, tmpRoot: root, dir: "gate-judge" });
      const planFile = path.join(dir, "judge-emit-plan.json");
      const plan = JSON.parse(await readFile(planFile, "utf8"));
      const planTime = (await stat(planFile)).mtimeMs;
      for (const file of roundFiles) if ((await stat(file)).mtimeMs >= planTime) return null;
      const pinnedDigest = plan?.workOrder?.authority?.specDigest;
      const outputRef = plan?.workOrder?.outputRefs?.find((ref) => path.basename(String(ref)) === "spec-authority-verdict.json");
      if (typeof pinnedDigest !== "string" || specDigests.includes(pinnedDigest) || typeof outputRef !== "string") continue;
      const verdict = JSON.parse(await readFile(outputRef, "utf8"));
      if (verdict.decisions.some((d) => d?.outcome === HUMAN_SPEC_DECISION_OUTCOME)) return { pinnedDigest };
    } catch { /* a missing or unreadable plan or verdict in this root proves nothing */ }
  }
  return null;
}

// The persisted emit plan, or the sidecar that survives its removal at the start of an emission; null when neither parses.
async function readEmitPlan(key) {
  const planPath = buildGateEmitPlanPath(key);
  for (const file of [planPath, `${planPath}.prior`]) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch { /* try the sidecar, then treat the unit as live */ }
  }
  return null;
}

/** The recovery for a round whose reviewers may still run: wait, rebuild the context and resume, and name `operator` before the retire command so no coordinator runs it unattended. */
export function buildLiveRoundRecovery({ gate, headSha, tmpRoot, findingsDir = null, repo, pr }) {
  return `wait for the running reviewers to write their findings, re-run write-gate-context.mjs at the same head so pendingGroups drops the completed units, then run emit-fanout-dispatch.mjs --pending; for a crashed unit, run emit-fanout-dispatch.mjs --pending with --retry-crashed and the unit name; for a rebuilt briefing, operator: run \`${buildRetireCommand({ gate, headSha, tmpRoot, findingsDir, repo, pr, reason: `operator confirmed the reviewers of ${headSha} are no longer running` })}\``;
}

/**
 * The sentinel file names (one gate, each stamped with its full head) whose reviewer has not finished: no valid artifact
 * for the unit is newer than the sentinel. A group unit finishes only when every angle the emit plan lists for it has one,
 * so another unit's artifact never counts, and a missing or unreadable plan or a unit absent from it leaves it unfinished.
 */
export async function findUnfinishedSentinels({ repo, pr, gate, tmpRoot, findingsTmpRoot = tmpRoot, names }) {
  const sentinelPrefix = `${CHECKPOINT_SENTINEL_PREFIX}${gateScopePrefix(gate)}`;
  const plans = new Map(); // the emit plan (or its sidecar) per head, read once and only when a group sentinel needs it
  const unfinished = [];
  for (const name of names) {
    const head = name.slice(0, -".json".length).split("-").at(-1);
    const segment = name.slice(sentinelPrefix.length, -`-${head}.json`.length);
    const findingsDir = buildGateReviewsDir({ repo, pr, gate, headSha: head, tmpRoot: findingsTmpRoot });
    let angles = [segment];
    if (segment.startsWith("group-")) {
      if (!plans.has(head)) plans.set(head, await readEmitPlan({ repo, pr, gate, headSha: head, tmpRoot: findingsTmpRoot }));
      const unit = plans.get(head)?.units?.find((u) => u?.scope === `${gateScopePrefix(gate)}${segment}`);
      angles = Array.isArray(unit?.angles) && unit.angles.length > 0 ? unit.angles.map(String) : [];
    }
    const finished = angles.length > 0 && (await Promise.all(angles.map((angle) => isFinishedArtifact({
      file: path.join(findingsDir, `${sanitizeScopeSegment(angle)}.json`), sentinelFile: path.join(tmpRoot, name), wantHead: head, sameAngle: (a) => sanitizeScopeSegment(a) === sanitizeScopeSegment(angle),
    })))).every(Boolean);
    if (!finished) unfinished.push(name);
  }
  return unfinished;
}
