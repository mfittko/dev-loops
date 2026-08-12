#!/usr/bin/env node
/**
 * validate-rule-ownership.mjs — L0/L1 contract rule ownership validator.
 *
 * This scan is deliberately lexical. It catches stable rule-ID ownership,
 * required-rule deletion, machine-checkable references, defined-term drift,
 * RFC-2119 modality conflicts, near-duplicate rule bodies, and duplicated
 * free-text imperative sentences across the corpus. All findings are gating
 * (exit 1). Behavioral contradictions belong to the L2/L3 harness; semantic
 * contradictions belong to the gate contradiction lens.
 *
 * Also gates corpus→manifest completeness: every defined rule must be listed
 * in required-rules.json's requiredRules or its optOutRules (unregistered_rule),
 * the optOutRules manifest itself must be internally consistent (no ID in both
 * lists — conflicting_manifest_entry; no opt-out for an undefined rule —
 * dead_opt_out_entry), and the duplicate-sentence allowlist must not contain
 * stale entries (dead_allowlist_entry).
 *
 * Subsumes former scripts/docs/validate-no-duplicate-rules.mjs (retired):
 * the duplicate-imperative-sentence scan below ports its unique check,
 * widened from skills/ only to every SOURCE_ROOTS directory.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDirectCliRun, parseJsonText } from "../_core-helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const SOURCE_ROOTS = ["skills", "agents", "commands", "docs"];
const MARKER_RE = /<!--\s*rule:\s*([A-Z][A-Z0-9-]*)\s*-->/g;
const REF_RE = /<!--\s*rule-ref:\s*([A-Z][A-Z0-9-]*)\s*-->|\[([A-Z0-9]+(?:-[A-Z0-9]+){2,})\]\([^)]*\)/g;
const TERM_RE = /<!--\s*term:\s*(state|reason|gate):([a-zA-Z0-9_.:-]+)\s*-->/g;
const CODE_TOKEN_RE = /`([a-z][a-z0-9_:-]+)`/g;
const MODAL_RE = /\b(MUST NOT|SHALL NOT|SHOULD NOT|MAY NOT|MUST|SHALL|SHOULD|MAY)\b/g;

// Enforcement classification surface: every registry rule carries a
// `doc` | `runtime` | `agent` classification; `agent` requires a one-line
// `enforcementNote` justification. `runtime` is the default for an unspecified
// classification, so a rule can never quietly escape the enforcement ratchet.
const ENFORCEMENT_VALUES = new Set(["doc", "runtime", "agent"]);
const RUNTIME_ROOTS = ["scripts", "packages"];
const RUNTIME_FILE_RE = /\.(mjs|cjs|js|ts|sh|json)$/;
// Registry-ID shape used to spot enforcement citations in runtime source.
// First segment is 3+ uppercase chars so 3-letter prefixes (OPS-, ADR-) are
// detectable, consistent with the canonical MARKER_RE grammar below.
const RULE_ID_SHAPE_RE = /\b[A-Z][A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+\b/g;

// Refusal/error emission construct carried by the same line as an enforcement
// citation. Enforcement credit is refusal-path-based (#1617): a runtime rule is
// only counted as enforced when its ID appears in an *enforcement error/refusal
// string* — a string literal emitted because the rule forbids an operation —
// not mere presence in source. An ID in a docstring, usage text, data/log
// string, or bare identifier performs no enforcement and must not be credited.
// This is a line-level lexical heuristic (this validator is deliberately
// lexical): a citation line is a refusal path when it carries one of these
// refusal/error emission constructs.
const REFUSAL_SIGNAL_RE = /\b(?:refus|throw|new Error|errors\.push|process\.exit|stderr\.write|console\.error|violat|invalid|forbid|denied|blocked|cannot|must not|must fail|required by|>&2|exit\s*\()/i;

// Line-level string-literal membership: returns true when `index` falls inside
// the literal text of a '...', "...", or `...` string on `line`. Handles
// template-literal `${...}` interpolation nesting (including a nested backtick
// string inside an interpolation), which naive quote-parity cannot (that is why
// a backtick-string nesting like the jq-output refusal breaks simple parity).
export function indexInsideStringLiteral(line, index) {
  const n = line.length;
  const stack = []; // 'sq' | 'dq' | 'tick' | 'interp'
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    if (i === index) return top === "sq" || top === "dq" || top === "tick";
    const c = line[i];
    if (top === "sq") {
      if (c === "\\") { i += 2; continue; }
      if (c === "'") stack.pop();
      i += 1; continue;
    }
    if (top === "dq") {
      if (c === "\\") { i += 2; continue; }
      if (c === '"') stack.pop();
      i += 1; continue;
    }
    if (top === "tick") {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { stack.pop(); i += 1; continue; }
      if (c === "$" && line[i + 1] === "{") { stack.push("interp"); i += 2; continue; }
      i += 1; continue;
    }
    if (top === "interp") {
      if (c === "\\") { i += 2; continue; }
      if (c === "'") { stack.push("sq"); i += 1; continue; }
      if (c === '"') { stack.push("dq"); i += 1; continue; }
      if (c === "`") { stack.push("tick"); i += 1; continue; }
      if (c === "{") { stack.push("interp"); i += 1; continue; }
      if (c === "}") { stack.pop(); i += 1; continue; }
      i += 1; continue;
    }
    // code context (no open string)
    if (c === "'") { stack.push("sq"); i += 1; continue; }
    if (c === '"') { stack.push("dq"); i += 1; continue; }
    if (c === "`") { stack.push("tick"); i += 1; continue; }
    i += 1;
  }
  return false;
}

// A citation occurrence counts as an enforcement (refusal-path) site only when
// the rule ID sits inside a string literal that is part of a refusal/error
// emission on that line. `tokenIndex` is the 0-based column of the token in `line`.
export function isRefusalPathCitation(line, tokenIndex) {
  return indexInsideStringLiteral(line, tokenIndex) && REFUSAL_SIGNAL_RE.test(line);
}

// Registry-ID-shaped tokens that appear in runtime source but are ordinary
// English/technical/placeholder tokens, not rule citations. Mirrors the
// KNOWN_INTENTIONAL_DUPLICATE_SENTENCES allowlist pattern: without this, a raw
// shape scan would flag FAIL-CLOSED / BEST-EFFORT / PROJ-123 as phantom rule
// citations. A NEW unknown token in runtime source that is not a real registry
// ID and not on this list is treated as a phantom citation (gating).
const NON_RULE_TOKENS = new Set([
  "ACCEPT-CRITERIA-VERIFY-AND",
  "AGENT-LEVEL",
  "AXIS-TEXT-DELIMITER",
  "BEST-EFFORT",
  "CLEANUP-SAFETY",
  "DEFAULT-SAFE",
  "FAIL-CLOSED",
  "FAIL-OPEN",
  "FAIL-SOFT",
  "FALSE-ACCEPTS",
  "GATE-AUTHORED",
  "HEAD-ADVANCED",
  "INLINE-INTERPRETER",
  "INTERNALLY-CONSISTENT",
  "LOCAL-FIRST",
  "LOCATABLE-SHAPED",
  "MANY-TO-ONE",
  "MARKER-ONLY",
  "MUST-RE-RUN",
  "NON-FATAL",
  "OWN-AUTHORED",
  "PATH-NUMBERING",
  "POST-CAP",
  "PREFIX-ONLY",
  "PROJ-123",
  "PURE-DETERMINISTIC",
  "SHA-256",
  "SUPERSEDE-NOT-REWRITE",
  "TOP-LEVEL",
  "VERDICT-ONLY",
  "WORK-DEDUP",
  "YYYY-MM-DD",
  "YYYY-MM-DDTHH",
]);

export function normalizeRuleEntry(entry) {
  if (typeof entry === "string") return { id: entry, enforcement: "runtime" };
  if (entry === null || typeof entry !== "object" || Array.isArray(entry) || typeof entry.id !== "string" || entry.id.trim() === "") {
    return {
      id: undefined,
      enforcement: "runtime",
      invalid: true,
      reason: entry === null ? "null entry" : Array.isArray(entry) ? `array entry` : typeof entry.id !== "string" ? `expected a string "id", got ${typeof entry.id}` : `empty "id"`,
    };
  }
  return {
    id: entry.id,
    enforcement: entry.enforcement || "runtime",
    enforcementNote: entry.enforcementNote,
  };
}

export function isRuntimeSourceFile(basename, relPath) {
  const parts = relPath.split(/[\\/]/);
  if (parts.includes("test") || parts.includes("node_modules") || parts.includes("tmp") || parts.includes("site")) return false;
  if (/\.test\./.test(basename)) return false;
  return RUNTIME_FILE_RE.test(basename);
}

// Strip comments before scanning so a rule ID named only in a code comment is not
// credited as enforcement: the structural-quality.md convention requires the rule ID
// in an actual enforcement error message/check, not just a comment. .json has no
// comments and its string values are data, not enforcement sites, so it is excluded.
function stripSourceComments(content, ext) {
  if (ext === ".json") return ""; // json values are data, never enforcement citations
  if (ext === ".sh") {
    return content.replace(/^[ \t]*#.*$/gm, "");
  }
  let out = "";
  let i = 0;
  const n = content.length;
  while (i < n) {
    const c = content[i];
    if (c === "/" && content[i + 1] === "*") {
      const end = content.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
    } else if (c === "/" && content[i + 1] === "/") {
      const end = content.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
      out += "\n";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

async function* walkRuntime(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    // vendor/ (and analogous vendored dirs) is never an enforcement site: it
    // holds third-party/minified files whose rule-ID-shaped tokens must not be
    // citation or phantom signals (c.f. the node_modules/tmp/site exclusions).
    if (entry.name === "node_modules" || entry.name === "tmp" || entry.name === "site" || entry.name === "vendor" || entry.name === ".claude") continue;
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* walkRuntime(full);
    else if (entry.isFile()) yield full;
  }
}

// Registry-ID-shaped tokens found in non-test runtime source (scripts/,
// packages/), tagged with the relative file they appear in and whether the
// occurrence is a refusal-path (enforcement error/refusal string) citation.
// Phantom detection (unknown IDs) scans all presence; enforcement credit uses
// `refusalPath` only (see validateRuleOwnership).
export async function collectRuntimeCitations(repoRoot = REPO_ROOT) {
  const tokens = [];
  for (const root of RUNTIME_ROOTS) {
    for await (const file of walkRuntime(path.join(repoRoot, root))) {
      const rel = toPosix(path.relative(repoRoot, file));
      if (!isRuntimeSourceFile(path.basename(file), rel)) continue;
      const content = await readFile(file, "utf8");
      const scanned = stripSourceComments(content, path.extname(file));
      const lines = scanned.split("\n");
      for (const line of lines) {
        for (const match of line.matchAll(RULE_ID_SHAPE_RE)) {
          tokens.push({ id: match[0], file: rel, refusalPath: isRefusalPathCitation(line, match.index) });
        }
      }
    }
  }
  return tokens;
}

// Duplicate-imperative-sentence scan (ported from validate-no-duplicate-rules.mjs).
const IMPERATIVE_PATTERNS = [/\bmust\b/i, /\bnever\b/i, /\bdo not\b/i, /\brequire[sd]?\b/i];
const MIN_SENTENCE_LENGTH = 20;

// Contract docs that mirror each other's content by design.
const CANONICAL_MIRROR_DOCS = new Set(["skills/docs/copilot-loop-operations.md", "skills/docs/public-dev-loop-contract.md"]);

// Sentences deliberately duplicated across files (mirrored procedure text, or
// command trigger-phrasing that STYLE/(c) guardrails require to stay verbatim
// per file). Cross-file duplication of these is not a corpus authoring bug.
const KNOWN_INTENTIONAL_DUPLICATE_SENTENCES = new Set([
  // agents/dev-loop.agent.md mirrors this CLI-fallback safety line from skills/dev-loop/SKILL.md;
  // each doc's surrounding candidate-resolution list differs per install layout.
  "NEVER fall back to or any unbounded filesystem walk to locate the CLI — it stalls and trips the needs-attention timeout.",
  // commands/loop-auto.command.md and commands/loop-start.command.md — command trigger
  // phrasing is load-bearing verbatim per-command guardrail (c); not a restatement bug.
  "Do not pick an internal strategy name yourself.",
  // skills/docs/slides-story-review-loop.md and skills/docs/ui-designer-review-loop.md are sibling
  // non-normative review-loop docs (epic non-goal) that share boilerplate by design.
  "The loop requires all of the following inputs before it may run:",
  "If any required part of this bundle is missing, incomplete, or ambiguous, the loop fails closed instead of guessing.",
  "- required acceptance criteria are missing",
  // agents/developer.agent.md and agents/fixer.agent.md deliberately state the same git-stash
  // ban verbatim — both are direct implementation agents that touch the same shared-`.git`
  // worktree layout, so the guardrail belongs in both, not just one.
  "- Never (or /): is shared across every worktree over this repo's one directory, so a stash can pop into a different worktree.",
]);

const USAGE = `Usage: validate-rule-ownership.mjs [--help]

Validate rule markers, required IDs, rule references, term definitions,
near-duplicate/modality-conflict findings, and duplicated imperative
sentences. Also validates corpus→manifest completeness (every defined rule
must be in requiredRules or explicitly opted out via optOutRules in
required-rules.json), optOutRules manifest hygiene (no rule listed as both
required and opted-out; no opt-out for an undefined rule), and that the
duplicate-sentence allowlist has no stale (dead) entries. All findings are
gating (exit 1).

Options:
  --help, -h   Show this help`.trim();

export function isImperativeSentence(sentence) {
  return IMPERATIVE_PATTERNS.some((pattern) => pattern.test(sentence));
}

export function normalizeSentence(text) {
  return text.replace(/\s+/g, " ").trim();
}

export function extractImperativeSentences(content) {
  const lines = content.split(/\r?\n/);
  const sentences = [];
  let inFencedBlock = false;
  let fencedDelimiter = "";

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const rawTrimmed = line.trim();

    if (/^\s*#/.test(line) || /^\s*>/.test(line)) continue;

    const fenceMatch = rawTrimmed.match(/^(```|~~~)/);
    if (fenceMatch) {
      if (!inFencedBlock) {
        inFencedBlock = true;
        fencedDelimiter = fenceMatch[1];
        continue;
      } else if (rawTrimmed.startsWith(fencedDelimiter)) {
        inFencedBlock = false;
        fencedDelimiter = "";
        continue;
      }
    }
    if (inFencedBlock) continue;

    line = line.replace(/`[^`]*`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

    const parts = line.split(/(?<=[.!?])\s+(?=[A-Z])/);
    for (const part of parts) {
      const normalized = normalizeSentence(part);
      if (normalized.length >= MIN_SENTENCE_LENGTH && isImperativeSentence(normalized)) {
        sentences.push({ text: normalized, line: i + 1 });
      }
    }
  }
  return sentences;
}

export function detectDuplicateImperativeSentences(fileContents) {
  const bySentence = new Map();
  for (const { file, content } of fileContents) {
    for (const { text, line } of extractImperativeSentences(content)) {
      if (!bySentence.has(text)) bySentence.set(text, []);
      bySentence.get(text).push({ file, line });
    }
  }
  const findings = [];
  for (const [text, occurrences] of bySentence) {
    if (KNOWN_INTENTIONAL_DUPLICATE_SENTENCES.has(text)) continue;
    const files = new Set(occurrences.map((o) => o.file));
    if (files.size <= 1) continue;
    if ([...files].every((f) => CANONICAL_MIRROR_DOCS.has(f))) continue;
    findings.push({ kind: "duplicate_imperative_sentence", text, occurrences });
  }
  return findings;
}

function toPosix(p) {
  return p.replace(/\\/g, "/");
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "tmp" || entry.name === "site" || entry.name === ".claude") {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile() && entry.name.endsWith(".md")) yield full;
  }
}

export async function collectContractMarkdownFiles(repoRoot = REPO_ROOT) {
  const files = [];
  for (const root of SOURCE_ROOTS) {
    for await (const file of walk(path.join(repoRoot, root))) {
      files.push(file);
    }
  }
  return files.sort();
}

function lineFor(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function stripFences(content) {
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let fence = "";
  return lines.map((line) => {
    const m = line.trim().match(/^(```|~~~)/);
    if (m) {
      if (!inFence) {
        inFence = true;
        fence = m[1];
      } else if (line.trim().startsWith(fence)) {
        inFence = false;
        fence = "";
      }
      return "";
    }
    return inFence ? "" : line;
  }).join("\n");
}

function extractRuleBody(content, markerIndex) {
  const after = content.slice(markerIndex).replace(MARKER_RE, "").trimStart();
  const firstLine = after.split(/\r?\n/, 1)[0].trim();
  return firstLine.replace(/^`[A-Z][A-Z0-9-]*`\s*\|\s*/, "").replace(/\s+/g, " ").trim();
}

