#!/usr/bin/env node
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateZeroUnitCarryProof } from "./_carried-angles.mjs";
import { angleReviewSurface } from "@dev-loops/core/loop/gate-carry-forward";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult, preflightJqFilter } from "../lib/jq-output.mjs";
import { gateScopePrefix, LIFECYCLE_GATES, normalizeGate } from "./_gate-names.mjs";
import { HEAD_SHA_RE, VALID_SCOPE_RE } from "./record-dispatch-prompt-layout.mjs";
import { buildCarryForwardPlanPath, buildGateContextPath, buildGateEmitPlanPath, mapGateToConfigKey } from "./write-gate-context.mjs";
import { buildLogPath } from "./write-gate-findings-log.mjs";
import { composeAndRecordReviewerPrompt } from "./compose-reviewer-prompt.mjs";
import { loadDevLoopConfig, resolveFanoutEffectiveConcurrency, resolveGateAngleContract } from "@dev-loops/core/config";
import { PROHIBITED_REVIEWER_OPERATIONS, REVIEWER_UNIT_BUDGET, REVIEWER_UNIT_MAX_ANGLES } from "@dev-loops/core/loop/reviewer-unit-bound";

const USAGE = `Usage: emit-fanout-dispatch.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate|review> --head-sha <sha> [--pending] [--tmp-root <path>] [--help]
The SANCTIONED one-shot gate fan-out dispatch step: given a gate +
head whose write-gate-context.mjs bundle is already on disk, it reads the resolved
fan-out plan (the artifact's fanout.groups / fanout.pendingGroups, from
resolveFanoutGroups) and, for each dispatch unit, composes a ready-to-dispatch
reviewer prompt via compose-reviewer-prompt.mjs's atomic composer. It is the ONE
place the gate-context bundle is turned into per-unit reviewer prompts, so a
coordinator never re-derives persona/prompt composition and never spelunks
print-gates.mjs.

Dispatch-unit rule: EVERY multi-angle resolveFanoutGroups unit — a CONFIGURED
gates.fanout.groups group OR an auto-chunked leftover \`group:...\` bundle —
shares one reviewer, and never more than REVIEWER_UNIT_MAX_ANGLES (${REVIEWER_UNIT_MAX_ANGLES}) angles
per reviewer. A multi-angle unit LARGER than that cap deterministically splits
into ordered ≤${REVIEWER_UNIT_MAX_ANGLES}-angle sub-units (\`<name>-part1\`, \`<name>-part2\`, ...) — angle
order preserved, nothing dropped/duplicated/merged. Only a genuine SINGLE-angle
unit gets its own distinct singleton reviewer. This matches ADR 0048's
grouped-dispatch-default: resolveFanoutGroups draws no dispatch-relevant
distinction between a configured group and an auto-chunk bundle, so this step
no longer does either. A multi-angle unit's (or split sub-unit's) reviewer
records a non-null provenance \`group\` — the resolved unit's own name; each
sub-unit's angles stay members of the SAME resolved unit, so the merge guard's
resolveFanoutGroups re-derivation (detect-checkpoint-evidence.mjs's
fanoutReviewerPairingError, the fail-closed authority for this) still pairs
them honestly whether the unit is configured or auto-chunked. A singleton
from an unsplit single-angle resolved unit records no group; a one-angle split
tail retains its original unit's group.

The per-unit angle-suffix this emits only NAMES the unit's angle(s) and instructs
the reviewer to self-resolve each angle's persona/prompt (resolveReviewerRole) —
it never inlines persona text extracted by the coordinator. Reviewer composition
is resolved by the review agent + the neutral bundle (see the review agent's
scoped angle-review mode), not re-derived here.

Run write-gate-context.mjs FIRST (it writes the briefing prefix, volatile tail,
and the fanout dispatch plan this reads). Then dispatch ONE fresh-context \`review\`
subagent per emitted unit, seeded with that unit's promptPath bytes verbatim, and
record each unit's \`group\` on Phase 3's provenance (null for an unsplit singleton;
the original resolved unit's name for a shared unit or any split sub-unit).

Required:
  --repo <owner/name>        Same vocabulary as write-gate-context.mjs.
  --pr <number>               Same vocabulary as write-gate-context.mjs.
  --gate <draft_gate|pre_approval_gate|review>
                               Same vocabulary as write-gate-context.mjs.
  --head-sha <sha>            The FULL 40- or 64-char reviewed head SHA.
Optional:
  --pending                    Emit only fanout.pendingGroups (the resumable
                               shortfall subset a budget-limited round still owes)
                               instead of the full fanout.groups. Falls back to
                               fanout.groups only when pendingGroups is ABSENT (an
                               older artifact); a PRESENT-but-empty pendingGroups
                               requires every resolved angle to be carried with
                               --carry-forward-plan proof, or refuses zero units.
  --carry-forward-plan <json>  Resolver output (or its carried array). Required
                               for a zero-unit pending round; persisted with the
                               keyed plan for fan-in and provenance verification.
  --tmp-root <path>            The tmp/ directory the round's gate-context
                               artifacts live under (default: process.cwd()/tmp;
                               must match the write-gate-context.mjs call).
Output (stdout, JSON):
  { "ok": true, "gate": "...", "headSha": "...", "repo": "...", "pr": "...",
    "pending": <true|false>, "count": <n>, "maxConcurrent": <n>, "units": [ { "scope": "...", "angles": ["..."], "group": <name|null>, "promptPath": "..." } ] }
  Wave the EMITTED units at most \`maxConcurrent\` at a time (1 when
  gates.fanout.sequential is set). Do NOT use the artifact's fanout.wavePlan to
  bound this step: that plan is computed over the UNSPLIT resolveFanoutGroups
  units and no longer matches this step's split unit set.
  A fail-closed refusal (exit 1) emits { "ok": false, "error": "..." } on STDOUT
  (via the shared jq-output emitter); a usage/parse error (exit 2) emits
  { "ok": false, "error": "...", "hint"?: "run with --help for usage" } on STDERR.
  On success this step ALSO persists its emitted round plan to the keyed
  <gate>-<headSha>.emit-plan.json sibling of the gate-context bundle
  (buildGateEmitPlanPath, GATE-EXEC-FANOUT-DISPATCH-EMIT) — body = the emitter's
  own result object — so a consumer reads THAT keyed path and never hand-rolls
  a fixed-path stdout capture that concurrent gates would clobber; the keyed
  plan is REMOVED at the start of the run, so any refusal or error leaves NO
  plan file on disk even when an earlier successful run at the same key wrote
  one; a failed persist exits 2 (a persist failure is an IO failure, not a
  plan-semantics refusal).
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Emitted one composed prompt per resolved dispatch unit
  1  Refused: the gate-context artifact is missing (run write-gate-context.mjs
     first), carries no fanout dispatch plan, has a present-but-non-array
     pendingGroups under --pending, resolves zero units, a unit carries no
     angles, a dispatch unit's name sanitizes to an invalid scope, two units
     derive a colliding scope, or a unit's invariant-prefix record is missing /
     suffix could not be composed
  2  Usage or internal error (bad --repo/--pr/--gate/--head-sha shape, filesystem
     error, or invalid --jq filter)`.trim();

