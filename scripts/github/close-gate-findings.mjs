#!/usr/bin/env node
import { parseArgs } from "node:util";
import { parseAllowedRefsCsv, requireTokenValue } from "../_cli-primitives.mjs";
import { containsBareCopilotSummon, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { listIssueComments, resolveAuthenticatedLogin, runGhJson, sanitizeInline } from "./post-gate-findings.mjs";
import {
  FINDING_MARKER_RE,
  countUnresolvedGateAuthoredThreads,
  collectFingerprints,
  commentDeferredFindings,
  fetchThreadsWithFullBodies,
  findJudgeDispositionForFingerprint,
  fingerprintFinding,
  isBelowInlineFloor,
  isDeferredAtRound,
  isFileableDeferral,
  listPrReviews,
  parseFindingMarker,
  parseRenderedJudgeDisposition,
  readGateFindingsLedger,
  resolveGateRound,
} from "./_gate-finding-surface.mjs";
import { replyAndMaybeResolve } from "./_review-thread-mutations.mjs";
import { resolveGateArtifactTmpRoot } from "../loop/_repo-root-resolver.mjs";
import { loadDevLoopConfig, resolveGateConfig, resolveTrackerProvider } from "@dev-loops/core/config";
import { GATE_CONFIG_KEY, isOpenActItem } from "@dev-loops/core/loop/gate-fanin";
import { neutralizeBareIssuePrIds } from "@dev-loops/core/github/comment-id-guard";

const USAGE = `Usage: close-gate-findings.mjs --ledger <findings-log path> [--tmp-root <dir>]
Run a closed gate round's THREAD DISPOSITION pass. This helper posts NO review of
its own: the round's single visible surface is the one PR review
upsert-checkpoint-verdict.mjs already posted (verdict-marker body + inline finding
comments). Its only other comment is ONE batched deferral comment per tool run
on a linked spec issue target (below; none on a PR target). Here, every unresolved gate-authored finding thread is reconciled
against the current round. A thread whose finding the judge disposed \`act\`
(current ledger first; on no match, the prior local ledgers, then the thread's
rendered judge suffix; an ambiguous result at either ledger tier, meaning
current-ledger duplicate-fingerprint entries that disagree or prior ledgers
that disagree, also skips) is never
selected, at any severity and round (ADR 0089): it gets no
stamp, no reply, no resolve, and no deferral entry, and stays open until the fixer
replies with the fixing commit or a decline reason and resolves it. Two exceptions: (1) a thread whose markers are all judge \`act\`
with remedyKind evidence_only is closed with an evidence-only reply (evidenceOnlyClosed); (2) a nit member
of a judge-deferred mixed cluster closes with the cluster rationale ("Closed at gate close"),
with no stamp and no filing. Otherwise only a thread whose every marker the judge
disposed \`defer\` is replied-to + resolved ("deferred at gate close"), whatever its
severity or round. Severity and round never defer a thread: the medium fix window
(default 3, set per gate via gates.<gate>.mediumFixWindow) is an
input to the judge, and an unjudged or ambiguous thread stays open. A question is
answered, never deferred, so an unanswered question blocks gate-close exactly like an open defect — with
ONE reject-close exception (ADR 0088): a question thread is closed here when BOTH
hold: (a) it carries a resolving ANSWER REPLY — a non-empty, non-automation, non-bot
comment on the thread other than its own finding/marker comment (identity is never
"author != this gate's login": a single-account setup can post the finding AND every
reply under the same login, so the reply is recognized by what it is — not gate
automation output, not a bot/System comment, and containing no unescaped @copilot or
/copilot* summon anywhere in its body (post the answer and any re-review summon as
separate replies) — never by who posted it; an unanswered question carries no such
comment and keeps blocking);
and (b) the judge's own disposition for that finding was
\`reject\` (resolved current-ledger-first, then a prior local findings-log
ledger for the same PR/gate, then the \` — judge: reject\` suffix already
rendered on the thread's own posted comment as a last resort — see
resolveJudgeRejection). The closing reply cites the judge's rejection
rationale when known, or a generic on-the-merits note when only the rendered
disposition token survived. A medium, low or nit defect thread the judge rejected
(same lookup) is closed the same way with no answer reply required; its reply
carries an Examined on merits rationale naming the summary and the judge
rationale (ADR 0144). A judge-rejected high is never closed here. This never stamps disposition=deferred and never
files the finding (a rejected finding is never fileable). Every
judge-deferred thread is filed to the deferral comment. The
round's FILEABLE deferrals (judge-deferred thread targets plus judge-deferred folded findings) go
as ONE batched comment on the linked spec issue (tracker.provider is github and
the PR has exactly one closing issue reference). A PR target posts no comment:
a folded entry is recorded by its Details marker in the verdict-body group it renders under (Deferred, Rejected or Not judged; only thread and Deferred-group markers carry issue=<pr>),
a stamped thread by its thread marker (issue=<pr>) plus resolving reply. This tool never creates an issue. A fingerprint the
target already lists is not appended again. A FILED thread's marker is stamped
\`disposition=deferred issue=<n>\` (n = the target's number) before it is resolved, so
on a linked-issue target the deferral is never parked only in the thread marker and the ephemeral tmp
findings ledger (on a PR target a stamped thread's marker and resolving reply are the record). A contract-violating disposition=deferred stamp — on a thread the judge did not
dispose defer (a subagent bypass of
selectDispositionTargets/isFileableDeferral), or missing its target number — is
detected and rejected before the pass runs.

Round number = the MAXIMUM of three worktree-independent-first sources:
  (A) count of DISTINCT reviewed-head SHAs across this gate's own verdict surfaces —
      PR review bodies (repos/.../pulls/.../reviews) plus issue comments
      (repos/.../issues/.../comments, the legacy verdict surface) — deduped and
      unioned with the ledger's own head so the same head counts once;
  (B) the highest round= recorded on this gate's own posted review headers (the
      "gate-findings-review <gate>" marker, so it can never mix rounds across gates);
  (C) count of local <gate>-*.json findings-log files under --tmp-root/gate-findings/....
(A) is primary and survives a fresh worktree/clone; (B) and (C) are cross-checks that
can only push the round number UP, never down, guarding against an undercount.

Required:
  --ledger <path>              Path to a write-gate-findings-log.mjs JSON ledger:
                                { repo, pr, gate, headSha, verdict, findings[] }
                                repo/pr/gate/headSha are derived from the ledger itself.
Optional:
  --tmp-root <path>            Root tmp directory for the local findings-log fallback
                                count. Omitted, it resolves to the MAIN worktree's tmp/
                                (the stable per-repo ledger location); an explicit path overrides.
  --allowed-refs <csv>         Explicit allowlist of issue/PR ids a disposition reply
                                body may cite (same shape/semantics as
                                reply-resolve-review-thread): the bare-#N comment-id
                                guard opens only for these ids (e.g. the PR's own
                                governing issue quoted in a deferred finding's
                                summary). Without it, un-whitelisted bare refs stay
                                fail-closed.

Output (stdout, JSON):
  { "ok": true, "repo": "...", "pr": 42, "gate": "...", "headSha": "...", "round": N,
    "deferredResolved": <threads the judge deferred, plus nit members of a judge-deferred cluster, reply+resolved this pass; 0 when none qualify>,
    "evidenceOnlyClosed": <threads whose every marker is a judge act with remedyKind evidence_only, reply+resolved with no stamp and no filing; 0 when none qualify>,
    "rejectClosed": <answered, judge-rejected question threads and judge-rejected medium/low/nit defect threads reply+resolved this pass (ADR 0088, 0144); 0 when none qualify>,
    "unresolvedGateThreadCount": <gate-authored threads still unresolved after the defer, reject-close and evidence-only passes; the gate-close assertion (fetchDraftGateEvidence / ready-for-review) refuses ready-for-review while non-zero (#1585); folded findings (#2263) never create a thread, so they never enter this count>,
    "foldedFiled": <#2263: folded (below gates.<gate>.inlineSeverityFloor) non-nit findings the judge disposed defer, newly listed in the deferral comment this pass, from the ledger directly (they carry no thread of their own); on a PR target no comment is posted and it counts the folded entries recorded in the verdict body's Details block under any group (Deferred, Rejected or Not judged; only a Deferred-group marker carries issue=<pr>); a nit is never filed>,
    "followUpIssueNumber"?: <the deferral target number (the linked spec issue the comment goes to, or the PR itself, which gets no comment); present when the round had a fileable thread target OR a fileable folded finding>,
    "dispositionFailures"?: [ { "commentId": ..., "threadId": "...", "severity": "...", "angle": "...", "error": "..." } ] <present only when a target's reply could not be built/posted; that thread stays unresolved rather than deadlocking the batch (#1882)> }

${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error or gh failure
  2  Invalid --jq filter`.trim();

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

// ---------------------------------------------------------------------------
// Disposition pass
// ---------------------------------------------------------------------------

// Scan every unresolved gate-authored thread for a disposition=deferred
// stamp that the judge never set (its cluster is not disposed `defer`) or that
// carries no linked deferral comment target number — the signature of a
// subagent bypassing the sanctioned pass via a direct gh api PATCH. Detected
// BEFORE the disposition pass runs, so it surfaces as a gate failure rather
// than a silent reply+resolve or a false clean-deferral count
// (GATE-EXEC-THREAD-DISPOSITION).
async function detectContractViolatingDeferredStamps(threads, login, findings, lookup) {
  const violations = [];
  for (const thread of threads) {
    // Only unresolved threads: a resolved thread may have been legitimately
    // deferred by a PRIOR gate, and the marker carries no cross-gate
    // provenance, so scanning resolved threads would false-positive across
    // gates with no recovery path. This catches the stamp-only bypass;
    // stampDeferredDisposition's own guard catches stamp+resolve on the
    // sanctioned path, and a raw gh-api bypass is a process violation no code
    // guard can mechanically prevent.
    if (thread.isResolved) continue;
    if (thread.author !== login) continue;
    const marker = parseFindingMarker(thread.body);
    if (!marker) continue;
    if (marker.disposition !== "deferred") continue;
    // Severity floor: a nit, high or question is never deferred, whatever the ledger says.
    // No ledger evidence (tmp wiped, other host) is not a violation: only a ledger that
    // contradicts the stamp is.
    const belowFloor = marker.severity === "nit" || marker.severity === "high" || marker.severity === "question";
    const notJudgeDeferred = belowFloor || await ledgerContradictsDeferral(marker.fp, thread.body, findings, lookup);
    const missingIssue = !Number.isInteger(marker.issue) || marker.issue <= 0;
    if (notJudgeDeferred || missingIssue) {
      violations.push({
        threadId: thread.threadId,
        commentId: thread.commentId,
        severity: marker.severity,
        issue: marker.issue,
        reason: notJudgeDeferred ? "not-judge-deferred" : "missing-issue-link",
      });
    }
  }
  if (violations.length > 0) {
    const details = violations
      .map((v) => `thread ${v.threadId} (comment ${v.commentId}): severity=${v.severity} carries disposition=deferred, reason=${v.reason}${v.issue ? ` (issue=${v.issue})` : ""}`)
      .join("; ");
    throw new Error(`GATE-EXEC-THREAD-DISPOSITION violation: ${violations.length} gate-authored thread(s) carry a contract-violating disposition=deferred stamp (${details}). Only a cluster the judge disposed defer may be stamped deferred, whatever its severity or round, and every disposition=deferred stamp must link its deferral comment target number. Refuse to proceed with the disposition pass.`);
  }
}

// The reply-body prefixes this file posts are two (dispositionMessage and
// rejectCloseMessage below); the third ("Resolved at gate close (") is kept only
// to recognize historical unfiled-resolution replies. This is the single source
// hasAnswerReply's automation-reply exclusion (ADR 0088) reads, so that
// exclusion can never drift from what these builders actually emit.
const GATE_DEFERRED_REPLY_PREFIX = "Deferred at gate close (";
const GATE_UNFILED_RESOLUTION_REPLY_PREFIX = "Resolved at gate close (";
const GATE_REJECT_CLOSE_REPLY_PREFIX = "Closed at gate close (";
const GATE_AUTOMATION_REPLY_PREFIXES = Object.freeze([
  GATE_DEFERRED_REPLY_PREFIX,
  GATE_UNFILED_RESOLUTION_REPLY_PREFIX,
  GATE_REJECT_CLOSE_REPLY_PREFIX,
]);

function isGateAutomationReply(body) {
  const trimmed = body.trim();
  return GATE_AUTOMATION_REPLY_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

// Only ever called for a deferred target. Each
// reply is distinct by construction (fingerprint/severity/angle plus the
// window reason) and names the deferral comment on a linked-issue target, or the
// thread marker (issue=<pr>) on a PR target (GATE-EXEC-DEFERRAL-RECORD).
function dispositionMessage({ fp, severity, angle, round, repo, pr, issueNumber, body, judgeReason, judgeRationale }) {
  const meritRationale = buildMeritRationale({ body, judgeReason, judgeRationale });
  return `${GATE_DEFERRED_REPLY_PREFIX}round ${round}, fingerprint ${fp}, severity ${severity}, angle ${angle}): ${meritRationale} the judge deferred this finding as outside this PR's scope; ${issueNumber === pr ? `recorded in this thread's marker (issue=${pr}).` : `recorded in the deferral comment on https://github.com/${repo}/issues/${issueNumber}.`}`;
}


// A severity/round rule only selects an eligible disposition boundary, not a
// per-finding reason to close, so every resolve-without-fix reply must record
// the rendered finding summary rather than a bare severity label (GATE-EXEC-THREAD-DISPOSITION).
function extractFindingSummary(body) {
  // The fixed inline layout carries the summary on its `**Problem:**` line;
  // a body posted before that layout keeps the single-line form.
  const match = typeof body === "string"
    ? (body.match(/^\*\*Problem:\*\*\s+(.+)$/mu) ?? body.match(/^\*\*[^*\n]+\*\*\s+\(`[^`\n]+`\):\s+(.+)$/mu))
    : null;
  const summary = match?.[1]?.replace(/\s+— judge:.*$/u, "").trim();
  if (!summary) {
    throw new Error("GATE-EXEC-THREAD-DISPOSITION violation: selected finding has no parseable finding summary; refuse severity-only closure");
  }
  return summary;
}

export function buildMeritRationale({ body, judgeReason, judgeRationale }) {
  // Collapse any embedded double quote to a single quote: the summary is
  // wrapped in literal double quotes below and sanitizeInline does not escape
  // `"` (no injection risk — cosmetic only, avoids confusing nested quotes).
  const summary = sanitizeInline(extractFindingSummary(body)).replace(/"/g, "'");
  // The visible reason is the judge's own words, never a text derived from severity or round.
  const judgeText = [judgeReason, judgeRationale].find((t) => typeof t === "string" && t.trim().length > 0);
  const reason = judgeText
    ? sanitizeInline(neutralizeBareIssuePrIds(judgeText.trim())).replace(/[.\s]+$/u, "")
    : "the judge recorded no reason text for this disposition";
  return `Examined on merits: \"${summary}\" was reviewed against current scope and acceptance criteria; ${reason}.`;
}

// Every currently-unresolved gate-authored thread — newly posted this round
// or carried open from an earlier one — is reconciled against the CURRENT
// round, not the round recorded on its own marker.
//
// A thread whose finding the judge disposed `act` is never selected, whatever
// its severity and round (ADR 0089): the judge `act` overrides the medium fix
// window, so the thread stays open until the fixer replies with the fixing
// commit or a decline reason and resolves it, or a judge rerun at the current head changes the
// disposition. It gets no stamp, reply, or resolve. The disposition comes
// from the current ledger first. On no current-ledger match, the prior local
// ledgers and then the thread's rendered ` — judge: <disposition>` suffix
// decide (a posted finding is suppressed from later ledgers). An ambiguous
// prior-ledger result also skips the thread (fail closed).
//
// Fingerprints are not unique per ledger (two angles can share one), so the
// current-ledger tier keeps the thread open when any match is `act` OR the
// matches disagree (mixed or partly missing dispositions): an ambiguous
// current result fails closed, like the prior-ledger tier. Returns null when
// the current ledger has no match.
function currentLedgerActOrAmbiguous(findings, fp) {
  const currentMatches = findings.filter((f) => f && findingFingerprintMatches(f, fp));
  if (currentMatches.length === 0) return null;
  const dispositions = new Set(currentMatches.map((f) => (typeof f.judgeDisposition === "string" ? f.judgeDisposition.trim() : "")));
  return currentMatches.some(isOpenActItem) || dispositions.size > 1;
}

async function selectDispositionTargets(threads, login, findings = [], lookup = {}) {
  const targets = [];
  for (const thread of threads) {
    if (thread.isResolved) continue;
    // Gate-authored is decided by AUTHOR IDENTITY (the authenticated `gh`
    // viewer's login), never by rendered marker text: a foreign comment can
    // quote the same marker shape, and this result gets PATCHed/resolved —
    // trusting marker text alone would be a forgery vector.
    if (thread.author !== login) continue;
    const marker = parseFindingMarker(thread.body);
    if (!marker) continue; // author matches, but carries no parseable finding marker
    // A high and a question are never deferred (GATE-EXEC-THREAD-DISPOSITION), even if a ledger says defer.
    if (marker.severity === "high" || marker.severity === "question") continue;
    // Only a thread whose every marker the judge disposed `defer` is deferred, whatever
    // its severity or round. An act, rejected, unjudged or ambiguous thread is never selected.
    const judgement = await resolveThreadDisposition("defer", { fp: marker.fp, threadBody: thread.body, findings, ...lookup });
    if (!isDeferredAtRound(judgement?.disposition)) continue;
    // commentId is null whenever list-review-threads.mjs could not resolve a
    // finite databaseId for the thread's first comment. Reject it here (named
    // by threadId) rather than let it reach stampDeferredDisposition and
    // interpolate into `pulls/comments/null`.
    if (!Number.isInteger(thread.commentId) || thread.commentId <= 0) {
      throw new Error(`Thread ${thread.threadId} carries a gate-authored finding marker selected for deferral but has no resolvable comment id (commentId=${JSON.stringify(thread.commentId)}); refuse to stamp/resolve it.`);
    }
    targets.push({
      threadId: thread.threadId,
      commentId: thread.commentId,
      severity: marker.severity,
      angle: marker.angle,
      fp: marker.fp,
      judgeDisposition: judgement.disposition,
      judgeReason: judgement.reason ?? null,
      judgeRationale: judgement.rationale ?? null,
      body: thread.body,
    });
  }
  return targets;
}

// Stamp `disposition=deferred` onto the thread's line-1 marker before the
// resolve, distinguishing a deferred thread from one the fix loop resolved
// with a fixing commit. The already-stamped guard parses the marker's own
// `disposition` field, never a free-text body search, so a finding whose
// summary happens to quote that literal token is never mistaken for a stamp.
async function stampDeferredDisposition({ repo, commentId, judgeDisposition, issueNumber }, { env, ghCommand, runChild }) {
  const payload = await runGhJson(["api", `repos/${repo}/pulls/comments/${commentId}`], { env, ghCommand, runChild });
  // Trimmed to match parseReviewThreads' normalizeBody — the same
  // normalization selectDispositionTargets parsed thread.body through — so
  // this and that pass agree on whether `^` (FINDING_MARKER_RE is line-start
  // anchored) matches a marker preceded by leading whitespace.
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  const marker = parseFindingMarker(body);
  if (!marker) {
    throw new Error(`Review comment ${commentId} was selected as a deferral target but no longer carries a parseable finding marker; refuse to resolve it unstamped.`);
  }
  // Defense-in-depth: validate that this severity/round/operator-visibility
  // actually clears the filing bar BEFORE stamping or skipping.
  // runDispositionPass only calls this for a FILEABLE target, so this should
  // never fire in normal flow; it catches a direct/manual bypass call, where
  // skipping silently would proceed straight to reply+resolve (GATE-EXEC-THREAD-DISPOSITION).
  if (!isFileableDeferral(judgeDisposition)) {
    throw new Error(`Review comment ${commentId} carries no judge defer disposition (judgeDisposition=${judgeDisposition}); refuse to stamp or resolve a contract-violating disposition=deferred (GATE-EXEC-THREAD-DISPOSITION).`);
  }
  if (marker.disposition === "deferred") {
    // Already stamped (an idempotent retry) must link the SAME deferral comment
    // target this pass resolved for the round's batch; a mismatch fails closed
    // rather than silently leaving a stale/wrong link on the thread (GATE-EXEC-DEFERRAL-RECORD).
    if (marker.issue !== issueNumber) {
      throw new Error(`Review comment ${commentId} is already stamped disposition=deferred issue=${marker.issue} but this pass resolved deferral comment target ${issueNumber}; refuse to overwrite the existing link (GATE-EXEC-THREAD-DISPOSITION).`);
    }
    return;
  }
  // Every disposition=deferred stamp links a deferral comment target number — never
  // resolve a thread's deferral into the marker + ephemeral tmp ledger alone (GATE-EXEC-DEFERRAL-RECORD).
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Review comment ${commentId} would be stamped disposition=deferred with no linked deferral comment target number; refuse (GATE-EXEC-THREAD-DISPOSITION).`);
  }
  const stamped = body.replace(FINDING_MARKER_RE, (m) => m.replace(/\s*-->$/, ` disposition=deferred issue=${issueNumber} -->`));
  await runGhJson(
    ["api", "-X", "PATCH", `repos/${repo}/pulls/comments/${commentId}`, "-f", `body=${stamped}`],
    { env, ghCommand, runChild },
  );
}

// `snapshot` is the full-body review-thread snapshot the caller already
// fetched alongside `threads` (fetchThreadsWithFullBodies) — reused as the
// reply-target validation snapshot rather than re-fetched. `foldedEntries`
// are the folded findings that clear the filing bar
// (selectFoldedFileableEntries); on a linked spec issue target they share the
// round's batched deferral comment with the fileable thread targets (a PR
// target posts no comment).
async function runDispositionPass({ repo, pr, gate, headSha, tmpRoot, repoRoot, round, threads, snapshot, login, findings = [], foldedEntries = [], trackerProvider, allowedRefs = [] }, { env, ghCommand, runChild }) {
  // GATE-EXEC-THREAD-DISPOSITION: Before stamping, detect any contract-violating disposition=deferred
  // stamps already present on gate-authored threads (a subagent bypass).
  await detectContractViolatingDeferredStamps(threads, login, findings, { repo, pr, gate, headSha, tmpRoot, repoRoot });
  const targets = await selectDispositionTargets(threads, login, findings, { repo, pr, gate, headSha, tmpRoot, repoRoot });
  // Every target is a judge-deferred thread. Every non-nit target is recorded on the
  // deferral comment target and stamped disposition=deferred; a nit is the one no-stamp thread.
  // A nit member of a deferred mixed cluster is never stamped or filed (GATE-EXEC-THREAD-DISPOSITION); it is resolved with the cluster rationale.
  const nitTargets = targets.filter((target) => isFileableDeferral(target.judgeDisposition) && target.severity === "nit");
  const fileableTargets = targets.filter((target) => isFileableDeferral(target.judgeDisposition) && target.severity !== "nit");

  // Build (and thereby validate) every reply BEFORE any mutating GitHub call:
  // a throw after the PATCH/comment would leave a target stamped-but-unresolved
  // and deadlock every retry. A target whose reply cannot be built (or whose
  // GitHub call later fails) is recorded in dispositionFailures and stays
  // unresolved — blocking gate-close for that thread alone, not the rest of the
  // batch (GATE-EXEC-THREAD-DISPOSITION).
  const dispositionFailures = [];
  const recordFailure = (target, err) => {
    dispositionFailures.push({
      commentId: target.commentId,
      threadId: target.threadId,
      severity: target.severity,
      angle: target.angle,
      error: err instanceof Error ? err.message : String(err),
    });
  };
  // Partition off any fileable target whose merit rationale cannot be built —
  // BEFORE the deferral comment, so an unresolvable target is never recorded
  // on a target it can never be replied against (GATE-EXEC-THREAD-DISPOSITION).
  const buildableFileable = [];
  for (const target of fileableTargets) {
    try {
      buildMeritRationale({ body: target.body, judgeReason: target.judgeReason, judgeRationale: target.judgeRationale });
      buildableFileable.push(target);
    } catch (err) {
      recordFailure(target, err);
    }
  }

  // ONE batched comment per round on a linked spec issue target (a PR target
  // posts no comment), posted BEFORE any stamp/resolve so a crash never
  // resolves a thread whose deferral was not recorded. A fingerprint the
  // target already lists is not appended again, so a retry is idempotent.
  // No issue is ever created (GATE-EXEC-DEFERRAL-RECORD).
  const entries = [
    ...buildableFileable.map((target) => ({
      fingerprint: target.fp,
      severity: target.severity,
      angle: target.angle,
      refUrl: `https://github.com/${repo}/pull/${pr}#discussion_r${target.commentId}`,
    })),
    ...foldedEntries,
  ];
  let issueNumber;
  let foldedFiled = 0;
  if (entries.length > 0) {
    const posted = await commentDeferredFindings(
      { repo, pr, entries, trackerProvider },
      { env, ghCommand, run: runChild },
    );
    issueNumber = posted.issueNumber;
    foldedFiled = foldedEntries.filter((entry) => posted.appendedFingerprints.has(entry.fingerprint)).length;
  }

  let deferredResolved = 0;
  // The message is built first, so a per-target failure never lands a stamp
  // without its reply.
  for (const target of buildableFileable) {
    try {
      const message = dispositionMessage({ fp: target.fp, severity: target.severity, angle: target.angle, round, repo, pr, issueNumber, body: target.body, judgeReason: target.judgeReason, judgeRationale: target.judgeRationale });
      await stampDeferredDisposition({ repo, commentId: target.commentId, judgeDisposition: target.judgeDisposition, issueNumber }, { env, ghCommand, runChild });
      await replyAndMaybeResolve(
        { repo, pr, commentId: target.commentId, threadId: target.threadId, body: message, resolve: true, validatedSnapshot: snapshot, allowedRefs },
        { env, ghCommand, runChild },
      );
      deferredResolved += 1;
    } catch (err) {
      recordFailure(target, err);
    }
  }
  for (const target of nitTargets) {
    try {
      const message = `${GATE_REJECT_CLOSE_REPLY_PREFIX}round ${round}, fingerprint ${target.fp}, severity nit, angle ${target.angle}): ${buildMeritRationale({ body: target.body, judgeReason: target.judgeReason, judgeRationale: target.judgeRationale })} A nit is never deferred or filed, so this thread closes with the cluster rationale.`;
      await replyAndMaybeResolve(
        { repo, pr, commentId: target.commentId, threadId: target.threadId, body: message, resolve: true, validatedSnapshot: snapshot, allowedRefs },
        { env, ghCommand, runChild },
      );
      deferredResolved += 1;
    } catch (err) {
      recordFailure(target, err);
    }
  }
  const result = { deferredResolved, foldedFiled };
  if (issueNumber !== undefined) result.followUpIssueNumber = issueNumber;
  if (dispositionFailures.length > 0) result.dispositionFailures = dispositionFailures;
  return result;
}

// ---------------------------------------------------------------------------
// Reject-close pass: an answered judge-rejected `question` (ADR 0088) or a
// judge-rejected medium, low or nit defect thread (ADR 0144)
// ---------------------------------------------------------------------------
//
// A `question` thread is NEVER selected by selectDispositionTargets above
// (a question is never deferred, whatever the ledger says) —
// it is answered, never deferred. Without this pass, a question the judge
// REJECTED (so it never entered the fixer's act list, and the fixer's own
// answer-and-resolve path is never invoked for it — GATE-EXEC-ACT-LIST-SCOPE,
// out of scope to change) had no sanctioned resolution path at all once
// someone answered it: unresolvedGateThreadCount could never reach 0. This
// pass closes that case and, per ADR 0144, a medium, low or nit defect thread whose
// every marker resolves to reject (a high is never reject-closed). An
// unanswered question, or an answered question the judge did NOT reject, is
// untouched and keeps blocking.

// A resolving ANSWER REPLY: a non-empty comment on the thread OTHER than its
// own finding/marker comment (thread.commentId). `comments` is the FULL
// per-thread comment list (fetchThreadsWithFullBodies' underlying
// snapshot.comments) — every comment past the thread's own first (marker)
// comment is structurally a reply (GitHub review threads have exactly one
// top-level comment). An unanswered question carries no such comment.
//
// Identity is NEVER "author != this gate's login" (a single-account setup —
// the gate, the fixer, and the operator all posting as the same authenticated
// login — makes that check untrue for every reply on the reproducing PR: the
// finding AND every reply share one login, so the pass could never fire).
// Instead this asks "is this reply itself gate automation output, or a
// genuine reply": c.isActionable (packages/core/src/github/review-threads.mjs)
// already excludes a bot author (isBot/`[bot]` login/Bot typename) and a
// System/ghost author (empty login) and an empty-or-whitespace-only body —
// reused here rather than re-implementing the same three checks. On top of
// that: a comment carrying the gate's own finding-marker shape
// (parseFindingMarker) or starting with one of this file's own automation
// reply prefixes (GATE_AUTOMATION_REPLY_PREFIXES — the disposition, reject-
// close, or nit/low resolution replies this file itself posts) is the gate
// talking to itself, not an answer; and a reply that CONTAINS a bare
// `@copilot`/`/copilot*` summon ANYWHERE in its body (containsBareCopilotSummon
// scans the whole comment, not just a summon-only body) is a re-review
// trigger, not an answer — fail-safe by design: a reply that mixes a real
// answer with a summon is still excluded, erring toward "unanswered" rather
// than risking a false-positive reject-close.
function hasAnswerReply(thread, comments) {
  const markerCommentId = String(thread.commentId);
  return comments.some((c) => {
    if (c.threadId !== thread.threadId) return false;
    if (c.databaseId === null || c.databaseId === markerCommentId) return false;
    if (!c.isActionable) return false;
    if (parseFindingMarker(c.body)) return false;
    if (isGateAutomationReply(c.body)) return false;
    if (containsBareCopilotSummon(c.body)) return false;
    return true;
  });
}

function isRejectClosableSeverity(severity) {
  return severity === "medium" || severity === "low" || severity === "nit";
}

// Every unresolved, gate-authored question, medium, low or nit thread (ADR 0144; a high is never
// reject-closed). Narrowing to "answered" (questions only, hasAnswerReply) and "judge-rejected"
// (resolveJudgeRejection) happens in the caller; this step only checks identity and marker shape,
// mirroring selectDispositionTargets above.
function selectRejectCloseCandidates(threads, login) {
  const candidates = [];
  for (const thread of threads) {
    if (thread.isResolved) continue;
    if (thread.author !== login) continue;
    const marker = parseFindingMarker(thread.body);
    if (!marker || (marker.severity !== "question" && !isRejectClosableSeverity(marker.severity))) continue;
    // An invalid commentId is kept: runRejectClosePass names it in dispositionFailures once the judge rejects it.
    candidates.push({ threadId: thread.threadId, commentId: thread.commentId, severity: marker.severity, fp: marker.fp, angle: marker.angle, body: thread.body });
  }
  return candidates;
}

function findingFingerprintMatches(finding, fp) {
  try {
    return fingerprintFinding(finding) === fp;
  } catch {
    return false; // A malformed finding (no usable summary) can never fingerprint-match.
  }
}

// Tiered judge-disposition/rationale lookup for a reject-close candidate's
// fingerprint: (1) the CURRENT round's own ledger findings (cheapest, already
// in memory); (2) a PRIOR round's local findings-log ledger file for the SAME
// repo/pr/gate (findJudgeDispositionForFingerprint, _gate-finding-surface.mjs
// — the judge may have rejected the finding several rounds ago); (3) the
// ` — judge: <disposition>` suffix already rendered on the thread's own
// posted comment (parseRenderedJudgeDisposition), which survives a fresh
// worktree/clone with no local ledger history but carries no rationale text.
// Every tier is tried in this order because judgeRationale — needed for the
// closing reply's citation — lives ONLY in the ledger, never in the rendered
// comment; tier 3 alone would always find the disposition but never the
// rationale.
//
// Tier 1 STOPS (returns null, never falls through to tier 2/3) the moment the
// CURRENT ledger has ANY finding matching this fingerprint, whether or not
// that finding carries a usable judgeDisposition: a missing/empty/ambiguous
// disposition on a fingerprint the current round already knows about is not
// a cache miss, and letting an older ledger or a stale rendered suffix
// resolve it would violate tier-1 precedence (ADR 0088). Tier 2/3 are only
// ever reached when the current ledger has NO match for the fingerprint at
// all.
//
// Tier 2 (findJudgeDispositionForFingerprint) returns a distinct
// `{ ambiguous: true }` shape when prior ledgers disagree with no decidable
// winner (a tie on the greatest loggedAt, or a disagreement with no usable
// loggedAt at all) — that is a STOP, never a tier-3 fallthrough (ADR 0088): a
// stale render-time ` — judge: reject` suffix (tier 3) is only a snapshot of
// whatever the finding's FIRST posting recorded, and letting it win on an
// ambiguity tier 2 already flagged would reject-close a thread that this
// pass cannot actually resolve on the merits. A plain `null` (no matching
// prior ledger at all) is a genuine cache miss and still falls through.
async function resolveJudgeRejection({ fp, threadBody, findings, repo, pr, gate, headSha, tmpRoot, repoRoot, allowRendered = true }) {
  // Fingerprint match FIRST, independent of whether judgeDisposition is
  // present — a current-ledger finding this round already knows about (by
  // fingerprint) is never a tier-2/3 cache miss, even when the judge hasn't
  // disposed it yet (or its disposition field is malformed/empty). Filtering
  // on a non-empty judgeDisposition in the SAME pass as the fingerprint match
  // (the prior shape) made an undisposed current-ledger finding invisible to
  // `currentMatches`, so it fell through to a PRIOR round's ledger or the
  // rendered `judge: reject` suffix — stale evidence, and a violation of
  // tier-1 precedence / the no-resolution-without-a-recorded-disposition
  // rule (ADR 0088).
  const currentMatches = findings.filter((f) => f && findingFingerprintMatches(f, fp));
  if (currentMatches.length > 0) {
    // fingerprintFinding hashes only files[0] + the normalized summary, and
    // the ledger does not dedupe by fingerprint — two angles can share one
    // fingerprint with different judge dispositions in the SAME ledger.
    // findings.find() would pick whichever comes first in array order,
    // fail open on ng:0 for one of the two, and disagree with tier 2's own
    // `{ ambiguous: true }` stop on the identical case. Collect every
    // disposition (missing/empty normalized to "") and stop — fail closed,
    // never fall through to tier 2/3 — when ANY match lacks a disposition or
    // when the present dispositions disagree.
    const dispositions = currentMatches.map((f) =>
      typeof f.judgeDisposition === "string" ? f.judgeDisposition.trim() : "",
    );
    if (dispositions.some((d) => d.length === 0)) return null;
    if (new Set(dispositions).size > 1) return null;
    const current = currentMatches[0];
    const rationale = typeof current.judgeRationale === "string" && current.judgeRationale.trim().length > 0
      ? current.judgeRationale.trim()
      : null;
    const reason = typeof current.judgeReason === "string" && current.judgeReason.trim().length > 0 ? current.judgeReason.trim() : null;
    const remedyKind = currentMatches.every((f) => f.remedyKind === "evidence_only") ? "evidence_only" : null;
    return { disposition: dispositions[0], rationale, reason, ...(remedyKind ? { remedyKind } : {}) };
  }
  const prior = await findJudgeDispositionForFingerprint({ repo, pr, gate, headSha, tmpRoot, repoRoot, fp });
  if (prior?.ambiguous) return null;
  if (prior) return prior;
  // The rendered suffix ends the line that carries the reviewer's untrusted summary, so it never authorizes a defer (ledger evidence only).
  if (!allowRendered) return null;
  const rendered = parseRenderedJudgeDisposition(threadBody);
  return rendered ? { disposition: rendered, rationale: null, reason: null } : null;
}

// The single ownership rule the defer and reject passes read: a thread is owned by a judge
// disposition only when EVERY finding marker on its root (a merged inline comment carries one
// per member) resolves to it. Returns the primary marker's judgement (it supplies the closing
// rationale), else null so the thread stays open.
async function resolveThreadDisposition(wanted, { fp, threadBody, ...rest }) {
  const fps = new Set([fp]);
  collectFingerprints(threadBody, fps);
  let primary = null;
  for (const memberFp of fps) {
    // The rendered header suffix (tier 3) carries only the primary's disposition, so a
    // non-primary member never reads it: with no ledger evidence the thread stays open.
    const judgement = await resolveJudgeRejection({ fp: memberFp, threadBody: memberFp === fp ? threadBody : "", allowRendered: wanted !== "defer", ...rest });
    if (judgement?.disposition !== wanted) return null;
    // An act owns a closing thread only as an evidence-only remedy; any open act keeps the thread open.
    if (wanted === "act" && judgement.remedyKind !== "evidence_only") return null;
    primary ??= judgement;
  }
  return primary;
}

// True when ledger evidence for any marker on the thread carries a disposition other than defer.
async function ledgerContradictsDeferral(fp, threadBody, findings, lookup) {
  const fps = new Set([fp]);
  collectFingerprints(threadBody, fps);
  for (const memberFp of fps) {
    // The current ledger is authoritative: a match that is unjudged or not uniformly defer contradicts the stamp.
    const currentDispositions = findings.filter((f) => f && findingFingerprintMatches(f, memberFp)).map((f) => (typeof f.judgeDisposition === "string" ? f.judgeDisposition.trim() : ""));
    if (currentDispositions.length > 0 && currentDispositions.some((d) => d !== "defer")) return true;
    const judgement = await resolveJudgeRejection({ fp: memberFp, threadBody: "", allowRendered: false, findings, ...lookup });
    if (judgement && judgement.disposition !== "defer") return true;
  }
  return false;
}

const resolveThreadRejection = (args) => resolveThreadDisposition("reject", args);

const NO_EVIDENCE_ONLY_RATIONALE_TEXT = "the judge recorded no rationale text for this evidence-only remedy";

// Evidence-only act close (GATE-EXEC-THREAD-DISPOSITION): a gate-authored thread whose every
// marker the judge disposed `act` with remedyKind evidence_only never reaches the fixer (isOpenActItem),
// so this pass replies and resolves it with no stamp and no filing.
async function runEvidenceOnlyClosePass({ repo, pr, gate, headSha, round, threads, snapshot, login, findings, tmpRoot, repoRoot, allowedRefs = [] }, { env, ghCommand, runChild }) {
  let evidenceOnlyClosed = 0;
  const dispositionFailures = [];
  for (const thread of threads) {
    if (thread.isResolved || thread.author !== login) continue;
    const marker = parseFindingMarker(thread.body);
    if (!marker) continue;
    const failure = (error) => dispositionFailures.push({ commentId: thread.commentId, threadId: thread.threadId, severity: marker.severity, angle: marker.angle, error: error instanceof Error ? error.message : String(error) });
    try {
      const judgement = await resolveThreadDisposition("act", { fp: marker.fp, threadBody: thread.body, findings, repo, pr, gate, headSha, tmpRoot, repoRoot });
      if (!judgement) continue;
      if (!Number.isInteger(thread.commentId) || thread.commentId <= 0) {
        failure(`evidence-only act thread ${thread.threadId} has no valid root commentId (${String(thread.commentId)}); left open`);
        continue;
      }
      const summary = sanitizeInline(extractFindingSummary(thread.body)).replace(/"/g, "'");
      const rationale = sanitizeInline(neutralizeBareIssuePrIds(judgement.rationale ?? NO_EVIDENCE_ONLY_RATIONALE_TEXT)).replace(/[.\s]+$/u, "");
      const message = `${GATE_REJECT_CLOSE_REPLY_PREFIX}round ${round}, fingerprint ${marker.fp}, severity ${marker.severity}, angle ${marker.angle}): Examined on merits: "${summary}" was accepted by the judge with an evidence-only remedy, so no file change applies — ${rationale}.`;
      await replyAndMaybeResolve(
        { repo, pr, commentId: thread.commentId, threadId: thread.threadId, body: message, resolve: true, validatedSnapshot: snapshot, allowedRefs },
        { env, ghCommand, runChild },
      );
      evidenceOnlyClosed += 1;
    } catch (err) {
      failure(err);
    }
  }
  return { evidenceOnlyClosed, dispositionFailures };
}

const NO_JUDGE_RATIONALE_TEXT = "the judge rejected this finding on its merits; no rationale text is recorded for it";

// judgeRationale is untrusted free text (the same trust boundary as a
// finding's summary/angle, formatDeferredFindingEntry above): a rationale
// citing a bare issue/PR reference would otherwise throw inside
// replyAndMaybeResolve's own guardCommentBodyNoIssuePrIds call, leaving the
// thread unresolved and re-deadlocking on every rerun (ADR 0088) —
// neutralizeBareIssuePrIds runs on the raw text, before sanitizeInline, for
// the same reason formatDeferredFindingEntry orders them that way.
function rejectCloseMessage({ fp, severity, angle, round, rationale, body }) {
  const rationaleText = sanitizeInline(neutralizeBareIssuePrIds(rationale ?? NO_JUDGE_RATIONALE_TEXT));
  const head = `${GATE_REJECT_CLOSE_REPLY_PREFIX}round ${round}, fingerprint ${fp}, severity ${severity}, angle ${angle}): `;
  if (severity === "question") return `${head}this question was answered, and the judge rejected the finding — ${rationaleText}.`;
  const summary = sanitizeInline(extractFindingSummary(body)).replace(/"/g, "'");
  return `${head}Examined on merits: "${summary}" was reviewed against current scope and acceptance criteria; the judge rejected the finding — ${rationaleText}.`;
}

// Reply + resolve every answered judge-rejected question and every judge-rejected medium or low
// defect thread (ADR 0144; a question needs an answer reply, a defect does not). Never stamps
// disposition=deferred (this is not a deferral) and never files a deferral comment (a
// rejected finding is never fileable). A
// per-candidate failure is recorded in dispositionFailures rather than
// deadlocking the batch, mirroring runDispositionPass.
async function runRejectClosePass({ repo, pr, gate, headSha, round, threads, snapshot, login, findings, tmpRoot, repoRoot, allowedRefs = [] }, { env, ghCommand, runChild }) {
  const candidates = selectRejectCloseCandidates(threads, login);
  let rejectClosed = 0;
  const dispositionFailures = [];
  for (const candidate of candidates) {
    if (candidate.severity === "question" && !hasAnswerReply(candidate, snapshot.comments)) continue;
    let judgement;
    try {
      judgement = await resolveThreadRejection({ fp: candidate.fp, threadBody: candidate.body, findings, repo, pr, gate, headSha, tmpRoot, repoRoot });
    } catch (err) {
      dispositionFailures.push({ commentId: candidate.commentId, threadId: candidate.threadId, severity: candidate.severity, angle: candidate.angle, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!judgement || judgement.disposition !== "reject") continue;
    if (!Number.isInteger(candidate.commentId) || candidate.commentId <= 0) {
      dispositionFailures.push({ commentId: candidate.commentId, threadId: candidate.threadId, severity: candidate.severity, angle: candidate.angle, error: `judge-rejected thread ${candidate.threadId} has no valid root commentId (${String(candidate.commentId)}); left open` });
      continue;
    }
    try {
      const message = rejectCloseMessage({ fp: candidate.fp, severity: candidate.severity, angle: candidate.angle, round, rationale: judgement.rationale, body: candidate.body });
      await replyAndMaybeResolve(
        { repo, pr, commentId: candidate.commentId, threadId: candidate.threadId, body: message, resolve: true, validatedSnapshot: snapshot, allowedRefs },
        { env, ghCommand, runChild },
      );
      rejectClosed += 1;
    } catch (err) {
      dispositionFailures.push({ commentId: candidate.commentId, threadId: candidate.threadId, severity: candidate.severity, angle: candidate.angle, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const result = { rejectClosed };
  if (dispositionFailures.length > 0) {
    result.dispositionFailures = dispositionFailures;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Folded filing (GATE-COMMENT-INLINE-SEVERITY-FLOOR)
// ---------------------------------------------------------------------------
//
// A finding below the gate's inlineSeverityFloor never gets an inline/
// body-filed thread of its own — upsert-checkpoint-verdict.mjs folds it into
// the verdict body's Details block instead (renderVerdictDetailsBlock),
// so it never reaches selectDispositionTargets. The filing rule is the judge's
// alone (isFileableDeferral): a folded finding the judge disposed `defer` joins
// the round's batched deferral comment, exactly like a fileable THREAD target
// (on a linked spec issue target only; a PR target posts no comment). A folded
// finding with any other disposition is never filed (already recorded, visible,
// in the folded <details> block itself; that IS its resolved-with-rationale
// record).
function selectFoldedFileableEntries({ findings, floor }) {
  return findings
    .filter((f) => isBelowInlineFloor(f.severity, floor))
    // A nit is never filed, even as a member of a deferred cluster.
    .filter((f) => f.severity !== "nit")
    // An act finding goes to the fixer, never the deferral record (ADR 0089);
    // a fingerprint whose ledger entries disagree is ambiguous and fails closed.
    .filter((f) => isFileableDeferral(f.judgeDisposition))
    .filter((f) => !currentLedgerActOrAmbiguous(findings, fingerprintFinding(f)))
    .map((f) => ({ fingerprint: fingerprintFinding(f), severity: f.severity, angle: f.angle, summary: f.summary }));
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export function parseCloseGateFindingsCliArgs(argv) {
  // tmpRoot defaults to undefined (not "tmp") so an OMITTED --tmp-root falls
  // through to the main-worktree ledger anchor in closeGateFindings; an explicit
  // --tmp-root still overrides. A literal "tmp" default would make that fallback
  // dead for the normal CLI path and keep the round cross-check worktree-relative.
  const options = { help: false, ledgerPath: undefined, tmpRoot: undefined, allowedRefs: [] };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      ledger: { type: "string" },
      "tmp-root": { type: "string" },
      "allowed-refs": { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unknown argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.name === "help") {
      options.help = true;
      return options;
    }
    if (token.name === "ledger") {
      const p = requireTokenValue(token, parseError).trim();
      if (p.length === 0) {
        throw parseError("--ledger requires a non-empty path");
      }
      options.ledgerPath = p;
      continue;
    }
    if (token.name === "tmp-root") {
      const t = requireTokenValue(token, parseError).trim();
      if (t.length === 0) {
        throw parseError("--tmp-root requires a non-empty path");
      }
      options.tmpRoot = t;
      continue;
    }
    if (token.name === "allowed-refs") {
      options.allowedRefs = parseAllowedRefsCsv(requireTokenValue(token, parseError), "--allowed-refs", parseError);
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (options.ledgerPath === undefined) {
    throw parseError("Missing required argument: --ledger <path>");
  }
  return options;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function closeGateFindings(options, { env = process.env, ghCommand = "gh", runChild, repoRoot = process.cwd() } = {}) {
  const { repo, pr, gate, headSha, findings } = await readGateFindingsLedger(options.ledgerPath, { errorFactory: parseError });
  // The findings-log ledger (resolveGateRound's local-count cross-check) is
  // anchored at the MAIN worktree; default there so a close running
  // inside a linked worktree still counts the centralized prior-round ledgers.
  // An explicit --tmp-root still wins.
  const tmpRoot = options.tmpRoot || resolveGateArtifactTmpRoot(repoRoot);
  const gh = { env, ghCommand, runChild };

  // 1. The authenticated login — the trust boundary for the gate-authored
  // provenance decision below, resolved once rather than trusted from rendered
  // marker text.
  const login = await resolveAuthenticatedLogin(gh);

  // 2. Round (gate-scoped; both verdict surfaces plus the local ledger count).
  const reviews = await listPrReviews({ repo, pr }, gh);
  const issueComments = await listIssueComments({ repo, pr }, gh);
  const round = await resolveGateRound({ repo, pr, gate, headSha, reviews, issueComments, tmpRoot, repoRoot });

  // 3. Resolve this gate's per-gate medium fix window and inline severity
  // floor (GATE-COMMENT-INLINE-SEVERITY-FLOOR) together. loadDevLoopConfig never throws; on
  // schema-validation failure it returns the merged config with a non-empty
  // errors array — fall back to the built-in defaults then, rather than trust
  // an unvalidated value.
  const { config, errors } = await loadDevLoopConfig({ repoRoot });
  const gateConfigKey = GATE_CONFIG_KEY[gate] ?? gate;
  const resolvedGateConfig = errors.length > 0 ? null : resolveGateConfig(config, gateConfigKey);
  const inlineSeverityFloor = resolvedGateConfig?.inlineSeverityFloor ?? "medium";

  // 4. Thread snapshot for the disposition pass. A carried-open thread from an
  // earlier round must be reconciled against THIS round regardless of whether
  // this round posted anything of its own.
  // Folded findings (GATE-COMMENT-INLINE-SEVERITY-FLOOR) never get a thread,
  // so their fileable subset joins the thread pass's batched deferral comment
  // on a linked spec issue target only. A PR target, including the
  // unvalidated-config fallback (no tracker named), posts no comment.
  const { threads, snapshot } = await fetchThreadsWithFullBodies({ repo, pr }, gh);
  const foldedEntries = selectFoldedFileableEntries({ findings, floor: inlineSeverityFloor });
  const trackerProvider = errors.length > 0 ? null : resolveTrackerProvider(config);
  const { deferredResolved, foldedFiled, followUpIssueNumber, dispositionFailures } = await runDispositionPass(
    { repo, pr, gate, headSha, tmpRoot, repoRoot, round, threads, snapshot, login, findings, foldedEntries, trackerProvider, allowedRefs: options.allowedRefs ?? [] },
    gh,
  );

  // 4b. Reject-close pass (ADR 0088, widened by ADR 0144): an answered,
  // judge-rejected `question` thread or a judge-rejected medium/low defect
  // thread has no other sanctioned resolution path. Runs against the SAME
  // pre-defer `threads` snapshot as the disposition pass above —
  // selectDispositionTargets skips every thread this pass owns, so the two
  // passes never contend for the same thread.
  const { rejectClosed, dispositionFailures: rejectCloseFailures } = await runRejectClosePass(
    { repo, pr, gate, headSha, round, threads, snapshot, login, findings, tmpRoot, repoRoot, allowedRefs: options.allowedRefs ?? [] },
    gh,
  );
  const { evidenceOnlyClosed, dispositionFailures: evidenceOnlyFailures } = await runEvidenceOnlyClosePass(
    { repo, pr, gate, headSha, round, threads, snapshot, login, findings, tmpRoot, repoRoot, allowedRefs: options.allowedRefs ?? [] },
    gh,
  );

  // Gate-authored threads still unresolved AFTER the defer pass: the pre-defer
  // total minus deferredResolved (only the targets runDispositionPass actually
  // replied+resolved — a per-target failure is recorded in dispositionFailures
  // and stays counted here rather than deadlocking the batch). This is high
  // not yet fix-closed, in-window medium, an unanswered question, or any
  // triaged-but-not-closed gate-authored thread. Folded findings never create
  // a thread (they fold into the verdict body's <details> block instead), so
  // they never enter this count either way. The gate-close assertion
  // (fetchDraftGateEvidence / ready-for-review) refuses ready-for-review while
  // this is non-zero. `threads` is the PRE-DEFER snapshot; runDispositionPass
  // resolves threads via the GitHub API but does not mutate this in-memory
  // array's `isResolved` flags — re-fetch here if a future change makes it do
  // so (GATE-EXEC-FINDING-THREADS). rejectClosed (ADR 0088) subtracts the same
  // way deferredResolved does: both passes reply+resolve a thread this count
  // would otherwise still include.
  const unresolvedGateThreadCount = countUnresolvedGateAuthoredThreads(threads, login) - deferredResolved - rejectClosed - evidenceOnlyClosed;
  const combinedDispositionFailures = [...(dispositionFailures ?? []), ...(rejectCloseFailures ?? []), ...evidenceOnlyFailures];

  const result = { ok: true, repo, pr, gate, headSha, round, deferredResolved, rejectClosed, evidenceOnlyClosed, unresolvedGateThreadCount, foldedFiled };
  // GATE-EXEC-DEFERRAL-RECORD: only present when the round had a fileable
  // deferral — the number of the comment target (linked spec issue or PR).
  if (followUpIssueNumber !== undefined) {
    result.followUpIssueNumber = followUpIssueNumber;
  }
  // GATE-EXEC-THREAD-DISPOSITION: surface any target whose reply could not be built/posted this pass,
  // so a malformed thread body is diagnosable instead of silently swallowed
  // (it also keeps unresolvedGateThreadCount non-zero, blocking gate close).
  if (combinedDispositionFailures.length > 0) {
    result.dispositionFailures = combinedDispositionFailures;
  }
  return result;
}

async function main() {
  let options;
  try {
    options = parseCloseGateFindingsCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  try {
    const result = await closeGateFindings(options);
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