export function extractRuleDefinitions(content, file) {
  const defs = [];
  const scan = stripFences(content);
  for (const match of scan.matchAll(MARKER_RE)) {
    defs.push({ id: match[1], file, line: lineFor(scan, match.index), body: extractRuleBody(scan, match.index) });
  }
  return defs;
}

export function extractRuleReferences(content, file) {
  const refs = [];
  const scan = stripFences(content);
  for (const match of scan.matchAll(REF_RE)) {
    const id = match[1] || match[2];
    refs.push({ id, file, line: lineFor(scan, match.index) });
  }
  return refs;
}

export function extractTermDefinitions(content, file) {
  const terms = [];
  const scan = stripFences(content);
  for (const match of scan.matchAll(TERM_RE)) {
    terms.push({ kind: match[1], value: match[2], key: `${match[1]}:${match[2]}`, file, line: lineFor(scan, match.index) });
  }
  return terms;
}

export function extractTermUses(content, file) {
  const terms = extractTermDefinitions(content, file);
  if (terms.length === 0 && !/<!--\s*rule:\s*[A-Z][A-Z0-9-]*\s*-->/u.test(stripFences(content))) return [];
  const defs = new Set(terms.map((t) => t.value));
  const uses = [];
  const scan = stripFences(content);
  for (const match of scan.matchAll(CODE_TOKEN_RE)) {
    const token = match[1];
    if (defs.has(token) || /^(npm|node|gh|dev-loop|dev-loops|final_approval|wait_watch|issue_intake|copilot_pr_followup|autonomy|humanMergeOnly)$/.test(token)) {
      continue;
    }
    if (/^(blocked|done|approval_ready|merge_ready|waiting|waiting_for_[a-z0-9_]+|needs_reconcile|[a-z]+_[a-z0-9_]*_gate)$/.test(token)) {
      uses.push({ token, file, line: lineFor(scan, match.index) });
    }
  }
  return uses;
}

