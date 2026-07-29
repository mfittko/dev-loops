#!/usr/bin/env node
// Resolve the board's single continue target for the live `/loop-continue` path
// (#988 P1, extended #1091). It lists the "In Progress" column and, failing
// that, the "Next Up" column via list-queue-items.mjs — with NO routing opinions
// beyond a single pick and NO guessing. It never touches Backlog.
//
//   exactly one In Progress   -> { ok: true, target: {kind,number}, source: "in-progress" }
//   multiple In Progress      -> { ok: false, reason: "..." }  (names the items)
//   zero In Progress:
//     Next Up has items        -> single-contributor ownership gate (#1377) scans
//                                  Next Up by POSITION ascending, claims (@me) an
//                                  unassigned item, RE-READS it (the claim is not
//                                  compare-and-swap) and, ONLY when the viewer's
//                                  own claim is actually visible in that re-read,
//                                  resolves a genuine contest with a deterministic
//                                  tiebreak: the loser self-unassigns and skips
//                                  (`claim_contested_lost_tiebreak`); the winner
//                                  removes the loser login(s) (`claimNote:
//                                  claim_contested_won_tiebreak`). If the re-read
//                                  shows only OTHER humans (our own claim not yet
//                                  visible), it is not ours to arbitrate:
//                                  best-effort self-unclaim and skip without
//                                  touching their assignment
//                                  (`claim_not_visible_post_read`). SKIPS items
//                                  owned by another human (reported in `skipped`)
//                                  -> { ok: true, target: {kind,number},
//                                  source: "next-up", skipped?: [...], claimNote?: "..." }
//     Every ownership read that observes contention fails closed, so a
//     contributor is stopped the moment contention is visible to it — making
//     two contributors both proceeding improbable and short-lived, NOT
//     impossible (assignment has no compare-and-swap; a "proceed" can't be
//     un-done). Two accepted residuals: (1) racer A completes claim -> both
//     re-reads (sole) -> proceeds before B's claim lands; B then wins the
//     tiebreak and removes A, but cannot retract A's already-started work, so
//     both proceed in that narrow window (self-corrects on A's next read).
//     (2) if BOTH racers' re-reads land before the other's write propagates,
//     neither observes the contention and the item is left safely co-assigned
//     — both fail closed at their own startup gate, released by a manual
//     unassign (the no-lease/no-automatic-reclamation non-goal). Convergence
//     to solely-owned holds for the common races (sequential, or either
//     racer's re-read observing the contention, which the tiebreak self-heals).
//     all Next Up items foreign -> { ok: false, reason: "...", source: "next-up", skipped: [...] }
//     Next Up empty            -> { ok: false, reason: <canonical empty-queue msg>, source: "next-up" }
//     Next Up query errors     -> propagates (fail closed — surface it, no fallback)
//
// Downstream (the dev-loop skill) resolves authoritative state from this number;
// this helper deliberately makes no further decisions.
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { parseArgs } from "node:util";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { main as listQueueItems } from "./list-queue-items.mjs";
import { applyDevloopsBoard } from "./_resolve-project.mjs";
import { EMPTY_NEXT_UP_MESSAGE } from "@dev-loops/core/loop/queue-board-ordering";
import { loadStateColumnMap, LOGICAL_COLUMN } from "@dev-loops/core/loop/queue-board-sync";
import {
  OWNERSHIP_STATE,
  classifyOwnership,
  ownershipNeedsViewerLogin,
} from "@dev-loops/core/github/ownership-helpers";
import { editIssue } from "../github/edit-issue.mjs";
import { editPr } from "../github/edit-pr.mjs";

// Illustrative default labels for USAGE/help + comments only; the actual query
// columns resolve through queue.statusColumns.in_progress / .next_up at
// runtime (#1098, #1143).
const IN_PROGRESS_COLUMN = "In Progress";
const NEXT_UP_COLUMN = "Next Up";
// Canonical fail-closed empty-queue message — matches queue-driver.mjs so
// operators see one string regardless of which layer detects it (#1091).
const EMPTY_QUEUE_REASON = EMPTY_NEXT_UP_MESSAGE;