const parseError = buildParseError(USAGE);

/**
 * Derive the reviewer-sentinel/prompt-layout scope for a resolved dispatch unit.
 * A singleton unit dispatches under its angle name (`<gatePrefix><angle>`); a
 * multi-angle unit dispatches under `<gatePrefix>group-<sanitized name>`. Unit
 * names from resolveFanoutGroups can carry `:`/`+`/`#` (auto-chunk units like
 * `group:a+b+c`), which VALID_SCOPE_RE forbids, so a multi-angle scope sanitizes
 * the name to alphanumeric/hyphen. The scope keys the sentinel/prompt layout
 * only; the EXACT unit name is carried separately as the provenance `group`.
 * Pure.
 * @param {string} gate normalized gate id
 * @param {{ name: string, angles: string[] }} unit
 * @returns {string}
 */
export function dispatchUnitScope(gate, unit) {
  const prefix = gateScopePrefix(gate);
  const angles = Array.isArray(unit?.angles) ? unit.angles : [];
  if (angles.length === 1) return `${prefix}${sanitizeScopeSegment(angles[0])}`;
  return `${prefix}group-${sanitizeScopeSegment(unit?.name ?? "")}`;
}

/**
 * Collapse any run of non-alphanumeric characters to a single hyphen and trim
 * leading/trailing hyphens, so an arbitrary unit name becomes a VALID_SCOPE_RE
 * segment. Pure.
 * @param {string} value
 * @returns {string}
 */
export function sanitizeScopeSegment(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}

// Human phrasing for each PROHIBITED_REVIEWER_OPERATIONS kind. The RENDERED
// SET is still driven off the array (buildAngleNamingSuffix below maps over
// it), so an unmapped kind still renders (via the fallback) rather than
// silently vanishing from the prompt — this dict only supplies wording, never
// which kinds appear.
const PROHIBITED_OPERATION_INSTRUCTIONS = {
  poll_pr_state: "do not poll PR state",
  poll_ci_state: "do not poll CI state",
  poll_copilot_state: "do not poll Copilot state",
  network_status_probe: "do not invoke network status probes",
  rerun_validation: "do not rerun validation",
  inspect_orchestration_runtime: "do not inspect orchestration runtime internals",
  review_unassigned_angle: "do not review unassigned angles",
};

