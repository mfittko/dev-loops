import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildRevisionIdentity, specCriterionIds, stampSpecAuthorityIdentity } from "@dev-loops/core/loop/spec-authority";

/**
 * GATE-EXEC-JUDGE-SKIP-EMPTY: why a round must still run the judge, or null when it may skip.
 * A finding, a carried act item (prior-round unresolved act) and a recurrence escalation (which needs a finding) all require a judge.
 */
export function judgeSkipRefusal({ findings, priorActItems }) {
  if (findings.length > 0) return `${findings.length} consolidated finding(s) need a judge disposition`;
  if (priorActItems.length > 0) return `${priorActItems.length} carried act item(s) from prior rounds need a judge`;
  return null;
}

/** The judge-free round result: scope drift derived from the recorded spec identity, the skip recorded with its reason. */
export async function runJudgeSkip(options, resolvedRoot, { findings, overallVerdict, spec, priorActItems }) {
  const refusal = judgeSkipRefusal({ findings, priorActItems });
  if (refusal) throw new Error(`GATE-EXEC-JUDGE-SKIP-EMPTY: --judge-skip refused (fail closed): ${refusal}; run the judge pass`);
  const identity = spec ? buildRevisionIdentity({ spec, headSha: options.headSha, contentDigest: options.contentDigest }) : null;
  const reason = "the round has no consolidated findings and no carried act items, so there is nothing for the judge to dispose";
  const judgeSkipped = { reason, ...(identity ? { specDigest: identity.specDigest } : {}) };
  const scopeDrift = {
    verdict: "within_scope",
    rationale: `Judge skipped: ${reason}. Derived from ${identity ? `the recorded spec identity ${identity.specDigest}` : "the round with no spec identity"}.`,
    driftedAreas: [],
  };
  const record = { overallVerdict, findings: [], scopeDrift, judgeSkipped };
  const stamped = identity
    ? stampSpecAuthorityIdentity(record, { specDigest: identity.specDigest, headSha: identity.headSha, contentDigest: identity.contentDigest, checkedCriteria: specCriterionIds(spec) })
    : record;
  for (const [file, body] of [[options.ledgerOut, stamped], [options.out, []]]) {
    if (!file) continue;
    const target = path.resolve(resolvedRoot, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(body, null, 2)}\n`);
  }
  return {
    ok: true, gate: options.gate, repo: options.repo, pr: Number(options.pr), headSha: options.headSha,
    scopeDrift, counts: { act: 0, defer: 0, reject: 0 }, actCount: 0, act: [], judgeSkipped,
    // The caller passes this as --findings-summary so the posted gate comment says the judge was skipped and why.
    findingsSummary: `No findings. Judge skipped: ${reason}.`,
    ledgerOut: options.ledgerOut || undefined, out: options.out || undefined,
  };
}