const USAGE = `Usage: dev-loops queue resolve-active --repo <owner/name> [--project <number|id>]

Resolve the board's single continue target for bare \`/loop-continue\`:
continues the one "${IN_PROGRESS_COLUMN}" item; if there is none, picks the HEAD
of "${NEXT_UP_COLUMN}" by POSITION ascending. Fails closed (no guessing) on
multiple in-progress items, and when "${NEXT_UP_COLUMN}" is empty. Never pulls
from Backlog.

Options:
  --repo <owner/name>     Required. Repository to scope the project search.
  --project <number|id>   Project number (integer) or node ID. When omitted,
                          resolved from .devloops tracker.board (or the
                          deprecated queue.board) number / title.
  --help, -h              Show this help.

Output (stdout):
  JSON, exactly one in-progress item:
    { ok: true, target: { kind: "issue"|"pr", number }, source: "in-progress" }
  JSON, zero in-progress + "${NEXT_UP_COLUMN}" head:
    { ok: true, target: { kind: "issue"|"pr", number }, source: "next-up" }
  JSON, fail closed (multiple in-progress, or empty "${NEXT_UP_COLUMN}"):
    { ok: false, reason: "..." }

${JQ_OUTPUT_USAGE}

Exit codes (default / unfiltered output):
  0 — a single continue target resolved (in-progress or "${NEXT_UP_COLUMN}" head)
  1 — usage or argument error
  2 — GitHub API error / invalid --jq filter
  3 — fail closed (pass an explicit issue/PR): multiple in-progress items, an
      empty "${NEXT_UP_COLUMN}" column, or the board/project could not be
      resolved (project, status field, or the column not found)

With --jq/--silent the result is filtered to a value/predicate, so the exit code
follows the shared jq-output contract (0 = truthy/ok, 1 = falsy/non-ok, 2 =
invalid filter) — fail closed surfaces as a falsy \`.ok\`, i.e. exit 1, not 3.
`.trim();

function parseCliArgs(argv) {
  const parseError = (message) => Object.assign(new Error(message), { usage: USAGE, code: "INVALID_ARGS" });
  const requireValue = (token, message) => {
    const v = token.value;
    if (typeof v !== "string" || v.length === 0 || v.startsWith("-")) {
      throw parseError(message);
    }
    return v;
  };

  const args = {};
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      project: { type: "string" },
      help: { type: "boolean", short: "h" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });

  for (const token of tokens) {
    if (token.kind === "positional") {
      throw parseError(`Unexpected argument: ${token.value}`);
    }
    if (token.kind !== "option") {
      continue;
    }
    switch (token.name) {
      case "help":
        if (token.value !== undefined) {
          throw parseError(`Unknown flag: ${token.rawName}=${token.value}`);
        }
        args.help = true;
        break;
      case "repo":
        args.repo = requireValue(token, "--repo requires a value (owner/name)");
        break;
      case "project":
        args.project = requireValue(token, "--project requires a value (number or node ID)");
        break;
      default: {
        if (matchJqOutputToken(token, args, (t) => requireValue(t, "--jq requires a filter"))) break;
        throw parseError(`Unknown flag: ${token.rawName}`);
      }
    }
  }
  return args;
}

function describeItem(item) {
  const ref = item.prNumber != null ? `PR #${item.prNumber}` : `issue #${item.issueNumber}`;
  return item.title ? `${ref} (${item.title})` : ref;
}

// Prefer the linked PR number when present (the canonical artifact once work is
// in flight), else the issue. No routing opinion beyond that single pick.
function itemToTarget(item) {
  return item.prNumber != null
    ? { kind: "pr", number: item.prNumber }
    : { kind: "issue", number: item.issueNumber };
}