/**
 * The deterministic angle-suffix for a dispatch unit: it NAMES the unit's
 * angle(s), instructs the reviewer to self-resolve each angle's persona/focus
 * via resolveReviewerRole and review adversarially per its scoped-mode contract,
 * and carries the bounded reviewer contract (REVIEWER_UNIT_BUDGET, assigned-
 * angles-only scope, PROHIBITED_REVIEWER_OPERATIONS, and the escape hatch for
 * BOTH ways a unit can fail its bound — budget exhaustion or incomplete angle
 * coverage, mirroring enforceReviewerUnitBound's own two REVOKE conditions in
 * reviewer-unit-bound.mjs) so a reviewer never has to consult the primitive
 * directly to learn its own bound. The budget/prohibited numbers are read
 * from the primitive, never hard-coded, so this text can't drift from
 * reviewer-unit-bound.mjs. It never inlines persona text — reviewer
 * composition is the review agent's job. Pure: generates no new unit/scope
 * names, only references unit.angles/unit.name. The escape-hatch invocation
 * it names is described with PLACEHOLDERS the reviewer fills from values it
 * already has (self-reported coverage/consumption, and the head SHA /
 * findings directory named earlier in the briefing) — it never interpolates
 * a concrete angle name (or any other concrete value) into the shell-command
 * text, since an angle name is only required to be a non-empty string and
 * could otherwise carry shell metacharacters into a copy-pasted command.
 * @param {{ name: string, angles: string[] }} unit
 * @returns {string}
 */
export function buildAngleNamingSuffix(unit) {
  const angles = Array.isArray(unit?.angles) ? unit.angles : [];
  const list = angles.join(", ");
  const single = angles.length === 1;
  const header = single
    ? `## Your review angle: ${list}`
    : `## Your review angles (dispatch unit "${unit?.name}"): ${list}`;
  const body = single
    ? `Self-resolve this angle's persona and focus prompt via resolveReviewerRole(config, "${angles[0]}") from @dev-loops/core/config, then review adversarially per your scoped angle-review mode. Write one findings artifact for this angle at its per-angle path.`
    : `For EACH angle above, self-resolve its persona and focus prompt via resolveReviewerRole(config, <angle>) from @dev-loops/core/config, then review adversarially per your scoped angle-review mode. Write one findings artifact PER ANGLE at its per-angle path — one artifact per angle, never one merged artifact for the unit.`;
  const prohibited = PROHIBITED_REVIEWER_OPERATIONS
    .map((kind) => PROHIBITED_OPERATION_INSTRUCTIONS[kind] ?? `do not perform ${kind}`)
    .join("; ");
  const contract = `## Bounded reviewer contract
Budget: at most ${REVIEWER_UNIT_BUDGET.maxModelTurns} model turns and ${REVIEWER_UNIT_BUDGET.maxToolCalls} tool calls for this unit.
Scope: review ONLY the angle(s) named above — reviewing an unassigned angle is prohibited.
Prohibited: ${prohibited}.
If you exceed this budget (more than ${REVIEWER_UNIT_BUDGET.maxModelTurns} model turns or ${REVIEWER_UNIT_BUDGET.maxToolCalls} tool calls) OR cannot finish reviewing every assigned angle within it, do NOT report clean — emit a durable blocked result via: dev-loops-run scripts/github/emit-reviewer-blocked.mjs --run <reviewed head sha> --head-sha <reviewed head sha> --angles <your assigned angles, comma-separated> --completed-angles <angles you finished> --model-turns <model turns you used> --tool-calls <tool calls you used> --findings-dir <the per-angle findings directory named in the briefing prefix above>.`;
  return `${header}\n\n${body}\n\n${contract}\n`;
}

/**
 * Generate a split sub-unit's scope-distinguishing name: `${baseName}-part${n}`,
 * disambiguated against `configuredGroupNames` on their SANITIZED form — the
 * same sanitizeScopeSegment dispatchUnitScope applies when deriving a
 * multi-angle unit's scope. Comparing raw names is not enough: a
 * separately-configured "backend_part1" group sanitizes to the SAME
 * "group-backend-part1" scope as a generated "backend-part1" sub-unit even
 * though the raw strings differ, so the collision must be caught here too —
 * while the candidate's sanitized form is itself a configured group's
 * sanitized name, append a further suffix until it is not. The dispatch
 * loop's seenScopes guard below remains the final backstop for any residual
 * collision this cannot see. Deterministic, pure.
 * @param {string} baseName configured group name being split
 * @param {number} n 1-based split index
 * @param {Set<string>} configuredGroupNames configured gates.fanout.groups names
 * @returns {string}
 */
export function splitSubUnitName(baseName, n, configuredGroupNames) {
  const sanitizedConfiguredNames = new Set(Array.from(configuredGroupNames, (name) => sanitizeScopeSegment(name)));
  let candidate = `${baseName}-part${n}`;
  let bump = 0;
  while (sanitizedConfiguredNames.has(sanitizeScopeSegment(candidate))) {
    bump += 1;
    candidate = `${baseName}-part${n}-x${bump}`;
  }
  return candidate;
}