export function detectNearDuplicates(definitions) {
  const seen = new Map();
  const findings = [];
  for (const def of definitions) {
    const normalized = def.body.toLowerCase().replace(/`[^`]+`/g, "").replace(/\b(must|shall|should|may|not)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
    if (!normalized || normalized.length < 24) continue;
    const prior = seen.get(normalized);
    if (prior && prior.id !== def.id) findings.push({ kind: "near_duplicate", a: prior, b: def });
    else seen.set(normalized, def);
  }
  return findings;
}

export function detectModalityConflicts(definitions) {
  // Order-insensitive: group every definition per normalized subject first,
  // then compare all pairs, so file-walk order can never mask a conflict
  // (this scan gates the build).
  const bySubject = new Map();
  for (const def of definitions) {
    const modalities = [...def.body.matchAll(MODAL_RE)].map((m) => m[1]);
    if (modalities.length === 0) continue;
    const subject = def.body
      .replace(MODAL_RE, "")
      .replace(/`[^`]+`/g, "")
      .replace(/[^a-zA-Z0-9]+/g, " ")
      .toLowerCase()
      .trim();
    if (!subject) continue;
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject).push({ def, modalities });
  }
  const findings = [];
  for (const entries of bySubject.values()) {
    for (let i = 0; i < entries.length; i += 1) {
      for (let j = i + 1; j < entries.length; j += 1) {
        const a = entries[i];
        const b = entries[j];
        const aNegative = a.modalities.some((m) => m.endsWith("NOT"));
        const bNegative = b.modalities.some((m) => m.endsWith("NOT"));
        // MUST and SHALL are equivalent strong forms (RFC 2119); either
        // downgrading to SHOULD/MAY (or the negative equivalents) flags.
        const strongPositive = (mods) => mods.some((m) => m === "MUST" || m === "SHALL");
        const strongNegative = (mods) => mods.some((m) => m === "MUST NOT" || m === "SHALL NOT");
        const weakPositive = (mods) => mods.some((m) => m === "SHOULD" || m === "MAY");
        const weakNegative = (mods) => mods.some((m) => m === "SHOULD NOT" || m === "MAY NOT");
        const weaker = (strongPositive(a.modalities) && weakPositive(b.modalities))
          || (strongPositive(b.modalities) && weakPositive(a.modalities))
          || (strongNegative(a.modalities) && weakNegative(b.modalities))
          || (strongNegative(b.modalities) && weakNegative(a.modalities));
        if (aNegative !== bNegative || weaker) findings.push({ kind: "modality_conflict", a: a.def, b: b.def });
      }
    }
  }
  return findings;
}

