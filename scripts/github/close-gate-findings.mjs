#!/usr/bin/env node
import { parseArgs } from "node:util";
import { parseAllowedRefsCsv, requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { listIssueComments, resolveAuthenticatedLogin, runGhJson, sanitizeInline } from "./post-gate-findings.mjs";
import {
  FINDING_MARKER_RE,
  MEDIUM_FIX_WINDOW,
  countUnresolvedGateAuthoredThreads,
  ensureFollowUpIssue,
  fetchThreadsWithFullBodies,
  isDeferredAtRound,
  isFileableDeferral,
  listPrReviews,
  parseFindingMarker,
  readGateFindingsLedger,
  resolveGateRound,
} from "./_gate-finding-surface.mjs";
import { replyAndMaybeResolve } from "./_review-thread-mutations.mjs";
import { loadDevLoopConfig, resolveGateConfig } from "@dev-loops/core/config";
import { GATE_CONFIG_KEY } from "@dev-loops/core/loop/gate-fanin";

const USAGE = `Usage: close-gate-findings.mjs --ledger <findings-log path> [--tmp-root <dir>]
Run a closed gate round's THREAD DISPOSITION pass. This helper posts NO comment
and NO review of its own: the round's single visible surface is the one PR review
upsert-checkpoint-verdict.mjs already posted (verdict-marker body + inline finding
comments). Here, every unresolved gate-authored finding thread is reconciled
against the current round: high always stays open (it never defers, forcing
per-gate continuation until the gate round cap escalates); medium stays
open through this gate's configured medium fix window (default
${MEDIUM_FIX_WINDOW}, set per gate via gates.<gate>.mediumFixWindow)
and is replied-to + resolved ("deferred at gate close") from the next round on;
low is replied-to + resolved at gate close (after the Phase 5 fixer
triage; #1585). question always stays open too — it is answered, never deferred,
so an unanswered question blocks gate-close exactly like an open defect; nit is
replied-to + resolved immediately, with no fixer cycle. Every resolve-without-fix
above is ALSO gated on the net-reduction filing bar (#1846): resolving a thread and
FILING it to a tracked follow-up issue are separate decisions. nit is NEVER filed —
resolved-with-rationale in-thread only, no marker stamp, no issue. low is filed only
when its own marker carries the explicit operatorVisible signal (the finding's own
operatorVisible: true, rendered as the marker's ov=1 field); the default (absent/false)
is NOT filed either. medium (past its fix window) is unchanged: always filed. A FILED
thread's marker is stamped \`disposition=deferred issue=<n>\` before it is resolved: a
defer ALWAYS creates (or, when this PR already has one, appends to) ONE tracked
follow-up GitHub issue for the round's whole batch of FILEABLE deferrals — never an
empty one when nothing in the batch clears the filing bar — so the deferral disposition
is never parked only in the thread marker and the ephemeral tmp findings ledger. A
contract-violating disposition=deferred stamp — on a question or in-window medium
thread, a nit, a non-operator-visible low (a subagent bypass of selectDispositionTargets/
isFileableDeferral), or missing its linked follow-up issue number — is detected and
rejected before the pass runs (#1672, #1807, #1846).

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
                                count (default: tmp/)
  --allowed-refs <csv>         Explicit allowlist of issue/PR ids a disposition reply
                                body may cite (same shape/semantics as
                                reply-resolve-review-thread): the bare-#N comment-id
                                guard opens only for these ids (e.g. the PR's own
                                governing issue quoted in a deferred finding's
                                summary). Without it, un-whitelisted bare refs stay
                                fail-closed.

Output (stdout, JSON):
  { "ok": true, "repo": "...", "pr": 42, "gate": "...", "headSha": "...", "round": N,
    "deferredResolved": <disposition reply+resolve count>,
    "unresolvedGateThreadCount": <gate-authored threads still unresolved after the defer pass; the gate-close assertion (fetchDraftGateEvidence / ready-for-review) refuses ready-for-review while non-zero (#1585)>,
    "followUpIssueNumber"?: <the PR's one tracked follow-up issue number; present only when this pass deferred at least one thread (#1807)>,
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
// stamp that selectDispositionTargets/runDispositionPass could never have
// produced (question never deferred; medium only past its fix window; nit
// never fileable; low fileable only with operatorVisible) or that carries no
// linked follow-up issue number — the signature of a subagent bypassing the
// sanctioned pass via a direct gh api PATCH. Detected BEFORE the disposition
// pass runs, so it surfaces as a gate failure rather than a silent
// reply+resolve or a false clean-deferral count (GATE-EXEC-THREAD-DISPOSITION).
function detectContractViolatingDeferredStamps(threads, login, round, mediumFixWindow) {
  const violations = [];
  for (const thread of threads) {
    // Only unresolved threads: a resolved thread may have been legitimately
    // deferred by a PRIOR gate at a higher round, and the marker carries no
    // cross-gate provenance, so scanning resolved threads would false-positive
    // across gates with no recovery path. This catches the stamp-only bypass;
    // stampDeferredDisposition's own guard catches stamp+resolve on the
    // sanctioned path, and a raw gh-api bypass is a process violation no code
    // guard can mechanically prevent.
    if (thread.isResolved) continue;
    if (thread.author !== login) continue;
    const marker = parseFindingMarker(thread.body);
    if (!marker) continue;
    if (marker.disposition !== "deferred") continue;
    // "out-of-window" is the umbrella reason label: an out-of-window medium, a
    // question, a nit, or a low with no operatorVisible signal all fail
    // isFileableDeferral and share this one reason.
    const notFileable = !isFileableDeferral(marker.severity, marker.operatorVisible, round, mediumFixWindow);
    const missingIssue = !Number.isInteger(marker.issue) || marker.issue <= 0;
    if (notFileable || missingIssue) {
      violations.push({
        threadId: thread.threadId,
        commentId: thread.commentId,
        severity: marker.severity,
        round,
        mediumFixWindow,
        issue: marker.issue,
        reason: notFileable ? "out-of-window" : "missing-issue-link",
      });
    }
  }
  if (violations.length > 0) {
    const details = violations
      .map((v) => `thread ${v.threadId} (comment ${v.commentId}): severity=${v.severity} at round=${v.round} (mediumFixWindow=${v.mediumFixWindow}) carries disposition=deferred, reason=${v.reason}${v.issue ? ` (issue=${v.issue})` : ""}`)
      .join("; ");
    throw new Error(`GATE-EXEC-THREAD-DISPOSITION violation: ${violations.length} gate-authored thread(s) carry a contract-violating disposition=deferred stamp (${details}). A question must be answered (never deferred), a nit must never be stamped deferred (resolved-with-rationale instead, never filed), a low must carry operatorVisible=true on its own marker before it may be stamped deferred (otherwise resolved-with-rationale, never filed), an in-window medium (round ≤ mediumFixWindow) must stay unresolved to force a fix round, and every disposition=deferred stamp must link a follow-up issue number. Refuse to proceed with the disposition pass.`);
  }
}

// Reason named in the reply for a FILEABLE target only (see
// unfiledResolutionReason for a nit/non-operator-visible low): medium defers
// for staying past the fix window; low defers unconditionally at gate close.
function windowReason(severity, mediumFixWindow) {
  if (severity === "medium") {
    return `stayed open past this gate's round-${mediumFixWindow} medium fix window`;
  }
  return "low findings are deferred at gate close after the fixer triaged them (fix-if-cheap-in-the-same-commit, else defer)";
}

