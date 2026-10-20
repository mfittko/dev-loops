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
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { detectAcDodMatrix, parseMarkdownSections } from "@dev-loops/core/loop/issue-refinement-artifact";
import { extractSection } from "@dev-loops/core/loop/markdown-sections";
import { formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import {
  RULE_ID_SHAPE_RE,
  collectContractMarkdownFiles,
  extractRuleDefinitions,
} from "../docs/validate-rule-ownership.mjs";
import { CONTRACT_DOC_RE, DEVLOOPS_CONFIG_PATHS, GATE_CONFIG_PATH } from "./check-adr-tripwire.mjs";
import { citedAdrNumbers, indexDecisionRecords, loadKnownRuleIds, stripFencedCode } from "./spec-lint.mjs";

const USAGE = `Usage: dev-loops loop implementation-brief --body-file <path> [--paths <p,...>] [--repo-root <path>]

Print the canonical review expectations of a spec body before the first edit.
Read-only and offline: the brief parses local files and makes no network call.

  --body-file <path>   File that holds the spec body (required)
  --paths <p,...>      Comma-separated repo-relative paths the work will touch
  --repo-root <path>   Repository root to resolve paths against (default: cwd)

Output (stdout, JSON):
  { "ok": true, "matrix": [{ "criterion", "evidence" }] | null, "nonGoals": ["..."],
    "touchedPaths": ["..."], "unresolvedPaths": ["..."], "rules": [{ "id", "doc" }],
    "adrs": [{ "number", "title", "path", "amendedBy": [...], "supersededBy" }],
    "adrNeed": "<section text>" | "unstated", "adrTripwirePaths": ["..."],
    "requiredReads": ["skills/docs/structural-quality.md", "changes/README.md"],
    "findings": [{ "kind", "reason" }] }

"touchedPaths", "unresolvedPaths", "adrTripwirePaths", the rule IDs and the ADRs
are sorted and de-duplicated; "nonGoals" keeps body order (duplicates included),
"findings" keeps emission order, and "requiredReads" is the fixed pair above.
"matrix" is null and "findings" carries missing_ac_dod_matrix when the body holds
no usable AC/DoD matrix; the exit code stays 0 because a missing matrix is a spec
finding, not a tool failure.
"adrTripwirePaths" are the touched paths the ADR tripwire would treat as
decision-shaped.

${JQ_OUTPUT_USAGE}

Exit codes: 0 brief produced (with or without findings); 1 usage error, a missing
--body-file, a --paths entry that is absolute (POSIX, drive-letter or UNC) or
holds a ".." segment, a --repo-root that is not an existing directory, or a
--paths entry whose real target resolves outside --repo-root; 2 malformed
skills/docs/required-rules.json, an unreadable body file, or another runtime
error.`;

const REQUIRED_READS = Object.freeze(["skills/docs/structural-quality.md", "changes/README.md"]);
const ADR_NEED_UNSTATED = "unstated";
// Repo-relative path citation, including extensionless root entries (LICENSE).
// A token never ends on a dot, so sentence punctuation stays out. Colon/slash
// boundaries exclude URL schemes and their path segments. Every candidate still
// requires existence and containment before it is claimed.
const PATH_CANDIDATE_RE = new RegExp(
  `(?<![\\w./:-])((?:\\.\\/)?(?:[A-Za-z0-9._-]+\\/)*[A-Za-z0-9._-]*[A-Za-z0-9_-])(?![\\w/:-])`,
  "gu",
);
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/u;
const MARKDOWN_FILE_RE = /\.(?:md|mdx)$/iu;
const NON_GOALS_HEADING_RE = /^non-?\s?goals?$/iu;
const BULLET_RE = /^\s*[-*+]\s+(.*\S)\s*$/u;
const RECORD_TITLE_RE = /^#\s+(?:\d{4,}\.\s*)?(.*\S)\s*$/mu;
const DEVLOOPS_CONFIG_PATH_SET = new Set(DEVLOOPS_CONFIG_PATHS);

function isMissing(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
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
  if (shown === "") return null;
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
  const normalized = segments.filter((segment) => segment !== "" && segment !== ".").join("/");
  return normalized === "" ? null : normalized;
}

/** Path citations in the body: a token is claimed only when it is a plausible
 * repo-relative path and it actually resolves under `--repo-root`. */
function citedPathCandidates(body) {
  return [...body.matchAll(PATH_CANDIDATE_RE)]
    .map(([raw]) => raw.replace(/^\.\//u, ""))
    .filter((token) => !token.includes(":"))
    .filter((token) => token.split("/").every((segment) => PATH_SEGMENT_RE.test(segment) && segment !== "." && segment !== ".."));
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
  const section = parseMarkdownSections(body).find((entry) => NON_GOALS_HEADING_RE.test(entry.name));
  if (!section) return [];
  return section.bodyLines.map((line) => BULLET_RE.exec(line)?.[1]).filter((item) => typeof item === "string");
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
    const normalized = normalizeDeclaredPath(raw);
    if (normalized !== null) declared.push(normalized);
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
    else if (!found.inside) {
      throw Object.assign(new Error(`--paths entry resolves outside --repo-root: ${candidate}`), { exitCode: 1 });
    } else resolved.set(candidate, found.kind);
  }
  for (const candidate of citedPathCandidates(body)) {
    if (resolved.has(candidate) || unresolved.includes(candidate)) continue;
    const found = await pathKind(root, rootReal, candidate);
    if (found?.inside) resolved.set(candidate, found.kind);
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
      if (kind !== "file") continue;
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
    if (!ref) continue;
    const amendedBy = [];
    for (const amender of [...record.amendedBy].sort(byNumber)) {
      const amendment = await recordRef(amender);
      if (amendment) amendedBy.push(amendment);
    }
    adrs.push({ ...ref, amendedBy, supersededBy: record.supersededBy ? await recordRef(record.supersededBy) : null });
  }

  const adrNeed = extractSection(body, "ADR need") ?? "";

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
