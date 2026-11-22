#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadDevLoopConfigStrict } from "@dev-loops/core/config";
import { parsePositiveInteger } from "@dev-loops/core/cli/primitives";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { isBaseOnlyMergeSince, runGitCommand } from "../lib/git-delta.mjs";
import { ROUND_CAUSES, deriveRoundCause, findSameHeadRerun } from "../github/_round-cause.mjs";
import { GATE_NAMES } from "../github/_gate-names.mjs";
import { buildLogPath } from "../github/_gate-artifact-paths.mjs";
import { readClosedPriorRoundLogs } from "../github/write-gate-context.mjs";
import { resolveGateArtifactTmpRoot, resolveRepoRoot } from "./_repo-root-resolver.mjs";

const USAGE = `Usage:
  dev-loops loop round-causes --repo <owner/name> --merged-prs <path> [--issues <path>] [--last <n>] [--gate <name>] [--base <branch>] [--tmp-root <path>]
Read-only report of gate rounds per merged change, split by roundCause, from the local
findings logs. Prints JSON. It makes no gh call: the export files come from
  gh pr list --state merged --json number,mergedAt --limit <m>
  gh issue list --state all --json number,createdAt --limit <m>
Use an export limit <m> well above --last (for example 200): gh orders by creation time, and the
report selects the window by mergedAt, so an old PR merged today needs a limit that reaches it.
Required:
  --repo <owner/name>   Repository whose findings logs are read
  --merged-prs <path>   JSON array of { number, mergedAt }
Optional:
  --issues <path>       JSON array of { number, createdAt }; adds issues filed per merge
  --last <n>            Window: the n most recent merges by mergedAt, ties broken by PR number, higher first (default 20)
  --gate <name>         Gate to count (default draft_gate)
  --base <branch>       Base for the legacy base-merge probe (default main); must resolve as origin/<branch> when a probe runs
  --tmp-root <path>     Findings-log root (default: <main checkout>/tmp); it must hold gate-findings/<owner-name>
  --help, -h            Show this help

Window and issues: the n selected merges span n merge intervals. Issues filed after the merge before
the oldest selected merge (exclusive) up to the newest selected merge (inclusive) count, so
issues.perMerge divides by n. With no preceding merge in the export, the window starts at the oldest
selected merge (inclusive).

Causes: byCause splits rounds by roundCause (${ROUND_CAUSES.join(", ")}). A ledger written before the
stamp is derived in memory (derivedRounds). A derived round counts as undetermined, outside the causes,
when git cannot answer (a missing commit object) or its head is contained in the current origin/<base>
(the base then holds the landed PR, so a base-only probe misreads it). A derived round reads the blocked ledgers
and retirement records of its head that lie between the previous round and itself (system_rerun and body_only); records that are missing
(for example a retirement under a removed checkout) can undercount system_rerun and body_only. An unreadable retirement record is skipped,
and warnings names it. unreadableLedgers counts ledgers the findings reader dropped (invalid JSON or an invalid verdict).
outOfBandLedgers counts ledgers whose seal does not match; the report excludes them and never trusts their content.

Checklist split (checklist): the first completed draft_gate round of each change (the earliest one stamped
first, else the earliest by loggedAt), whatever --gate says, counts each finding as covered when its angle
has a developer-checklist id in the gates.draft.angles config resolved from the repository root (an invalid
config exits 1 with config_load_failed), and as uncovered otherwise. Changes group before and after
2026-11-21T17:03Z (the checklist merge) by the loggedAt of that round. A change without such a round has round1 null.

${JQ_OUTPUT_USAGE}

Exit codes:
  0  Success
  1  Argument error or runtime failure (for example a missing findings-log root or an unresolved base)
  2  Invalid output filter (--jq or --fields)`.trim();

const parseError = buildParseError(USAGE);
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const GATE_SENTINEL_HEAD = "0".repeat(40);
const CHECKLIST_CUTOFF = "2026-11-21T17:03:00Z";
const UNDETERMINED = "undetermined";
const round2 = (n) => Math.round(n * 100) / 100;
const emptyCauses = () => Object.fromEntries(ROUND_CAUSES.map((c) => [c, 0]));
const emptySplit = () => ({ changes: 0, covered: 0, uncovered: 0 });

