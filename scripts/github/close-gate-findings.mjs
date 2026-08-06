#!/usr/bin/env node
import { parseArgs } from "node:util";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { listIssueComments, resolveAuthenticatedLogin, runGhJson } from "./post-gate-findings.mjs";
import {
  FINDING_MARKER_RE,
  WORTH_FIXING_NOW_FIX_WINDOW,
  countUnresolvedGateAuthoredThreads,
  fetchThreadsWithFullBodies,
  isDeferredAtRound,
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
against the current round: must-fix always stays open (it never defers, forcing
per-gate continuation until the gate round cap escalates); worth-fixing-now stays
open through this gate's configured worth-fixing-now fix window (default
${WORTH_FIXING_NOW_FIX_WINDOW}, set per gate via gates.<gate>.worthFixingNowFixWindow)
and is replied-to + resolved ("deferred at gate close") from the next round on;
nice-to-have is replied-to + resolved immediately. A deferred thread's marker is
stamped \`disposition=deferred\` before it is resolved, so the deferral disposition
lives on the thread itself and in the durable tmp ledger.

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

Output (stdout, JSON):
  { "ok": true, "repo": "...", "pr": 42, "gate": "...", "headSha": "...", "round": N,
    "deferredResolved": <disposition reply+resolve count>,
    "unresolvedGateThreadCount": <gate-authored threads still unresolved after the defer pass; the gate-close assertion (fetchDraftGateEvidence / ready-for-review) refuses ready-for-review while non-zero (#1585)> }

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

// The window/disposition reason named in the reply: a worth-fixing-now thread
// deferred because it stayed open past the in-gate fix window vs. a
// nice-to-have finding that is never fix-windowed at all.
function windowReason(severity, worthFixingNowFixWindow) {
  if (severity === "worth-fixing-now") {
    return `stayed open past this gate's round-${worthFixingNowFixWindow} worth-fixing-now fix window`;
  }
  return "nice-to-have findings are deferred immediately, at the round they are first posted";
}

// Every deferral reply is distinct by construction through the thread's own
// stamped marker fields (fingerprint, severity, angle) plus the window/
// disposition reason for THIS thread, so no two threads ever receive the same
// reply body even when a caller batches several deferrals in one pass — unlike
// a FIX-closing reply (COPILOT-FOLLOWUP-REPLY-RESOLVE-HELPER), nothing here
// names a "fix" because nothing was fixed.
function dispositionMessage({ fp, severity, angle, round, worthFixingNowFixWindow }) {
  return `Deferred at gate close (round ${round}, fingerprint ${fp}, severity ${severity}, angle ${angle}): ${windowReason(severity, worthFixingNowFixWindow)}; the deferral is recorded on this thread's marker and in the durable findings ledger.`;
}

// Every currently-unresolved gate-authored thread, whether newly posted this
// round or carried open from an earlier one, is reconciled against the
// CURRENT round — not the round recorded on its own marker. A worth-fixing-now
// finding first raised at round 1 and still open when the chain reaches round
// 4 is deferred then, exactly like one raised fresh at round 4.
function selectDispositionTargets(threads, round, login, worthFixingNowFixWindow) {
  const targets = [];
  for (const thread of threads) {
    if (thread.isResolved) continue;
    // Gate-authored is decided by AUTHOR IDENTITY (the authenticated `gh`
    // viewer's own login), never by rendered marker text alone: a foreign
    // comment can quote the exact marker shape this module renders just as
    // easily as its own producer does, and this function's result is PATCHed
    // (stampDeferredDisposition) and resolved — mutating a third-party comment
    // on the strength of its own words would be a forgery vector, not a
    // provenance check.
    if (thread.author !== login) continue;
    const marker = parseFindingMarker(thread.body);
    if (!marker) continue; // author matches, but carries no parseable finding marker
    if (!isDeferredAtRound(marker.severity, round, worthFixingNowFixWindow)) continue;
    // commentId is null whenever list-review-threads.mjs could not resolve a
    // finite databaseId for the thread's first comment. Reject it here, named
    // by threadId, rather than let it reach stampDeferredDisposition and
    // interpolate unchecked into `pulls/comments/null` — a bare "gh command
    // failed: <404 text>" names neither the thread nor the cause.
    if (!Number.isInteger(thread.commentId) || thread.commentId <= 0) {
      throw new Error(`Thread ${thread.threadId} carries a gate-authored finding marker selected for deferral but has no resolvable comment id (commentId=${JSON.stringify(thread.commentId)}); refuse to stamp/resolve it.`);
    }
    targets.push({ threadId: thread.threadId, commentId: thread.commentId, severity: marker.severity, angle: marker.angle, fp: marker.fp });
  }
  return targets;
}