/**
 * Expand resolveFanoutGroups units into the dispatch units this step actually
 * seeds reviewers for: EVERY multi-angle unit — a CONFIGURED `gates.fanout.groups`
 * group or an auto-chunked leftover `group:...` bundle, resolveFanoutGroups
 * draws no distinction between the two for dispatch purposes (ADR 0048's
 * grouped-dispatch-default; issue 2180 reconciles this emitter to it) — shares
 * ONE reviewer, capped at `REVIEWER_UNIT_MAX_ANGLES` via the same ordered
 * cap-split used for an over-cap configured group. Only a genuine single-angle
 * unit dispatches as a singleton. The merge guard (`fanoutReviewerPairingError`
 * in `@dev-loops/core/loop/gate-fanin`) is the fail-closed authority here: it
 * re-derives this round's grouping from `resolveFanoutGroups` independently
 * (`detect-checkpoint-evidence.mjs`) and already honors a shared identity
 * within ANY resolved unit — configured or auto-chunk — so the emitter no
 * longer needs to be more conservative than the guard by splitting an
 * auto-chunk bundle to singletons. Angle order is preserved, nothing
 * dropped/duplicated/merged. Every emitted unit carries a `group`: the
 * resolved unit's own name (configured or auto-chunk) for a multi-angle unit
 * (whole or split sub-unit), null for a genuine singleton — this is
 * provenance, distinct from `name` (which scopes the reviewer and, for a
 * split sub-unit, is disambiguated via splitSubUnitName). `configuredGroupNames`
 * is used only for that disambiguation (together with this round's own unit
 * names), never to classify a unit as shared vs. singleton. Pure.
 * @param {{ name: string, angles: string[] }[]} units resolveFanoutGroups output
 * @param {Set<string>} configuredGroupNames configured gates.fanout.groups names
 * @returns {{ name: string, angles: string[], group: string|null }[]}
 */
/**
 * The single normalization for a unit's angle list: keep non-empty string
 * angles, trimmed. Used by both the angle-less refusal pre-check and
 * expandDispatchUnits so the fail-closed guard and the dispatch classification
 * can never disagree on a unit's angle set. Pure.
 * @param {{ angles?: unknown }} unit
 * @returns {string[]}
 */
export function normalizeUnitAngles(unit) {
  return Array.isArray(unit?.angles) ? unit.angles.filter((a) => typeof a === "string" && a.trim().length > 0).map((a) => a.trim()) : [];
}

export function expandDispatchUnits(units, configuredGroupNames) {
  const unitList = Array.isArray(units) ? units : [];
  // Disambiguate a split sub-unit's name against every configured group name
  // AND every OTHER unit resolved this round (a configured group's name and an
  // auto-chunk bundle's stable name both key a real emitted scope this round,
  // so both are live collision candidates — not just the configured table).
  const collisionNames = new Set(configuredGroupNames);
  for (const unit of unitList) {
    if (typeof unit?.name === "string" && unit.name.length > 0) collisionNames.add(unit.name);
  }
  const out = [];
  for (const unit of unitList) {
    const angles = normalizeUnitAngles(unit);
    // Every multi-angle resolved unit — a CONFIGURED gates.fanout.groups group
    // or an auto-chunked leftover `group:...` bundle — shares one reviewer;
    // resolveFanoutGroups draws no dispatch-relevant distinction between the
    // two (ADR 0048), so neither does this step. Only a genuine single-angle
    // unit is a singleton.
    if (angles.length > 1) {
      // Cap each dispatch unit at REVIEWER_UNIT_MAX_ANGLES assigned angles (the
      // reviewer-unit-bound primitive's contract). A unit within the cap keeps
      // its exact name (unchanged behaviour). A unit LARGER than the cap
      // deterministically splits into ordered ≤cap sub-units — angle order
      // preserved, no angle dropped, duplicated, or merged. Each sub-unit gets
      // a distinct, collision-disambiguated `<name>-part<n>` name
      // (splitSubUnitName) so its reviewer scope (dispatchUnitScope) never
      // collides with a sibling's — the dispatch loop's seenScopes guard below
      // remains the final backstop for any residual collision this cannot see.
      // Every sub-unit records the RESOLVED unit's own name (not its own split
      // name) as `group` — matching the contract's provenance rule — and stays
      // a member of the SAME resolved unit, so the fan-in pairing check
      // (fanoutReviewerPairingError, re-derived via resolveFanoutGroups) stays
      // honest for a configured group AND an auto-chunk bundle alike.
      // maxConcurrent already counts EMITTED dispatch units, so a split simply
      // yields more units per wave — never more angles per unit.
      if (angles.length <= REVIEWER_UNIT_MAX_ANGLES) {
        out.push({ name: unit.name, angles, group: unit.name });
      } else {
        for (let i = 0; i < angles.length; i += REVIEWER_UNIT_MAX_ANGLES) {
          const chunk = angles.slice(i, i + REVIEWER_UNIT_MAX_ANGLES);
          const n = i / REVIEWER_UNIT_MAX_ANGLES + 1;
          out.push({ name: splitSubUnitName(unit.name, n, collisionNames), angles: chunk, group: unit.name });
        }
      }
    } else {
      for (const angle of angles) out.push({ name: angle, angles: [angle], group: null });
    }
  }
  return out;
}