// Only ever called for a FILEABLE target (isFileableDeferral true) — see
// unfiledResolutionMessage for the nit/non-operator-visible-low reply. Each
// reply is distinct by construction (fingerprint/severity/angle plus the
// window reason) and always names a tracked follow-up issue rather than only
// the thread marker + ephemeral tmp ledger (GATE-EXEC-DEFERRAL-RECORD).
function dispositionMessage({ fp, severity, angle, round, mediumFixWindow, repo, issueNumber, body, operatorVisible }) {
  const meritRationale = buildMeritRationale({ body, severity, operatorVisible, round, mediumFixWindow });
  return `Deferred at gate close (round ${round}, fingerprint ${fp}, severity ${severity}, angle ${angle}): ${meritRationale} ${windowReason(severity, mediumFixWindow)}; tracked in follow-up issue https://github.com/${repo}/issues/${issueNumber}.`;
}

// Reply for a thread RESOLVED this round but that does NOT clear the
// net-reduction filing bar — a nit (never fileable) or a low with no
// operatorVisible signal (the conservative default). Never names a follow-up
// issue: runDispositionPass creates/appends one only for fileable targets.
function unfiledResolutionReason(severity) {
  if (severity === "nit") {
    return "nit findings are resolved with rationale at gate close, with no fixer cycle and no tracked follow-up issue (net-reduction disposition policy)";
  }
  return "this low finding carries no operator-visibility signal, so it is resolved with rationale at gate close instead of filed to a tracked follow-up issue (net-reduction disposition policy)";
}