// Collapse the "In Progress" column to a single continue target. The caller only
// invokes this with a NON-EMPTY column (zero In Progress falls through to
// resolveNextUpHead in main()), so this only decides among the in-progress items
// and never guesses when there is more than one.
function collapseToTarget(items) {
  if (items.length > 1) {
    const listed = items.map(describeItem).join(", ");
    return {
      ok: false,
      reason: `${items.length} in-progress board items: ${listed}. Pass an explicit issue/PR to disambiguate, e.g. \`/loop-continue #N\`.`,
    };
  }
  return { ok: true, target: itemToTarget(items[0]), source: "in-progress" };
}

// Single-contributor ownership gate for Next Up pickup (#1377): fetch the
// target's current assignees via `gh`. Resolves the viewer login only when a
// non-copilot assignee is present, keeping the copilot/empty cases immune to
// viewer-login resolution failures (same posture as resolve-dev-loop-startup).
async function fetchAssignees(target, repo, { env, runChild }) {
  const viewArgs = target.kind === "pr" ? ["pr", "view"] : ["issue", "view"];
  const result = await runChild("gh", [...viewArgs, String(target.number), "--repo", repo, "--json", "assignees"], env);
  if (result.code !== 0) {
    throw new Error(`gh ${viewArgs.join(" ")} ${target.number} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
  }
  const payload = JSON.parse(result.stdout);
  return Array.isArray(payload?.assignees) ? payload.assignees : [];
}

async function resolveViewerLogin({ env, runChild }) {
  const result = await runChild("gh", ["api", "user"], env);
  if (result.code !== 0) {
    throw new Error(
      `Unable to resolve the current GitHub viewer login (gh api user failed: ${result.stderr.trim() || `exit code ${result.code}`}); cannot verify or claim single-contributor ownership — fail closed. Check \`gh auth status\` and retry.`,
    );
  }
  let login;
  try {
    login = JSON.parse(result.stdout)?.login;
  } catch (err) {
    throw new Error(`Unable to parse gh api user output while resolving the viewer login: ${err.message}`);
  }
  if (typeof login !== "string" || login.length === 0) {
    throw new Error("gh api user returned no login; cannot verify or claim single-contributor ownership — fail closed.");
  }
  return login;
}

// Memoized viewer-login resolution shared across Next Up candidates within one
// resolveNextUpHead scan: resolves at most once, on first need.
async function ensureViewerLogin(viewerLoginBox, ctx) {
  if (!viewerLoginBox.resolved) {
    viewerLoginBox.login = await resolveViewerLogin(ctx);
    viewerLoginBox.resolved = true;
  }
  return viewerLoginBox.login;
}

// The sanctioned mutations this script performs, all on a Next Up item:
// claim (`@me`, visible to every other contributor's fail-closed ownership
// gate in resolve-dev-loop-startup.mjs), self-unclaim (`@me`, backing off a
// lost claim-contested tiebreak), and — as the tiebreak WINNER — removing the
// other contender's login(s) so the item converges to solely-owned (see
// resolveNextUpHead below).
async function editTargetAssignees(target, repo, { addAssignees = [], removeAssignees = [] }, { env, runChild }) {
  const options = { repo, addAssignees, removeAssignees };
  if (target.kind === "pr") {
    await editPr({ ...options, pr: target.number }, { env, ghCommand: "gh", run: runChild });
  } else {
    await editIssue({ ...options, issue: target.number }, { env, ghCommand: "gh", run: runChild });
  }
}
const claimTarget = (target, repo, ctx) => editTargetAssignees(target, repo, { addAssignees: ["@me"] }, ctx);
const unclaimTarget = (target, repo, ctx) => editTargetAssignees(target, repo, { removeAssignees: ["@me"] }, ctx);
const removeAssigneeLogins = (target, repo, logins, ctx) => editTargetAssignees(target, repo, { removeAssignees: logins }, ctx);

