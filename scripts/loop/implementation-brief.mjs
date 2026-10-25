#!/usr/bin/env node
/**
 * implementation-brief — read-only, offline projection of a spec body into the
 * review expectations a worker needs before its first edit.
 *
 * The brief derives every field deterministically from the body plus repository
 * files. It authors no text, creates no gate evidence, and changes no reviewer
 * input: it only copies IDs, paths and already-parsed rows into one JSON object
 * (see the artifact-authority contract for the spec-of-record split).
 *
 * Parsing is shared, never re-implemented: the AC/DoD matrix and section
 * splitting come from the issue-refinement-artifact module, ADR records and
 * their amendment edges from spec-lint's `indexDecisionRecords`, rule ownership
 * from the rule-ownership validator, and the ADR tripwire matchers from
 * check-adr-tripwire. A second parser for any of those surfaces would be
 * authority drift.
 */
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { PR_BODY_SPEC_NARRATIVE_SECTIONS, detectAcDodMatrix, parseMarkdownSections } from "@dev-loops/core/loop/issue-refinement-artifact";
import { extractSection } from "@dev-loops/core/loop/markdown-sections";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import {
  RULE_ID_SHAPE_RE,
  collectContractMarkdownFiles,
  extractRuleDefinitions,
} from "../docs/validate-rule-ownership.mjs";
import { CONTRACT_DOC_RE, DEVLOOPS_CONFIG_PATHS, GATE_CONFIG_PATH } from "./check-adr-tripwire.mjs";
import { citedAdrNumbers, indexDecisionRecords, inForceAmenders, loadKnownRuleIds, stripFencedCode } from "./spec-lint.mjs";

const USAGE = `Usage: dev-loops loop implementation-brief --body-file <path> [--paths <p,...>] [--repo-root <path>]

Print the canonical review expectations of a spec body before the first edit.
Read-only and offline: the brief parses local files and makes no network call.

  --body-file <path>   File that holds the spec body (required)
  --paths <p,...>      Comma-separated repo-relative paths the work will touch
  --repo-root <path>   Repository root to resolve paths against (default: cwd)

Output (stdout, JSON):
  { "ok": true, "matrix": [{ "criterion", "evidence" }] | null, "nonGoals": ["..."],
    "touchedPaths": ["..."], "unresolvedPaths": ["..."], "rules": [{ "id", "doc": "<path>" | null }],
    "adrs": [{ "number", "title": "<text>" | null, "path", "amendedBy": [{ "number", "title", "path" }],
      "supersededBy": { "number", "title", "path" } | null }],
    "adrNeed": "<section text>" | "unstated", "adrTripwirePaths": ["..."],
    "requiredReads": ["skills/docs/structural-quality.md", "changes/README.md"],
    "findings": [{ "kind", "reason" }] }

"touchedPaths", "unresolvedPaths", "adrTripwirePaths", the rule IDs and the ADRs
are sorted and de-duplicated; "nonGoals" keeps body order (duplicates included),
"findings" keeps emission order, and "requiredReads" is the fixed pair above.
"matrix" is null and "findings" carries missing_ac_dod_matrix when the body holds
no usable AC/DoD matrix; the exit code stays 0 because a missing matrix is a spec
finding, not a tool failure.
"touchedPaths" is the --paths set plus every existing repo-relative path the
body cites, so a tripwire-shaped path the spec only mentions is still reported.
"unresolvedPaths" is the declared subset that does not resolve; a declared path
that does not resolve yet is in BOTH lists, because the touch set is the declared
set plus existing body citations and a planned new file has to reach the rule,
ADR and tripwire projection too.
A body citation needs a path-shape signal - an explicit "./" prefix, a slash (one
trailing slash spells a directory) or a file extension - so ordinary prose ("the docs directory") is not claimed, and its
on-disk entry names must match case-exactly, so two checkouts of one tree agree.
"adrTripwirePaths" is the path-based ADR-tripwire candidate set: the touched
paths whose shape matches the tripwire constants (a skills/docs/*-contract.md
doc, packages/core/src/config/extension-defaults.yaml, a .devloops* config
source). The tripwire's content-based triggers - a rule-modality (MUST/SHOULD/MAY)
reversal in a touched skills/docs markdown file, an unresolvable rule or devloops
scan, a standing-authorizations change and commit-msg-guard loosening - are NOT
projected here; the tripwire evaluates those against the diff.
"nonGoals" joins a wrapped continuation line into its item and accepts numbered
list markers. "findings" carries missing_decision_records when the checkout has
no docs/decisions directory and missing_adr_record for a cited ADR with no record.

${JQ_OUTPUT_USAGE}

Exit codes: 0 brief produced (with or without findings); 1 usage error, a missing
--body-file, a --paths entry that is absolute (POSIX, drive-letter or UNC), holds
a ".." segment, carries a file:line[:col] suffix or normalizes to an empty path,
a --repo-root that is not an existing directory, or a --paths entry whose real
target resolves outside --repo-root; 2 malformed skills/docs/required-rules.json,
an unreadable body file, or another runtime error.`;