/**
 * List the durable gate-findings-log heads for THIS gate at a head DIFFERENT
 * from the current one. A prior-round log is the deterministic signal that this
 * is not the gate's first round — independent of whether the driver passed
 * `--prev-head`, so a driver cannot evade the carry-forward step by omitting the
 * flag (the exact defect GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED prevents). Only draft_gate / pre_approval_gate
 * carry forward (the review gate has no resolver), so the caller guards this to
 * those gates. A non-empty result makes the current head a re-gate.
 *
 * FAIL-CLOSED on the scan: ENOENT (the findings-log directory does not exist)
 * genuinely means "no prior round" and returns the empty set. Any OTHER readdir
 * error (EACCES, ENOTDIR, …) is NOT proof of a first round — this is an
 * enforcement chokepoint, so it rethrows rather than fail-open to "not a re-gate"
 * and silently skipping the guard.
 * @returns {Promise<Set<string>>} lowercased full SHAs of prior findings-logs
 */
export async function listPriorFindingsLogHeads({ repo, pr, gate, headSha, tmpRoot }) {
  const dir = path.dirname(buildLogPath({ repo, pr, gate, headSha, tmpRoot }));
  const want = String(headSha).trim().toLowerCase();
  const prefix = `${gate}-`;
  const heads = new Set();
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return heads;
    throw err;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".json")) continue;
    const sha = entry.slice(prefix.length, -".json".length).toLowerCase();
    if (!/^[0-9a-f]{7,64}$/.test(sha) || sha === want) continue;
    // Do NOT trust the filename alone: a stale or arbitrary `<gate>-<sha>.json`
    // in this directory must not count as a real prior round (that would let a
    // fabricated carry-forward marker naming a bogus prevHead satisfy the guard).
    // Require the file to be a genuine keyed findings-log whose OWN recorded
    // headSha matches the filename before counting it. A non-ENOENT read error
    // rethrows (fail-closed, like the readdir above); a missing/malformed/
    // identity-mismatched file is simply not a valid prior round and is skipped.
    let log;
    try {
      log = JSON.parse(await readFile(path.join(dir, entry), "utf8"));
    } catch (err) {
      if (err?.code && err.code !== "ENOENT") throw err;
      continue;
    }
    const recordedHead = log && typeof log.headSha === "string" ? log.headSha.trim().toLowerCase() : null;
    if (recordedHead === sha) heads.add(sha);
  }
  return heads;
}

function resolveFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val === "" || (val.length > 0 && val[0] === "-")) return "";
  return val;
}