// Best-effort cleanup for a post-claim failure path (re-read error, or the
// tiebreak-loser's own unclaim call failing): swallow the cleanup attempt's
// own error and let the ORIGINAL error surface, so an orphaned self-claim
// isn't left behind on an aborted pick, while the run still fails closed.
async function bestEffortSelfUnclaim(target, repo, ctx) {
  try {
    await unclaimTarget(target, repo, ctx);
  } catch {
    // best-effort only
  }
}

// Run post-claim IO (a read or a mutation) with the same cleanup-on-failure
// posture: if `fn` throws, best-effort self-unclaim first (so an aborted pick
// never strands a phantom claim), then rethrow the ORIGINAL error unchanged so
// the run still fails closed.
async function withSelfUnclaimOnError(target, repo, ctx, fn) {
  try {
    return await fn();
  } catch (err) {
    await bestEffortSelfUnclaim(target, repo, ctx);
    throw err;
  }
}

// `gh ... --add-assignee` is not compare-and-swap: two loopers racing to claim
// the same unassigned item can both land as assignees. Deterministic tiebreak
// among a contested claim's contenders (viewer + the other human logins that
// showed up on re-read) — case-insensitive lexicographically-smallest login
// wins, so every racer computes the same winner independently.
function pickTiebreakWinner(logins) {
  return [...logins].sort((a, b) => {
    const [al, bl] = [a.toLowerCase(), b.toLowerCase()];
    return al < bl ? -1 : al > bl ? 1 : 0;
  })[0];
}

// Claim an UNASSIGNED Next Up candidate and arbitrate any concurrent-claim
// contest. Only call this when the pre-claim read was OWNERSHIP_STATE.UNASSIGNED
// (already-owned/foreign candidates never reach here).
//
// `gh ... --add-assignee` is not compare-and-swap, so another looper may have
// claimed concurrently — this re-reads right after claiming and:
//   - sole owner (empty or just us)            -> { outcome: "owned" }
//   - contested, viewer verified present too   -> deterministic tiebreak:
//       won  -> removes the other login(s), converging to solely-owned
//               -> { outcome: "owned", claimNote: "...claim_contested_won_tiebreak" }
//       lost -> self-unassigns, backs off
//               -> { outcome: "skip", skipReason: "...claim_contested_lost_tiebreak" }
//   - contested, but OUR OWN claim isn't visible in this read (read-after-write
//     lag, a degraded claim, a permissions quirk) -> not a contest we're part
//     of: never touches the other assignee, best-effort self-unclaims
//               -> { outcome: "skip", skipReason: "...claim_not_visible_post_read" }
// Any gh read/mutation failure throws (fail closed) after a best-effort
// self-unclaim — it never degrades into a skip outcome.
async function attemptClaimAndArbitrate(target, repo, { env, runChild, itemLabel, viewerLoginBox }) {
  const ctx = { env, runChild };
  await claimTarget(target, repo, ctx);
  const viewerLogin = await withSelfUnclaimOnError(target, repo, ctx, () => ensureViewerLogin(viewerLoginBox, ctx));
  const postClaimAssignees = await withSelfUnclaimOnError(target, repo, ctx, () => fetchAssignees(target, repo, ctx));
  const postClaimOwnership = classifyOwnership(postClaimAssignees, viewerLogin);
  if (postClaimOwnership.state !== OWNERSHIP_STATE.ASSIGNED_TO_OTHER) {
    return { outcome: "owned" };
  }
  // ASSIGNED_TO_OTHER only means "some non-viewer human is present" — it does
  // NOT guarantee our own claim is actually visible in this same read.
  const viewerLoginLower = viewerLogin.toLowerCase();
  const viewerVisible = postClaimAssignees.some(
    (a) => typeof a?.login === "string" && a.login.toLowerCase() === viewerLoginLower,
  );
  if (!viewerVisible) {
    await bestEffortSelfUnclaim(target, repo, ctx);
    return {
      outcome: "skip",
      skipReason: `${itemLabel} claim was not visible on re-read (only ${postClaimOwnership.foreignLogins.join(", ")} showed up) — not our item to arbitrate, skipped (claim_not_visible_post_read).`,
    };
  }
  const winner = pickTiebreakWinner([viewerLogin, ...postClaimOwnership.foreignLogins]);
  if (winner.toLowerCase() !== viewerLogin.toLowerCase()) {
    // Lost: back off so the winner ends up the sole assignee once IT observes
    // this same contested state (see below). If both racers' re-reads instead
    // land before the other's write propagates, neither observes the
    // contention at all — that rare case is the documented safe-stuck
    // residual, not something this branch can detect or fix.
    await withSelfUnclaimOnError(target, repo, ctx, () => unclaimTarget(target, repo, ctx));
    return {
      outcome: "skip",
      skipReason: `${itemLabel} claim contested by ${postClaimOwnership.foreignLogins.join(", ")}; lost the tiebreak — skipped (claim_contested_lost_tiebreak).`,
    };
  }
  // Won: the other contender may have raced ahead, seen itself as sole owner
  // (before this claim landed), and already proceeded — an interleaving this
  // removal closes: the raced-past contender's own next ownership read sees
  // only this winner and fails closed as foreign, instead of double-starting.
  await withSelfUnclaimOnError(target, repo, ctx, () => removeAssigneeLogins(target, repo, postClaimOwnership.foreignLogins, ctx));
  return {
    outcome: "owned",
    claimNote: `${itemLabel} claim was contested by ${postClaimOwnership.foreignLogins.join(", ")}; won the tiebreak and removed them (claim_contested_won_tiebreak).`,
  };
}

