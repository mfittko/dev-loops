#!/usr/bin/env node
/**
 * resolve-reviewer-role
 *
 * Sanctioned CLI for a gate reviewer to resolve ONE angle's reviewer role for
 * a named review operation from the fully merged dev-loops config (shipped
 * extension default + the repo's `.pi/dev-loop/defaults` + `.devloops`
 * merge-by-name), returning the persona, its focus prompt, and the
 * authoritative harness-resolved model tier. This is the wrapper that lets a
 * reviewer obey OPS-NO-INLINE-INTERPRETER instead of grepping
 * `packages/core/src/config/extension-defaults.yaml` directly — a raw grep of
 * the shipped defaults misses the config-layer merge, so it yields the wrong
 * persona/model whenever a repo overrides an angle in `.devloops`.
 *
 * Config-only (no git, no GitHub), matching the scripts/loop/ placement of
 * pre-flight-gate / gate-coordination. ALL angle-pool/eligibility logic lives
 * in the ONE shared authority this CLI calls
 * (`resolveOperationReviewerRole`/`resolveOperationAnglePool`,
 * `@dev-loops/core/loop/review-operation`) — this file must never reimplement
 * a membership/union/additive/disabled/spike classifier of its own.
 *
 * The reviewer boundary is exit code plus the optional returned `prompt`:
 * exit 0 means consume `persona`/`model`, use `prompt` when present,
 * otherwise review the authorized angle by name; a nonzero exit means stop.
 * Inside a fan-out unit (defensively re-validating a carried role), emit the
 * blocked result via `emit-reviewer-blocked.mjs`; running standalone, instead
 * report the angle as blocked in the review verdict output (owning rule: the
 * Persona mapping bullet in skills/copilot-pr-followup/SKILL.md). `status` is
 * a DIAGNOSTIC field only — it is never a second reviewer decision branch.
 */
import { parseArgs } from "node:util";

import { loadDevLoopConfig } from "@dev-loops/core/config";
import { REVIEW_OPERATIONS, resolveOperationReviewerRole } from "@dev-loops/core/loop/review-operation";
import { isClaudeHarness } from "@dev-loops/core/loop/run-context";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { resolveRepoRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: resolve-reviewer-role.mjs --gate <${REVIEW_OPERATIONS.join("|")}> --angle <name> [--harness <pi|claude>]

Resolve a gate angle's reviewer role for a review operation from the fully
merged config (shipped extension default + the repo's .pi/dev-loop/defaults +
.devloops merge-by-name). Returns the persona, its focus prompt, and the
authoritative harness-resolved model tier, authorized against the operation's
legal candidate angle pool (the same pool dispatch/planning uses — see
@dev-loops/core/loop/review-operation). Use this instead of grepping
extension-defaults.yaml directly — a raw grep misses the .devloops
config-layer merge and yields the wrong persona/model.

Required:
  --gate <op>             Review operation: ${REVIEW_OPERATIONS.join(" | ")}
                           (standalone review is only ever selected by
                           --gate review, never inferred from an omitted flag)
  --angle <name>           Gate angle / lens name (e.g. correctness, security)

Optional:
  --harness <pi|claude>    Harness whose concrete model tier to resolve
                            (default: "claude" under Claude Code, else "pi")
  --help, -h                Show this help

Output (stdout, JSON):
  {
    "ok": true,
    "operation": "pre_approval_gate",
    "angle": "correctness",
    "harness": "claude",
    "persona": "review",
    "prompt": "…" | null,
    "model": "…" | null,      // authoritative merged tier (kind:"angle")
    "fallback": false,
    "status": "resolved",     // diagnostic only: config-error | non-member | fallback | prompt-missing | resolved
    "warnings": [],
    "configErrors": []
  }

${JQ_OUTPUT_USAGE}

Note: for this command, --silent's exit code always reflects \`ok\`, never the
--jq predicate's truthiness (the reviewer safety boundary overrides the
shared --jq/--silent composition described above).

Exit codes:
  0  ok: true  — config errors absent AND the angle is a legal member of the operation's pool
  1  ok: false — config-layer errors present, or the angle is not a legal member of the operation's pool
  2  Argument/runtime error, or invalid --jq filter`;

const parseError = buildParseError(USAGE);
const HARNESSES = new Set(["pi", "claude"]);

export function parseResolveReviewerRoleCliArgs(argv, { env = process.env } = {}) {
  const options = { help: false, gate: null, angle: null, harness: null };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      gate: { type: "string" },
      angle: { type: "string" },
      harness: { type: "string" },
      ...JQ_OUTPUT_PARSE_OPTIONS,
    },
    allowPositionals: true,
    strict: false,
    tokens: true,
  });
  for (const token of tokens) {
    if (token.kind === "positional") throw parseError(`Unknown argument: ${token.value}`);
    if (token.kind !== "option") continue;
    if (token.name === "help") { options.help = true; return options; }
    if (token.name === "gate") { options.gate = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "angle") { options.angle = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "harness") { options.harness = requireTokenValue(token, parseError).trim(); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.gate) {
    throw parseError(`resolve-reviewer-role requires --gate <${REVIEW_OPERATIONS.join("|")}>`);
  }
  if (!REVIEW_OPERATIONS.includes(options.gate)) {
    throw parseError(`--gate must be one of ${REVIEW_OPERATIONS.join("|")} (got ${JSON.stringify(options.gate)})`);
  }
  if (!options.angle) throw parseError("resolve-reviewer-role requires --angle <name>");
  // `!== null` (not a truthiness check) so a whitespace-only --harness that
  // trims to "" is still rejected here, matching --gate/--angle's rejection
  // of the same input, instead of silently falling through to the env
  // default below.
  if (options.harness !== null && !HARNESSES.has(options.harness)) {
    throw parseError(`--harness must be one of pi|claude (got ${JSON.stringify(options.harness)})`);
  }
  if (!options.harness) options.harness = isClaudeHarness(env) ? "claude" : "pi";
  return options;
}

export async function runCli(argv = process.argv.slice(2), { repoRoot = resolveRepoRoot(process.cwd()), env = process.env } = {}) {
  const options = parseResolveReviewerRoleCliArgs(argv, { env });
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const loadResult = await loadDevLoopConfig({ repoRoot });
  const result = resolveOperationReviewerRole(loadResult, {
    operation: options.gate,
    angle: options.angle,
    harness: options.harness,
  });
  const emitted = emitResult(result, { jq: options.jq, silent: options.silent, fields: options.fields });
  // emitResult's --jq + --silent path reports the jq PREDICATE's truthiness
  // (e.g. `.persona` is a non-empty string even for a non-member/fallback
  // role), not `result.ok` — that would let a blocked reviewer read exit 0.
  // The reviewer exit-code boundary is `result.ok`, full stop; only a genuine
  // emit-time error (invalid --jq/--fields, exit 2) overrides it.
  process.exitCode = emitted === 2 ? 2 : (result.ok ? 0 : 1);
  return result;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 2;
  });
}