async function readRequiredRules(repoRoot) {
  const rulesPath = path.join(repoRoot, "skills", "docs", "required-rules.json");
  const text = await readFile(rulesPath, "utf8");
  let parsed;
  try {
    parsed = parseJsonText(text);
  } catch (error) {
    throw new Error(`Malformed JSON in ${rulesPath}`, { cause: error });
  }
  return {
    // Entries may be legacy flat ID strings (default `runtime`) or objects with an
    // `enforcement` classification.
    requiredRules: Array.isArray(parsed.requiredRules) ? parsed.requiredRules.map(normalizeRuleEntry) : [],
    // Explicit opt-out for a defined rule that is intentionally NOT deletion-protected. Empty by default.
    optOutRules: Array.isArray(parsed.optOutRules) ? parsed.optOutRules : [],
  };
}

// A KNOWN_INTENTIONAL_DUPLICATE_SENTENCES entry is "dead" when it no longer suppresses a real
// cross-file duplicate: the sentence would not be flagged even without the allowlist (absent,
// single-file, or only across canonical-mirror docs). A dead entry silently pre-authorizes
// reintroducing that exact duplicate, so it gates.
export function detectDeadAllowlistEntries(fileContents, allowlist = KNOWN_INTENTIONAL_DUPLICATE_SENTENCES) {
  const filesBySentence = new Map();
  for (const { file, content } of fileContents) {
    for (const { text } of extractImperativeSentences(content)) {
      if (!filesBySentence.has(text)) filesBySentence.set(text, new Set());
      filesBySentence.get(text).add(file);
    }
  }
  const dead = [];
  for (const text of allowlist) {
    const files = filesBySentence.get(text);
    const wouldFlag = files && files.size > 1 && ![...files].every((f) => CANONICAL_MIRROR_DOCS.has(f));
    if (!wouldFlag) dead.push(text);
  }
  return dead;
}

