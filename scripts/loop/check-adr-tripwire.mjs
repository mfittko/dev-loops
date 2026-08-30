#!/usr/bin/env node
/**
 * check-adr-tripwire
 *
 * Fail-closed ADR tripwire for decision-shaped PRs (issue #1867). A lazy
 * tripwire, not an ADR-worthiness classifier: it detects the three
 * highest-signal mechanical surfaces and requires an ADR (or an explicit
 * waiver) alongside them, converting the advisory-first remainder of
 * `ADR-WORTHY-PERSIST` into a fail-closed gate for exactly those cases.
 *
 * Trigger classes (any one trips the check):
 *  1. contract-doc: an added/modified/deleted path under `skills/docs/`
 *     ending `-contract.md` (the generated `.claude/skills/docs` mirror is
 *     deliberately NOT a trigger — only the canonical surface is).
 *  2. gate-config: the shared gate defaults
 *     `packages/core/src/config/extension-defaults.yaml`.
 *  3. rule-modality reversal: the same `<!-- rule: ID -->` marker whose
 *     RFC-2119 modality family (MUST/SHALL vs SHOULD vs MAY) changed between
 *     the base and head content of a changed `skills/docs/*.md` file. A
 *     changed rule-bearing file whose base+head content cannot BOTH be read
 *     fails closed (unresolvable-rule-scan) rather than silently passing.
 *
 * Satisfaction: the diff adds or updates a `docs/decisions/NNNN-*.md` record,
 * or the PR body carries a one-line waiver marker
 * `adr-tripwire:allow <reason>` (mirroring `secret-scan:allow`'s
 * marker-plus-reason shape). The waiver is body-derived, so both enforcement
 * paths (ready-for-review.mjs and the raw `gh pr ready` hook,
 * pre-pr-ready-gate.mjs) honor it without any flag surface — the reason lives
 * durably in the same PR description a reviewer already reads.
 *
 * Pure computation (no git I/O) lives in `computeAdrTripwire`; the git-side
 * wrapper is `evaluateAdrTripwire`, mirroring `evaluatePrSizeBudget` in
 * check-size-budget.mjs. The existing ADR-shape validator
 * (`scripts/docs/validate-decision-records.mjs`) is deliberately untouched.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { requireTokenValue } from "../_cli-primitives.mjs";
import { gitEnvWithoutDirOverrides } from "../github/write-gate-context.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, matchJqOutputToken } from "../lib/jq-output.mjs";

const USAGE = `Usage: check-adr-tripwire.mjs --base <ref> [--head <ref>] [--pr-body-file <path>]

Fail-closed ADR tripwire for decision-shaped PRs (issue #1867): a diff
touching a decision-shaped surface — skills/docs/*-contract.md, the shared
gate config extension-defaults.yaml, or a rule-modality (MUST/SHOULD/MAY)
reversal on an existing <!-- rule: ID --> — must also add or update a
docs/decisions/NNNN-*.md record, or the PR body must carry the one-line
waiver marker 'adr-tripwire:allow <reason>'. Emits pass | block.

Required:
  --base <ref>          Git ref to diff against (git diff <ref>...<head>)

Optional:
  --head <ref>          Git ref for the PR head (default: HEAD)
  --pr-body-file <path> File holding the PR body (waiver surface); default:
                        no body — a waiver can then never be honored

Output (stdout, JSON):
  {
    "ok": true,
    "outcome": "pass"|"block",
    "satisfiedBy": "adr"|"waiver"|null,
    "triggers": [{ "type": "contract-doc"|"gate-config"|"rule-modality-reversal"|"unresolvable-rule-scan", "path": "...", ... }],
    "adrFiles": ["docs/decisions/0052-..."],
    "waiver": { "requested": false, "valid": false, "reason": null },
    "reasons": []
  }

${JQ_OUTPUT_USAGE}`;

const parseError = buildParseError(USAGE);

// ---------------------------------------------------------------------------
// Path matchers
// ---------------------------------------------------------------------------

export const ADR_PATH_RE = /^docs\/decisions\/\d{4}-[a-z0-9-]+\.md$/u;
export const CONTRACT_DOC_RE = /^skills\/docs\/[A-Za-z0-9._-]*-contract\.md$/u;
export const GATE_CONFIG_PATH = "packages/core/src/config/extension-defaults.yaml";
export const WAIVER_MARKER = "adr-tripwire:allow";
const WAIVER_RE = /adr-tripwire:allow[ \t]+(\S.*?)\s*$/u;

/** True when the path is a markdown doc under skills/docs (rule-marker scan surface). */
function isSkillsDocsMarkdown(p) {
  return p.startsWith("skills/docs/") && p.endsWith(".md");
}

