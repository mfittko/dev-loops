#!/usr/bin/env node
/**
 * consolidate-fanin.mjs — sanctioned fan-in CLI over the pure helpers in
 * @dev-loops/core/loop/gate-fanin (issue #1481). Reads every per-angle
 * findings artifact a gate-review fan-out produced, consolidates them with
 * consolidateFanin()/toFindingsLogShape(), and emits the JSON shapes
 * write-gate-findings-log.mjs (--findings / --findings-file), post-gate-findings.mjs
 * (--findings / --findings-file), and upsert-checkpoint-verdict.mjs (--findings-json,
 * via the result's "findingsJson" field / --out) accept directly — the orchestrator
 * no longer hand-authors this JSON with inline interpreters. "findingsJson"/--out is
 * the NESTED per-angle shape (one section per source artifact, clean angles included
 * with an empty findings array); "findings"/--ledger-out is the FLAT per-finding shape.
 *
 * Per-angle findings artifact shape (one *.json file per angle in --findings-dir):
 *   {
 *     angle: string,
 *     verdict: "clean" | "findings_present" | "blocked",
 *     findings: [{ severity, summary, file?, line?, disposition?, recommendation? }]
 *   }
 * `disposition` on an input finding is IGNORED — consolidateFanin() always
 * DERIVES it from severity (accepted-for-fix for a blocking severity,
 * deferred otherwise). It is accepted on the input shape only so a reviewer's
 * own artifact schema round-trips without a separate strip step. A
 * reviewer-provided `recommendation` IS carried through to both output shapes
 * unchanged (truncated only if it exceeds the length cap below).
 *
 * An angle reporting verdict "blocked" (or any malformed artifact) makes the
 * whole fan-in FAIL CLOSED (exit 1, naming the offending angles): a blocked
 * consolidation has no publishable findings shape, and emitting one would
 * present an all-clean structure that silently discards real findings. Fix or
 * re-run the offending reviewer, then re-consolidate. Two artifacts naming the
 * SAME angle also fails closed (ambiguous fan-out) — see "duplicate angle
 * name" below.
 *
 * The render budget applies ONLY to "findingsJson"/--out (the visible gate
 * comment) — never to "findings"/--ledger-out (the durable disposition
 * ledger, which write-gate-findings-log.mjs accepts at arbitrary size). Fit is
 * measured by actually RENDERING a candidate shape through
 * upsert-checkpoint-verdict.mjs's own normalizeStructuredFindings/
 * renderStructuredFindings and catching the length-exceeded throw — never an
 * approximated size — so a shape this CLI accepts as fitting is exactly a
 * shape that renderer accepts too. A round too large to render even at
 * minimum summary length still writes a COMPLETE --ledger-out and exits 0,
 * degrading "findingsJson"/--out through three tiers, decided PER ANGLE (an
 * angle whose own marker fits keeps the verbose breakdown even when a
 * neighboring angle does not):
 *   1. verbose — one synthetic finding per angle naming its omitted count and
 *      severity breakdown;
 *   2. bare — that angle's marker shortens to a bare omitted-count line;
 *   3. withheld — reached only when even ONE bare line per angle across the
 *      WHOLE round still does not fit: "findingsJson" is emitted empty and
 *      --out, if given, is REMOVED from disk (never left stale from a prior
 *      round) rather than written or silently left in place.
 * Every tier PRESERVES the real angle set and each angle's real verdict,
 * never collapsing into a foreign section, so upsert-checkpoint-verdict.mjs's
 * fanout_fanin mandatory-angle/pool validation still accepts the posted
 * verdict (tiers 1-2) or the caller falls back to --findings-summary (tier
 * 3, --findings-json absent). Every tier sets "commentBudgetExceeded": true
 * and still exits 0. NOTE: upsert-checkpoint-verdict.mjs's posted "Findings
 * summary:" digest is derived solely from "findingsJson", so on an
 * over-budget round it counts marker lines, not real findings, and
 * undercounts — "findings"/--ledger-out and the marker text's own severity
 * breakdown carry the true numbers; there is currently no flag that corrects
 * the digest itself.
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";
import { GATE_NAMES } from "../github/_gate-names.mjs";
import { normalizeStructuredFindings, renderStructuredFindings } from "../github/upsert-checkpoint-verdict.mjs";
import { loadDevLoopConfig, resolveGateConfig } from "@dev-loops/core/config";
import { VALID_SEVERITIES, consolidateFanin, toFindingsLogShape } from "@dev-loops/core/loop/gate-fanin";

const USAGE = `Usage: consolidate-fanin.mjs --findings-dir <dir> [--gate <draft_gate|pre_approval_gate>] [--out <path>] [--ledger-out <path>] [--pr-checklist-matrix clean] [--repo-root <path>]
Consolidate the per-angle *.json findings artifacts a gate-review fan-out wrote into
--findings-dir into the JSON shapes write-gate-findings-log.mjs, post-gate-findings.mjs
(--findings / --findings-file), and upsert-checkpoint-verdict.mjs (--findings-json) accept.
Required:
  --findings-dir <dir>          Directory containing one *.json per-angle findings
                                 artifact: { angle, verdict, findings: [{ severity, summary, file?, line?, disposition?, recommendation? }] }.
                                 An input finding's "disposition" (if present) is IGNORED — the
                                 output disposition is always DERIVED from severity (see below).
                                 An input finding's "recommendation" (if present) is carried through.
                                 Two artifacts naming the SAME angle fail closed (ambiguous fan-out).
Optional:
  --gate <draft_gate|pre_approval_gate>   Echoed onto the result as "gate"; also loads this
                                 worktree's config and applies gates.<gate>.blockCleanOnFindingSeverities
                                 to the overall verdict (default when omitted: ["must-fix"]). When given,
                                 a config that could not be fully loaded/validated FAILS CLOSED (exit 1)
                                 rather than silently falling back to the shipped default severities.
  --out <path>                  Write the nested per-angle "findingsJson" shape (below) to this
                                 path as JSON — the exact input upsert-checkpoint-verdict.mjs's
                                 --findings-json accepts. Per angle over the gate-comment render
                                 budget, findings are replaced with a budget-marker finding (angle
                                 set + per-angle verdict kept real — see "commentBudgetExceeded"
                                 below); REMOVED (deleted, not just skipped, so a stale prior-round
                                 file is never mistaken for this round's) on the rare round wide
                                 enough that even one bare marker line per angle cannot fit.
                                 --ledger-out is unaffected either way.
  --ledger-out <path>            Write the flat "findings" shape (below) to this path as JSON — the
                                 exact --findings-file input write-gate-findings-log.mjs and
                                 post-gate-findings.mjs accept
  --pr-checklist-matrix clean    When no pr-checklist-matrix angle artifact was found, upsert
                                 { angle: "pr-checklist-matrix", verdict: "clean", findings: [] }
  --repo-root <path>             Root used to resolve this worktree's config (loadDevLoopConfig) when
                                 --gate is given (default: process.cwd()) — makes the overall verdict
                                 deterministic regardless of the CLI's invocation directory
Output (stdout, JSON):
  { "ok": true, "gate"?: "...", "angles": [{ "angle", "verdict", "findingCount" }],
    "findingsJson": [{ "angle", "verdict", "findings": [...] }], "findings": [...],
    "severityCounts": { "must-fix", "worth-fixing-now", "defer" },
    "overallVerdict": "clean"|"findings_present", "commentBudgetExceeded"?: true }
  "findingsJson" is the nested per-angle shape (one section per source artifact, including clean
  angles with an empty findings array) — pass --out's file straight to
  upsert-checkpoint-verdict.mjs's --findings-json. "findings" is the FLAT per-finding shape — pass
  --ledger-out's file straight to write-gate-findings-log.mjs/post-gate-findings.mjs's
  --findings-file, and is ALWAYS complete (never budgeted). "severityCounts" is likewise ALWAYS the
  true, unbudgeted totals across every finding, independent of any marking applied to "findingsJson"
  below. Every output finding's "disposition" is DERIVED from severity (accepted-for-fix for a
  blocking severity, deferred otherwise) — an input finding's own "disposition" is never honored,
  including on a budget-marker finding (below). A reviewer-provided "recommendation" is carried
  through to both shapes unchanged. A finding "summary" or "recommendation" longer than 2000 chars
  is truncated with a plain " …" suffix (never a "[truncated N chars]" marker), and "findingsJson"
  (--out) alone is bounded against upsert-checkpoint-verdict.mjs's OWN rendered-block limit — fit is
  measured by actually rendering a candidate through that CLI's normalizeStructuredFindings/
  renderStructuredFindings and catching the throw, not an approximated size. Summaries are first
  shrunk evenly; a round still over budget at minimum summary length instead degrades through three
  tiers, decided PER ANGLE: (1) verbose — that angle's findings replaced with ONE synthetic marker
  finding naming its omitted count and severity breakdown; (2) bare — that angle's marker shortens
  to a bare omitted-count line when the verbose sentence alone does not fit; (3) withheld — reached
  only when even ONE bare line per angle across the WHOLE round does not fit: "findingsJson" is
  emitted empty and --out, if given, is REMOVED from disk (never left stale from a prior run).
  Tiers 1-2 keep the real angle set and each angle's real verdict intact so the posted verdict's
  mandatory-angle/pool validation still passes. Every tier sets "commentBudgetExceeded": true and
  still exits 0; "findings"/--ledger-out is always unaffected. NOTE: upsert-checkpoint-verdict.mjs's
  posted "Findings summary:" digest is derived solely from "findingsJson", so on an over-budget
  round it counts marker lines, not real findings, and undercounts — "findings"/--ledger-out and the
  marker text's own breakdown carry the true numbers.
${JQ_OUTPUT_USAGE}
Exit codes:
  0  Success
  1  Argument error, missing/empty --findings-dir, unparseable artifact, schema
     violation, duplicate angle name across artifacts, blocked fan-in (a malformed or
     blocked per-angle artifact), or (with --gate) an unloadable/invalid worktree config
  2  Invalid --jq filter`.trim();

const parseError = buildParseError(USAGE);

const VALID_GATES = new Set(GATE_NAMES);
// Findings text (summary/recommendation) longer than this is truncated with a
// plain " …" suffix before emission — matching upsert-checkpoint-verdict.mjs's
// plain-ellipsis truncation policy (never the "[truncated N chars]" marker,
// which that CLI reserves for a posted comment being SHORTENED, not this
// tool's own findings text). upsert-checkpoint-verdict.mjs also bounds the
// WHOLE rendered --findings-json block and FAILS CLOSED above it, so a
// per-field cap alone is not enough — see fitsRenderBudget below, which
// measures that bound directly rather than duplicating its number here.
const MAX_FINDING_TEXT_LENGTH = 2000;
function truncateFindingText(value, limit = MAX_FINDING_TEXT_LENGTH) {
  if (typeof value !== "string" || value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 2))} …`;
}

// VALID_SEVERITIES (imported) is a membership vocabulary only — its Set
// iteration order is an implementation detail, not a contract; relying on it
// to mean "most blocking first" would let a future reordering there silently
// turn a must-fix angle's marker into "defer". This local, explicitly ordered
// list IS that contract, used only for picking a marker's representative
// severity and for the severity-count buckets below. Asserted at load time
// against VALID_SEVERITIES so the two can never silently drift apart.
const SEVERITY_RANK = ["must-fix", "worth-fixing-now", "defer"];
if (SEVERITY_RANK.length !== VALID_SEVERITIES.size || SEVERITY_RANK.some((s) => !VALID_SEVERITIES.has(s))) {
  throw new Error("consolidate-fanin.mjs: SEVERITY_RANK has drifted from @dev-loops/core/loop/gate-fanin's VALID_SEVERITIES");
}

// Does a candidate findingsJson shape actually fit upsert-checkpoint-verdict.mjs's
// posted-comment render bound? Measured by RENDERING it through that CLI's own
// normalizeStructuredFindings/renderStructuredFindings and catching the
// length-exceeded throw — not an approximated size. An estimate has to
// reproduce every rendering detail (per-line decoration, sanitizeStructuredInline's
// escaping) to stay accurate, and drifts the moment it does not; rendering the
// real candidate can't drift because it IS the bound.
function fitsRenderBudget(findingsJson) {
  try {
    renderStructuredFindings(normalizeStructuredFindings(findingsJson));
    return true;
  } catch {
    return false;
  }
}

// Shrink the longest summaries evenly until the candidate actually renders —
// deterministic. Returns whether the (mutated in place) findingsJson now fits;
// the caller decides what to do when the floor is reached and it still does
// not (see buildAngleMarker below) — this function never throws, so a round
// too large to render never blocks the durable ledger write.
function fitFindingsToRenderBudget(findingsJson) {
  let cap = MAX_FINDING_TEXT_LENGTH;
  while (!fitsRenderBudget(findingsJson) && cap > 40) {
    cap = Math.floor(cap / 2);
    for (const a of findingsJson) {
      for (const f of a.findings) {
        f.summary = truncateFindingText(f.summary, cap);
      }
    }
  }
  return fitsRenderBudget(findingsJson);
}

// Floor reached and still over budget: the fan-in has too many findings to
// render in one gate comment no matter how short each summary gets. Collapse
// ONE angle's findings to a single synthetic marker finding rather than
// failing closed — the durable ledger (--ledger-out) already carries every
// finding in full; only the rendered comment is space-constrained. The angle
// name and its real verdict are PRESERVED (never collapsed into a foreign
// section) — upsert-checkpoint-verdict.mjs's fanout_fanin mode validates the
// posted angle set against the gate's configured mandatory angles/pool, so a
// synthetic angle name or a missing real one would make the verdict itself
// unpostable, which is the exact failure this exists to avoid. `verbose`
// states the omitted count and severity breakdown; the caller (below) picks
// `false` for a bare "N omitted — see ledger" line, decided PER ANGLE so a
// round with a mix of wide and narrow angles keeps the breakdown wherever it
// actually fits rather than dropping it everywhere the instant any single
// angle can't afford it. Never partially truncates the marker text itself —
// always the whole verbose sentence or the whole bare one, so a marker is
// always lossless or bare, never a mangled hybrid.
function buildAngleMarker(a, verbose) {
  if (a.findings.length === 0) return a; // clean angle: nothing omitted
  const bySeverity = Object.fromEntries(SEVERITY_RANK.map((s) => [s, 0]));
  for (const f of a.findings) {
    if (Object.hasOwn(bySeverity, f.severity)) bySeverity[f.severity] += 1;
  }
  // Represent the angle by its own highest-severity dropped finding — same
  // severity+disposition pairing consolidateFanin already derived, so the
  // marker's "disposition" still matches every other findingsJson finding's
  // severity-derived disposition (accepted-for-fix for a blocking severity,
  // deferred otherwise).
  const representative = SEVERITY_RANK
    .map((s) => a.findings.find((f) => f.severity === s))
    .find(Boolean) ?? a.findings[0];
  const summary = verbose
    ? `${a.findings.length} finding(s) omitted from this comment (must-fix: ${bySeverity["must-fix"]}, worth-fixing-now: ${bySeverity["worth-fixing-now"]}, defer: ${bySeverity.defer}) — see the disposition ledger`
    : `${a.findings.length} omitted — see ledger`;
  return {
    angle: a.angle,
    verdict: a.verdict,
    findings: [{ severity: representative.severity, summary, disposition: representative.disposition }],
  };
}

// Build the over-budget --out shape once fitFindingsToRenderBudget has given
// up on the real findings: start every over-threshold angle at the bare
// marker (the smallest possible per-angle shape) so an early, single render
// check tells us whether ANY per-angle shape can fit at all (tier 3 below).
// If bare-everywhere fits, greedily upgrade angles to the verbose breakdown
// one at a time, keeping each upgrade only while the WHOLE round still
// renders — the verbose-vs-bare choice is decided PER ANGLE, not once for
// the whole round. Returns { commentFindingsJson, withheldOut }.
function buildBudgetMarkedFindingsJson(findingsJson) {
  const marked = findingsJson.map((a) => buildAngleMarker(a, false));
  if (!fitsRenderBudget(marked)) {
    // Structural floor: this many real angles (far beyond the default
    // fan-out cap) means even ONE bare "N omitted" line per angle cannot
    // fit — no per-angle shape can, no matter how short the text gets.
    return { commentFindingsJson: [], withheldOut: true };
  }
  for (let i = 0; i < marked.length; i++) {
    if (findingsJson[i].findings.length === 0) continue; // clean angle, untouched
    const bare = marked[i];
    marked[i] = buildAngleMarker(findingsJson[i], true);
    if (!fitsRenderBudget(marked)) {
      marked[i] = bare; // this angle's breakdown doesn't fit — keep it bare
    }
  }
  return { commentFindingsJson: marked, withheldOut: false };
}

export function parseConsolidateFaninCliArgs(argv) {
  const options = {
    help: false,
    findingsDir: undefined,
    gate: undefined,
    out: undefined,
    ledgerOut: undefined,
    prChecklistMatrix: undefined,
    repoRoot: undefined,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "findings-dir": { type: "string" },
      gate: { type: "string" },
      out: { type: "string" },
      "ledger-out": { type: "string" },
      "pr-checklist-matrix": { type: "string" },
      "repo-root": { type: "string" },
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
    if (token.name === "findings-dir") {
      options.findingsDir = requireTokenValue(token, parseError).trim();
      continue;
    }
    if (token.name === "gate") {
      const gate = requireTokenValue(token, parseError).trim();
      if (!VALID_GATES.has(gate)) {
        throw parseError("--gate must be draft_gate or pre_approval_gate");
      }
      options.gate = gate;
      continue;
    }
    if (token.name === "out") {
      const out = requireTokenValue(token, parseError).trim();
      if (out.length === 0) {
        throw parseError("--out requires a non-empty path");
      }
      options.out = out;
      continue;
    }
    if (token.name === "ledger-out") {
      const ledgerOut = requireTokenValue(token, parseError).trim();
      if (ledgerOut.length === 0) {
        throw parseError("--ledger-out requires a non-empty path");
      }
      options.ledgerOut = ledgerOut;
      continue;
    }
    if (token.name === "pr-checklist-matrix") {
      options.prChecklistMatrix = requireTokenValue(token, parseError);
      continue;
    }
    if (token.name === "repo-root") {
      const repoRoot = requireTokenValue(token, parseError).trim();
      if (repoRoot.length === 0) {
        throw parseError("--repo-root requires a non-empty path");
      }
      options.repoRoot = repoRoot;
      continue;
    }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.findingsDir) {
    throw parseError("Missing required argument: --findings-dir <dir>");
  }
  return options;
}

// Validate the CLI's own fail-closed schema floor: a well-formed object with a
// non-empty angle, a non-empty verdict, and (when findings is present as an
// array) only recognized severities. Everything else — verdict enum value,
// findings/clean-vs-findings_present consistency, missing summary — is left
// to consolidateFanin()'s own malformed-input handling; a consolidation it
// marks blocked then FAILS CLOSED below (exit 1) rather than emitting any
// findings shape, so this stays a thin floor rather than a second copy of
// consolidateFanin()'s validation.
function validateArtifactShape(raw, sourceLabel) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${sourceLabel}: artifact must be a JSON object`);
  }
  if (typeof raw.angle !== "string" || raw.angle.trim().length === 0) {
    throw new Error(`${sourceLabel}: missing "angle"`);
  }
  if (typeof raw.verdict !== "string" || raw.verdict.trim().length === 0) {
    throw new Error(`${sourceLabel}: missing "verdict"`);
  }
  if (Array.isArray(raw.findings)) {
    raw.findings.forEach((f, i) => {
      if (f && typeof f === "object" && !Array.isArray(f) && typeof f.severity === "string" && !VALID_SEVERITIES.has(f.severity.trim())) {
        throw new Error(`${sourceLabel}: findings[${i}] has unknown severity "${f.severity}" (expected must-fix|worth-fixing-now|defer)`);
      }
    });
  }
}

// Resolve the --pr-checklist-matrix upsert value: only the literal "clean"
// keyword is accepted (the mandatory-angle convenience). AC1 only requires
// upserting the mandatory clean entry when nothing covers it; no documented
// caller ever passes a custom artifact, so that speculative surface is not
// offered.
function resolvePrChecklistMatrixUpsert(rawValue) {
  if (rawValue.trim().toLowerCase() !== "clean") {
    throw new Error('--pr-checklist-matrix accepts only "clean"');
  }
  return { angle: "pr-checklist-matrix", verdict: "clean", findings: [] };
}

export async function consolidateGateFanin(options) {
  const dir = options.findingsDir;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`--findings-dir "${dir}" could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A per-angle artifact SYMLINKED into --findings-dir (a reviewer writing via
  // a symlink) must resolve like a regular file, not vanish silently: readdir
  // reports a symlink as isSymbolicLink(), never isFile(), so a bare isFile()
  // filter drops it with no warning — the exact fail-open this tool exists to
  // prevent, reached through a different input path than the blocked-verdict
  // guard below. stat() (which follows symlinks) each *.json dirent instead;
  // fail closed, naming the entry, on anything that isn't a regular file or a
  // symlink resolving to one (a dangling symlink, a directory, a fifo, ...).
  const jsonEntries = entries.filter((e) => e.name.endsWith(".json"));
  const files = [];
  for (const e of jsonEntries) {
    const entryPath = path.join(dir, e.name);
    if (e.isFile()) {
      files.push(e.name);
      continue;
    }
    if (e.isSymbolicLink()) {
      let resolved;
      try {
        resolved = await stat(entryPath);
      } catch (err) {
        throw new Error(`--findings-dir "${dir}" contains a *.json entry "${e.name}" that could not be resolved (dangling symlink?): ${err instanceof Error ? err.message : String(err)}`);
      }
      if (resolved.isFile()) {
        files.push(e.name);
        continue;
      }
      throw new Error(`--findings-dir "${dir}" contains a *.json entry "${e.name}" whose symlink target is not a regular file`);
    }
    const kind = e.isDirectory() ? "a directory" : e.isFIFO?.() ? "a fifo" : "not a regular file";
    throw new Error(`--findings-dir "${dir}" contains a *.json entry "${e.name}" that is ${kind}, not a regular file or a symlink to one`);
  }
  files.sort();
  if (files.length === 0) {
    throw new Error(`--findings-dir "${dir}" contains no *.json findings artifacts`);
  }

  const rawArtifacts = [];
  const angleSourceFiles = new Map(); // angle -> file paths that declared it
  for (const name of files) {
    const filePath = path.join(dir, name);
    let text;
    try {
      text = await readFile(filePath, "utf8");
    } catch (err) {
      throw new Error(`Cannot read findings artifact "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`Findings artifact "${filePath}" is not valid JSON`);
    }
    validateArtifactShape(parsed, `"${filePath}"`);
    const angle = parsed.angle.trim();
    if (!angleSourceFiles.has(angle)) angleSourceFiles.set(angle, []);
    angleSourceFiles.get(angle).push(filePath);
    rawArtifacts.push(parsed);
  }

  // Duplicate angle name across two artifact files is an ambiguous fan-out
  // (which one is authoritative?) — without this guard, findingsJson would
  // duplicate that angle's findings into EVERY matching section while the
  // flat findings/ledger shape counts them once, silently inflating counts.
  // Fail closed instead, naming every offending angle + its source files.
  const duplicateAngles = [...angleSourceFiles.entries()].filter(([, paths]) => paths.length > 1);
  if (duplicateAngles.length > 0) {
    const detail = duplicateAngles
      .map(([angle, paths]) => `"${angle}" declared in ${paths.join(", ")}`)
      .join("; ");
    throw new Error(`--findings-dir "${dir}" has duplicate angle name(s) across multiple artifact files (ambiguous fan-out): ${detail}`);
  }

  if (options.prChecklistMatrix !== undefined) {
    const hasPrChecklistMatrix = rawArtifacts.some(
      (a) => typeof a.angle === "string" && a.angle.trim() === "pr-checklist-matrix",
    );
    if (!hasPrChecklistMatrix) {
      rawArtifacts.push(resolvePrChecklistMatrixUpsert(options.prChecklistMatrix));
    }
  }

  const angles = rawArtifacts.map((a) => ({
    angle: a.angle.trim(),
    verdict: a.verdict.trim(),
    findingCount: Array.isArray(a.findings) ? a.findings.length : 0,
  }));

  // Load this worktree's config to resolve the gate's configured blocking
  // severities when --gate is supplied, so the overall verdict honors e.g. a
  // repo that also blocks clean on worth-fixing-now. Without --gate, keep
  // consolidateFanin's own ["must-fix"] default (no config side effects).
  // --repo-root anchors this explicitly (default process.cwd()) so the overall
  // verdict is deterministic regardless of the CLI's invocation directory.
  let blockCleanOnFindingSeverities;
  if (options.gate !== undefined) {
    const repoRoot = options.repoRoot ?? process.cwd();
    // A nonexistent/non-directory root would make loadDevLoopConfig silently
    // fall back to shipped defaults — the exact clean-ward fail-open
    // --repo-root exists to remove. Fail closed instead.
    const rootStat = await stat(repoRoot).catch(() => null);
    if (!rootStat?.isDirectory()) {
      throw new Error(`--repo-root ${JSON.stringify(repoRoot)} is not an existing directory`);
    }
    const { config, errors } = await loadDevLoopConfig({ repoRoot });
    // loadDevLoopConfig never throws: on a parse/validation failure it still
    // returns `config` merged from the shipped defaults, silently REPLACING
    // this worktree's real gates.<gate>.blockCleanOnFindingSeverities with
    // ["must-fix"]. Since --gate was given specifically to honor that
    // config, a failed load must fail closed here rather than silently
    // emitting a verdict computed from the wrong severities.
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(`--gate ${options.gate} was given but this worktree's config (--repo-root ${JSON.stringify(repoRoot)}) could not be fully loaded/validated: ${JSON.stringify(errors)}`);
    }
    const gateKey = options.gate === "draft_gate" ? "draft" : "preApproval";
    blockCleanOnFindingSeverities = resolveGateConfig(config, gateKey).blockCleanOnFindingSeverities;
  }

  const consolidated = consolidateFanin({ angleResults: rawArtifacts, blockCleanOnFindingSeverities });
  // Bound each finding's free-text fields before they reach either output
  // shape — see MAX_FINDING_TEXT_LENGTH above.
  for (const f of consolidated.findings) {
    f.summary = truncateFindingText(f.summary);
    if (f.recommendation) f.recommendation = truncateFindingText(f.recommendation);
  }
  // toFindingsLogShape's output ({ severity, angle, summary, disposition?, files? })
  // is exactly both write-gate-findings-log.mjs's --findings shape and the flat
  // per-finding shape upsert-checkpoint-verdict.mjs's --findings-json accepts —
  // the same array satisfies both consumer contracts.
  const findings = toFindingsLogShape(consolidated.findings);
  // The NESTED per-angle shape upsert-checkpoint-verdict.mjs's --findings-json
  // natively accepts (normalizeStructuredFindings/checkFanoutAngleCoverage): one
  // section per source artifact — including clean angles with an empty findings
  // array — so an all-clean fan-out and mandatory-angle coverage both validate.
  const findingsByAngle = new Map();
  for (const f of consolidated.findings) {
    if (!findingsByAngle.has(f.angle)) findingsByAngle.set(f.angle, []);
    findingsByAngle.get(f.angle).push(f);
  }
  // Fail closed on a blocked consolidation BEFORE deriving the nested shape:
  // consolidateFanin() returns blocked with an EMPTY findings array whenever
  // any artifact is malformed or itself blocked, so deriving per-angle
  // verdicts from that array would emit an all-clean findingsJson that
  // upsert-checkpoint-verdict accepts verbatim — silently discarding real
  // findings. A blocked fan-in has no publishable consolidated shape; the
  // caller must fix/re-run the offending reviewer first.
  if (consolidated.verdict === "blocked") {
    const detail = Array.isArray(consolidated.malformed) && consolidated.malformed.length > 0
      ? consolidated.malformed
          .map(({ index, reason }) => {
            const artifact = rawArtifacts[index];
            const angle = artifact?.angle ?? `artifact[${index}]`;
            // A "blocked" verdict is a LEGAL artifact shape (a reviewer's
            // documented signal that its review is contaminated/incomplete),
            // not a schema violation. gate-fanin's validateAngleResult only
            // knows the enum clean|findings_present, so it reports this case
            // as "invalid verdict" — steering an operator toward "fixing" it
            // by rewriting blocked -> clean instead of re-running the
            // reviewer. Detect it here and say what actually happened.
            if (artifact && typeof artifact === "object" && artifact.verdict === "blocked") {
              return `${angle}: reported verdict "blocked" — re-run that reviewer, then re-consolidate`;
            }
            return `${angle}: ${reason}`;
          })
          .join("; ")
      : "one or more per-angle artifacts report a blocked verdict";
    throw new Error(`fan-in is blocked — refusing to emit a consolidated findings shape (${detail})`);
  }

  const findingsJson = rawArtifacts.map((a) => {
    const angle = a.angle.trim();
    const angleFindings = findingsByAngle.get(angle) ?? [];
    return {
      angle,
      verdict: angleFindings.length > 0 ? "findings_present" : "clean",
      findings: angleFindings.map((f) => {
        const entry = { severity: f.severity, summary: f.summary, disposition: f.disposition };
        if (f.file) entry.file = f.file;
        if (typeof f.line === "number") entry.line = f.line;
        if (f.recommendation) entry.recommendation = f.recommendation;
        return entry;
      }),
    };
  });

  const wholeRoundFits = fitFindingsToRenderBudget(findingsJson);
  let commentFindingsJson = findingsJson;
  let withheldOut = false;
  if (!wholeRoundFits) {
    ({ commentFindingsJson, withheldOut } = buildBudgetMarkedFindingsJson(findingsJson));
  }

  const result = {
    ok: true,
    ...(options.gate !== undefined ? { gate: options.gate } : {}),
    angles,
    findingsJson: commentFindingsJson,
    findings,
    severityCounts: consolidated.counts.bySeverity,
    overallVerdict: consolidated.verdict,
    ...(wholeRoundFits ? {} : { commentBudgetExceeded: true }),
  };

  if (options.out !== undefined) {
    if (withheldOut) {
      // Never leave a stale --out from an earlier round on disk: a caller
      // that unconditionally reads --out (rather than checking
      // "commentBudgetExceeded") would otherwise post a PRIOR round's
      // findings as though they were this round's.
      await rm(options.out, { force: true });
    } else {
      await mkdir(path.dirname(options.out), { recursive: true });
      await writeFile(options.out, `${JSON.stringify(commentFindingsJson, null, 2)}\n`, "utf8");
    }
  }
  if (options.ledgerOut !== undefined) {
    await mkdir(path.dirname(options.ledgerOut), { recursive: true });
    await writeFile(options.ledgerOut, `${JSON.stringify(findings, null, 2)}\n`, "utf8");
  }

  return result;
}

async function main() {
  let options;
  try {
    options = parseConsolidateFaninCliArgs(process.argv.slice(2));
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
    const result = await consolidateGateFanin(options);
    process.exitCode = emitResult(result, { jq: options.jq, silent: options.silent });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  }
}

if (isDirectCliRun(import.meta.url)) {
  await main();
}