async function readExport(file, dateField) {
  let data;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw parseError(`cannot read ${file} as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(data)) throw parseError(`${file} must hold a JSON array`);
  for (const entry of data) {
    if (!Number.isInteger(entry?.number) || entry.number <= 0 || typeof entry?.[dateField] !== "string" || !ISO_8601.test(entry[dateField]) || !Number.isFinite(Date.parse(entry[dateField]))) {
      throw parseError(`${file} has an entry without a positive integer number and an ISO ${dateField}`);
    }
  }
  // Keep the first entry per number so a repeated export row counts once.
  return data.filter((entry, i) => data.findIndex((e) => e.number === entry.number) === i);
}

// A ledger written before the stamp has no roundCause: derive it in memory against the previous round of the same PR.
// A round whose git answer is unknowable (a missing object) or whose head the current base already contains is undetermined, never a cause.
// Before the git probe, a head move or a first round reads the blocked ledgers and retirement records of its head that lie between the previous round and itself (system_rerun, body_only).
async function roundCauses(rounds, { base, repoRoot, ensureBase, repo, pr, gate, tmpRoot, warn }) {
  const causes = [];
  let derived = 0;
  const resolves = async (rev) => (await runGitCommand(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { repoRoot })).code === 0;
  for (const [i, log] of rounds.entries()) {
    if (ROUND_CAUSES.includes(log.roundCause)) { causes.push(log.roundCause); continue; }
    derived += 1;
    const prior = rounds[i - 1];
    let baseOnly = false;
    const headMove = !prior || String(prior.headSha).toLowerCase() !== String(log.headSha).toLowerCase();
    if (headMove) {
      const untilMs = Date.parse(log.loggedAt);
      const sameHeadRerun = await findSameHeadRerun({ repoRoot, repo, pr, gate, headSha: log.headSha, tmpRoot, sinceMs: Date.parse(prior?.loggedAt) || 0, untilMs: Number.isFinite(untilMs) ? untilMs : Infinity, warn });
      if (sameHeadRerun) { causes.push(sameHeadRerun); continue; }
    }
    if (prior && headMove) {
      await ensureBase();
      const mainRef = `origin/${base}`;
      let answerable = (await resolves(prior.headSha)) && (await resolves(log.headSha));
      // A head the current base contains means the PR landed: the probe would exclude every PR commit.
      if (answerable && (await runGitCommand(["merge-base", "--is-ancestor", log.headSha, mainRef], { repoRoot })).code === 0) answerable = false;
      if (!answerable) { causes.push(UNDETERMINED); continue; }
      try {
        baseOnly = (await isBaseOnlyMergeSince({ fromHead: prior.headSha, head: log.headSha, mainRef, repoRoot })) === true;
      } catch {
        causes.push(UNDETERMINED);
        continue;
      }
    }
    causes.push(deriveRoundCause({ prior, headSha: log.headSha, prBodySha256: log.prBodySha256, baseOnly }));
  }
  return { causes, derived };
}

export async function buildReport(values, { repoRoot = process.cwd() } = {}) {
  const gate = values.gate ?? "draft_gate";
  if (!GATE_NAMES.includes(gate)) throw parseError(`--gate must be one of ${GATE_NAMES.join(", ")}`);
  if (values.base !== undefined && !values.base.trim()) throw parseError("--base must not be blank");
  const base = values.base?.trim() ?? "main";
  const last = values.last === undefined ? 20 : parsePositiveInteger(values.last, "--last", parseError);
  const sorted = (await readExport(values["merged-prs"], "mergedAt")).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt) || b.number - a.number);
  const merged = sorted.slice(0, last);
  const preceding = sorted[last] ?? null;
  const issues = values.issues === undefined ? null : await readExport(values.issues, "createdAt");

  if (values["tmp-root"] !== undefined && !values["tmp-root"].trim()) throw parseError("--tmp-root must not be blank");
  const tmpRoot = values["tmp-root"] ?? resolveGateArtifactTmpRoot(repoRoot);
  const findingsRoot = path.resolve(repoRoot, path.dirname(path.dirname(buildLogPath({ repo: values.repo, pr: 1, gate, headSha: GATE_SENTINEL_HEAD, tmpRoot }))));
  if (!(await stat(findingsRoot).then((s) => s.isDirectory(), () => false))) {
    throw new Error(`findings-log root ${findingsRoot} does not exist: pass --tmp-root, or run from the repository checkout`);
  }
  let baseChecked = false;
  const ensureBase = async () => {
    if (baseChecked) return;
    if ((await runGitCommand(["rev-parse", "--verify", "--quiet", `origin/${base}^{commit}`], { repoRoot })).code !== 0) {
      throw new Error(`origin/${base} does not resolve in ${repoRoot}: fetch it or pass --base`);
    }
    baseChecked = true;
  };
  const checklistAngles = new Set(((await loadDevLoopConfigStrict({ repoRoot: resolveRepoRoot(repoRoot) })).config.gates?.draft?.angles ?? []).filter((e) => e["developer-checklist"]?.length).map((e) => e.name));
  const cutoff = Date.parse(CHECKLIST_CUTOFF);

  const totalsByCause = emptyCauses();
  const checklist = { before: emptySplit(), after: emptySplit() };
  let totalRounds = 0;
  let totalDerived = 0;
  let totalUndetermined = 0;
  let totalUnreadable = 0;
  let totalOutOfBand = 0;
  const warnings = new Set();
  const perChange = [];
  for (const { number, mergedAt } of merged) {
    let unreadable = 0;
    let outOfBand = 0;
    // A ledger with a seal mismatch is excluded and counted, never trusted: one damaged ledger must not remove the report of every change.
    const read = (g) => readClosedPriorRoundLogs({ repo: values.repo, pr: number, gate: g, headSha: GATE_SENTINEL_HEAD, tmpRoot }, { repoRoot, includeRetainedCurrentHead: true, includeLiveCurrentHead: true, onUnreadable: () => { unreadable += 1; }, onOutOfBand: () => { outOfBand += 1; } });
    // A sentinel head matches no ledger, so every ledger of the PR is read as a prior round.
    const logs = await read(gate);
    const { causes, derived } = await roundCauses(logs, { base, repoRoot, ensureBase, repo: values.repo, pr: number, gate, tmpRoot, warn: (m) => warnings.add(m) });
    const byCause = emptyCauses();
    let undetermined = 0;
    for (const c of causes) {
      if (c === UNDETERMINED) { undetermined += 1; continue; }
      byCause[c] += 1;
      totalsByCause[c] += 1;
    }
    // A repeated judged write keeps its first stamp but gets a new loggedAt, so the earliest round stamped first is round 1; an unstamped ledger falls back to the earliest by loggedAt.
    const draftLogs = gate === "draft_gate" ? logs : await read("draft_gate");
    const first = draftLogs.find((l) => l.roundCause === "first") ?? draftLogs[0];
    let round1 = null;
    if (first) {
      const findings = Array.isArray(first.findings) ? first.findings : [];
      const covered = findings.filter((f) => checklistAngles.has(f?.angle)).length;
      const side = Date.parse(first.loggedAt) >= cutoff ? "after" : "before";
      round1 = { loggedAt: first.loggedAt ?? null, side, covered, uncovered: findings.length - covered };
      checklist[side].changes += 1;
      checklist[side].covered += covered;
      checklist[side].uncovered += round1.uncovered;
    }
    totalRounds += causes.length;
    totalDerived += derived;
    totalUndetermined += undetermined;
    totalUnreadable += unreadable;
    totalOutOfBand += outOfBand;
    perChange.push({ pr: number, mergedAt, rounds: causes.length, derivedRounds: derived, undeterminedRounds: undetermined, unreadableLedgers: unreadable, outOfBandLedgers: outOfBand, byCause, round1 });
  }
  const n = merged.length;
  const per = (x) => (n === 0 ? 0 : round2(x / n));
  const from = n ? merged[n - 1].mergedAt : null;
  const to = n ? merged[0].mergedAt : null;
  const after = preceding?.mergedAt ?? null;
  const inWindow = (createdAt) => {
    const t = Date.parse(createdAt);
    return (after === null ? t >= Date.parse(from) : t > Date.parse(after)) && t <= Date.parse(to);
  };
  const filed = issues === null ? null : issues.filter((i) => inWindow(i.createdAt)).length;
  return {
    ok: true,
    gate,
    warnings: [...warnings].sort(),
    window: { merges: n, from, to, after },
    perChange,
    totals: {
      rounds: totalRounds,
      roundsPerMerge: per(totalRounds),
      derivedRounds: totalDerived,
      undeterminedRounds: totalUndetermined,
      unreadableLedgers: totalUnreadable,
      outOfBandLedgers: totalOutOfBand,
      byCause: totalsByCause,
      byCausePerMerge: Object.fromEntries(ROUND_CAUSES.map((c) => [c, per(totalsByCause[c])])),
    },
    checklist: { cutoff: CHECKLIST_CUTOFF, ...checklist },
    issues: filed === null ? null : { filed, perMerge: per(filed) },
  };
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, repoRoot = process.cwd() } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        help: { type: "boolean", short: "h" }, repo: { type: "string" }, "merged-prs": { type: "string" }, issues: { type: "string" },
        last: { type: "string" }, gate: { type: "string" }, base: { type: "string" }, "tmp-root": { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS,
      },
      allowPositionals: false,
    }));
  } catch (err) {
    throw parseError(err instanceof Error ? err.message : String(err));
  }
  if (values.help) {
    stdout.write(`${USAGE}\n`);
    return;
  }
  if (!values.repo?.trim()) throw parseError("--repo is required");
  if (!values["merged-prs"]?.trim()) throw parseError("--merged-prs is required");
  let slug;
  try {
    const { owner, name } = parseRepoSlug(values.repo, { errorMessage: "--repo must be <owner/name>" });
    slug = `${owner}/${name}`;
  } catch (err) {
    throw parseError(err.message);
  }
  const report = await buildReport({ ...values, repo: slug, "merged-prs": path.resolve(values["merged-prs"]), ...(values.issues ? { issues: path.resolve(values.issues) } : {}) }, { repoRoot });
  process.exitCode = emitResult(report, { jq: values.jq, silent: values.silent, fields: values.fields, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
