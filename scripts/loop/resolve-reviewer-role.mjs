#!/usr/bin/env node
/**
 * resolve-reviewer-role
 *
 * Sanctioned CLI for a gate reviewer to resolve ONE angle's reviewer role from
 * the fully merged dev-loops config (shipped extension default + the repo's
 * `.devloops` merge-by-name), returning the persona prompt and the authoritative
 * model tier. This is the wrapper that lets reviewers obey OPS-NO-INLINE-INTERPRETER
 * instead of grepping `packages/core/src/config/extension-defaults.yaml` directly —
 * a raw grep of the shipped defaults misses the config-layer merge, so it yields
 * the wrong persona/model whenever a repo overrides an angle in `.devloops`.
 *
 * Config-only (no git, no GitHub), matching the scripts/loop/ placement of
 * pre-flight-gate / gate-coordination. It reuses the existing role-resolution
 * helpers (`resolveReviewerRole`, `resolveRoleModel`, `resolveGateAngleScope`)
 * unchanged — the role/persona/model-tier data model is out of scope here.
 *
 * The primary `model` in the output is `resolveRoleModel(..., { kind: "angle" })`
 * (the merged, harness-resolved tier the gate-review-sub-loop contract mandates),
 * NOT the bare `resolveReviewerRole(...).model` override. Both are emitted so a
 * caller can see the override separately, but `model` is the authoritative one.
 */
import { parseArgs } from "node:util";

import { loadDevLoopConfig, resolveGateAngleScope, resolveReviewerRole, resolveRoleModel } from "@dev-loops/core/config";
import { isClaudeHarness } from "@dev-loops/core/loop/run-context";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: resolve-reviewer-role.mjs --angle <name> [--gate <draft|preApproval|spike>] [--harness <pi|claude>]

Resolve a gate angle's reviewer role from the fully merged config (shipped
extension default + the repo's .devloops merge-by-name). Returns the persona,
its focus prompt, and the authoritative harness-resolved model tier. Use this
instead of grepping extension-defaults.yaml directly — a raw grep misses the
.devloops config-layer merge and yields the wrong persona/model.

Required:
  --angle <name>         Gate angle / lens name (e.g. correctness, security)

Optional:
  --gate <g>             One of draft|preApproval|spike; when given, also
                          resolves the angle's declared surface scope
  --harness <pi|claude>  Harness whose concrete model tier to resolve
                          (default: "claude" under Claude Code, else "pi")
  --help, -h             Show this help

Output (stdout, JSON):
  {
    "ok": true,
    "angle": "correctness",
    "harness": "claude",
    "persona": "review",
    "prompt": "…" | null,
    "model": "…" | null,        // authoritative merged tier (resolveRoleModel, kind:"angle")
    "overrideModel": "…" | null, // bare resolveReviewerRole(...).model override, if any
    "fallback": false,
    "gate": "draft",            // only when --gate given
    "scope": "full"             // only when --gate given
  }

${JQ_OUTPUT_USAGE}

Exit codes:
  0  resolved
  2  Argument/runtime error, or invalid --jq filter`;

const parseError = buildParseError(USAGE);

const GATES = new Set(["draft", "preApproval", "spike"]);
const HARNESSES = new Set(["pi", "claude"]);

export function parseResolveReviewerRoleCliArgs(argv, { env = process.env } = {}) {
  const options = { help: false, angle: null, gate: null, harness: null };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      angle: { type: "string" },
      gate: { type: "string" },
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
    if (token.name === "angle") { options.angle = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "gate") { options.gate = requireTokenValue(token, parseError).trim(); continue; }
    if (token.name === "harness") { options.harness = requireTokenValue(token, parseError).trim(); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.angle) throw parseError("resolve-reviewer-role requires --angle <name>");
  if (options.gate && !GATES.has(options.gate)) {
    throw parseError(`--gate must be one of draft|preApproval|spike (got ${JSON.stringify(options.gate)})`);
  }
  if (options.harness && !HARNESSES.has(options.harness)) {
    throw parseError(`--harness must be one of pi|claude (got ${JSON.stringify(options.harness)})`);
  }
  if (!options.harness) options.harness = isClaudeHarness(env) ? "claude" : "pi";
  return options;
}

/**
 * Build the resolved-role payload from an already-loaded merged config. Pure —
 * no config I/O — so a test can drive every branch with an injected config.
 * @param {object} config - merged DevLoopConfig
 * @param {{ angle: string, harness: "claude"|"pi", gate?: string|null }} params
 */
export function resolveRolePayload(config, { angle, harness, gate = null }) {
  const role = resolveReviewerRole(config, angle);
  // Authoritative merged tier per the gate-review-sub-loop contract, NOT the
  // bare resolveReviewerRole(...).model (that is only the entry's override).
  const model = resolveRoleModel(config, { role: angle, harness, kind: "angle" });
  const payload = {
    ok: true,
    angle,
    harness,
    persona: role.persona,
    prompt: role.prompt,
    model,
    overrideModel: role.model,
    fallback: role.fallback,
  };
  if (gate) {
    payload.gate = gate;
    payload.scope = resolveGateAngleScope(config, gate, angle);
  }
  return payload;
}

export async function runCli(argv = process.argv.slice(2), { repoRoot = process.cwd(), env = process.env } = {}) {
  const options = parseResolveReviewerRoleCliArgs(argv, { env });
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const { config } = await loadDevLoopConfig({ repoRoot });
  const result = resolveRolePayload(config, {
    angle: options.angle,
    harness: options.harness,
    gate: options.gate,
  });
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  return result;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 2;
  });
}
