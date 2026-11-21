import { access } from "node:fs/promises";
import path from "node:path";
import { retireGateRound } from "./retire-gate-round.mjs";
import { buildGateFaninLedgerPath, buildGateReviewsDir, buildLogPath } from "./_gate-artifact-paths.mjs";

const exists = (file) => access(file).then(() => true, () => false);
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Retire the undispatched or partial round of one gate at one head, through retire-gate-round's logic, so a rebuilt
 * context or a re-emission mints a fresh round (GATE-EXEC-ROUND-RETIREMENT). A round with a posted verdict (a fan-in
 * ledger or a findings log at that head) is never retired: the result is a refusal with a `recovery` field.
 *
 * `tmpRoot` holds the sentinels, dispatch records and the round's artifacts; `verdictRoots` lists the roots whose
 * fan-in ledger or findings log mark a posted verdict (the ledger may live under the main worktree's tmp).
 * Returns `{ retiredRound }` (null when nothing was live) or `{ refusal: { error, recovery } }`.
 */
export async function retireStaleRound({ repo, pr, gate, headSha, tmpRoot, verdictRoots = [tmpRoot] }) {
  const head = String(headSha).trim().toLowerCase();
  if (!FULL_SHA_RE.test(head)) return { retiredRound: null };
  for (const root of verdictRoots) {
    const key = { repo, pr, gate, headSha: head, tmpRoot: root };
    for (const marker of [buildGateFaninLedgerPath(key), buildLogPath(key)]) {
      if (await exists(marker)) {
        return {
          refusal: {
            error: `GATE-EXEC-ROUND-RETIREMENT: refusing to retire the ${gate} round at head ${head}: a verdict is already recorded at ${marker}. A posted verdict is never retired automatically.`,
            recovery: `operator: confirm the verdict at ${marker} is superseded, then run \`node scripts/github/retire-gate-round.mjs --gate ${gate} --head-sha ${head} --reason "<why>" --repo ${repo} --pr ${pr}\``,
          },
        };
      }
    }
  }
  const findingsDir = buildGateReviewsDir({ repo, pr, gate, headSha: head, tmpRoot });
  const hasFindings = await exists(findingsDir);
  const result = await retireGateRound({
    gate, headSha: head, tmpRoot, repo, pr,
    reason: "automatic: the gate context was rebuilt or the round re-emitted at the same head before any verdict was recorded",
    ...(hasFindings ? { findingsDir } : { noFindingsArtifacts: true }),
  });
  return { retiredRound: result.noop ? null : { retirementDir: path.resolve(result.retirementDir), retired: result.retired, sentinels: result.sentinels, dispatchPromptRecords: result.dispatchPromptRecords, findingsDirRetired: result.findingsDirRetired } };
}