// Zero in-progress: the live continue path falls through to the "Next Up"
// column, scanned by POSITION ascending (list-queue-items returns position
// order). NEVER pulls from Backlog; empty Next Up fails closed with the
// canonical message, and a query error propagates (fail closed — surface it,
// no fallback).
//
// Ownership gate (#1377): each candidate is skipped if it is assigned to a
// human other than the viewer (reported in `skipped`); an unassigned
// candidate is claimed (`@me`) and picked; a viewer-owned or copilot-owned
// candidate is picked as-is. If every item is foreign-owned, pickup fails
// closed with the skip reasons — parallel loopers naturally take disjoint work.
async function resolveNextUpHead(args, { env, runChild, cwd = process.cwd() } = {}) {
  // Resolve the next_up column name through the SAME statusColumns mapping
  // board-sync uses (#1098): a repo that renamed Next Up (e.g. to "Todo") gets
  // its configured column queried, not the literal default. Pickup SEMANTICS
  // (position-ascending HEAD, fail-closed on empty, never Backlog) are unchanged.
  const { columnNames, error: configError } = loadStateColumnMap(cwd);
  if (configError) {
    // A malformed `.devloops` must fail CLOSED — never silently fall back to the
    // literal "Next Up" and risk selecting the wrong item from a stale/renamed
    // column (#1098). Throw so the CLI surfaces it (exit 2), mirroring a Next Up
    // query error's "propagate, no fallback" contract.
    throw Object.assign(
      new Error(`could not resolve next_up column (config read/parse error: ${configError})`),
      { code: "CONFIG_ERROR" },
    );
  }
  const nextUpColumn = columnNames[LOGICAL_COLUMN.NEXT_UP];
  const listed = await listQueueItems(
    { repo: args.repo, project: args.project, projectTitle: args.projectTitle, column: nextUpColumn },
    { env, runChild },
  );
  const items = listed.items ?? [];
  if (items.length === 0) {
    return { ok: false, reason: EMPTY_QUEUE_REASON, source: "next-up" };
  }
  const viewerLoginBox = { login: null, resolved: false };
  const skipped = [];
  for (const item of items) {
    const target = itemToTarget(item);
    const assignees = await fetchAssignees(target, args.repo, { env, runChild });
    if (ownershipNeedsViewerLogin(assignees)) {
      await ensureViewerLogin(viewerLoginBox, { env, runChild });
    }
    const ownership = classifyOwnership(assignees, viewerLoginBox.login);
    if (ownership.state === OWNERSHIP_STATE.ASSIGNED_TO_OTHER) {
      skipped.push({
        target,
        reason: `${describeItem(item)} is assigned to ${ownership.foreignLogins.join(", ")}, not the current viewer — skipped.`,
      });
      continue;
    }
    let claimNote;
    if (ownership.state === OWNERSHIP_STATE.UNASSIGNED) {
      const attempt = await attemptClaimAndArbitrate(target, args.repo, {
        env,
        runChild,
        itemLabel: describeItem(item),
        viewerLoginBox,
      });
      if (attempt.outcome === "skip") {
        skipped.push({ target, reason: attempt.skipReason });
        continue;
      }
      claimNote = attempt.claimNote;
    }
    return {
      ok: true,
      target,
      source: "next-up",
      ...(skipped.length > 0 ? { skipped } : {}),
      ...(claimNote ? { claimNote } : {}),
    };
  }
  return {
    ok: false,
    reason: `Every ${NEXT_UP_COLUMN} item is owned by another contributor: ${skipped.map((s) => s.reason).join(" ")}`,
    source: "next-up",
    skipped,
  };
}

