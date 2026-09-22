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

import { loadDevLoopConfig, resolveGateAngleContract, resolveGateAngleScope, resolveReviewerRole, resolveRoleModel } from "@dev-loops/core/config";
import { GATE_CONFIG_KEY } from "@dev-loops/core/loop/gate-fanin";
import { isClaudeHarness } from "@dev-loops/core/loop/run-context";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { resolveRepoRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage: resolve-reviewer-role.mjs --angle <name> [--gate <gate>] [--harness <pi|claude>]

Resolve a gate angle's reviewer role from the fully merged config (shipped
extension default + the repo's .devloops merge-by-name). Returns the persona,
its focus prompt, and the authoritative harness-resolved model tier. Use this
instead of grepping extension-defaults.yaml directly — a raw grep misses the
.devloops config-layer merge and yields the wrong persona/model.

Role resolution (persona/prompt/model) is gate-independent; --gate only affects
the reported scope, never the persona/prompt/model — do not assume a per-gate
persona.

Required:
  --angle <name>         Gate angle / lens name (e.g. correctness, security)

Optional:
  --gate <g>             A canonical gate id (draft_gate|pre_approval_gate) or
                          its config key (draft|preApproval|spike); when given,
                          also resolves the angle's declared surface scope
  --harness <pi|claude>  Harness whose concrete model tier to resolve
                          (default: "claude" under Claude Code, else "pi")
  --help, -h             Show this help

Output (stdout, JSON):
  {
    "ok": true,
    "status": "resolved",       // resolved | prompt-missing | fallback | unresolved | config-error
    "angle": "correctness",
    "harness": "claude",
    "persona": "review",
    "prompt": "…" | null,
    "model": "…" | null,        // authoritative merged tier (resolveRoleModel, kind:"angle")
    "overrideModel": "…" | null, // bare resolveReviewerRole(...).model override, if any
    "fallback": false,
    "warnings": [],              // human-readable, non-fatal resolution caveats
    "configErrors": [],          // per-layer config load errors (see configErrorCount)
    "configErrorCount": 0,       // >0 => config-layer errors; ok:false, no role trusted
    "gate": "draft",            // only when --gate given
    "scope": "full"             // only when --gate given
  }

${JQ_OUTPUT_USAGE}

Exit codes:
  0  resolved to a concrete (non-fallback) role, or a configured gate angle
     that ships only a fallback persona, with no config-layer errors
  1  unresolved (angle absent from the merged gate config) or .devloops config errors present
  2  Argument/runtime error, or invalid --jq filter`;

const parseError = buildParseError(USAGE);

// Accepted `--gate` spellings: the canonical gate ids from GATE_CONFIG_KEY plus
// the config keys they map to (and `spike`, which has no marker gate id).
const GATE_CONFIG_KEYS = new Set([...Object.values(GATE_CONFIG_KEY), "spike"]);
const HARNESSES = new Set(["pi", "claude"]);

/**
 * Normalize a `--gate` value to its `gates.<key>` config key, accepting BOTH
 * the canonical gate id (`pre_approval_gate`) and the config-key spelling
 * (`preApproval`). Returns null for anything else. GATE_CONFIG_KEY is the
 * single source of the marker-name -> config-key mapping, so this CLI cannot
 * drift from the canonical gate vocabulary its own briefing prints.
 * @param {string} value
 * @returns {string|null}
 */
function normalizeGateArg(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  if (Object.hasOwn(GATE_CONFIG_KEY, trimmed)) return GATE_CONFIG_KEY[trimmed];
  return GATE_CONFIG_KEYS.has(trimmed) ? trimmed : null;
}

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
    if (token.name === "gate") {
      const raw = requireTokenValue(token, parseError).trim();
      const gate = normalizeGateArg(raw);
      if (!gate) {
        throw parseError(`--gate must be one of draft_gate|pre_approval_gate|draft|preApproval|spike (got ${JSON.stringify(raw)})`);
      }
      options.gate = gate;
      continue;
    }
    if (token.name === "harness") { options.harness = requireTokenValue(token, parseError).trim(); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.angle) throw parseError("resolve-reviewer-role requires --angle <name>");
  if (options.harness && !HARNESSES.has(options.harness)) {
    throw parseError(`--harness must be one of pi|claude (got ${JSON.stringify(options.harness)})`);
  }
  if (!options.harness) options.harness = isClaudeHarness(env) ? "claude" : "pi";
  return options;
}

/**
 * Build the resolved-role payload from an already-loaded merged config. Pure —
 * no config I/O — so a test can drive every branch with an injected config.
 *
 * Fail-closed: this CLI exists to prevent a WRONG role. A condition that makes
 * the resolved role untrustworthy sets `ok:false` (nonzero exit) while still
 * emitting the payload so a caller can inspect it:
 *   - `configErrors` from `loadDevLoopConfig` — a per-layer schema/parse failure
 *     drops that layer (`extensionDefaults`, repo `defaults`, `.devloops`, or the
 *     final `merged` validation) and silently falls back to the shipped default,
 *     the exact wrong-role bug this CLI guards against (mirrors
 *     scripts/loop/check-size-budget.mjs);
 *   - an UNKNOWN angle absent from the merged gate config, which resolves only to
 *     the generic fallback persona (indistinguishable from a typo).
 *
 * A CONFIGURED gate angle that ships only a fallback persona (no dedicated
 * persona/prompt entry) is NOT a typo: it is reported distinctly — `ok:true`
 * with `fallback:true` plus a `status`/`warnings` signal — so a reviewer does
 * not misread a legitimate gate angle as a hard failure and fall back to the
 * forbidden defaults grep. A non-fallback angle whose `prompt` is null/empty
 * (a repo `.devloops` override that set only `persona`, dropping the shipped
 * prompt via merge-by-name) is likewise signalled with `status:"prompt-missing"`
 * and a warning rather than silently returning an unusable focus instruction.
 * @param {object} config - merged DevLoopConfig
 * @param {{ angle: string, harness: "claude"|"pi", gate?: string|null, configErrors?: Array<unknown> }} params
 */
export function resolveRolePayload(config, { angle, harness, gate = null, configErrors = [] }) {
  const role = resolveReviewerRole(config, angle);
  // Authoritative merged tier per the gate-review-sub-loop contract, NOT the
  // bare resolveReviewerRole(...).model (that is only the entry's override).
  const model = resolveRoleModel(config, { role: angle, harness, kind: "angle" });
  const configErrorCount = Array.isArray(configErrors) ? configErrors.length : 0;

  const warnings = [];
  let status;
  let ok;
  if (configErrorCount > 0) {
    // Any config-layer failure (`extensionDefaults`, repo `defaults`, `.devloops`,
    // or the final `merged` validation) drops that layer, so the emitted role may
    // not be the authoritative one — signal nonzero exit regardless of what
    // resolved. Name the affected layer(s) so the operator is not sent to the
    // wrong file.
    status = "config-error";
    ok = false;
    const layers = [...new Set(
      (Array.isArray(configErrors) ? configErrors : [])
        .map((e) => (e && typeof e === "object" && typeof e.layer === "string" ? e.layer : null))
        .filter(Boolean),
    )];
    const where = layers.length > 0 ? ` in layer(s) ${layers.join(", ")}` : "";
    warnings.push(
      `${configErrorCount} config-layer error(s)${where}; the resolved role may be a shipped default and must not be trusted.`,
    );
  } else if (role.fallback) {
    // Distinguish a genuinely unknown angle from a configured gate angle that
    // ships only a fallback persona (no dedicated persona/prompt entry).
    if (angleIsConfigured(config, gate, angle)) {
      status = "fallback";
      ok = true;
      warnings.push(
        `angle '${angle}' is configured in the merged gate config but has no dedicated persona/prompt entry; the generic default-reviewer persona is returned. Review the angle by name with no angle-specific focus instruction.`,
      );
    } else {
      status = "unresolved";
      ok = false;
      warnings.push(
        `angle '${angle}' is absent from the merged gate config; the generic default-reviewer persona is returned. Verify the angle name — do not grep extension-defaults.yaml.`,
      );
    }
  } else if (typeof role.prompt !== "string" || role.prompt.trim() === "") {
    // Non-fallback role with a null/empty prompt: a repo `.devloops` entry that
    // overrides only `persona` drops the shipped prompt (merge-by-name). Signal
    // it explicitly instead of silently returning an unusable focus instruction.
    status = "prompt-missing";
    ok = true;
    warnings.push(
      `angle '${angle}' resolved persona '${role.persona}' but its focus prompt is null/empty (a repo override likely set only the persona); review with no angle-specific focus instruction.`,
    );
  } else {
    status = "resolved";
    ok = true;
  }

  const payload = {
    ok,
    status,
    angle,
    harness,
    persona: role.persona,
    prompt: role.prompt,
    model,
    overrideModel: role.model,
    fallback: role.fallback,
    warnings,
    configErrors,
    configErrorCount,
  };
  if (gate) {
    payload.gate = gate;
    payload.scope = resolveGateAngleScope(config, gate, angle);
  }
  return payload;
}

/**
 * True when `angle` is a member of the merged gate config's DISPATCHABLE angle
 * pool — the gate named by `--gate` when given, else any of draft/preApproval/
 * spike. Classifies against `resolveGateAngleContract(...).pool` (the
 * additive-aware pool dynamic dispatch uses: the static angle list widened to
 * `gates.anglePool` when `dynamic.additive` is on), NOT the static
 * `resolveGateAngles` list. A consumer can leave an angle out of the static
 * entries while keeping it in the additive pool; a matching diff still
 * dispatches it, so a static-only classifier would misreport a legitimate angle
 * as `unresolved` (nonzero exit). `pool` is null when a gate declares no angles,
 * so a bare config never counts as "configured". Defensive try/catch: a
 * malformed config already surfaced through `configErrors` must not crash the
 * CLI's fallback-classification path.
 * @param {object} config
 * @param {string|null} gate
 * @param {string} angle
 * @returns {boolean}
 */
function angleIsConfigured(config, gate, angle) {
  const gates = gate ? [gate] : ["draft", "preApproval", "spike"];
  for (const g of gates) {
    let pool;
    try {
      pool = resolveGateAngleContract(config, g).pool;
    } catch {
      continue;
    }
    if (Array.isArray(pool) && pool.includes(angle)) return true;
  }
  return false;
}

export async function runCli(argv = process.argv.slice(2), { repoRoot = resolveRepoRoot(process.cwd()), env = process.env } = {}) {
  const options = parseResolveReviewerRoleCliArgs(argv, { env });
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return { ok: true, help: true };
  }
  const { config, errors: configErrors } = await loadDevLoopConfig({ repoRoot });
  const result = resolveRolePayload(config, {
    angle: options.angle,
    harness: options.harness,
    gate: options.gate,
    configErrors,
  });
  process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent, fields: options.fields });
  return result;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 2;
  });
}