// ---------------------------------------------------------------------------
// Rule-marker modality extraction (lexical, deliberately simple)
// ---------------------------------------------------------------------------

const RULE_MARKER_RE = /<!--\s*rule:\s*([A-Z][A-Z0-9-]*)\s*-->/gu;
const MODALITY_RE = /\b(MUST NOT|SHALL NOT|SHOULD NOT|MAY NOT|MUST|SHALL|SHOULD|MAY)\b/u;

function modalityFamily(keyword) {
  if (keyword === "MUST" || keyword === "SHALL" || keyword === "MUST NOT" || keyword === "SHALL NOT") return "must";
  if (keyword === "SHOULD" || keyword === "SHOULD NOT") return "should";
  return "may"; // MAY / MAY NOT
}

/**
 * Extract `ruleId -> modality family ("must"|"should"|"may"|null)` from
 * markdown content. For each `<!-- rule: ID -->` marker, scan the marker's
 * own line and then following lines until the next marker, a blank line, or
 * a bounded 3-line window — the first RFC-2119 keyword wins. Covers both
 * marker-inline rows (contract tables) and own-line markers with the rule
 * sentence beneath. Lexical and judgment-free by design; the tripwire's
 * waiver absorbs over-triggers.
 */
export function extractRuleModalities(content) {
  const modalities = new Map();
  if (typeof content !== "string" || content.length === 0) return modalities;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    for (const m of lines[i].matchAll(RULE_MARKER_RE)) {
      if (modalities.has(m[1])) continue;
      let family = null;
      const remainder = lines[i].slice((m.index ?? 0) + m[0].length);
      const km = MODALITY_RE.exec(remainder);
      if (km) {
        family = modalityFamily(km[1]);
      } else {
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
          if (lines[j].trim() === "") break;
          const next = MODALITY_RE.exec(lines[j]);
          if (next) { family = modalityFamily(next[1]); break; }
        }
      }
      modalities.set(m[1], family);
    }
  }
  return modalities;
}

// ---------------------------------------------------------------------------
// Diff name-status parsing (handles rename rows: R<score>\told\tnew)
// ---------------------------------------------------------------------------

