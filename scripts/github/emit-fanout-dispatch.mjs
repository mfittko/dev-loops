#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult, preflightJqFilter } from "../lib/jq-output.mjs";
import { gateScopePrefix, normalizeGate } from "./_gate-names.mjs";
import { HEAD_SHA_RE, VALID_SCOPE_RE } from "./record-dispatch-prompt-layout.mjs";
import { buildGateContextPath, buildGateEmitPlanPath } from "./write-gate-context.mjs";
import { composeAndRecordReviewerPrompt } from "./compose-reviewer-prompt.mjs";
import { loadDevLoopConfig, resolveFanoutEffectiveConcurrency } from "@dev-loops/core/config";

const USAGE = `Usage: emit-fanout-dispatch.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate|review> --head-sha <sha> [--pending] [--tmp-root <path>] [--help]
The SANCTIONED one-shot gate fan-out dispatch step: given a gate +
head whose write-gate-context.mjs bundle is already on disk, it reads the resolved
fan-out plan (the artifact's fanout.groups / fanout.pendingGroups, from
resolveFanoutGroups) and, for each dispatch unit, composes a ready-to-dispatch
reviewer prompt via compose-reviewer-prompt.mjs's atomic composer. It is the ONE
place the gate-context bundle is turned into per-unit reviewer prompts, so a
coordinator never re-derives persona/prompt composition and never spelunks
print-gates.mjs.

Dispatch-unit rule: only a CONFIGURED gates.fanout.groups group shares one
reviewer. Every angle NOT in a configured group gets its OWN distinct reviewer —
including angles resolveFanoutGroups auto-chunked into a leftover \`group:...\`
unit, which this step SPLITS back into per-angle singletons. A coordinator can
therefore never seed a shared reviewer for an ad-hoc auto-chunk unit the
configured table never named (a requireFanoutProvenance breach). A configured
group's reviewer records that group's name as its
provenance \`group\`, matching the merge guard's own resolveFanoutGroups
re-derivation (detect-checkpoint-evidence.mjs); a singleton records no group.

The per-unit angle-suffix this emits only NAMES the unit's angle(s) and instructs
the reviewer to self-resolve each angle's persona/prompt (resolveReviewerRole) —
it never inlines persona text extracted by the coordinator. Reviewer composition
is resolved by the review agent + the neutral bundle (see the review agent's
scoped angle-review mode), not re-derived here.

Run write-gate-context.mjs FIRST (it writes the briefing prefix, volatile tail,
and the fanout dispatch plan this reads). Then dispatch ONE fresh-context \`review\`
subagent per emitted unit, seeded with that unit's promptPath bytes verbatim, and
record each unit's \`group\` on Phase 3's provenance (null for a singleton unit; the
configured group name for a shared unit).

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
                               means nothing is pending and refuses with "zero
                               units" rather than silently re-emitting the full set.
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

/**
 * The deterministic angle-suffix for a dispatch unit: it NAMES the unit's
 * angle(s) and instructs the reviewer to self-resolve each angle's persona/focus
 * via resolveReviewerRole and review adversarially per its scoped-mode contract.
 * It never inlines persona text — reviewer composition is the review agent's job.
 * Pure.
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
  return `${header}\n\n${body}\n`;
}

/**
 * Expand resolveFanoutGroups units into the dispatch units this step actually
 * seeds reviewers for: only a CONFIGURED gates.fanout.groups group (a
 * multi-angle unit whose name is in `configuredGroupNames`) shares one reviewer;
 * every other angle — an ungrouped angle that resolveFanoutGroups auto-chunked
 * into a leftover `group:...` unit, or a single-angle unit — gets its OWN
 * singleton reviewer. This is the "angles not in a configured group get their
 * own distinct reviewer" rule: a coordinator can never seed a shared reviewer
 * for an ad-hoc auto-chunk unit the configured table never named (a
 * requireFanoutProvenance breach). Angle order is preserved. Pure.
 * @param {{ name: string, angles: string[] }[]} units resolveFanoutGroups output
 * @param {Set<string>} configuredGroupNames configured gates.fanout.groups names
 * @returns {{ name: string, angles: string[] }[]}
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
  const out = [];
  for (const unit of Array.isArray(units) ? units : []) {
    const angles = normalizeUnitAngles(unit);
    const isConfiguredGroup = angles.length > 1 && typeof unit?.name === "string" && configuredGroupNames.has(unit.name);
    if (isConfiguredGroup) {
      out.push({ name: unit.name, angles });
    } else {
      for (const angle of angles) out.push({ name: angle, angles: [angle] });
    }
  }
  return out;
}

function resolveFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val === "" || (val.length > 0 && val[0] === "-")) return "";
  return val;
}

export async function main(argv = process.argv.slice(2), { tmpRootDefault = path.join(process.cwd(), "tmp") } = {}) {
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
  const jqArg = resolveFlagValue(argv, "--jq");
  if (jqArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --jq value: must be non-empty."))}\n`);
    return 2;
  }
  const jq = jqArg === null ? undefined : jqArg;
  const silent = argv.includes("--silent") || argv.includes("-s");
  const finish = (payload, ok) => emitResult(payload, { jq, silent, ok });

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
  if (!Array.isArray(units) || units.length === 0) {
    return finish({ ok: false, error: `GATE-EXEC-FANOUT-DISPATCH-EMIT: refusing — fanout dispatch plan resolves zero units (${pendingOnly ? "pendingGroups" : "groups"}) — nothing to dispatch` }, false);
  }
  // An angle-less resolved unit is a malformed plan: refuse rather than silently
  // contribute zero reviewers for it.
  for (const unit of units) {
    if (normalizeUnitAngles(unit).length === 0) {
      return finish({ ok: false, error: `dispatch unit ${JSON.stringify(unit?.name ?? unit)} carries no angles — malformed fanout plan` }, false);
    }
  }

  // Only CONFIGURED gates.fanout.groups share one reviewer; every ungrouped
  // angle (including one resolveFanoutGroups auto-chunked into a leftover unit)
  // gets its own singleton reviewer. Load the same config write-gate-context
  // resolved against (this step runs in that worktree).
  let configuredGroupNames;
  let maxConcurrent;
  try {
    const { config } = await loadDevLoopConfig({ repoRoot: process.cwd() });
    configuredGroupNames = new Set((config?.gates?.fanout?.groups ?? []).map((g) => g?.name).filter((n) => typeof n === "string" && n.length > 0));
    // The concurrency bound the coordinator MUST wave the EMITTED (split) units
    // by — the artifact's fanout.wavePlan is computed over the UNSPLIT
    // resolveFanoutGroups units and no longer matches this step's unit set.
    maxConcurrent = resolveFanoutEffectiveConcurrency(config);
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
    emitted.push({ scope, angles, group: angles.length > 1 ? unit.name : null, promptPath: result.promptPath });
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
  const payload = { ok: true, gate, headSha, repo, pr, pending: pendingOnly, count: emitted.length, maxConcurrent, units: emitted };
  const planPath = buildGateEmitPlanPath({ repo, pr, gate, headSha, tmpRoot });
  try {
    await mkdir(path.dirname(planPath), { recursive: true });
    await writeFile(planPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }
  return finish(payload, true);
}

if (isDirectCliRun(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 2;
  }
}
