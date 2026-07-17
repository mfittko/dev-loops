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
//                                  compare-and-swap) and resolves a contested
//                                  claim with a deterministic tiebreak: the loser
//                                  self-unassigns and skips (`claim_contested_lost_
//                                  tiebreak`); the winner removes the loser
//                                  login(s) so the item converges to solely-owned
//                                  regardless of race order (`claimNote:
//                                  claim_contested_won_tiebreak`). SKIPS items
//                                  owned by another human (reported in `skipped`)
//                                  -> { ok: true, target: {kind,number},
//                                  source: "next-up", skipped?: [...], claimNote?: "..." }
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
import { EMPTY_NEXT_UP_MESSAGE } from "@dev-loops/core/loop/queue-board-ordering";
import { loadStateColumnMap, LOGICAL_COLUMN } from "@dev-loops/core/loop/queue-board-sync";
import {
  OWNERSHIP_STATE,
  OwnershipGateFailure,
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

const USAGE = `Usage: dev-loops queue resolve-active --repo <owner/name> --project <number|id>

Resolve the board's single continue target for bare \`/loop-continue\`:
continues the one "${IN_PROGRESS_COLUMN}" item; if there is none, picks the HEAD
of "${NEXT_UP_COLUMN}" by POSITION ascending. Fails closed (no guessing) on
multiple in-progress items, and when "${NEXT_UP_COLUMN}" is empty. Never pulls
from Backlog.

Options:
  --repo <owner/name>     Required. Repository to scope the project search.
  --project <number|id>   Required. Project number (integer) or node ID.
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
    throw new OwnershipGateFailure(
      `Unable to resolve the current GitHub viewer login (gh api user failed: ${result.stderr.trim() || `exit code ${result.code}`}); cannot verify or claim single-contributor ownership — fail closed. Check \`gh auth status\` and retry.`,
    );
  }
  let login;
  try {
    login = JSON.parse(result.stdout)?.login;
  } catch (err) {
    throw new OwnershipGateFailure(`Unable to parse gh api user output while resolving the viewer login: ${err.message}`);
  }
  if (typeof login !== "string" || login.length === 0) {
    throw new OwnershipGateFailure("gh api user returned no login; cannot verify or claim single-contributor ownership — fail closed.");
  }
  return login;
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
    { repo: args.repo, project: args.project, column: nextUpColumn },
    { env, runChild },
  );
  const items = listed.items ?? [];
  if (items.length === 0) {
    return { ok: false, reason: EMPTY_QUEUE_REASON, source: "next-up" };
  }
  let viewerLogin = null;
  let viewerLoginResolved = false;
  const skipped = [];
  for (const item of items) {
    const target = itemToTarget(item);
    const assignees = await fetchAssignees(target, args.repo, { env, runChild });
    if (ownershipNeedsViewerLogin(assignees) && !viewerLoginResolved) {
      viewerLogin = await resolveViewerLogin({ env, runChild });
      viewerLoginResolved = true;
    }
    const ownership = classifyOwnership(assignees, viewerLogin);
    if (ownership.state === OWNERSHIP_STATE.ASSIGNED_TO_OTHER) {
      skipped.push({
        target,
        reason: `${describeItem(item)} is assigned to ${ownership.foreignLogins.join(", ")}, not the current viewer — skipped.`,
      });
      continue;
    }
    let claimNote;
    if (ownership.state === OWNERSHIP_STATE.UNASSIGNED) {
      await claimTarget(target, args.repo, { env, runChild });
      // Post-claim re-verify: the claim above is not compare-and-swap, so
      // another looper may have claimed concurrently. Re-read and resolve a
      // contested claim with the deterministic tiebreak instead of trusting
      // the claim call alone.
      if (!viewerLoginResolved) {
        try {
          viewerLogin = await resolveViewerLogin({ env, runChild });
        } catch (err) {
          // Don't leave an orphaned self-claim behind on an aborted pick.
          await bestEffortSelfUnclaim(target, args.repo, { env, runChild });
          throw err;
        }
        viewerLoginResolved = true;
      }
      let postClaimAssignees;
      try {
        postClaimAssignees = await fetchAssignees(target, args.repo, { env, runChild });
      } catch (err) {
        // Don't leave an orphaned self-claim behind on an aborted pick.
        await bestEffortSelfUnclaim(target, args.repo, { env, runChild });
        throw err;
      }
      const postClaimOwnership = classifyOwnership(postClaimAssignees, viewerLogin);
      if (postClaimOwnership.state === OWNERSHIP_STATE.ASSIGNED_TO_OTHER) {
        const winner = pickTiebreakWinner([viewerLogin, ...postClaimOwnership.foreignLogins]);
        if (winner.toLowerCase() !== viewerLogin.toLowerCase()) {
          // Lost: back off so the winner ends up the sole assignee. The
          // winner (see below) removes this login once IT observes the same
          // contested state, so this item converges to solely-owned even if
          // this looper is raced past. If this login is itself somehow raced
          // past the winner's removal, everyone's sole-owner startup gate is
          // the universal backstop.
          try {
            await unclaimTarget(target, args.repo, { env, runChild });
          } catch (err) {
            await bestEffortSelfUnclaim(target, args.repo, { env, runChild });
            throw err;
          }
          skipped.push({
            target,
            reason: `${describeItem(item)} claim contested by ${postClaimOwnership.foreignLogins.join(", ")}; lost the tiebreak — skipped (claim_contested_lost_tiebreak).`,
          });
          continue;
        }
        // Won: the OTHER contender(s) may have raced ahead, seen themselves
        // as sole owner (before this claim landed), and already proceeded to
        // pick this same item — an interleaving that would otherwise strand
        // it co-assigned. Removing them here converges ownership regardless
        // of race order: the raced-past contender's own startup gate then
        // re-reads and sees only this winner -> assigned_to_other -> clean
        // fail-closed skip, no stuck state.
        try {
          await removeAssigneeLogins(target, args.repo, postClaimOwnership.foreignLogins, { env, runChild });
        } catch (err) {
          await bestEffortSelfUnclaim(target, args.repo, { env, runChild });
          throw err;
        }
        claimNote = `${describeItem(item)} claim was contested by ${postClaimOwnership.foreignLogins.join(", ")}; won the tiebreak and removed them (claim_contested_won_tiebreak).`;
      }
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
    { repo: args.repo, project: args.project, column: inProgressColumn },
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

export { main, collapseToTarget, resolveNextUpHead, runCli };
