#!/usr/bin/env node
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_USAGE, emitResult, preflightJqFilter } from "../lib/jq-output.mjs";
import { LIFECYCLE_GATES, REVIEW_GATE, normalizeGate } from "./_gate-names.mjs";
import { HEAD_SHA_RE } from "./record-dispatch-prompt-layout.mjs";
import { buildGateEmitPlanPath } from "./write-gate-context.mjs";
import { resolveRepoRoot } from "../loop/_repo-root-resolver.mjs";
import {
  loadDevLoopConfig,
  resolveFanoutEffectiveConcurrency,
  resolveFanoutSequential,
  resolveRequireFanoutEvidence,
} from "@dev-loops/core/config";

const USAGE = `Usage: emit-wave-dispatch.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate|review> --head-sha <sha> [--tmp-root <path>] [--cwd <path>] [--timeout-ms <ms>] [--max-concurrent <n>] [--primer-key <key>] [--sequential] [--help]
The SANCTIONED wave-dispatch step (GATE-EXEC-FANOUT-WAVE-DISPATCH): turns the
keyed emit-plan.json a completed emit-fanout-dispatch.mjs run already wrote into
the READY parallel dispatch body for each wave, so the conductor never composes
the call shape itself.

The emitted wave is ONE call:

  subagent({ workflowScriptPath: "<wave>.js", cwd: "<worktree>", async: false, timeoutMs: <bounded> })

whose script body returns ONE \`runs.all([...])\` with a unique non-empty \`key\`
per dispatch unit (GATE-EXEC-FANOUT-DISPATCH-KEY), each item carrying that unit's
composed reviewer prompt bytes VERBATIM as its \`task\` (GATE-EXEC-BRIEFING-PREFIX
byte identity: the conductor never handles the prompt bytes). The legacy
\`tasks: [...]\` top-level input is NOT emitted and NOT accepted — this
pi-subagents version rejects it with "Legacy top-level chain and parallel inputs
were removed; use workflowScript".

Concurrency (GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK): each wave releases up to
\`gates.fanout.maxConcurrent\` dispatch units (resolveFanoutEffectiveConcurrency;
this repo configures 3), and the round is partitioned into
ceil(units / maxConcurrent) waves. \`gates.fanout.sequential: true\` resolves to 1,
so every wave is a single unit — the documented, recorded LOAD FALLBACK. Any
OTHER serialization fails closed rather than silently degrading a
\`gates.requireFanoutEvidence\` gate: an explicit --sequential request while
\`gates.fanout.sequential\` is NOT configured refuses (exit 1) whenever
\`gates.requireFanoutEvidence\` is on.

Run emit-fanout-dispatch.mjs FIRST (it writes the keyed emit-plan.json this reads
and the per-unit promptPath bytes it inlines).

Required:
  --repo <owner/name>        Same vocabulary as emit-fanout-dispatch.mjs.
  --pr <number>               Same vocabulary as emit-fanout-dispatch.mjs.
  --gate <draft_gate|pre_approval_gate|review>
                               Same vocabulary as emit-fanout-dispatch.mjs.
  --head-sha <sha>            The FULL 40- or 64-char reviewed head SHA.
Optional:
  --tmp-root <path>            The tmp/ directory the round's gate artifacts live
                               under (default: process.cwd()/tmp; must match the
                               emit-fanout-dispatch.mjs call).
  --cwd <path>                 The worktree the emitted call must run in,
                               resolved to an ABSOLUTE path (default: the
                               round's artifact root — the directory holding
                               --tmp-root's tmp/, resolved via resolveRepoRoot
                               — never the raw shell cwd) — written into the
                               emitted call body's \`cwd\` AND used as the
                               config root the round's fan-out concurrency is
                               resolved against (GATE-EXEC-NO-CWD-DEPENDENCE:
                               the shell may sit in the primary checkout; pass
                               --tmp-root <worktree>/tmp to anchor both the
                               round's artifacts and this default there).
  --timeout-ms <ms>            Bounded per-wave dispatch deadline in ms
                               (default: 900000). Must be a safe integer
                               between 1 and 86400000 (24h).
  --max-concurrent <n>         Bounded DEGRADATION of the round's concurrency
                               (GATE-EXEC-DISPATCH-RETRY-BACKOFF): emits this
                               run's waves at most n units wide. n must be a
                               positive integer no GREATER than the emit-plan's
                               recorded maxConcurrent — a degradation may only
                               reduce the batch, never raise it — and the wave
                               plan records it (maxConcurrentSource:
                               "explicit-degradation") as an explicit, justified
                               fallback rather than a silent re-partition.
  --primer-key <key>           The dispatch unit that IS the round's primer under
                               GATE-EXEC-PRIME's DEFAULT one-reviewer-as-primer
                               form. It is excluded from the remaining partition
                               and emitted as its OWN single-unit FIRST wave, so
                               awaiting calls[0] is the primer barrier and the
                               remaining waves release after it — the primer is
                               never double-dispatched inside wave 1. Refused
                               (exit 1) when the key is absent from the emit-plan
                               or matches more than one unit. Omit it for the
                               dedicated angle-less <gate>-prime primer (which is
                               not an emitted unit).
  --sequential                 Request single-unit waves. Refused (exit 1) unless
                               \`gates.fanout.sequential\` is configured or
                               \`gates.requireFanoutEvidence\` is off.
Output (stdout, JSON):
  { "ok": true, "gate": "...", "headSha": "...", "repo": "...", "pr": "...",
    "count": <n>, "maxConcurrent": <n>, "maxConcurrentSource": "emit-plan|config|explicit-request|explicit-degradation",
    "sequential": <bool>, "sequentialSource": "config-flag|explicit-request|explicit-degradation|maxConcurrent:1|null",
    "primerKey"?: "...",
    "waves": [ { "index": <1-based>, "count": <n>, "keys": ["..."], "scriptPath": "..." } ],
    "calls": [ { "workflowScriptPath": "...", "cwd": "...", "async": false, "timeoutMs": <ms> } ] }
  Issue ONE subagent call per entry in \`calls\`, in order, awaiting each wave
  before releasing the next. With --primer-key, \`calls[0]\` is the primer's own
  single-unit wave: awaiting it IS the GATE-EXEC-PRIME barrier.
  A fail-closed refusal (exit 1) emits { "ok": false, "error": "..." } on STDOUT
  (via the shared jq-output emitter); a usage/parse error (exit 2) emits
  { "ok": false, "error": "...", "hint"?: "run with --help for usage" } on STDERR.
  The start-of-flow clear removes this key's prior wave artifacts at the START
  of every run, and every refusal/IO/persist failure and every data-dependent
  --jq error (exit 2) re-clears them, so those non-success exits leave NO wave
  artifact on disk for this (gate, headSha) key. A falsy --jq predicate (exit 1)
  is an emitted-round result: the round's artifacts are persisted and left in
  place. Argument-validation exits that precede the key resolution (bad --repo/
  --pr/--gate/--head-sha/--tmp-root/--cwd/--timeout-ms) do not touch the key's
  artifacts.
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Emitted one ready wave script + call body per wave (a zero-unit all-carried
     plan emits zero waves/calls and exits 0)
  1  Refused: no emit-plan.json at this key (run emit-fanout-dispatch.mjs first),
     the plan carries no units while ok is not true, records no valid count, or
     records a count that disagrees with its units,
     the plan's recorded maxConcurrent is present but not a positive integer,
     the plan's recorded maxConcurrent disagrees with the resolved effective
     concurrency, --max-concurrent exceeds the round's recorded maxConcurrent,
     --primer-key is not a dispatch unit in the plan (or matches more than one),
     a unit carries no key, a unit's promptPath is
     missing/empty/unreadable, the plan's wave partition does not honor the
     concurrency bound, or the requested serialization is not the sanctioned
     \`gates.fanout.sequential\` fallback
  2  Usage or internal error (bad --repo/--pr/--gate/--head-sha/--timeout-ms
     shape, a --cwd that is not an existing directory, filesystem error, or
     invalid --jq filter)`.trim();

