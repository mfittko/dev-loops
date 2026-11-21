import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { retireGateRound } from "./retire-gate-round.mjs";
import { CHECKPOINT_SENTINEL_PREFIX } from "./verify-fresh-review-context.mjs";
import { gateScopePrefix } from "./_gate-names.mjs";
import { buildGateFaninLedgerPath, buildGateReviewsDir, buildLogPath } from "./_gate-artifact-paths.mjs";

const exists = (file) => access(file).then(() => true, () => false);
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The runnable retire-gate-round command for one round: the launcher, the full head, a fixed reason and every path
 * JSON-quoted (a checkout path with a space stays one argument). `findingsDir` null names the round by --repo and --pr.
 */
export function buildRetireCommand({ gate, headSha, tmpRoot, findingsDir = null, repo, pr, reason }) {
  return `dev-loops-run scripts/github/retire-gate-round.mjs --gate ${gate} --head-sha ${headSha} --reason ${JSON.stringify(reason)} --tmp-root ${JSON.stringify(tmpRoot)} ${findingsDir ? `--findings-dir ${JSON.stringify(findingsDir)}` : `--repo ${repo} --pr ${pr}`}`;
}

/**
 * Retire the undispatched or partial round of one gate at one head, through retire-gate-round's logic, so a rebuilt
 * context or a re-emission mints a fresh round (GATE-EXEC-ROUND-RETIREMENT). A round with a posted verdict (a fan-in
 * ledger or a findings log at that head) is never retired: the result is a refusal with a `recovery` field.
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
  const names = await readdir(tmpRoot).catch(() => []);
  const suffix = `-${head}.json`;
  const prefixes = [`${CHECKPOINT_SENTINEL_PREFIX}${gateScopePrefix(gate)}`, `checkpoint-dispatch-prompt-${gateScopePrefix(gate)}`];
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
  const result = await retireGateRound({ // the findings dir may live under another root than the sentinels
    gate, headSha: head, tmpRoot, repo, pr,
    reason: "automatic: the gate context was rebuilt or the round re-emitted at the same head before any verdict was recorded",
    ...(hasFindings ? { findingsDir } : { noFindingsArtifacts: true }),
  });
  return { retiredRound: result.noop ? null : { retirementDir: path.resolve(result.retirementDir), retired: result.retired, sentinels: result.sentinels, dispatchPromptRecords: result.dispatchPromptRecords, findingsDirRetired: result.findingsDirRetired } };
}
