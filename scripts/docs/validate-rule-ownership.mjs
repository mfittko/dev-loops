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
const MODAL_RE = /\b(MUST NOT|SHALL NOT|MUST|SHALL|SHOULD|MAY)\b/g;

// Duplicate-imperative-sentence scan (ported from validate-no-duplicate-rules.mjs).
const IMPERATIVE_PATTERNS = [/\bmust\b/i, /\bnever\b/i, /\bdo not\b/i, /\brequire[sd]?\b/i];
const MIN_SENTENCE_LENGTH = 20;

// Contract docs that mirror each other's content by design.
const CANONICAL_MIRROR_DOCS = new Set(["skills/docs/copilot-loop-operations.md", "skills/docs/public-dev-loop-contract.md"]);

// Sentences deliberately duplicated across files (mirrored procedure text, or
// command trigger-phrasing that STYLE/(c) guardrails require to stay verbatim
// per file). Cross-file duplication of these is not a corpus authoring bug.
const KNOWN_INTENTIONAL_DUPLICATE_SENTENCES = new Set([
  "- **PERSISTENCE RULE: Do not exit your session until the PR is merged or you hit a hard stop that requires conductor authorization.**",
  "If any required bundled contract doc is missing from the installed skill layout, treat that as a packaging/installer bug.",
  "Each reviewer starts in fresh context with the briefing artifact, inspects the diff, returns findings via output artifacts only, and never edits files.",
  "3. **Consolidation:** reconcile all review outputs into a consolidated fix plan with classified findings (must-fix, worth-fixing-now, defer).",
  "5. **Fix cycle:** apply only accepted must-fix changes on the same branch.",
  "- remains a stop/fix state, never a wait loop",
  "Do not create a fresh PR directly in ready-for-review state unless the user explicitly overrides that policy for the current PR scope.",
  "Each reviewer starts in fresh context (subagent({context:\"fresh\"}) mandatory), inspects the diff, returns findings via output artifacts only, and never edits files. **Before starting:** run to self-verify fresh context; refuse to proceed on contamination.",
  "If includes , then worth-fixing-now findings must be fixed before the gate can reach .",
  // agents/dev-loop.agent.md mirrors this CLI-fallback safety line from skills/dev-loop/SKILL.md;
  // each doc's surrounding candidate-resolution list differs per install layout.
  "NEVER fall back to or any unbounded filesystem walk to locate the CLI — it stalls and trips the needs-attention timeout.",
  // commands/loop-auto.command.md and commands/loop-start.command.md — command trigger
  // phrasing is load-bearing verbatim per-command guardrail (c); not a restatement bug.
  "Do not pick an internal strategy name yourself.",
  // docs/slides-story-review-loop.md and docs/ui-designer-review-loop.md are sibling
  // non-normative review-loop docs (epic non-goal) that share boilerplate by design.
  "The loop requires all of the following inputs before it may run:",
  "If any required part of this bundle is missing, incomplete, or ambiguous, the loop fails closed instead of guessing.",
  "- required acceptance criteria are missing",
]);

const USAGE = `Usage: validate-rule-ownership.mjs [--help]

Validate rule markers, required IDs, rule references, term definitions,
near-duplicate/modality-conflict findings, and duplicated imperative
sentences. All findings are gating (exit 1).

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
  const bySubject = new Map();
  const findings = [];
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
    const prior = bySubject.get(subject);
    if (prior) {
      const priorNegative = prior.modalities.some((m) => m.endsWith("NOT"));
      const currentNegative = modalities.some((m) => m.endsWith("NOT"));
      const weaker = prior.modalities.includes("MUST") && modalities.some((m) => m === "SHOULD" || m === "MAY");
      if (priorNegative !== currentNegative || weaker) findings.push({ kind: "modality_conflict", a: prior.def, b: def });
    } else {
      bySubject.set(subject, { def, modalities });
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
  return Array.isArray(parsed.requiredRules) ? parsed.requiredRules : [];
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

  const requiredRules = await readRequiredRules(repoRoot);
  for (const id of requiredRules) {
    if (!byId.has(id)) errors.push({ kind: "required_rule_missing", id });
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

  return { ok: errors.length === 0, filesScanned: files.length, rules: definitions.length, references: references.length, terms: termDefs.length, errors };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const result = await validateRuleOwnership(REPO_ROOT);
  if (result.ok) {
    process.stdout.write(`Rule ownership validation passed: ${result.rules} rules, ${result.references} references, ${result.terms} terms, ${result.filesScanned} files scanned.\n`);
    return 0;
  }
  process.stdout.write(`Rule ownership validation failed:\n`);
  for (const error of result.errors) process.stdout.write(`- ${error.kind}: ${error.id || error.key || error.token} ${error.location || (error.locations || []).join(", ")}\n`);
  return 1;
}

if (isDirectCliRun(import.meta.url)) {
  process.exitCode = await main();
}