const REQUIRED_READS = Object.freeze(["skills/docs/structural-quality.md", "changes/README.md"]);
const ADR_NEED_UNSTATED = "unstated";
// Repo-relative path citation, including an ./-prefixed extensionless entry
// (./LICENSE). A token never ends on a dot, so sentence punctuation stays out. Leading
// colon/slash boundaries exclude URL path segments; a trailing colon only
// excludes a URL scheme when followed by a slash, not prose or file:line cites.
// Every candidate still requires existence and containment before it is claimed.
const PATH_CANDIDATE_RE = new RegExp(
  `(?<![\\w./:-])((?:\\.\\/)?(?:[A-Za-z0-9._-]+\\/)*[A-Za-z0-9._-]*[A-Za-z0-9_-]\\/?)(?![\\w/-]|:\\/)`,
  "gu",
);
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/u;
const MARKDOWN_FILE_RE = /\.(?:md|mdx)$/iu;
// The canonical non-goals patterns, plus the spaced "Non goals" form the brief always read.
const NON_GOALS_PATTERNS = [...PR_BODY_SPEC_NARRATIVE_SECTIONS.non_goals.patterns, /^non goals\b/iu];
const BULLET_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/u;
// A `file:line[:col]` citation is not a path; the body reader accepts that form
// for paths it resolves, while a declared path has to name the file itself.
const FILE_LINE_SUFFIX_RE = /:\d+(?::\d+)?$/u;
const RECORD_TITLE_RE = /^#\s+(?:\d{4,}\.\s*)?(.*\S)\s*$/mu;
const DEVLOOPS_CONFIG_PATH_SET = new Set(DEVLOOPS_CONFIG_PATHS);

