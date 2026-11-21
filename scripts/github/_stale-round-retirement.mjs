import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { validateAngleResult } from "@dev-loops/core/loop/gate-fanin";
import { retireGateRound } from "./retire-gate-round.mjs";
import { CHECKPOINT_SENTINEL_PREFIX } from "./verify-fresh-review-context.mjs";
import { gateScopePrefix } from "./_gate-names.mjs";
import { sanitizeScopeSegment } from "./_dispatch-units.mjs";
import { buildGateFaninLedgerPath, buildGateReviewsDir, buildLogPath } from "./_gate-artifact-paths.mjs";

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

/**
 * The runnable retire-gate-round command for one round: the launcher, the full head, a fixed reason and every path
 * JSON-quoted (a checkout path with a space stays one argument). `findingsDir` null names the round by --repo and --pr.
 */
export function buildRetireCommand({ gate, headSha, tmpRoot, findingsDir = null, repo, pr, reason }) {
  return `dev-loops-run scripts/github/retire-gate-round.mjs --gate ${gate} --head-sha ${headSha} --reason ${JSON.stringify(reason)} --tmp-root ${JSON.stringify(tmpRoot)} ${findingsDir ? `--findings-dir ${JSON.stringify(findingsDir)}` : `--repo ${repo} --pr ${pr}`}`;
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
 * `findingsTmpRoot` (default `tmpRoot`) is the root the round's findings directory lives under. `liveOnly` counts a
 * round as live only when it has sentinels or dispatch records, so a findings directory alone is left in place.
 * Returns `{ retiredRound }` (null when nothing was live) or `{ refusal: { error, recovery } }`.
 */
export async function retireStaleRound({ repo, pr, gate, headSha, tmpRoot, verdictRoots = [tmpRoot], findingsTmpRoot = tmpRoot, liveOnly = false }) {
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
  const prefixes = [sentinelPrefix, `checkpoint-dispatch-prompt-${gateScopePrefix(gate)}`];
  const hasRecords = names.some((n) => n.endsWith(suffix) && prefixes.some((p) => n.startsWith(p)));
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
  const artifactFiles = hasFindings ? (await readdir(findingsDir)).filter((n) => n.endsWith(".json")) : [];
  const liveSentinels = [];
  for (const name of names.filter((n) => n.endsWith(suffix) && n.startsWith(sentinelPrefix))) {
    const segment = name.slice(sentinelPrefix.length, -suffix.length);
    const sentinelFile = path.join(tmpRoot, name);
    // shortcut: a group unit's angles are not recorded in its sentinel, so any valid newer artifact counts as finished; upgrade when the sentinel records its angles.
    const candidates = segment.startsWith("group-") ? artifactFiles : artifactFiles.filter((n) => n === `${segment}.json`);
    const sameAngle = segment.startsWith("group-") ? () => true : (angle) => sanitizeScopeSegment(angle) === segment;
    const finished = (await Promise.all(candidates.map((n) => isFinishedArtifact({ file: path.join(findingsDir, n), sentinelFile, wantHead: head, sameAngle })))).some(Boolean);
    if (!finished) liveSentinels.push(name);
  }
  if (liveSentinels.length > 0) {
    return {
      refusal: {
        error: `GATE-EXEC-ROUND-RETIREMENT: refusing to retire the ${gate} round at head ${head}: ${liveSentinels.length} reviewer sentinel(s) have no findings artifact newer than them, so their reviewers may still be running (${liveSentinels.sort().join(", ")}). Retiring now would orphan them.`,
        recovery: `wait for the running reviewers to write their findings and resume the round with emit-fanout-dispatch.mjs --pending; if they crashed, operator: run \`${buildRetireCommand({ gate, headSha: head, tmpRoot, findingsDir: hasFindings ? findingsDir : null, repo, pr, reason: `operator confirmed the reviewers of ${head} are no longer running` })}\``,
      },
    };
  }
  const result = await retireGateRound({ // the findings dir may live under another root than the sentinels
    gate, headSha: head, tmpRoot, repo, pr,
    reason: "automatic: the gate context was rebuilt or the round re-emitted at the same head before any verdict was recorded",
    ...(hasFindings ? { findingsDir } : { noFindingsArtifacts: true }),
  });
  return { retiredRound: result.noop ? null : { retirementDir: path.resolve(result.retirementDir), retired: result.retired, sentinels: result.sentinels, dispatchPromptRecords: result.dispatchPromptRecords, findingsDirRetired: result.findingsDirRetired } };
}