// Stamp `disposition=deferred` onto the thread's line-1 marker before the
// resolve, so a deferred thread is distinguishable from a worth-fixing-now
// thread the fix loop resolved with a fixing commit. The already-stamped guard
// parses the marker's own `disposition` field (not a free-text
// `/disposition=deferred/` body search): a finding whose own summary or
// recommendation happens to quote that literal token must never be mistaken
// for an already-stamped marker.
async function stampDeferredDisposition({ repo, commentId }, { env, ghCommand }) {
  const payload = await runGhJson(["api", `repos/${repo}/pulls/comments/${commentId}`], { env, ghCommand });
  // Trimmed to match parseReviewThreads' normalizeBody, which is what
  // selectDispositionTargets parsed thread.body through to select this exact
  // comment as a deferral target: two differently normalized copies of one
  // body could disagree on whether `^` (FINDING_MARKER_RE is line-start
  // anchored) matches a marker preceded by leading whitespace.
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  const marker = parseFindingMarker(body);
  if (!marker) {
    throw new Error(`Review comment ${commentId} was selected as a deferral target but no longer carries a parseable finding marker; refuse to resolve it unstamped.`);
  }
  if (marker.disposition === "deferred") return;
  const stamped = body.replace(FINDING_MARKER_RE, (m) => m.replace(/\s*-->$/, " disposition=deferred -->"));
  await runGhJson(
    ["api", "-X", "PATCH", `repos/${repo}/pulls/comments/${commentId}`, "-f", `body=${stamped}`],
    { env, ghCommand },
  );
}

// `snapshot` is the full-body review-thread snapshot the caller already
// fetched alongside `threads` (fetchThreadsWithFullBodies) — reused here as
// the reply-target validation snapshot rather than re-fetching it, since it is
// already fresh (fetched immediately before this pass runs).
async function runDispositionPass({ repo, pr, round, threads, snapshot, login, worthFixingNowFixWindow }, { env, ghCommand }) {
  const targets = selectDispositionTargets(threads, round, login, worthFixingNowFixWindow);
  if (targets.length === 0) {
    return { deferredResolved: 0 };
  }
  let deferredResolved = 0;
  for (const target of targets) {
    await stampDeferredDisposition({ repo, commentId: target.commentId }, { env, ghCommand });
    const message = dispositionMessage({ fp: target.fp, severity: target.severity, angle: target.angle, round, worthFixingNowFixWindow });
    await replyAndMaybeResolve(
      { repo, pr, commentId: target.commentId, threadId: target.threadId, body: message, resolve: true, validatedSnapshot: snapshot },
      { env, ghCommand },
    );
    deferredResolved += 1;
  }
  return { deferredResolved };
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

export function parseCloseGateFindingsCliArgs(argv) {
  const options = { help: false, ledgerPath: undefined, tmpRoot: "tmp" };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      ledger: { type: "string" },
      "tmp-root": { type: "string" },
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

export async function closeGateFindings(options, { env = process.env, ghCommand = "gh", repoRoot = process.cwd() } = {}) {
  const { repo, pr, gate, headSha } = await readGateFindingsLedger(options.ledgerPath, { errorFactory: parseError });
  const tmpRoot = options.tmpRoot || "tmp";
  const gh = { env, ghCommand };

  // 1. The authenticated login — the trust boundary for the gate-authored
  // provenance decision below, resolved once rather than trusted from rendered
  // marker text.
  const login = await resolveAuthenticatedLogin(gh);

  // 2. Round (gate-scoped; both verdict surfaces plus the local ledger count).
  const reviews = await listPrReviews({ repo, pr }, gh);
  const issueComments = await listIssueComments({ repo, pr }, gh);
  const round = await resolveGateRound({ repo, pr, gate, headSha, reviews, issueComments, tmpRoot, repoRoot });

  // 3. Resolve this gate's per-gate worth-fixing-now fix window (#1581): the
  // disposition pass honors the configured window instead of the hardcoded
  // constant. loadDevLoopConfig never throws; on schema-validation failure it
  // returns the merged (possibly unvalidated) config with a non-empty errors
  // array. When that happens, fall back to the built-in WORTH_FIXING_NOW_FIX_WINDOW
  // (window 3) so an unloadable/broken config fails open to the historic behavior
  // rather than trusting an unvalidated value.
  const { config, errors } = await loadDevLoopConfig({ repoRoot });
  const gateConfigKey = GATE_CONFIG_KEY[gate] ?? gate;
  const worthFixingNowFixWindow =
    errors.length > 0
      ? WORTH_FIXING_NOW_FIX_WINDOW
      : resolveGateConfig(config, gateConfigKey).worthFixingNowFixWindow;

  // 4. Thread snapshot for the disposition pass. A carried-open thread from an
  // earlier round must be reconciled against THIS round regardless of whether
  // this round posted anything of its own.
  const { threads, snapshot } = await fetchThreadsWithFullBodies({ repo, pr }, gh);
  const { deferredResolved } = await runDispositionPass(
    { repo, pr, round, threads, snapshot, login, worthFixingNowFixWindow },
    gh,
  );

  // #1585: report gate-authored threads still unresolved AFTER the defer pass.
  // The defer pass resolves exactly the deferrable subset (nice-to-haves and
  // out-of-window worth-fixing-now threads — the targets selectDispositionTargets
  // returned, counted by deferredResolved), so the remaining unresolved
  // gate-authored count is the pre-defer total minus that resolved count —
  // i.e. must-fix the fixer has not yet fix-closed, in-window worth-fixing-now,
  // or any gate-authored thread the fixer triaged but did not yet close. The
  // gate-close assertion (fetchDraftGateEvidence / ready-for-review) refuses to
  // mark ready while this is non-zero, so a clean verdict can never again leave
  // a gate-authored thread dangling. Computed in-memory from the pre-defer
  // snapshot (runDispositionPass throws if any target's resolve failed, so
  // deferredResolved is exact) — no second thread walk.
  const unresolvedGateThreadCount = countUnresolvedGateAuthoredThreads(threads, login) - deferredResolved;

  return { ok: true, repo, pr, gate, headSha, round, deferredResolved, unresolvedGateThreadCount };
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
