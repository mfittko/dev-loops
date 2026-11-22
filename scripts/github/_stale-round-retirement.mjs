import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { validateAngleResult } from "@dev-loops/core/loop/gate-fanin";
import { retireGateRound } from "./retire-gate-round.mjs";
import { CHECKPOINT_SENTINEL_PREFIX } from "./verify-fresh-review-context.mjs";
import { gateScopePrefix } from "./_gate-names.mjs";
import { sanitizeScopeSegment } from "./_dispatch-units.mjs";
import { buildGateEmitPlanPath, buildGateFaninLedgerPath, buildGateReviewsDir, buildLogPath } from "./_gate-artifact-paths.mjs";

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
 * context or a re-emission mints a fresh round (GATE-EXEC-ROUND-RETIREMENT). A round with a posted verdict (a fan-in
 * ledger or a findings log at that head) is never retired: the result is a refusal with a `recovery` field. So is a round
 * with a live sentinel (no valid artifact for its unit newer than it): its reviewer may still be running. An error other
 * than ENOENT while probing the round throws, so the guards fail closed.
 *
 * `tmpRoot` holds the sentinels, dispatch records and the round's artifacts; `verdictRoots` lists the roots whose
 * fan-in ledger or findings log mark a posted verdict (the ledger may live under the main worktree's tmp).
 * `findingsTmpRoot` (default `tmpRoot`) is the root the round's findings directory and emit plan live under;
 * `recordsTmpRoot` (default `tmpRoot`) is the root the emitter wrote the dispatch records under (--tmp-root). `liveOnly` counts a
 * round as live only when it has sentinels or dispatch records, so a findings directory alone is left in place.
 * Returns `{ retiredRound }` (null when nothing was live) or `{ refusal: { error, recovery } }`.
 */
export async function retireStaleRound({ repo, pr, gate, headSha, tmpRoot, verdictRoots = [tmpRoot], findingsTmpRoot = tmpRoot, recordsTmpRoot = tmpRoot, liveOnly = false }) {
  const head = String(headSha).trim().toLowerCase();
  if (!FULL_SHA_RE.test(head)) return { retiredRound: null };
  const findingsDir = buildGateReviewsDir({ repo, pr, gate, headSha: head, tmpRoot: findingsTmpRoot });
  const hasFindings = await exists(findingsDir);
  // A verdict marker alone is not a live round: a manual retirement leaves the ledger and log in place.
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
  if (!hasRecords && (liveOnly || !hasFindings)) return { retiredRound: null };
  for (const root of verdictRoots) {
    const key = { repo, pr, gate, headSha: head, tmpRoot: root };
    for (const marker of [buildGateFaninLedgerPath(key), buildLogPath(key)]) {
      if (await exists(marker)) {
        return {
          refusal: {
            error: `GATE-EXEC-ROUND-RETIREMENT: refusing to retire the ${gate} round at head ${head}: a verdict is already recorded at ${marker}. A posted verdict is never retired automatically.`,
            recovery: `operator: confirm the verdict at ${marker} is superseded, then run \`${buildRetireCommand({ gate, headSha: head, tmpRoot, findingsDir: hasFindings ? findingsDir : null, repo, pr, reason: `operator confirmed the verdict at ${head} is superseded` })}\``,
          },
        };
      }
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
  const reason = "automatic: the gate context was rebuilt or the round re-emitted at the same head before any verdict was recorded";
  const distinctRecords = recordsTmpRoot !== tmpRoot && recordNames.some((n) => n.endsWith(suffix) && n.startsWith(recordPrefix));
  const findingsOpt = hasFindings ? { findingsDir } : { noFindingsArtifacts: true };
  let result = { noop: true };
  let recordsResult = null;
  if (await exists(tmpRoot)) {
    result = await retireGateRound({ // the findings dir may live under another root than the sentinels
      gate, headSha: head, tmpRoot, repo, pr, reason, ...findingsOpt,
    });
    // The dispatch records follow --tmp-root, so a distinct records root retires them in a second audited move.
    if (distinctRecords) recordsResult = await retireGateRound({ gate, headSha: head, tmpRoot: recordsTmpRoot, reason, noFindingsArtifacts: true });
  } else if (distinctRecords || hasFindings) {
    // The sentinel root is missing, so it holds no sentinels and retireGateRound would refuse it; retire the records and findings through the roots that hold them.
    result = await retireGateRound({ gate, headSha: head, tmpRoot: distinctRecords ? recordsTmpRoot : findingsTmpRoot, repo, pr, reason, ...findingsOpt });
  }
  if (result.noop && !recordsResult) return { retiredRound: null };
  const base = result.noop ? recordsResult : result;
  return { retiredRound: { retirementDir: path.resolve(base.retirementDir), retired: result.retired, sentinels: result.sentinels, dispatchPromptRecords: [...result.dispatchPromptRecords, ...(recordsResult?.dispatchPromptRecords ?? [])], findingsDirRetired: result.findingsDirRetired } };
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

/** The recovery for a round whose reviewers may still run: wait and resume, and name `operator` before the retire command so no coordinator runs it unattended. */
export function buildLiveRoundRecovery({ gate, headSha, tmpRoot, findingsDir = null, repo, pr }) {
  return `wait for the running reviewers to write their findings and resume the round with emit-fanout-dispatch.mjs --pending; if they crashed, operator: run \`${buildRetireCommand({ gate, headSha, tmpRoot, findingsDir, repo, pr, reason: `operator confirmed the reviewers of ${headSha} are no longer running` })}\``;
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