export async function validateRuleOwnership(repoRoot = REPO_ROOT) {
  const files = await collectContractMarkdownFiles(repoRoot);
  const definitions = [];
  const references = [];
  const termDefs = [];
  const termUses = [];
  const fileContents = [];

  for (const filePath of files) {
    const rel = toPosix(path.relative(repoRoot, filePath));
    const content = await readFile(filePath, "utf8");
    fileContents.push({ file: rel, content });
    definitions.push(...extractRuleDefinitions(content, rel));
    references.push(...extractRuleReferences(content, rel));
    termDefs.push(...extractTermDefinitions(content, rel));
    termUses.push(...extractTermUses(content, rel));
  }

  const errors = [];
  const byId = new Map();
  for (const def of definitions) {
    if (!byId.has(def.id)) byId.set(def.id, []);
    byId.get(def.id).push(def);
  }
  for (const [id, defs] of byId) {
    if (defs.length !== 1) errors.push({ kind: "duplicate_rule_definition", id, locations: defs.map(({ file, line }) => `${file}:${line}`) });
  }

  const { requiredRules, optOutRules } = await readRequiredRules(repoRoot);
  // Malformed manifest entries are a clean gating error, never a crash or a silently
  // inserted `undefined`, so they are reported and excluded from further processing.
  for (const entry of requiredRules) {
    if (entry.invalid) errors.push({ kind: "invalid_manifest_entry", id: entry.id, location: `required-rules.json: ${entry.reason}` });
  }
  const validRequiredRules = requiredRules.filter((entry) => !entry.invalid);
  const requiredSet = new Set(validRequiredRules.map((entry) => entry.id));
  const optOutSet = new Set(optOutRules);
  for (const id of validRequiredRules.map((entry) => entry.id)) {
    if (!byId.has(id)) errors.push({ kind: "required_rule_missing", id });
  }
  // Enforcement classification validation: classification must be one of
  // doc/runtime/agent, and an `agent` rule must carry a one-line justification so
  // it cannot become a quiet escape hatch from the runtime enforcement ratchet.
  for (const entry of validRequiredRules) {
    if (!ENFORCEMENT_VALUES.has(entry.enforcement)) {
      errors.push({ kind: "invalid_enforcement_classification", id: entry.id, location: `enforcement="${entry.enforcement}"` });
    } else if (entry.enforcement === "agent") {
      const note = entry.enforcementNote;
      if (!(typeof note === "string" && note.trim())) {
        errors.push({ kind: "agent_enforcement_missing_justification", id: entry.id });
      } else if (note.includes("\n")) {
        errors.push({ kind: "agent_enforcement_multiline_justification", id: entry.id, location: "enforcementNote must be one line" });
      }
    }
  }
  // corpus→manifest completeness: every defined rule must be registered in the manifest or explicitly opted out.
  for (const [id, defs] of byId) {
    if (!requiredSet.has(id) && !optOutSet.has(id)) {
      errors.push({ kind: "unregistered_rule", id, location: defs.map(({ file, line }) => `${file}:${line}`).join(", ") });
    }
  }
  // optOutRules manifest hygiene, in file order for deterministic error ordering.
  for (const id of optOutRules) {
    if (requiredSet.has(id)) errors.push({ kind: "conflicting_manifest_entry", id });
    if (!byId.has(id)) errors.push({ kind: "dead_opt_out_entry", id });
  }

  for (const ref of references) {
    if (!byId.has(ref.id)) errors.push({ kind: "unresolved_rule_reference", id: ref.id, location: `${ref.file}:${ref.line}` });
  }

  const termsByKey = new Map();
  for (const term of termDefs) {
    if (!termsByKey.has(term.key)) termsByKey.set(term.key, []);
    termsByKey.get(term.key).push(term);
  }
  for (const [key, defs] of termsByKey) {
    if (defs.length !== 1) errors.push({ kind: "duplicate_term_definition", key, locations: defs.map(({ file, line }) => `${file}:${line}`) });
  }
  const termValues = new Set(termDefs.map((t) => t.value));
  for (const use of termUses) {
    if (!termValues.has(use.token)) errors.push({ kind: "undefined_term_use", token: use.token, location: `${use.file}:${use.line}` });
  }

  for (const finding of detectNearDuplicates(definitions)) {
    errors.push({ kind: finding.kind, id: `${finding.a.id}~${finding.b.id}`, location: `${finding.a.file}:${finding.a.line} / ${finding.b.file}:${finding.b.line}` });
  }
  for (const finding of detectModalityConflicts(definitions)) {
    errors.push({ kind: finding.kind, id: `${finding.a.id}~${finding.b.id}`, location: `${finding.a.file}:${finding.a.line} / ${finding.b.file}:${finding.b.line}` });
  }
  for (const finding of detectDuplicateImperativeSentences(fileContents)) {
    errors.push({ kind: finding.kind, id: finding.text, location: finding.occurrences.map((o) => `${o.file}:${o.line}`).join(", ") });
  }
  for (const text of detectDeadAllowlistEntries(fileContents)) {
    errors.push({ kind: "dead_allowlist_entry", id: text });
  }

  // Runtime-source enforcement cross-check:
  //   - phantom_rule_citation (gating): a registry-ID-shaped token in runtime
  //     source that is neither a real registry ID nor on the NON_RULE_TOKENS
  //     allowlist is a bogus citation — fail the build.
  //   - runtimeEnforced/runtimeUnenforced (reported ratchet): a `runtime`-classed
  //     rule that appears in runtime source counts as enforced; the rest are a
  //     non-increasing ratchet pinned by a test (do not backfill in one sweep).
  const runtimeCitations = await collectRuntimeCitations(repoRoot);
  const unknownById = new Map();
  const citedRuntimeIds = new Set();
  for (const token of runtimeCitations) {
    if (byId.has(token.id)) {
      // Enforcement credit is refusal-path-based (#1617): only a citation in an
      // enforcement error/refusal string marks the rule as enforced, not mere
      // presence in source. Phantom detection below still scans all presence.
      if (requiredSet.has(token.id) && token.refusalPath) citedRuntimeIds.add(token.id);
    } else if (!NON_RULE_TOKENS.has(token.id)) {
      const prev = unknownById.get(token.id);
      unknownById.set(token.id, prev ? { count: prev.count + 1, file: prev.file } : { count: 1, file: token.file });
    }
  }
  for (const [id, { count, file }] of unknownById) {
    errors.push({ kind: "phantom_rule_citation", id, location: `cited ${count}x in runtime source (e.g. ${file})` });
  }
  const runtimeIds = new Set(validRequiredRules.filter((entry) => entry.enforcement === "runtime").map((entry) => entry.id));
  const runtimeEnforced = [...citedRuntimeIds].filter((id) => runtimeIds.has(id)).length;
  const enforcement = {
    runtimeTotal: runtimeIds.size,
    runtimeEnforced,
    runtimeUnenforced: runtimeIds.size - runtimeEnforced,
  };

  return { ok: errors.length === 0, filesScanned: files.length, rules: definitions.length, references: references.length, terms: termDefs.length, errors, enforcement };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const result = await validateRuleOwnership(REPO_ROOT);
  if (result.ok) {
    const e = result.enforcement;
    process.stdout.write(`Rule ownership validation passed: ${result.rules} rules, ${result.references} references, ${result.terms} terms, ${result.filesScanned} files scanned. Runtime rules: ${e.runtimeTotal} total, ${e.runtimeEnforced} enforced, ${e.runtimeUnenforced} unenforced.\n`);
    return 0;
  }
  process.stdout.write(`Rule ownership validation failed:\n`);
  for (const error of result.errors) process.stdout.write(`- ${error.kind}: ${error.id || error.key || error.token} ${error.location || (error.locations || []).join(", ")}\n`);
  return 1;
}

if (isDirectCliRun(import.meta.url)) {
  process.exitCode = await main();
}