function isMissing(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "ENAMETOOLONG";
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

/**
 * A `--paths` value must stay inside the repository: an absolute path or a `..`
 * segment can name a file outside `--repo-root`, so it is a usage error rather
 * than an unresolved path.
 */
function normalizeDeclaredPath(raw) {
  const shown = String(raw).trim();
  const value = shown.replace(/\\/gu, "/");
  // Absolute forms are rejected AFTER backslash normalization: a UNC path
  // (\\server\share\x -> //server/share/x) would otherwise be rewritten into a
  // silent repo-relative path instead of the documented usage error.
  if (value.startsWith("/") || /^[A-Za-z]:\//u.test(value)) {
    throw Object.assign(
      new Error(`--paths entry must be a repo-relative path without ".." segments: ${shown}`),
      { exitCode: 1 },
    );
  }
  const segments = value.split("/");
  if (segments.includes("..")) {
    throw Object.assign(
      new Error(`--paths entry must be a repo-relative path without ".." segments: ${shown}`),
      { exitCode: 1 },
    );
  }
  if (FILE_LINE_SUFFIX_RE.test(value)) {
    throw Object.assign(
      new Error(`--paths entry must be a repo-relative path without ".." segments or a file:line citation: ${shown}`),
      { exitCode: 1 },
    );
  }
  const normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  // A path that normalizes to nothing names no file, so it is a usage error
  // rather than a silently dropped input the caller never sees again.
  if (normalized === "") {
    throw Object.assign(
      new Error(`--paths entry must be a repo-relative path that names a path inside the repository: ${shown}`),
      { exitCode: 1 },
    );
  }
  return normalized;
}

/** A file extension is one of the three path-shape signals, next to a slash and
 * an explicit `./` prefix. */
const EXTENSION_RE = /\.[A-Za-z0-9]+$/u;

/** Path citations in the body. A bare extensionless token is ordinary prose
 * ("docs", "test", "suite") far more often than it is a path, so a token needs
 * a path-shape signal before it is even a candidate; it is then claimed only when
 * it resolves under `--repo-root` with exactly those on-disk entry names. */
function citedPathCandidates(body) {
  const candidates = new Set();
  for (const [raw] of body.matchAll(PATH_CANDIDATE_RE)) {
    const explicit = raw.startsWith("./");
    // One trailing "/" spells a directory citation the way `--paths` accepts it;
    // it is a path-shape signal and is stripped before resolution.
    const token = (explicit ? raw.slice(2) : raw).replace(/\/$/u, "");
    if (token === "" || token.includes(":")) continue;
    if (!explicit && !raw.includes("/") && !EXTENSION_RE.test(token)) continue;
    if (!token.split("/").every((segment) => PATH_SEGMENT_RE.test(segment) && segment !== "." && segment !== "..")) continue;
    candidates.add(token);
  }
  return [...candidates];
}

/**
 * Resolve one repo-relative path, and report whether its real target is still
 * inside the repository: a symlinked path can pass the syntactic check and
 * still point outside `--repo-root`, so containment is decided on the resolved
 * target, not on the string.
 */
async function pathKind(repoRoot, rootReal, relPath) {
  const target = path.join(repoRoot, ...relPath.split("/"));
  const info = await stat(target).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!info) return null;
  const real = await realpath(target).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (real === null) return null;
  const inside = real === rootReal || real.startsWith(rootReal + path.sep);
  return { kind: info.isDirectory() ? "directory" : "file", inside };
}

/**
 * Whether every segment of `relPath` matches its on-disk entry name exactly.
 * `stat` resolves case-insensitively on a case-insensitive volume, so without
 * this check the host filesystem decides which body tokens enter `touchedPaths`
 * and the same body and tree stop producing byte-identical output across a macOS
 * and a Linux checkout root.
 */
async function entryNamesMatch(repoRoot, relPath) {
  let dir = repoRoot;
  for (const segment of relPath.split("/")) {
    const names = await readdir(dir).catch((error) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!names || !names.includes(segment)) return false;
    dir = path.join(dir, segment);
  }
  return true;
}

async function readTextOrNull(file) {
  return readFile(file, "utf8").catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
}

/** The owning doc of a rule is the file that carries its `<!-- rule: ID -->` marker. */
async function ruleOwnerIndex(repoRoot) {
  const owners = new Map();
  for (const file of await collectContractMarkdownFiles(repoRoot)) {
    const rel = path.relative(repoRoot, file).split(path.sep).join("/");
    const content = await readTextOrNull(file);
    if (content == null) continue;
    for (const definition of extractRuleDefinitions(content, rel)) {
      if (!owners.has(definition.id)) owners.set(definition.id, rel);
    }
  }
  return owners;
}

