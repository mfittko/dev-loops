#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { gateScopePrefix, normalizeGate } from "./_gate-names.mjs";
import { HEAD_SHA_RE, VALID_SCOPE_RE } from "./record-dispatch-prompt-layout.mjs";
import { buildGateContextPath } from "./write-gate-context.mjs";
import { composeAndRecordReviewerPrompt } from "./compose-reviewer-prompt.mjs";
import { loadDevLoopConfig } from "@dev-loops/core/config";

const USAGE = `Usage: emit-fanout-dispatch.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate|review> --head-sha <sha> [--pending] [--tmp-root <path>] [--help]
The SANCTIONED one-shot gate fan-out dispatch step (issue #2092): given a gate +
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
configured table never named (the requireFanoutProvenance breach seen on
#2100/#2101). A configured group's reviewer records that group's name as its
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
    "count": <n>, "units": [ { "scope": "...", "angles": ["..."], "group": <name|null>, "promptPath": "..." } ] }
  A fail-closed refusal (exit 1) emits { "ok": false, "error": "..." } on STDOUT
  (via the shared jq-output emitter); a usage/parse error (exit 2) emits
  { "ok": false, "error": "...", "hint"?: "run with --help for usage" } on STDERR.
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
 * for an ad-hoc auto-chunk unit the configured table never named (the
 * requireFanoutProvenance breach seen on #2100/#2101). Angle order is preserved.
 * Pure.
 * @param {{ name: string, angles: string[] }[]} units resolveFanoutGroups output
 * @param {Set<string>} configuredGroupNames configured gates.fanout.groups names
 * @returns {{ name: string, angles: string[] }[]}
 */
export function expandDispatchUnits(units, configuredGroupNames) {
  const out = [];
  for (const unit of Array.isArray(units) ? units : []) {
    const angles = Array.isArray(unit?.angles) ? unit.angles.filter((a) => typeof a === "string" && a.trim().length > 0) : [];
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
    const angles = Array.isArray(unit?.angles) ? unit.angles.filter((a) => typeof a === "string" && a.trim().length > 0) : [];
    if (angles.length === 0) {
      return finish({ ok: false, error: `dispatch unit ${JSON.stringify(unit?.name ?? unit)} carries no angles — malformed fanout plan` }, false);
    }
  }

  // Only CONFIGURED gates.fanout.groups share one reviewer; every ungrouped
  // angle (including one resolveFanoutGroups auto-chunked into a leftover unit)
  // gets its own singleton reviewer. Load the same config write-gate-context
  // resolved against (this step runs in that worktree).
  let configuredGroupNames;
  try {
    const { config } = await loadDevLoopConfig({ repoRoot: process.cwd() });
    configuredGroupNames = new Set((config?.gates?.fanout?.groups ?? []).map((g) => g?.name).filter((n) => typeof n === "string" && n.length > 0));
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

  return finish({ ok: true, gate, headSha, repo, pr, count: emitted.length, units: emitted }, true);
}

if (isDirectCliRun(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    process.exitCode = 2;
  }
}