async function main(args, { env = process.env, runChild, cwd = process.cwd() } = {}) {
  // Resolve the in_progress column name through the SAME statusColumns mapping
  // board-sync uses (#1098, #1143): a repo that renamed In Progress gets its
  // configured column queried, not the literal default. Fail CLOSED on a
  // malformed `.devloops` — never silently query the literal "In Progress"
  // and risk missing the active item on a renamed/stale column.
  const { columnNames, error: configError } = loadStateColumnMap(cwd);
  if (configError) {
    throw Object.assign(
      new Error(`could not resolve in_progress column (config read/parse error: ${configError})`),
      { code: "CONFIG_ERROR" },
    );
  }
  const inProgressColumn = columnNames[LOGICAL_COLUMN.IN_PROGRESS];
  const listed = await listQueueItems(
    { repo: args.repo, project: args.project, projectTitle: args.projectTitle, column: inProgressColumn },
    { env, runChild },
  );
  const items = listed.items ?? [];
  // Exactly one → continue it. Multiple → fail closed (never guess). Zero →
  // fall through to the Next Up head (the live pickup path, #1091).
  if (items.length === 0) {
    return resolveNextUpHead(args, { env, runChild, cwd });
  }
  return collapseToTarget(items);
}

function classifyExitCode(err) {
  if (err.code === "INVALID_ARGS" || err.code === "INVALID_REPO" || err.code === "INVALID_PROJECT") return 1;
  if (err.code === "PROJECT_NOT_FOUND" || err.code === "FIELD_NOT_FOUND" || err.code === "COLUMN_NOT_FOUND") return 3;
  return 2;
}

async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, runChild, cwd = process.cwd() } = {}) {
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    stdout.write(USAGE);
    return;
  }

  // Resolve the board from .devloops when --project is absent.
  applyDevloopsBoard(args, cwd);

  try {
    const result = await main(args, { env, runChild, cwd });
    // Fail closed (zero/multiple) is a clean, expected outcome — distinct exit code 3,
    // not a crash; --jq/--silent still apply so callers can probe `.ok`.
    process.exitCode = emitResult(result, {
      jq: args.jq,
      silent: args.silent,
      stdout,
      stderr,
      ok: result.ok,
    });
    if (result.ok !== true && args.jq === undefined && !args.silent) {
      process.exitCode = 3;
    }
  } catch (err) {
    stderr.write(JSON.stringify({ ok: false, error: err.message, code: err.code ?? "UNKNOWN" }) + "\n");
    process.exitCode = classifyExitCode(err);
  }
}

if (isDirectCliRun(import.meta.url)) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(JSON.stringify({ ok: false, error: error.message, code: error.code ?? "UNKNOWN" }) + "\n");
    process.exitCode = 2;
  });
}

export { main, collapseToTarget, resolveNextUpHead, attemptClaimAndArbitrate, runCli };