const parseError = buildParseError(USAGE);

/** Default bounded per-wave dispatch deadline, in ms. */
export const DEFAULT_WAVE_TIMEOUT_MS = 900000;

/**
 * Hard ceiling for --timeout-ms: 24 hours. A deadline beyond this is a caller
 * bug (an effectively unbounded wait), not a longer review, so it refuses
 * rather than silently accepting it.
 */
export const MAX_WAVE_TIMEOUT_MS = 86400000;

/**
 * The `runs.all` item `key` for a dispatch unit: the unit's own `key` when it
 * carries one, else its `scope` (the emitted plan's canonical per-unit
 * identity — the emitter's seenScopes guard already guarantees it is unique
 * within a round). Returns "" for a unit that carries neither, which the
 * caller refuses on. Pure.
 * @param {{ key?: unknown, scope?: unknown }} unit
 * @returns {string}
 */
export function waveDispatchKey(unit) {
  for (const candidate of [unit?.key, unit?.scope]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return "";
}

/**
 * Partition dispatch units into waves of at most `maxConcurrent`, preserving
 * order. This is the ONLY serialization the emitter can express, so a wave
 * count other than ceil(n / maxConcurrent) is by construction not a valid plan
 * (see validateWaveDispatchPlan). Pure.
 * @param {unknown[]} units
 * @param {number} maxConcurrent
 * @returns {unknown[][]}
 */
export function partitionWaves(units, maxConcurrent) {
  const list = Array.isArray(units) ? units : [];
  const size = Number.isInteger(maxConcurrent) && maxConcurrent >= 1 ? maxConcurrent : 1;
  const waves = [];
  for (let i = 0; i < list.length; i += size) waves.push(list.slice(i, i + size));
  return waves;
}

/**
 * Encode a value as a JS string literal. JSON.stringify already produces a
 * valid JS string literal; the two line-separator code points it leaves raw
 * are escaped so the emitted script parses under every JS engine. Pure.
 * @param {string} value
 * @returns {string}
 */
export function encodeJsStringLiteral(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Render one wave's self-contained workflow script: ONE `runs.all([...])`
 * call, one item per dispatch unit, each item carrying the unit's key and its
 * composed reviewer prompt bytes as `task`. The prompt bytes are INLINED (the
 * script reads nothing at dispatch time) so the conductor never handles them
 * and byte identity is structural. The item shape (`key` / `agent` / `context`
 * / `task`) is the live-verified pi-subagents workflow-script shape; the legacy
 * top-level `tasks` array input is not an available shape in this version and
 * is never emitted. Pure.
 * @param {{ gate: string, headSha: string, waveIndex: number, waveCount: number,
 *           units: { key: string, promptBytes: string }[] }} args
 * @returns {string}
 */
export function renderWaveWorkflowScript({ gate, headSha, waveIndex, waveCount, units }) {
  const items = units
    .map((unit) => `  {\n    key: ${encodeJsStringLiteral(unit.key)},\n    agent: "review",\n    context: "fresh",\n    task: ${encodeJsStringLiteral(unit.promptBytes)},\n  },`)
    .join("\n");
  return `// Generated by emit-wave-dispatch.mjs — do not edit by hand.
// Gate fan-out wave ${waveIndex}/${waveCount} for ${gate} at head ${headSha}.
// This is ONE runs.all(...) call: the reviewers below are released
// concurrently, bounded by the wave partition. Never rewrite it as N separate
// subagent calls, and never use the legacy \`tasks: [...]\` top-level input —
// this pi-subagents version rejects it.
return runs.all([
${items}
]);
`;
}

/**
 * The dispatch-call shape of a rendered wave script, read from its CODE only.
 * Line comments and string literals are stripped first — string literals carry
 * the inlined reviewer prompt bytes, whose prose may legitimately mention
 * `runs.all` or a `tasks:` field, and the generated header comment names both.
 * Without the strip, reviewer prose could be mistaken for the script's own call
 * shape and fail a legitimate round closed. Pure.
 * @param {string} script
 * @returns {{ runsAllCalls: number, hasLegacyTasksInput: boolean }}
 */
export function waveScriptCallShape(script) {
  const code = String(script ?? "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return {
    runsAllCalls: code.match(/runs\.all\s*\(/g)?.length ?? 0,
    hasLegacyTasksInput: /(^|[\s,{])tasks\s*:/.test(code),
  };
}

/**
 * Fail-closed shape validator for a built wave plan. It is the enforcement
 * seam behind the "one runs.all call with unique keys" acceptance criterion,
 * and it is DEFENSE IN DEPTH at runtime: the partitioner that feeds it is
 * deterministic, so a well-formed round always passes, while a regression in
 * that partitioner (or a wave plan arriving from elsewhere) is caught before
 * any script reaches disk. It rejects a plan whose wave partition does not
 * honor `maxConcurrent` (the shape a conductor produces when it emits units as
 * SEPARATE calls), a plan with a missing/blank or duplicated key, and any wave
 * script that is not exactly one `runs.all(...)` call or that carries the
 * rejected legacy `tasks:` top-level input. Pure.
 * @param {{ waves: { index: number, keys: string[], script: string }[], maxConcurrent: number, count: number, hasPrimerWave?: boolean }} plan
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateWaveDispatchPlan({ waves, maxConcurrent, count, hasPrimerWave = false } = {}) {
  const errors = [];
  const waveList = Array.isArray(waves) ? waves : [];
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) errors.push(`maxConcurrent must be a positive integer (got ${JSON.stringify(maxConcurrent)})`);
  if (!Number.isInteger(count) || count < 1) errors.push(`count must be a positive integer (got ${JSON.stringify(count)})`);
  if (waveList.length === 0) errors.push("plan carries no waves");
  if (hasPrimerWave && (Array.isArray(waveList[0]?.keys) ? waveList[0].keys.length : 0) !== 1) {
    errors.push("the primer wave must carry exactly the one primer unit");
  }
  if (Number.isInteger(maxConcurrent) && maxConcurrent >= 1 && Number.isInteger(count) && count >= 1) {
    // With --primer-key the primer unit is emitted as its OWN first wave (the
    // primer barrier), so the expected count is that wave plus the standard
    // partition of the REMAINING units.
    const primerWaves = hasPrimerWave ? 1 : 0;
    const expected = primerWaves + Math.ceil((count - primerWaves) / maxConcurrent);
    if (waveList.length !== expected) {
      errors.push(`plan resolves ${waveList.length} wave(s) for ${count} unit(s) at maxConcurrent ${maxConcurrent}; expected ${expected} — units partitioned into separate calls instead of one runs.all call per wave`);
    }
  }
  const seen = new Set();
  let seenUnits = 0;
  for (const wave of waveList) {
    const keys = Array.isArray(wave?.keys) ? wave.keys : [];
    if (keys.length === 0) errors.push(`wave ${wave?.index} carries no units`);
    if (Number.isInteger(maxConcurrent) && keys.length > maxConcurrent) {
      errors.push(`wave ${wave?.index} releases ${keys.length} unit(s), exceeding the maxConcurrent bound of ${maxConcurrent}`);
    }
    for (const key of keys) {
      // Normalize ONCE: the blank check trims, so the duplicate check must
      // compare the same trimmed value or " a" and "a " read as distinct keys.
      const normalized = typeof key === "string" ? key.trim() : "";
      if (normalized.length === 0) {
        errors.push(`wave ${wave?.index} carries a blank dispatch key — every runs.all item needs a unique non-empty key`);
        continue;
      }
      if (seen.has(normalized)) errors.push(`dispatch key ${JSON.stringify(normalized)} is duplicated — every runs.all item needs a UNIQUE key`);
      seen.add(normalized);
    }
    seenUnits += keys.length;
    const script = typeof wave?.script === "string" ? wave.script : "";
    const shape = waveScriptCallShape(script);
    if (shape.runsAllCalls !== 1) errors.push(`wave ${wave?.index} script carries ${shape.runsAllCalls} runs.all(...) call(s); a wave must be exactly ONE runs.all call`);
    if (shape.hasLegacyTasksInput) errors.push(`wave ${wave?.index} script carries the rejected legacy \`tasks:\` top-level input; use runs.all`);
  }
  if (Number.isInteger(count) && count >= 1 && seenUnits !== count) {
    errors.push(`plan covers ${seenUnits} unit(s) but count is ${count} — every dispatch unit must appear exactly once`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Deterministic path of one wave's generated workflow script: a keyed sibling
 * of the round's emit-plan.json, so two gates at one head (and two heads of one
 * gate) can never clobber each other's scripts. Pure.
 * @param {{ planPath: string, gate: string, headSha: string, index: number }} args
 * @returns {string}
 */
export function buildWaveScriptPath({ planPath, gate, headSha, index }) {
  return path.join(path.dirname(planPath), `${gate}-${headSha}.wave-${index}.js`);
}

/**
 * Deterministic path of the round's keyed wave plan — the emitted payload a
 * coordinator reads instead of hand-rolling a fixed-path stdout capture that a
 * concurrent gate would clobber. Same keying as buildWaveScriptPath. Pure.
 * @param {{ planPath: string, gate: string, headSha: string }} args
 * @returns {string}
 */
export function buildWavePlanPath({ planPath, gate, headSha }) {
  return path.join(path.dirname(planPath), `${gate}-${headSha}.wave-plan.json`);
}

function resolveFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const val = argv[idx + 1];
  if (val === undefined || val === "" || (val.length > 0 && val[0] === "-")) return "";
  return val;
}

/**
 * Default emitted-call cwd when --cwd is omitted: the round's artifact root —
 * the directory holding the round's `tmp/` (`--tmp-root`'s parent) — NOT the
 * ambient shell cwd, which may sit in the primary checkout while the round
 * belongs to a linked worktree (GATE-EXEC-NO-CWD-DEPENDENCE). Deriving it from
 * the shared `--tmp-root` means an explicit `--tmp-root <worktree>/tmp` also
 * targets that worktree, so the reviewers are never silently dispatched into
 * the shell's checkout. Falls back to the raw parent only if the resolver
 * itself throws.
 * @param {string} tmpRoot the round's resolved tmp/ directory
 * @returns {string}
 */
function resolveDefaultCwd(tmpRoot) {
  const artifactRoot = path.dirname(tmpRoot);
  try {
    return resolveRepoRoot(artifactRoot);
  } catch {
    return artifactRoot;
  }
}

/**
 * Remove every wave artifact this step generates for a (gate, headSha) key:
 * the generated scripts and the keyed wave plan. Called before writing and on
 * every non-success exit, so a failed or refused run never leaves a stale
 * artifact a later dispatch could pick up. ENOENT on the directory is fine (no
 * plan exists yet); any other readdir error rethrows (fail-closed — this is an
 * enforcement chokepoint, not a best-effort cleanup).
 * @param {{ planPath: string, gate: string, headSha: string }} args
 */
async function clearWaveArtifacts({ planPath, gate, headSha }) {
  const dir = path.dirname(planPath);
  const scriptPrefix = `${gate}-${headSha}.wave-`;
  const planFile = path.basename(buildWavePlanPath({ planPath, gate, headSha }));
  let entries;
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (entry === planFile || (entry.startsWith(scriptPrefix) && entry.endsWith(".js"))) {
      await rm(path.join(dir, entry), { force: true });
    }
  }
}

export async function main(argv = process.argv.slice(2), { tmpRootDefault = path.join(process.cwd(), "tmp"), writeScript = writeFile, persistPlan = writeFile, loadConfig = loadDevLoopConfig } = {}) {
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
  if (!gate || !(LIFECYCLE_GATES.includes(gate) || gate === REVIEW_GATE)) {
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
  const tmpRoot = path.resolve(tmpRootArg ?? tmpRootDefault);
  const cwdArg = resolveFlagValue(argv, "--cwd");
  if (cwdArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --cwd value: must be non-empty."))}\n`);
    return 2;
  }
  const cwd = path.resolve(cwdArg ?? resolveDefaultCwd(tmpRoot));
  // --cwd is BOTH the emitted child cwd and the config root the concurrency is
  // resolved against, and loadDevLoopConfig treats a missing <root>/.devloops as
  // a warning (silently BUILT_IN_DEFAULTS), so a nonexistent --cwd would either
  // refuse with a message blaming the emit-plan and a remediation that cannot
  // change the resolved root, or emit a "ready" call body whose cwd cannot
  // launch. Fail loudly at the CLI boundary instead. The DERIVED default is not
  // checked here: it is the round's artifact root, so a missing --tmp-root
  // already fails loudly on the plan read (ENOENT) and that refusal names the
  // real cause.
  if (cwdArg !== null) {
    try {
      if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
    } catch {
      process.stderr.write(`${formatCliError(parseError(`Invalid --cwd value: ${JSON.stringify(cwd)} is not an existing directory.`))}\n`);
      return 2;
    }
  }
  const timeoutArg = resolveFlagValue(argv, "--timeout-ms");
  if (timeoutArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --timeout-ms value: must be a positive integer."))}\n`);
    return 2;
  }
  let timeoutMs = DEFAULT_WAVE_TIMEOUT_MS;
  if (timeoutArg !== null) {
    const parsedTimeout = Number(timeoutArg);
    if (!/^[0-9]+$/.test(timeoutArg) || !Number.isSafeInteger(parsedTimeout) || parsedTimeout < 1 || parsedTimeout > MAX_WAVE_TIMEOUT_MS) {
      process.stderr.write(`${formatCliError(parseError(`--timeout-ms must be a safe integer between 1 and ${MAX_WAVE_TIMEOUT_MS} (24h)${timeoutArg ? ` (got ${JSON.stringify(timeoutArg)})` : ""}.`))}\n`);
      return 2;
    }
    timeoutMs = parsedTimeout;
  }
  const maxConcurrentArg = resolveFlagValue(argv, "--max-concurrent");
  if (maxConcurrentArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --max-concurrent value: must be a positive integer."))}\n`);
    return 2;
  }
  let requestedMaxConcurrent = null;
  if (maxConcurrentArg !== null) {
    const parsed = Number(maxConcurrentArg);
    if (!/^[0-9]+$/.test(maxConcurrentArg) || !Number.isSafeInteger(parsed) || parsed < 1) {
      process.stderr.write(`${formatCliError(parseError(`--max-concurrent must be a positive safe integer${maxConcurrentArg ? ` (got ${JSON.stringify(maxConcurrentArg)})` : ""}.`))}\n`);
      return 2;
    }
    requestedMaxConcurrent = parsed;
  }
  const primerKeyArg = resolveFlagValue(argv, "--primer-key");
  if (primerKeyArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --primer-key value: must be non-empty."))}\n`);
    return 2;
  }
  const primerKey = primerKeyArg === null ? null : primerKeyArg.trim();
  let planPath;
  try {
    planPath = buildGateEmitPlanPath({ repo, pr, gate, headSha, tmpRoot });
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }

  // Clear this key's wave scripts at the very START, before the plan is read,
  // so every non-success exit below leaves NO script on disk — the same
  // stale-artifact hazard GATE-EXEC-FANOUT-DISPATCH-EMIT's start-of-flow rm
  // protects its own keyed plan against. The --jq/--fields validation runs
  // AFTER this clear: the round key is resolved by now, so an empty or
  // syntactically invalid filter is a post-key exit that still leaves no wave
  // artifact on disk.
  try {
    await clearWaveArtifacts({ planPath, gate, headSha });
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }

  const jqArg = resolveFlagValue(argv, "--jq");
  if (jqArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --jq value: must be non-empty."))}\n`);
    return 2;
  }
  const jq = jqArg === null ? undefined : jqArg;
  const silent = argv.includes("--silent") || argv.includes("-s");
  const fieldsArg = resolveFlagValue(argv, "--fields");
  if (fieldsArg === "") {
    process.stderr.write(`${formatCliError(parseError("Invalid --fields value: must be non-empty."))}\n`);
    return 2;
  }
  const fields = fieldsArg === null ? undefined : fieldsArg;
  const finish = (payload, ok) => emitResult(payload, { jq, silent, ...(fields === undefined ? {} : { fields }), ok });
  const jqSyntaxError = preflightJqFilter(jq);
  if (jqSyntaxError !== undefined) return jqSyntaxError;

  const refuse = async (error) => {
    try {
      await clearWaveArtifacts({ planPath, gate, headSha });
    } catch {
      // Best-effort clear only — never mask the refusal.
    }
    return finish({ ok: false, error }, false);
  };

  let plan;
  try {
    plan = JSON.parse(await readFile(planPath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") {
      return refuse(`GATE-EXEC-FANOUT-WAVE-DISPATCH: refusing — no emit-plan.json at ${JSON.stringify(planPath)} — run scripts/github/emit-fanout-dispatch.mjs --repo ${repo} --pr ${pr} --gate ${gate} --head-sha ${headSha} first`);
    }
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }
  const units = Array.isArray(plan?.units) ? plan.units : [];
  if (plan?.ok !== true) {
    return refuse(`GATE-EXEC-FANOUT-WAVE-DISPATCH: refusing — the emit-plan at ${JSON.stringify(planPath)} carries no dispatch units (ok=${JSON.stringify(plan?.ok)}, units=${units.length}) — re-run emit-fanout-dispatch.mjs`);
  }
  // The emit-plan records the round's unit count. A plan whose recorded count
  // is missing, malformed, or disagrees with the units it actually carries is
  // truncated/partial and must not dispatch as a complete round.
  if (!Number.isInteger(plan.count)) {
    return refuse(`GATE-EXEC-FANOUT-WAVE-DISPATCH: refusing — the emit-plan at ${JSON.stringify(planPath)} records no valid count (count=${JSON.stringify(plan.count)}) — a plan whose recorded count is missing or malformed must not dispatch as a complete round; re-run emit-fanout-dispatch.mjs`);
  }
  if (plan.count !== units.length) {
    return refuse(`GATE-EXEC-FANOUT-WAVE-DISPATCH: refusing — the emit-plan at ${JSON.stringify(planPath)} records count ${plan.count} but carries ${units.length} dispatch unit(s) — a truncated or partial plan must not dispatch as a complete round; re-run emit-fanout-dispatch.mjs`);
  }
  // A legitimately empty all-carried `--pending` round emits
  // `{ ok: true, count: 0, units: [] }` from emit-fanout-dispatch.mjs — a
  // zero-wave SUCCESS (nothing to dispatch), not a refusal. It is reachable
  // only here, after the count guards proved the plan is not truncated.

  // The units must each carry a key and a readable promptPath before anything
  // is written; a unit that cannot be seeded is a malformed round, not a
  // partially-dispatchable one.
  const keyed = [];
  for (const unit of units) {
    const key = waveDispatchKey(unit);
    if (key === "") {
      return refuse(`GATE-EXEC-FANOUT-WAVE-DISPATCH: refusing — dispatch unit ${JSON.stringify(unit?.scope ?? unit?.name ?? unit)} carries no key (no \`key\`, no \`scope\`) — every runs.all item needs a unique non-empty key (GATE-EXEC-FANOUT-DISPATCH-KEY)`);
    }
    const promptPath = typeof unit?.promptPath === "string" && unit.promptPath.trim().length > 0 ? unit.promptPath.trim() : "";
    if (promptPath === "") {
      return refuse(`GATE-EXEC-FANOUT-WAVE-DISPATCH: refusing — dispatch unit ${JSON.stringify(key)} carries no promptPath — re-run emit-fanout-dispatch.mjs`);
    }
    let promptBytes;
    try {
      promptBytes = await readFile(promptPath, "utf8");
    } catch (err) {
      return refuse(`GATE-EXEC-FANOUT-WAVE-DISPATCH: refusing — dispatch unit ${JSON.stringify(key)} prompt is unreadable at ${JSON.stringify(promptPath)}: ${err?.message ?? err}`);
    }
    if (promptBytes.trim().length === 0) {
      return refuse(`GATE-EXEC-FANOUT-WAVE-DISPATCH: refusing — dispatch unit ${JSON.stringify(key)} prompt at ${JSON.stringify(promptPath)} is empty`);
    }
    keyed.push({ key, promptBytes });
  }

  // GATE-EXEC-PRIME reconciliation: under the DEFAULT one-reviewer-as-primer
  // form the primer IS one of the emitted dispatch units, and the conductor
  // dispatches it FIRST and awaits its prefix write. Re-releasing it inside
  // wave 1 would double-dispatch the same per-angle artifact path and spend a
  // concurrency slot on the duplicate. --primer-key names that unit; it is
  // emitted as its OWN single-unit first wave (the existing "issue ONE call per
  // entry in calls, in order, awaiting each wave" contract IS the primer
  // barrier) and excluded from the remaining partition.
  let primerUnit = null;
  if (primerKey !== null) {
    const matches = keyed.filter((unit) => unit.key === primerKey);
    if (matches.length === 0) {
      return refuse(`GATE-EXEC-FANOUT-WAVE-DISPATCH: refusing — --primer-key ${JSON.stringify(primerKey)} is not a dispatch unit in the emit-plan at ${JSON.stringify(planPath)} — the one-reviewer-as-primer unit must be one of the emitted units; omit --primer-key for the dedicated angle-less <gate>-prime primer`);
    }
    if (matches.length > 1) {
      return refuse(`GATE-EXEC-FANOUT-WAVE-DISPATCH: refusing — --primer-key ${JSON.stringify(primerKey)} matches ${matches.length} dispatch units — every runs.all item needs a UNIQUE key`);
    }
    primerUnit = matches[0];
  }
  const waveable = primerUnit ? keyed.filter((unit) => unit !== primerUnit) : keyed;
  // A zero-WAVE round: nothing left to release (either the all-carried zero-unit
  // plan, or a round whose only unit is the primer). Distinct from a refusal.
  const zeroWave = keyed.length === 0;

  let resolvedMaxConcurrent;
  let sequential;
  let requireFanoutEvidence;
  try {
    const { config } = await loadConfig({ repoRoot: cwd });
    sequential = resolveFanoutSequential(config);
    requireFanoutEvidence = resolveRequireFanoutEvidence(config);
    resolvedMaxConcurrent = resolveFanoutEffectiveConcurrency(config, process.env);
  } catch (err) {
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }

  // Partition the round as its own artifact records it. The emit-plan carries
  // the maxConcurrent the emitter resolved, so a re-run at this key must reuse
  // that value rather than silently re-partition against a config that changed
  // underneath the round. A recorded value that disagrees with the freshly
  // resolved effective concurrency refuses instead of drifting.
  let maxConcurrent;
  let maxConcurrentSource;
  if (plan.maxConcurrent === undefined) {
    // ABSENT: the plan predates the field (or a hermetic fixture omitted it) —
    // fall back to the freshly resolved effective concurrency.
    maxConcurrent = resolvedMaxConcurrent;
    maxConcurrentSource = "config";
  } else if (Number.isInteger(plan.maxConcurrent) && plan.maxConcurrent >= 1) {
    if (plan.maxConcurrent !== resolvedMaxConcurrent) {
      return refuse(`GATE-EXEC-FANOUT-WAVE-DISPATCH: refusing — the emit-plan at ${JSON.stringify(planPath)} records maxConcurrent ${plan.maxConcurrent} but the resolved effective fan-out concurrency is ${resolvedMaxConcurrent} (resolved against config root ${JSON.stringify(cwd)}) — a re-run at this key must not partition the round differently; re-run emit-fanout-dispatch.mjs at that config root`);
    }
    maxConcurrent = plan.maxConcurrent;
    maxConcurrentSource = "emit-plan";
  } else {
    // PRESENT-but-invalid: a string/float/zero recorded value must not silently
    // fall back (mirroring the `count` guard) — that would re-partition the
    // round against a config that may have drifted underneath it, defeating the
    // very drift guard the recorded-vs-resolved equality check exists for.
    return refuse(`GATE-EXEC-FANOUT-WAVE-DISPATCH: refusing — the emit-plan at ${JSON.stringify(planPath)} records an invalid maxConcurrent (maxConcurrent=${JSON.stringify(plan.maxConcurrent)}) — a recorded value that is present but not a positive integer must not silently fall back; re-run emit-fanout-dispatch.mjs`);
  }

  // GATE-EXEC-DISPATCH-RETRY-BACKOFF: after a transient 429/5xx exhausts its
  // retries the contract halves the active batch via `backoffMaxConcurrent` and
  // recomputes the waves. That degradation is expressible here as a BOUNDED
  // override — it may only REDUCE the round's recorded bound, never raise it —
  // and the wave plan records it as an explicit, justified fallback rather than
  // a silent re-partition.
  let degradation = null;
  if (requestedMaxConcurrent !== null && requestedMaxConcurrent < maxConcurrent) {
    degradation = requestedMaxConcurrent;
    maxConcurrent = requestedMaxConcurrent;
    maxConcurrentSource = "explicit-degradation";
  } else if (requestedMaxConcurrent !== null && requestedMaxConcurrent > maxConcurrent) {
    return refuse(`GATE-EXEC-FANOUT-WAVE-DISPATCH: refusing — --max-concurrent ${requestedMaxConcurrent} exceeds the round's recorded maxConcurrent ${maxConcurrent} — a degradation may only REDUCE the batch, never raise it; re-run emit-fanout-dispatch.mjs at the higher concurrency instead`);
  }

  // GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK: `gates.fanout.sequential: true` is the
  // documented, RECORDED load fallback — a repo that enables it records why
  // parallel execution was impractical. Any OTHER serialization silently
  // degrades a gate that requires fan-out evidence, so it fails closed here
  // instead of producing single-unit waves nobody justified. That includes the
  // resolved concurrency collapsing to 1 for a reason other than the recorded
  // flag (`gates.fanout.maxConcurrent: 1` is a valid config value and would
  // otherwise serialize every round unnoticed), and an explicit --sequential
  // request the config does not back.
  const requestedSequential = argv.includes("--sequential");
  const unjustifiedSerialization = maxConcurrent === 1 && !sequential && degradation === null;
  if (!zeroWave && requireFanoutEvidence && (unjustifiedSerialization || (requestedSequential && !sequential))) {
    return refuse(`GATE-EXEC-FANOUT-SEQUENTIAL-FALLBACK: refusing — ${requestedSequential ? "--sequential was requested" : "the resolved fan-out concurrency is 1 (gates.fanout.maxConcurrent: 1)"} but gates.fanout.sequential is not configured, and gates.requireFanoutEvidence is on. Bounded parallelism is the DEFAULT posture; a sequential round must be a justified, recorded load fallback. Set gates.fanout.sequential: true in .devloops to record why parallel execution is impractical for this environment (and keep gates.fanout.maxConcurrent at its configured value), or drop the serialization to release parallel waves.`);
  }
  if (requestedSequential || sequential) {
    // The override changes the reported value, so re-derive the provenance:
    // `maxConcurrentSource` names the source of the REPORTED `maxConcurrent`
    // (USAGE), and an override that forced 1 was not produced by the emit-plan.
    if (maxConcurrent !== 1) maxConcurrentSource = requestedSequential ? "explicit-request" : "config-flag";
    maxConcurrent = 1;
  }

  // Report WHY the round serialized, honestly: `sequential` mirrors the
  // resolved `gates.fanout.sequential` config flag (never the derived
  // maxConcurrent), while `sequentialSource` names the trigger.
  let sequentialSource = null;
  if (sequential === true) sequentialSource = "config-flag";
  else if (requestedSequential) sequentialSource = "explicit-request";
  else if (degradation !== null && maxConcurrent === 1) sequentialSource = "explicit-degradation";
  else if (resolvedMaxConcurrent === 1) sequentialSource = "maxConcurrent:1";

  const waves = zeroWave
    ? []
    : [...(primerUnit ? [[primerUnit]] : []), ...partitionWaves(waveable, maxConcurrent)];
  const waveCount = waves.length;
  const built = [];
  for (let i = 0; i < waveCount; i += 1) {
    const index = i + 1;
    const script = renderWaveWorkflowScript({ gate, headSha, waveIndex: index, waveCount, units: waves[i] });
    built.push({ index, keys: waves[i].map((unit) => unit.key), scriptPath: buildWaveScriptPath({ planPath, gate, headSha, index }), script });
  }

  // Fail closed on the shape BEFORE anything reaches disk, so a plan that would
  // serialize units into separate calls never produces a dispatchable script.
  const validation = zeroWave ? { ok: true, errors: [] } : validateWaveDispatchPlan({ waves: built, maxConcurrent, count: keyed.length, hasPrimerWave: Boolean(primerUnit) });
  if (!validation.ok) {
    return refuse(`GATE-EXEC-FANOUT-WAVE-DISPATCH: refusing — emitted wave plan failed its shape check: ${validation.errors.join("; ")}`);
  }

  for (const wave of built) {
    try {
      await mkdir(path.dirname(wave.scriptPath), { recursive: true });
      await writeScript(wave.scriptPath, wave.script, "utf8");
    } catch (err) {
      try {
        await clearWaveArtifacts({ planPath, gate, headSha });
      } catch {
        // Best-effort clear only — never mask the original IO failure.
      }
      process.stderr.write(`${formatCliError(err)}\n`);
      return 2;
    }
  }

  const payload = {
    ok: true,
    gate,
    headSha,
    repo,
    pr,
    count: keyed.length,
    maxConcurrent,
    maxConcurrentSource,
    sequential: sequential === true,
    sequentialSource,
    ...(primerUnit ? { primerKey: primerUnit.key } : {}),
    waves: built.map(({ index, keys, scriptPath }) => ({ index, count: keys.length, keys, scriptPath })),
    calls: built.map(({ scriptPath }) => ({ workflowScriptPath: scriptPath, cwd, async: false, timeoutMs })),
  };
  // Persist the round's wave plan to its keyed sibling so a coordinator reads
  // THAT path instead of hand-rolling a fixed-path stdout capture a concurrent
  // gate would clobber — the same reason the emitter persists its own plan.
  const wavePlanPath = buildWavePlanPath({ planPath, gate, headSha });
  try {
    await mkdir(path.dirname(wavePlanPath), { recursive: true });
    await persistPlan(wavePlanPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (err) {
    try {
      await clearWaveArtifacts({ planPath, gate, headSha });
    } catch {
      // Best-effort clear only — never mask the original persist failure.
    }
    process.stderr.write(`${formatCliError(err)}\n`);
    return 2;
  }
  try {
    const result = finish(payload, true);
    // finish() returning 2 is emitResult's data-dependent jq-error path: the
    // scripts just written belong to a FAILED emission and must not survive.
    if (result === 2) {
      try {
        await clearWaveArtifacts({ planPath, gate, headSha });
      } catch {
        // Best-effort clear only — never mask the exit-2.
      }
    }
    return result;
  } catch (err) {
    try {
      await clearWaveArtifacts({ planPath, gate, headSha });
    } catch {
      // Best-effort clear only — never mask the throw.
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