export async function main(argv = process.argv.slice(2), { tmpRootDefault = path.join(process.cwd(), "tmp"), persistPlan = writeFile } = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const repo = resolveFlagValue(argv, "--repo");
  if (repo === null || repo === "") {
    process.stderr.write(`${formatCliError(parseError("--repo is required and must be non-empty (owner/name)."))}\n`);
    return 2;
  }
  const pr = resolveFlagValue(argv, "--pr");
  if (pr === null || pr === "") {
    process.stderr.write(`${formatCliError(parseError("--pr is required and must be non-empty."))}\n`);
    return 2;
  }
  const gateArg = resolveFlagValue(argv, "--gate");
  const gate = gateArg === null || gateArg === "" ? null : normalizeGate(gateArg);
  if (!gate) {
    process.stderr.write(`${formatCliError(parseError(`--gate is required and must be one of: draft_gate, pre_approval_gate, review${gateArg ? ` (got ${JSON.stringify(gateArg)})` : ""}.`))}\n`);
    return 2;
  }
  const headShaArg = resolveFlagValue(argv, "--head-sha");
  if (headShaArg === null || headShaArg === "" || !HEAD_SHA_RE.test(headShaArg)) {
    process.stderr.write(`${formatCliError(parseError(`--head-sha is required and must be the FULL 40- or 64-character hex head SHA${headShaArg ? ` (got ${JSON.stringify(headShaArg)})` : ""}.`))}\n`);
    return 2;
  }
  const headSha = headShaArg.toLowerCase();
  const tmpRootArg = resolveFlagValue(argv, "--tmp-root");
  if (tmpRootArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --tmp-root value: must be non-empty."))}\n`);
    return 2;
  }
  const tmpRoot = tmpRootArg ?? tmpRootDefault;
  const pendingOnly = argv.includes("--pending");

  let contextPath;
  try {
    contextPath = buildGateContextPath({ repo, pr, gate, headSha, tmpRoot });
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }

  // GATE-EXEC-FANOUT-DISPATCH-EMIT: clear the keyed
  // <gate>-<headSha>.emit-plan.json sibling (buildGateEmitPlanPath) at the
  // very START of the emission flow — BEFORE the gate-context artifact is
  // read/parsed — so literally every non-success exit after this point
  // (missing artifact, malformed/unparseable JSON, no fanout plan, zero
  // units, any per-unit refusal) leaves it ABSENT. Without this, a successful
  // earlier run at the same gate/head key survives a failed re-run, and a
  // later fan-in (which key-checks that file) can accept the stale plan as
  // this round's — the exact stale-plan hazard the key guard trusts this
  // path's freshness for. ENOENT on the rm is fine (no prior plan exists).
  // The success-only WRITE at the end of main is unchanged — this removes,
  // it does not pre-persist anything.
  try {
    await rm(buildGateEmitPlanPath({ repo, pr, gate, headSha, tmpRoot }), { force: true });
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }

  // The round key is now known and its prior plan is gone, so every remaining
  // refusal — including an explicitly empty --jq value — leaves no stale plan.
  const jqArg = resolveFlagValue(argv, "--jq");
  if (jqArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --jq value: must be non-empty."))}\n`);
    return 2;
  }
  const jq = jqArg === null ? undefined : jqArg;
  const silent = argv.includes("--silent") || argv.includes("-s");
  const finish = (payload, ok) => emitResult(payload, { jq, silent, ok });

  let artifact;
  try {
    artifact = JSON.parse(await readFile(contextPath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") {
      return finish({ ok: false, error: `no gate-context artifact at ${JSON.stringify(contextPath)} — run write-gate-context.mjs for this (gate, headSha) first` }, false);
    }
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }

  // --jq syntax preflight (Copilot review round 4): runs AFTER the keyed-plan
  // removal above (so an invalid filter still leaves the keyed plan ABSENT —
  // a prior successful run's stale plan must never survive a failed re-run)
  // but BEFORE any unit is composed and BEFORE the success-only plan persist,
  // so a syntactically invalid filter can never exit 2 with a freshly written
  // keyed plan on disk. emitResult's own data-dependent jq errors (e.g. `length`
  // on a scalar) stay at emit time, unchanged.
  const jqSyntaxError = preflightJqFilter(jq);
  if (jqSyntaxError !== undefined) return jqSyntaxError;

  const fanout = artifact?.fanout;
  if (!fanout || typeof fanout !== "object") {
    return finish({ ok: false, error: `GATE-EXEC-FANOUT-DISPATCH-EMIT: refusing — gate-context artifact at ${JSON.stringify(contextPath)} carries no fanout dispatch plan — re-run write-gate-context.mjs (a thin briefing with no --base emits no fanout plan)` }, false);
  }

  // GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED: on a re-gate head — a
  // durable findings-log for this gate exists at an EARLIER head — carry-forward
  // MUST have been consulted before any reviewer is dispatched.
  // resolve-angle-carry-forward.mjs records its plan (or a fail-closed
  // full-fallback marker) as the keyed <gate>-<headSha>.carry-forward-plan.json
  // sibling at the CURRENT head; its ABSENCE means the re-gate skipped the
  // resolver entirely and would re-fan every angle — the exact amplifier this
  // issue exists to prevent. Refuse to emit (no reviewer spawned) until the
  // resolver has run at this head. This is the earliest chokepoint (before the
  // wasted fan-out), chosen over the post-hoc ledger seam. Only the lifecycle
  // gates carry forward; the review gate has no resolver, so it never guards
  // here. Bind to the exported LIFECYCLE_GATES set (not a parallel inline
  // literal) so a future lifecycle gate is guarded automatically rather than
  // silently falling open — the same load-bearing derivation _gate-names.mjs
  // uses for GATE_NAMES.
  if (LIFECYCLE_GATES.includes(gate)) {
    const priorHeads = await listPriorFindingsLogHeads({ repo, pr, gate, headSha, tmpRoot });
    if (priorHeads.size > 0) {
      let plan = null;
      try {
        plan = JSON.parse(await readFile(buildCarryForwardPlanPath({ repo, pr, gate, headSha, tmpRoot }), "utf8"));
      } catch {
        plan = null;
      }
      // Bind the plan to THIS round's full identity — the same (repo, pr, gate,
      // headSha) key write-gate-findings-log enforces, plus `prevHead`. Requiring
      // `prevHead` to be one of the ACTUAL prior findings-log heads is what stops a
      // wrong/guessed --prev-head (or a plan copied from another PR) from being
      // laundered into "the resolver ran": a marker whose prevHead names no real
      // prior round does not satisfy the guard. repo/gate are compared
      // case-insensitively, matching the findings-log identity check.
      // Require the artifact to be a genuine resolver OUTCOME, not merely a JSON
      // object carrying the five identity fields: a hand-written/truncated file
      // must not satisfy the guard. A valid plan is either a success result
      // (`ok: true`) or the documented fail-closed full-fallback marker
      // (`ok: false, fallback: true`) — nothing else.
      const planOutcomeValid = plan
        && (plan.ok === true || (plan.ok === false && plan.fallback === true));
      const planOk = planOutcomeValid
        && String(plan.headSha ?? "").trim().toLowerCase() === headSha
        && String(plan.gate ?? "").trim().toLowerCase() === gate
        && String(plan.repo ?? "").trim().toLowerCase() === repo.trim().toLowerCase()
        && String(plan.pr ?? "") === String(pr)
        && priorHeads.has(String(plan.prevHead ?? "").trim().toLowerCase());
      if (!planOk) {
        return finish({ ok: false, error: `GATE-EXEC-CARRY-FORWARD-PLAN-REQUIRED: refusing — a prior gate findings-log for ${gate} exists at an earlier head (this is a re-gate), but no valid carry-forward plan artifact (keyed to this repo/pr/gate/head with a prevHead naming a real prior round) is recorded at the current head ${headSha}. Run scripts/github/resolve-angle-carry-forward.mjs --repo ${repo} --pr ${pr} --gate ${gate} --prev-head <A> --head-sha ${headSha} from the current-head worktree before dispatch — the resolver records the plan this step requires.` }, false);
      }
    }
  }

  // --pending falls back to `groups` ONLY when pendingGroups is genuinely ABSENT
  // (an older artifact). A PRESENT-but-non-array pendingGroups is a malformed
  // plan and refuses — silently falling back would mask a broken plan and
  // re-emit the full set the caller explicitly did not ask for.
  let units;
  if (pendingOnly && fanout.pendingGroups !== undefined) {
    if (!Array.isArray(fanout.pendingGroups)) {
      return finish({ ok: false, error: `GATE-EXEC-FANOUT-DISPATCH-EMIT: refusing — fanout.pendingGroups is present but not an array (malformed plan); re-run write-gate-context.mjs` }, false);
    }
    units = fanout.pendingGroups;
  } else {
    units = fanout.groups;
  }
  // A zero-unit pending plan is valid only when every original angle was
  // carried. Completed-only resumes and malformed empty plans still refuse;
  // fan-in independently verifies the carry proof before accepting findings.
  const carried = new Set(Array.isArray(fanout.preflight?.carriedAngles)
    ? fanout.preflight.carriedAngles.filter((angle) => typeof angle === "string").map((angle) => angle.trim().toLowerCase()) : []);
  const allCarried = pendingOnly && Array.isArray(fanout.groups) && fanout.groups.length > 0
    && fanout.groups.every((unit) => normalizeUnitAngles(unit).length > 0
      && normalizeUnitAngles(unit).every((angle) => carried.has(angle.trim().toLowerCase())));
  if (!Array.isArray(units) || (units.length === 0 && !allCarried)) {
    return finish({ ok: false, error: `GATE-EXEC-FANOUT-DISPATCH-EMIT: refusing — fanout dispatch plan resolves zero units (${pendingOnly ? "pendingGroups" : "groups"}) — nothing to dispatch` }, false);
  }
  let carryProof;
  if (units.length === 0) {
    try {
      const angles = fanout.groups.flatMap(normalizeUnitAngles);
      if (angles.some((angle) => angleReviewSurface(angle).kind !== "kinds")) {
        throw new Error("zero-unit plan cannot carry mandatory, always-run, or unknown angles");
      }
      carryProof = validateZeroUnitCarryProof(JSON.parse(resolveFlagValue(argv, "--carry-forward-plan") ?? "null"), angles);
    } catch (error) {
      return finish({ ok: false, error: `zero-unit carry proof refused: ${error.message}` }, false);
    }
  }
  // An angle-less resolved unit is a malformed plan: refuse rather than silently
  // contribute zero reviewers for it.
  for (const unit of units) {
    if (normalizeUnitAngles(unit).length === 0) {
      return finish({ ok: false, error: `dispatch unit ${JSON.stringify(unit?.name ?? unit)} carries no angles — malformed fanout plan` }, false);
    }
  }

  // Every multi-angle resolveFanoutGroups unit shares one reviewer, configured
  // group or auto-chunk bundle alike (see expandDispatchUnits); configuredGroupNames
  // is passed through only for split sub-unit name disambiguation. Load the same
  // config write-gate-context resolved against (this step runs in that worktree).
  let configuredGroupNames;
  let maxConcurrent;
  try {
    const { config } = await loadDevLoopConfig({ repoRoot: process.cwd() });
    if (carryProof !== undefined) {
      const alwaysRerun = resolveGateAngleContract(config, mapGateToConfigKey(gate)).mandatoryAngles;
      if (carryProof.some(({ angle }) => angleReviewSurface(angle, { alwaysRerun }).kind !== "kinds")) {
        throw new Error("zero-unit plan cannot carry configured mandatory angles");
      }
    }
    configuredGroupNames = new Set((config?.gates?.fanout?.groups ?? []).map((g) => g?.name).filter((n) => typeof n === "string" && n.length > 0));
    // The concurrency bound the coordinator MUST wave the EMITTED (split) units
    // by — the artifact's fanout.wavePlan is computed over the UNSPLIT
    // resolveFanoutGroups units and no longer matches this step's unit set.
    maxConcurrent = resolveFanoutEffectiveConcurrency(config, process.env);
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }
  // Every dispatch unit here already carries a filtered, non-empty angle list; a
  // shared unit is a configured group (a valid string name), a singleton uses
  // its angle as the name — so both the scope and the provenance group are
  // well-formed by construction.
  const dispatchUnits = expandDispatchUnits(units, configuredGroupNames);

  const emitted = [];
  const seenScopes = new Set();
  for (const unit of dispatchUnits) {
    const angles = unit.angles;
    const scope = dispatchUnitScope(gate, unit);
    if (!VALID_SCOPE_RE.test(scope)) {
      return finish({ ok: false, error: `derived scope ${JSON.stringify(scope)} for unit ${JSON.stringify(unit?.name)} is not a valid reviewer scope (alphanumeric/hyphen only)` }, false);
    }
    // sanitizeScopeSegment is lossy, so two distinct resolveFanoutGroups unit
    // names could collapse to one scope — which would silently overwrite a
    // sibling unit's prompt file and share its sentinel scope. Refuse instead.
    if (seenScopes.has(scope)) {
      return finish({ ok: false, error: `dispatch unit ${JSON.stringify(unit?.name)} derives scope ${JSON.stringify(scope)}, which collides with an earlier unit's scope — distinct units must dispatch under distinct scopes` }, false);
    }
    seenScopes.add(scope);
    const suffixPath = path.join(path.dirname(contextPath), `${gate}-${headSha}.angle-suffix-${scope}.txt`);
    try {
      await mkdir(path.dirname(suffixPath), { recursive: true });
      await writeFile(suffixPath, buildAngleNamingSuffix(unit), "utf8");
    } catch (err) {
      process.stderr.write(`${formatCliError(err)}\n`);
      return 2;
    }

    let result;
    try {
      result = await composeAndRecordReviewerPrompt({ repo, pr, gate, headSha, scope, angleSuffixFile: suffixPath, tmpRoot });
    } catch (err) {
      process.stderr.write(`${formatCliError(err)}\n`);
      return 2;
    }
    if (!result.composed || !result.recorded) {
      return finish({ ok: false, error: `failed to compose reviewer prompt for unit ${JSON.stringify(unit?.name)} (scope ${scope}): ${result.reason}` }, false);
    }
    emitted.push({ scope, angles, group: unit.group, promptPath: result.promptPath });
  }

  // GATE-EXEC-FANOUT-DISPATCH-EMIT: success-only persist of the emitted round
  // plan at this point — every refusal/error return above already left NO plan
  // file (the start-of-flow rm removed any prior plan at this key before the
  // artifact was even read, so "leaves NO plan file" holds even across
  // re-runs). A re-run at the same key overwrites deterministically (the same
  // round). Two gates at one head write distinct files by path construction.
  // The persist is unconditional on the
  // success path (--pending/--jq/--silent shape stdout only); the --jq filter
  // is syntax-preflighted BEFORE this write, so a post-persist jq failure is
  // limited to data-dependent evaluation errors against a successfully emitted
  // round. A failed persist
  // is an IO failure and takes the module's formatCliError/exit-2 tier, matching
  // the suffix-write catch block directly above — exit 1 stays reserved for
  // plan-semantics refusals.
  //
  // Final-emission failure (Copilot review round 5): a data-invalid but
  // syntactically valid filter (e.g. `.count | length` — a number is not a
  // valid `length` input) makes finish() exit 2 AFTER the plan was persisted,
  // and a throw is the same tier. That leaves a key-valid plan from a FAILED
  // invocation that a later fan-in key-check would accept as this round's —
  // the exact stale-plan hazard the start-of-flow rm protects every earlier
  // refusal against. Remove the plan (ENOENT-tolerant force rm) on either
  // failure shape, then propagate the exit-2/throw unchanged. Only the final
  // success emit runs after the persist, so guarding here (rather than around
  // each earlier finish call, all of which run before the persist) is the one
  // complete seam.
  const payload = { ok: true, gate, headSha, repo, pr, pending: pendingOnly, count: emitted.length, maxConcurrent, units: emitted };
  if (carryProof !== undefined) payload.carried = carryProof;
  const planPath = buildGateEmitPlanPath({ repo, pr, gate, headSha, tmpRoot });
  try {
    await mkdir(path.dirname(planPath), { recursive: true });
    await persistPlan(planPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (err) {
    try {
      await rm(planPath, { force: true });
    } catch {
      // Best-effort clear only — never mask the original persist failure.
    }
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }
  try {
    const result = finish(payload, true);
    // finish() returning 2 is emitResult's data-dependent jq-error path (exit
    // 2, distinct from the ok predicate's 0/1): the just-persisted plan came
    // from this FAILED emission and must not survive for a later fan-in to
    // consume. ENOENT-tolerant force rm; a clear failure never masks the
    // exit-2.
    if (result === 2) {
      try {
        await rm(planPath, { force: true });
      } catch {
        // Best-effort clear only — never mask the exit-2.
      }
    }
    return result;
  } catch (err) {
    // A throw from the final emission is the same failure tier: the persisted
    // plan must not survive it. Best-effort clear; never mask the throw.
    try {
      await rm(planPath, { force: true });
    } catch {
      // Best-effort clear only — never mask the original emit failure.
    }
    throw err;
  }
}

if (isDirectCliRun(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 2;
  }
}