// A severity/round rule only selects an eligible disposition boundary, not a
// per-finding reason to close, so every resolve-without-fix reply must record
// the rendered finding summary rather than a bare severity label (GATE-EXEC-THREAD-DISPOSITION).
function extractFindingSummary(body) {
  const match = typeof body === "string"
    ? body.match(/^\*\*[^*\n]+\*\*\s+\(`[^`\n]+`\):\s+(.+)$/mu)
    : null;
  const summary = match?.[1]?.replace(/\s+— judge:.*$/u, "").trim();
  if (!summary) {
    throw new Error("GATE-EXEC-THREAD-DISPOSITION violation: selected finding has no parseable finding summary; refuse severity-only closure");
  }
  return summary;
}

export function buildMeritRationale({ body, severity, operatorVisible = false, round, mediumFixWindow }) {
  // Collapse any embedded double quote to a single quote: the summary is
  // wrapped in literal double quotes below and sanitizeInline does not escape
  // `"` (no injection risk — cosmetic only, avoids confusing nested quotes).
  const summary = sanitizeInline(extractFindingSummary(body)).replace(/"/g, "'");
  const reason = severity === "medium"
    ? `it remained open past the round-${mediumFixWindow} fix window and no in-scope fix was selected`
    : severity === "low" && operatorVisible
      ? "fixer triage found no same-commit fix warranted, while tracking preserves the operator-visible concern"
      : severity === "low"
        ? "fixer triage found no same-commit fix warranted and the finding does not clear the operator-visibility filing bar"
        : "it is cosmetic and does not warrant a fixer cycle or tracked follow-up";
  return `Examined on merits: \"${summary}\" was reviewed against current scope and acceptance criteria; ${reason}.`;
}

function unfiledResolutionMessage({ fp, severity, angle, round, body, operatorVisible, mediumFixWindow }) {
  const meritRationale = buildMeritRationale({ body, severity, operatorVisible, round, mediumFixWindow });
  return `Resolved at gate close (round ${round}, fingerprint ${fp}, severity ${severity}, angle ${angle}): ${meritRationale} ${unfiledResolutionReason(severity)}.`;
}

// Every currently-unresolved gate-authored thread — newly posted this round
// or carried open from an earlier one — is reconciled against the CURRENT
// round, not the round recorded on its own marker.
function selectDispositionTargets(threads, round, login, mediumFixWindow) {
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
    if (!isDeferredAtRound(marker.severity, round, mediumFixWindow)) continue;
    // commentId is null whenever list-review-threads.mjs could not resolve a
    // finite databaseId for the thread's first comment. Reject it here (named
    // by threadId) rather than let it reach stampDeferredDisposition and
    // interpolate into `pulls/comments/null`.
    if (!Number.isInteger(thread.commentId) || thread.commentId <= 0) {
      throw new Error(`Thread ${thread.threadId} carries a gate-authored finding marker selected for deferral but has no resolvable comment id (commentId=${JSON.stringify(thread.commentId)}); refuse to stamp/resolve it.`);
    }
    // Idempotency: a target can already carry its own `disposition=deferred
    // issue=<n>` stamp (an interrupted retry where the PATCH landed but the
    // reply+resolve did not); isDeferredAtRound still selects it, but
    // runDispositionPass must never re-append it to the follow-up issue (GATE-EXEC-DEFERRAL-RECORD).
    targets.push({
      threadId: thread.threadId,
      commentId: thread.commentId,
      severity: marker.severity,
      angle: marker.angle,
      fp: marker.fp,
      // The finding's own operator-visibility signal, carried from the marker
      // so runDispositionPass can FILE only the subset that clears the
      // net-reduction bar, while resolving every selected thread here.
      operatorVisible: marker.operatorVisible === true,
      alreadyStamped: marker.disposition === "deferred",
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
async function stampDeferredDisposition({ repo, commentId, round, mediumFixWindow, issueNumber }, { env, ghCommand, runChild }) {
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
  if (!isFileableDeferral(marker.severity, marker.operatorVisible, round, mediumFixWindow)) {
    throw new Error(`Review comment ${commentId} carries severity=${marker.severity} operatorVisible=${marker.operatorVisible} at round=${round} (mediumFixWindow=${mediumFixWindow}) which must not be filed to a follow-up issue (isFileableDeferral=false); refuse to stamp or resolve a contract-violating disposition=deferred (GATE-EXEC-THREAD-DISPOSITION).`);
  }
  if (marker.disposition === "deferred") {
    // Already stamped (an idempotent retry) must link the SAME follow-up
    // issue this pass resolved for the round's batch; a mismatch fails closed
    // rather than silently leaving a stale/wrong link on the thread (GATE-EXEC-DEFERRAL-RECORD).
    if (marker.issue !== issueNumber) {
      throw new Error(`Review comment ${commentId} is already stamped disposition=deferred issue=${marker.issue} but this pass resolved follow-up issue #${issueNumber}; refuse to overwrite the existing link (GATE-EXEC-THREAD-DISPOSITION).`);
    }
    return;
  }
  // Every disposition=deferred stamp links a follow-up issue number — never
  // resolve a thread's deferral into the marker + ephemeral tmp ledger alone (GATE-EXEC-DEFERRAL-RECORD).
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Review comment ${commentId} would be stamped disposition=deferred with no linked follow-up issue number; refuse (GATE-EXEC-THREAD-DISPOSITION).`);
  }
  const stamped = body.replace(FINDING_MARKER_RE, (m) => m.replace(/\s*-->$/, ` disposition=deferred issue=${issueNumber} -->`));
  await runGhJson(
    ["api", "-X", "PATCH", `repos/${repo}/pulls/comments/${commentId}`, "-f", `body=${stamped}`],
    { env, ghCommand, runChild },
  );
}

// The ONE tracked follow-up issue for this PR — reused across gate rounds —
// found by scanning every gate-authored thread's OWN marker (resolved
// threads included) for a previously-recorded `issue=` link. Returns `null`
// as a fast-path cache miss, not authority: judge-pass.mjs's relevance defer
// never stamps a marker's `issue=` field, so ensureFollowUpIssue
// (_gate-finding-surface.mjs) resolves against GitHub itself before creating
// whenever this returns `null` (GATE-EXEC-DEFERRAL-RECORD).
function findExistingFollowUpIssueNumber(threads, login) {
  for (const thread of threads) {
    if (thread.author !== login) continue;
    const marker = parseFindingMarker(thread.body);
    if (marker && Number.isInteger(marker.issue) && marker.issue > 0) return marker.issue;
  }
  return null;
}

// `snapshot` is the full-body review-thread snapshot the caller already
// fetched alongside `threads` (fetchThreadsWithFullBodies) — reused as the
// reply-target validation snapshot rather than re-fetched.
async function runDispositionPass({ repo, pr, round, threads, snapshot, login, mediumFixWindow, allowedRefs = [] }, { env, ghCommand, runChild }) {
  // GATE-EXEC-THREAD-DISPOSITION: Before stamping, detect any contract-violating disposition=deferred
  // stamps already present on gate-authored threads (a subagent bypass).
  detectContractViolatingDeferredStamps(threads, login, round, mediumFixWindow);
  const targets = selectDispositionTargets(threads, round, login, mediumFixWindow);
  if (targets.length === 0) {
    return { deferredResolved: 0 };
  }
  // Net-reduction filing bar: every target in `targets` gets RESOLVED this
  // round, but only the FILEABLE subset is tracked on the PR's follow-up
  // issue and stamped disposition=deferred — a nit is never fileable; a low
  // is fileable only with its own marker's operatorVisible signal.
  const fileableTargets = targets.filter((target) => isFileableDeferral(target.severity, target.operatorVisible, round, mediumFixWindow));
  const unfiledTargets = targets.filter((target) => !isFileableDeferral(target.severity, target.operatorVisible, round, mediumFixWindow));

  // followUpIssueNumber stays `undefined` unless this pass FILES at least one
  // target this round — an all-nit/all-non-visible-low batch creates no
  // follow-up issue and appends nothing to an existing one.
  let issueNumber;
  let fileableResolved = 0;
  let unfiledResolved = 0;
  // Build (and thereby validate) every reply BEFORE any mutating GitHub call:
  // a throw after the PATCH/issue-append would leave a target
  // stamped-but-unresolved and deadlock every retry. A target whose reply
  // cannot be built (or whose GitHub call later fails) is recorded in
  // dispositionFailures and stays unresolved — blocking gate-close for that
  // thread alone, not the rest of the batch (GATE-EXEC-THREAD-DISPOSITION).
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
  if (fileableTargets.length > 0) {
    // Partition off any fileable target whose merit rationale cannot be built —
    // BEFORE the follow-up-issue append, so an unresolvable target is never
    // recorded on the follow-up issue it can never be replied against (GATE-EXEC-THREAD-DISPOSITION).
    const buildableFileable = [];
    for (const target of fileableTargets) {
      try {
        buildMeritRationale({ body: target.body, severity: target.severity, operatorVisible: target.operatorVisible, round, mediumFixWindow });
        buildableFileable.push(target);
      } catch (err) {
        recordFailure(target, err);
      }
    }
    if (buildableFileable.length > 0) {
      // ONE tracked follow-up issue per PR for the whole FILEABLE batch —
      // reuse an existing one (found on an earlier round's marker) rather
      // than mint a duplicate (GATE-EXEC-DEFERRAL-RECORD).
      const existingIssueNumber = findExistingFollowUpIssueNumber(threads, login);
      // Idempotency: a target already stamped `disposition=deferred
      // issue=<n>` on a prior interrupted run was already recorded on the
      // follow-up issue — appending again would duplicate the "additional
      // finding(s)" comment. Only not-yet-stamped targets still need to reach
      // the follow-up issue; an already-stamped one still needs its
      // reply+resolve below (GATE-EXEC-THREAD-DISPOSITION).
      const unstampedFileable = buildableFileable.filter((target) => !target.alreadyStamped);
      issueNumber = existingIssueNumber;
      if (unstampedFileable.length > 0) {
        const entries = unstampedFileable.map((target) => ({
          fingerprint: target.fp,
          severity: target.severity,
          angle: target.angle,
          refUrl: `https://github.com/${repo}/pull/${pr}#discussion_r${target.commentId}`,
        }));
        ({ issueNumber } = await ensureFollowUpIssue(
          { repo, pr, entries, existingIssueNumber },
          { env, ghCommand, run: runChild },
        ));
      }
      // A pure retry (every fileable target already stamped) must resolve to
      // the existing issue found on the threads' own markers — the guard in
      // stampDeferredDisposition fails closed if that is null/mismatched. The
      // message is built first, so a per-target failure never lands a stamp
      // without its reply.
      for (const target of buildableFileable) {
        try {
          const message = dispositionMessage({ fp: target.fp, severity: target.severity, angle: target.angle, round, mediumFixWindow, repo, issueNumber, body: target.body, operatorVisible: target.operatorVisible });
          await stampDeferredDisposition({ repo, commentId: target.commentId, round, mediumFixWindow, issueNumber }, { env, ghCommand, runChild });
          await replyAndMaybeResolve(
            { repo, pr, commentId: target.commentId, threadId: target.threadId, body: message, resolve: true, validatedSnapshot: snapshot, allowedRefs },
            { env, ghCommand, runChild },
          );
          fileableResolved += 1;
        } catch (err) {
          recordFailure(target, err);
        }
      }
    }
  }
  // net-reduction disposition policy: a nit or a non-operator-visible low is resolved-with-rationale
  // in-thread — no GET/PATCH round-trip (there is nothing to stamp: the
  // marker's disposition field stays absent), no follow-up issue.
  for (const target of unfiledTargets) {
    try {
      const message = unfiledResolutionMessage({ fp: target.fp, severity: target.severity, angle: target.angle, round, body: target.body, operatorVisible: target.operatorVisible, mediumFixWindow });
      await replyAndMaybeResolve(
        { repo, pr, commentId: target.commentId, threadId: target.threadId, body: message, resolve: true, validatedSnapshot: snapshot, allowedRefs },
        { env, ghCommand, runChild },
      );
      unfiledResolved += 1;
    } catch (err) {
      recordFailure(target, err);
    }
  }
  const deferredResolved = fileableResolved + unfiledResolved;
  const result = issueNumber !== undefined ? { deferredResolved, followUpIssueNumber: issueNumber } : { deferredResolved };
  if (dispositionFailures.length > 0) {
    result.dispositionFailures = dispositionFailures;
  }
  return result;
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export function parseCloseGateFindingsCliArgs(argv) {
  const options = { help: false, ledgerPath: undefined, tmpRoot: "tmp", allowedRefs: [] };
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
  const { repo, pr, gate, headSha } = await readGateFindingsLedger(options.ledgerPath, { errorFactory: parseError });
  const tmpRoot = options.tmpRoot || "tmp";
  const gh = { env, ghCommand, runChild };

  // 1. The authenticated login — the trust boundary for the gate-authored
  // provenance decision below, resolved once rather than trusted from rendered
  // marker text.
  const login = await resolveAuthenticatedLogin(gh);

  // 2. Round (gate-scoped; both verdict surfaces plus the local ledger count).
  const reviews = await listPrReviews({ repo, pr }, gh);
  const issueComments = await listIssueComments({ repo, pr }, gh);
  const round = await resolveGateRound({ repo, pr, gate, headSha, reviews, issueComments, tmpRoot, repoRoot });

  // 3. Resolve this gate's per-gate medium fix window. loadDevLoopConfig
  // never throws; on schema-validation failure it returns the merged config
  // with a non-empty errors array — fall back to the built-in
  // MEDIUM_FIX_WINDOW then, rather than trust an unvalidated value.
  const { config, errors } = await loadDevLoopConfig({ repoRoot });
  const gateConfigKey = GATE_CONFIG_KEY[gate] ?? gate;
  const mediumFixWindow =
    errors.length > 0
      ? MEDIUM_FIX_WINDOW
      : resolveGateConfig(config, gateConfigKey).mediumFixWindow;

  // 4. Thread snapshot for the disposition pass. A carried-open thread from an
  // earlier round must be reconciled against THIS round regardless of whether
  // this round posted anything of its own.
  const { threads, snapshot } = await fetchThreadsWithFullBodies({ repo, pr }, gh);
  const { deferredResolved, followUpIssueNumber, dispositionFailures } = await runDispositionPass(
    { repo, pr, round, threads, snapshot, login, mediumFixWindow, allowedRefs: options.allowedRefs ?? [] },
    gh,
  );

  // Gate-authored threads still unresolved AFTER the defer pass: the pre-defer
  // total minus deferredResolved (only the targets runDispositionPass actually
  // replied+resolved — a per-target failure is recorded in dispositionFailures
  // and stays counted here rather than deadlocking the batch). This is high
  // not yet fix-closed, in-window medium, an unanswered question, or any
  // triaged-but-not-closed gate-authored thread. The gate-close assertion
  // (fetchDraftGateEvidence / ready-for-review) refuses ready-for-review while
  // this is non-zero. `threads` is the PRE-DEFER snapshot; runDispositionPass
  // resolves threads via the GitHub API but does not mutate this in-memory
  // array's `isResolved` flags — re-fetch here if a future change makes it do
  // so (GATE-EXEC-FINDING-THREADS).
  const unresolvedGateThreadCount = countUnresolvedGateAuthoredThreads(threads, login) - deferredResolved;

  const result = { ok: true, repo, pr, gate, headSha, round, deferredResolved, unresolvedGateThreadCount };
  // GATE-EXEC-DEFERRAL-RECORD: only present when this pass actually deferred something — a round
  // with nothing to defer creates no follow-up issue and reports none.
  if (followUpIssueNumber !== undefined) {
    result.followUpIssueNumber = followUpIssueNumber;
  }
  // GATE-EXEC-THREAD-DISPOSITION: surface any target whose reply could not be built/posted this pass,
  // so a malformed thread body is diagnosable instead of silently swallowed
  // (it also keeps unresolvedGateThreadCount non-zero, blocking gate close).
  if (dispositionFailures !== undefined) {
    result.dispositionFailures = dispositionFailures;
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