function nonGoalsFromBody(body) {
  // Same precedence as findSectionByPatterns: the exact pattern first, then the first alias match.
  const sections = parseMarkdownSections(body);
  const section = sections.find((entry) => NON_GOALS_PATTERNS[0].test(entry.name))
    ?? sections.find((entry) => NON_GOALS_PATTERNS.slice(1).some((re) => re.test(entry.name)));
  if (!section) return [];
  const items = [];
  // Markdown lazy continuation: the line right under a bullet, with no blank
  // line between them, still belongs to that item's paragraph. A blank line
  // ends the paragraph, so a following unindented line is standalone prose and
  // must not be absorbed into the last non-goal.
  let insideItemParagraph = false;
  for (const line of stripFencedCode(section.bodyLines.join("\n")).split("\n")) {
    if (line.trim() === "") {
      insideItemParagraph = false;
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      items.push(bullet[1]);
      insideItemParagraph = true;
      continue;
    }
    if (items.length === 0 || !(insideItemParagraph || /^\s+\S/u.test(line))) continue;
    items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

const matchesAdrTripwire = (relPath) =>
  CONTRACT_DOC_RE.test(relPath) || relPath === GATE_CONFIG_PATH || DEVLOOPS_CONFIG_PATH_SET.has(relPath);

const PATH_TOKEN_ESCAPE_RE = /[.*+?^${}()|[\]\\]/gu;

/**
 * Whether a record's text NAMES a touched path as a path token. An unbounded
 * `text.includes(relPath)` also claims a record that merely mentions a longer
 * path (`src/a.mjs.bak` for a touched `src/a.mjs`), so both edges are bounded,
 * and a directory only counts when the text spells it with its trailing slash.
 */
function namesTouchedPath(text, relPath, kind) {
  const token = kind === "directory" ? `${relPath}/` : relPath;
  const escaped = token.replace(PATH_TOKEN_ESCAPE_RE, "\\$&");
  if (new RegExp(`(?<![\\w/.-])${escaped}(?![\\w/-])(?!\\.[\\w/-])`, "u").test(text)) return true;

  // Markdown destinations name files relative to the ADR (docs/decisions), not
  // the repository root. Resolve them rather than loosening the token boundary:
  // ../src/a.mjs and ../../src/a.mjs.bak must not claim src/a.mjs.
  for (const [, angled, plain] of text.matchAll(/\]\(\s*(?:<([^<>\n]+)>|([^\s)]+))(?:\s+["'][^"'\n]*["'])?\s*\)/gu)) {
    const destination = (angled ?? plain).split(/[?#]/u)[0];
    if (!destination || /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/)/u.test(destination)) continue;
    if (kind === "directory" && !destination.endsWith("/")) continue;
    const normalized = path.posix.normalize(path.posix.join("docs/decisions", destination));
    if (normalized.replace(/\/$/u, "") === relPath) return true;
  }
  return false;
}

/**
 * Build the brief for one spec body. All inputs are files: `paths` is the
 * declared touch set (`--paths`), `repoRoot` is the only checkout reference, so
 * two checkouts of the same tree produce byte-identical output.
 */
export async function buildImplementationBrief({ body = "", repoRoot = process.cwd(), paths = [] } = {}) {
  const root = path.resolve(repoRoot);
  const rootInfo = await stat(root).catch((error) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (!rootInfo?.isDirectory()) {
    throw Object.assign(new Error(`--repo-root ${root} is not an existing directory`), { exitCode: 1 });
  }

  const declared = [];
  for (const raw of paths) {
    declared.push(normalizeDeclaredPath(raw));
  }

  const rootReal = await realpath(root);

  // Declared paths are validated: a declared path that does not resolve is
  // reported so the caller can correct the touch set, and one whose real target
  // leaves the repository is a usage error. A body citation is only claimed
  // when it resolves inside the root, so prose that looks path-shaped stays out
  // of both lists instead of becoming noise.
  const resolved = new Map();
  const unresolved = [];
  for (const candidate of declared) {
    if (resolved.has(candidate)) continue;
    const found = await pathKind(root, rootReal, candidate);
    if (!found) unresolved.push(candidate);
    else if (!(await entryNamesMatch(root, candidate))) {
      // A wrong-case path resolves on a case-insensitive volume only; report it
      // as unresolved before containment so every host emits the same bytes and
      // exit code.
      unresolved.push(candidate);
    } else if (!found.inside) {
      throw Object.assign(new Error(`--paths entry resolves outside --repo-root: ${candidate}`), { exitCode: 1 });
    } else resolved.set(candidate, found.kind);
  }
  for (const candidate of citedPathCandidates(body)) {
    if (resolved.has(candidate) || unresolved.includes(candidate)) continue;
    const found = await pathKind(root, rootReal, candidate);
    if (!found?.inside) continue;
    if (!(await entryNamesMatch(root, candidate))) continue;
    resolved.set(candidate, found.kind);
  }
  // A declared path is a touched path whether or not it exists yet: the spec's
  // touch set is `--paths` plus existing body citations, so a planned new file
  // must still reach the rule/ADR/tripwire projection. `unresolvedPaths` stays
  // the additional not-found marker.
  const touchedPaths = sortedUnique([...declared, ...resolved.keys()]);

  // A missing matrix is a spec finding, not a tool failure: the exit code stays 0.
  const detection = detectAcDodMatrix(body);
  const matrix = detection.valid ? detection.rows : null;
  const findings = detection.valid ? [] : [{ kind: "missing_ac_dod_matrix", reason: detection.reason }];

  // Registered rule IDs the work will meet: cited by the spec, or defined/cited
  // in a touched file. Registry ownership stays with required-rules.json.
  const registry = await loadKnownRuleIds(root);
  // Root-independent reason: the brief's output must not carry a checkout path.
  if (registry.skipped) findings.push({ kind: "missing_rule_registry", reason: "no skills/docs/required-rules.json under --repo-root" });
  const citedRuleIds = new Set();
  if (!registry.skipped) {
    // The brief and `loop spec-lint` must agree on what counts as a citation:
    // both read prose through the SAME fence-stripping helper, so an ID that
    // only appears inside a fenced example is not reported as cited.
    for (const [token] of stripFencedCode(body).matchAll(RULE_ID_SHAPE_RE)) {
      if (registry.ids.has(token)) citedRuleIds.add(token);
    }
    for (const [relPath, kind] of resolved) {
      // The registry lists every registered ID; counting it as a citing file would bury the relevant ones.
      if (kind !== "file" || relPath === "skills/docs/required-rules.json") continue;
      const content = await readTextOrNull(path.join(root, ...relPath.split("/")));
      if (content == null) continue;
      for (const definition of extractRuleDefinitions(content, relPath)) {
        if (registry.ids.has(definition.id)) citedRuleIds.add(definition.id);
      }
      const prose = MARKDOWN_FILE_RE.test(relPath) ? stripFencedCode(content) : content;
      for (const [token] of prose.matchAll(RULE_ID_SHAPE_RE)) {
        if (registry.ids.has(token)) citedRuleIds.add(token);
      }
    }
  }
  const ruleOwners = citedRuleIds.size > 0 ? await ruleOwnerIndex(root) : new Map();
  const rules = [...citedRuleIds]
    .sort()
    .map((id) => ({ id, doc: ruleOwners.get(id) ?? null }));

  // ADR surface: cited records plus accepted records whose text names a touched path.
  const records = await indexDecisionRecords(path.join(root, "docs", "decisions"));
  const adrNumbers = new Set(citedAdrNumbers(body));
  if (records) {
    for (const record of records.values()) {
      if (record.state !== "accepted") continue;
      const text = await readTextOrNull(path.join(root, "docs", "decisions", record.file));
      if (text == null) continue;
      if (touchedPaths.some((relPath) => namesTouchedPath(text, relPath, resolved.get(relPath) ?? null))) adrNumbers.add(record.id);
    }
  } else {
    // No record index resolves no citation at all, so the empty ADR list is
    // reported instead of looking like a spec that cites no decision.
    findings.push({ kind: "missing_decision_records", reason: "no docs/decisions directory under --repo-root" });
  }
  const titles = new Map();
  const recordRef = async (id) => {
    const record = records?.get(id);
    if (!record) return null;
    if (!titles.has(id)) {
      const text = await readTextOrNull(path.join(root, "docs", "decisions", record.file));
      titles.set(id, text == null ? null : (RECORD_TITLE_RE.exec(text)?.[1] ?? null));
    }
    return { number: id, title: titles.get(id), path: `docs/decisions/${record.file}` };
  };
  const byNumber = (a, b) => Number(a) - Number(b);
  const adrs = [];
  for (const id of [...adrNumbers].sort(byNumber)) {
    const record = records?.get(id);
    const ref = await recordRef(id);
    if (!ref) {
      // A cited ADR with no record would otherwise vanish with exit 0: the
      // developer sees no decision context and no sign that the citation failed
      // to resolve, which `loop spec-lint` reports as unknown_adr.
      if (records) findings.push({ kind: "missing_adr_record", reason: `no docs/decisions/${id}-*.md record for cited ADR ${id}` });
      continue;
    }
    const amendedBy = [];
    for (const amender of inForceAmenders(id, record, records).sort(byNumber)) {
      const amendment = await recordRef(amender);
      if (amendment) amendedBy.push(amendment);
    }
    adrs.push({ ...ref, amendedBy, supersededBy: record.supersededBy ? await recordRef(record.supersededBy) : null });
  }

  const adrNeed = extractSection(stripFencedCode(body), "ADR need") ?? "";

  return {
    ok: true,
    matrix,
    nonGoals: nonGoalsFromBody(body),
    touchedPaths,
    unresolvedPaths: sortedUnique(unresolved),
    rules,
    adrs,
    adrNeed: adrNeed === "" ? ADR_NEED_UNSTATED : adrNeed,
    adrTripwirePaths: touchedPaths.filter(matchesAdrTripwire),
    requiredReads: [...REQUIRED_READS],
    findings,
  };
}

export function parseImplementationBriefArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        help: { type: "boolean", short: "h" },
        "body-file": { type: "string" },
        paths: { type: "string" },
        "repo-root": { type: "string" },
        ...JQ_OUTPUT_PARSE_OPTIONS,
      },
      strict: true,
    }));
  } catch (error) {
    throw Object.assign(new Error(error.message), { usage: USAGE, exitCode: 1 });
  }
  if (values.help) return { help: true };
  if (!values["body-file"]) throw Object.assign(new Error("Missing required --body-file <path>"), { usage: USAGE, exitCode: 1 });
  if (values["repo-root"] !== undefined && !values["repo-root"].trim()) throw Object.assign(new Error("--repo-root must not be empty"), { usage: USAGE, exitCode: 1 });
  return {
    help: false,
    bodyFile: values["body-file"],
    paths: values.paths === undefined ? [] : values.paths.split(","),
    repoRoot: values["repo-root"] ?? process.cwd(),
    jq: values.jq,
    silent: values.silent,
    fields: values.fields,
  };
}

export async function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const options = parseImplementationBriefArgs(argv);
    if (options.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    const body = await readFile(options.bodyFile, "utf8");
    const brief = await buildImplementationBrief({ body, repoRoot: options.repoRoot, paths: options.paths });
    return emitResult(brief, {
      jq: options.jq,
      silent: options.silent,
      fields: options.fields,
      stdout,
      stderr,
    });
  } catch (error) {
    stderr.write(`${formatCliError(error, { usage: error.exitCode === 1 ? USAGE : undefined })}\n`);
    return error.exitCode ?? 2;
  }
}

if (isDirectCliRun(import.meta.url)) {
  process.exitCode = await main();
}