export function parseNameStatus(output) {
  if (typeof output !== "string" || output.length === 0) return [];
  const files = [];
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (parts.length >= 3) {
      files.push({ status, path: parts[2], origPath: parts[1] });
    } else if (parts.length === 2 && parts[1] !== "") {
      files.push({ status, path: parts[1], origPath: null });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Pure computation
// ---------------------------------------------------------------------------

/**
 * Compute the ADR-tripwire outcome for one diff. Pure — no git, no fs — so
 * fixtures can drive every branch directly.
 *
 * @param {object} input
 * @param {string} [input.nameStatusOutput] — `git diff --name-status` output
 * @param {Object<string,string>} [input.baseContents] — path → file content at base
 * @param {Object<string,string>} [input.headContents] — path → file content at head
 * @param {string} [input.prBody] — PR body text (the waiver surface)
 */
export function computeAdrTripwire({
  nameStatusOutput = "",
  baseContents = {},
  headContents = {},
  prBody = "",
} = {}) {
  const files = parseNameStatus(nameStatusOutput);
  const triggers = [];

  for (const file of files) {
    if (CONTRACT_DOC_RE.test(file.path)) {
      triggers.push({ type: "contract-doc", path: file.path });
    }
    if (file.path === GATE_CONFIG_PATH) {
      triggers.push({ type: "gate-config", path: file.path });
    }
  }

  // Rule-modality reversal scan over changed skills/docs markdown. Only
  // changed rule-BEARING content matters; an unscannable rule-bearing file
  // (missing base AND head content, or one side absent while the other
  // carries rules) fails closed — silence must mean "scanned, no reversal",
  // never "could not read".
  for (const file of files) {
    if (!isSkillsDocsMarkdown(file.path)) continue;
    const base = (file.origPath ? baseContents[file.origPath] : undefined) ?? baseContents[file.path] ?? null;
    const head = headContents[file.path] ?? null;
    const baseModal = base != null ? extractRuleModalities(base) : null;
    const headModal = head != null ? extractRuleModalities(head) : null;
    const ruleCount = (m) => (m ? [...m.keys()].length : 0);
    if (baseModal == null && headModal == null) {
      triggers.push({ type: "unresolvable-rule-scan", path: file.path });
      continue;
    }
    if (baseModal == null || headModal == null) {
      if (ruleCount(baseModal) > 0 || ruleCount(headModal) > 0) {
        triggers.push({ type: "unresolvable-rule-scan", path: file.path });
      }
      continue;
    }
    for (const [ruleId, family] of headModal) {
      const before = baseModal.get(ruleId);
      // A brand-new rule (no base modality) is not a reversal; a rule whose
      // modality family changed in either direction is (tighten or loosen —
      // both are policy-level modality changes per ADR-WORTHY-PERSIST).
      if (before != null && family != null && before !== family) {
        triggers.push({ type: "rule-modality-reversal", path: file.path, ruleId, from: before, to: family });
      }
    }
  }

  const adrFiles = files.filter((f) => ADR_PATH_RE.test(f.path)).map((f) => f.path);

  // Waiver: first `adr-tripwire:allow <reason>` line in the PR body. A bare
  // marker with no reason is invalid — the reason is the durable evidence a
  // reviewer reads; without it the marker is decorative.
  let waiver = { requested: false, valid: false, reason: null };
  if (typeof prBody === "string" && prBody.length > 0) {
    for (const line of prBody.split("\n")) {
      const m = WAIVER_RE.exec(line);
      if (m) {
        const reason = m[1].trim();
        waiver = { requested: true, valid: reason.length > 0, reason: reason.length > 0 ? reason : null };
        break;
      }
    }
  }

  if (triggers.length === 0) {
    return { ok: true, outcome: "pass", satisfiedBy: null, triggers, adrFiles, waiver, reasons: [] };
  }

  if (adrFiles.length > 0) {
    return { ok: true, outcome: "pass", satisfiedBy: "adr", triggers, adrFiles, waiver, reasons: [] };
  }

  if (waiver.valid) {
    return { ok: true, outcome: "pass", satisfiedBy: "waiver", triggers, adrFiles, waiver, reasons: [] };
  }

  const reasons = triggers.map((t) => {
    if (t.type === "rule-modality-reversal") return `${t.path}: rule ${t.ruleId} modality reversed ${t.from}→${t.to}`;
    if (t.type === "gate-config") return `${t.path}: shared gate config touched`;
    if (t.type === "unresolvable-rule-scan") return `${t.path}: rule-bearing doc changed but base+head content not both readable (fail-closed)`;
    return `${t.path}: decision-shaped contract doc touched`;
  });
  reasons.push(
    "ADR tripwire: a decision-shaped surface was touched without adding/updating a docs/decisions/NNNN-*.md record and without a valid `adr-tripwire:allow <reason>` waiver in the PR body.",
  );
  return { ok: true, outcome: "block", satisfiedBy: null, triggers, adrFiles, waiver, reasons };
}

// ---------------------------------------------------------------------------
// Git-side wrapper (mirrors evaluatePrSizeBudget)
// ---------------------------------------------------------------------------

function runGit(args, { repoRoot, env }) {
  // stdio ignore on the child's stderr: an expected `git show <ref>:<path>`
  // miss (path absent at that ref) must not leak git's fatal text onto our
  // caller's stderr — both enforcement paths emit JSON there.
  return execFileSync("git", args, { cwd: repoRoot, env, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString();
}

function assertPlausibleRef(ref, label) {
  if (typeof ref !== "string" || ref.length === 0 || ref.startsWith("-") || ref.includes("..")) {
    throw new Error(`${label} must be a plausible git ref (no leading '-', no '..')`);
  }
}

/**
 * Evaluate the tripwire against a locally-resolvable base...head diff. Never
 * runs `git fetch` — the caller's flow is responsible for the refs being
 * present locally. Reads `git show` content for every changed skills/docs
 * markdown file at both refs so rule-modality reversals are detectable.
 */
export async function evaluateAdrTripwire({
  base,
  head = "HEAD",
  prBody = "",
  repoRoot = process.cwd(),
  env = process.env,
} = {}) {
  assertPlausibleRef(base, "--base");
  assertPlausibleRef(head, "--head");
  const gitEnv = gitEnvWithoutDirOverrides(env);
  const nameStatusOutput = runGit(["diff", "--name-status", `${base}...${head}`], { repoRoot, env: gitEnv });
  const files = parseNameStatus(nameStatusOutput);
  const baseContents = {};
  const headContents = {};
  for (const file of files) {
    if (!isSkillsDocsMarkdown(file.path) && !(file.origPath && isSkillsDocsMarkdown(file.origPath))) continue;
    if (file.origPath) {
      try { baseContents[file.origPath] = runGit(["show", `${base}:${file.origPath}`], { repoRoot, env: gitEnv }); } catch { /* absent at base */ }
    } else {
      try { baseContents[file.path] = runGit(["show", `${base}:${file.path}`], { repoRoot, env: gitEnv }); } catch { /* absent at base */ }
    }
    try { headContents[file.path] = runGit(["show", `${head}:${file.path}`], { repoRoot, env: gitEnv }); } catch { /* absent at head */ }
  }
  return computeAdrTripwire({ nameStatusOutput, baseContents, headContents, prBody });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseCheckAdrTripwireCliArgs(argv) {
  const options = { help: false, base: undefined, head: "HEAD", prBodyFile: undefined };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      base: { type: "string" },
      head: { type: "string" },
      "pr-body-file": { type: "string" },
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
    if (token.name === "base") { options.base = requireTokenValue(token, parseError); continue; }
    if (token.name === "head") { options.head = requireTokenValue(token, parseError); continue; }
    if (token.name === "pr-body-file") { options.prBodyFile = requireTokenValue(token, parseError); continue; }
    if (matchJqOutputToken(token, options, (t) => requireTokenValue(t, parseError))) continue;
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  if (!options.base) throw parseError("check-adr-tripwire requires --base <ref>");
  return options;
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, repoRoot = process.cwd(), env = process.env } = {}) {
  const options = parseCheckAdrTripwireCliArgs(argv);
  if (options.help) { stdout.write(`${USAGE}\n`); return { ok: true, help: true }; }
  let prBody = "";
  if (options.prBodyFile) {
    prBody = readFileSync(options.prBodyFile, "utf8");
  }
  const result = await evaluateAdrTripwire({ base: options.base, head: options.head, prBody, repoRoot, env });
  const payload = result.outcome === "pass"
    ? { ...result, ok: true }
    : { ...result, ok: true, error: "adr_tripwire_block" };
  process.exitCode = emitResult(payload, { jq: options.jq, silent: options.silent, stdout, stderr });
  return payload;
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
