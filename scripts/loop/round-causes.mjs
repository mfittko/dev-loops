#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildParseError, formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult } from "../lib/jq-output.mjs";
import { isBaseOnlyMergeSince } from "../lib/git-delta.mjs";
import { ROUND_CAUSES, deriveRoundCause } from "../github/_round-cause.mjs";
import { readClosedPriorRoundLogs } from "../github/write-gate-context.mjs";

const USAGE = `Usage:
  dev-loops loop round-causes --repo <owner/name> --merged-prs <path> [--issues <path>] [--last <n>] [--gate <name>] [--base <branch>] [--tmp-root <path>]
Read-only report of gate rounds per merged change, split by roundCause, from the local
findings logs. Prints JSON. It makes no gh call: the export files come from
  gh pr list --state merged --json number,mergedAt --limit <n>
  gh issue list --state all --json number,createdAt --limit <n>
Required:
  --repo <owner/name>   Repository whose findings logs are read
  --merged-prs <path>   JSON array of { number, mergedAt }
Optional:
  --issues <path>       JSON array of { number, createdAt }; adds issues filed per merge
  --last <n>            Window: the n most recent merges (default 20)
  --gate <name>         Gate to count (default draft_gate)
  --base <branch>       Base for the legacy base-merge probe (default main)
  --tmp-root <path>     Findings-log root (default: <main checkout>/tmp)
  --help, -h            Show this help

${JQ_OUTPUT_USAGE}

Exit codes:
  0  Success
  1  Argument error or runtime failure`.trim();

const parseError = buildParseError(USAGE);
const GATE_SENTINEL_HEAD = "0".repeat(40);
const round2 = (n) => Math.round(n * 100) / 100;
const emptyCauses = () => Object.fromEntries(ROUND_CAUSES.map((c) => [c, 0]));

async function readExport(file, dateField) {
  let data;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw parseError(`cannot read ${file} as JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(data)) throw parseError(`${file} must hold a JSON array`);
  for (const entry of data) {
    if (!Number.isInteger(entry?.number) || typeof entry?.[dateField] !== "string" || !Number.isFinite(Date.parse(entry[dateField]))) {
      throw parseError(`${file} has an entry without an integer number and an ISO ${dateField}`);
    }
  }
  return data;
}

// A ledger written before the stamp has no roundCause: derive it in memory against the previous round of the same PR.
async function roundCauses(rounds, { base, repoRoot }) {
  const causes = [];
  let derived = 0;
  for (const [i, log] of rounds.entries()) {
    if (ROUND_CAUSES.includes(log.roundCause)) { causes.push(log.roundCause); continue; }
    derived += 1;
    const prior = rounds[i - 1];
    let baseOnly = false;
    if (prior && String(prior.headSha).toLowerCase() !== String(log.headSha).toLowerCase()) {
      baseOnly = await isBaseOnlyMergeSince({ fromHead: prior.headSha, head: log.headSha, mainRef: `origin/${base}`, repoRoot }).catch(() => false);
    }
    causes.push(deriveRoundCause({ prior, headSha: log.headSha, prBodySha256: log.prBodySha256, baseOnly }));
  }
  return { causes, derived };
}

export async function buildReport(values, { repoRoot = process.cwd() } = {}) {
  const gate = values.gate ?? "draft_gate";
  const base = values.base ?? "main";
  const last = values.last === undefined ? 20 : Number(values.last);
  if (!Number.isInteger(last) || last < 1) throw parseError("--last must be a positive integer");
  const merged = (await readExport(values["merged-prs"], "mergedAt")).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt)).slice(0, last);
  const issues = values.issues === undefined ? null : await readExport(values.issues, "createdAt");
  const totalsByCause = emptyCauses();
  let totalRounds = 0;
  let totalDerived = 0;
  const perChange = [];
  for (const { number, mergedAt } of merged) {
    // A sentinel head matches no ledger, so every ledger of the PR is read as a prior round.
    const logs = await readClosedPriorRoundLogs({ repo: values.repo, pr: number, gate, headSha: GATE_SENTINEL_HEAD, tmpRoot: values["tmp-root"] }, { repoRoot, includeRetainedCurrentHead: true, includeLiveCurrentHead: true });
    const { causes, derived } = await roundCauses(logs, { base, repoRoot });
    const byCause = emptyCauses();
    for (const c of causes) { byCause[c] += 1; totalsByCause[c] += 1; }
    totalRounds += causes.length;
    totalDerived += derived;
    perChange.push({ pr: number, mergedAt, rounds: causes.length, derivedRounds: derived, byCause });
  }
  const n = merged.length;
  const per = (x) => (n === 0 ? 0 : round2(x / n));
  const from = n ? merged[n - 1].mergedAt : null;
  const to = n ? merged[0].mergedAt : null;
  const filed = issues === null ? null : issues.filter((i) => Date.parse(i.createdAt) >= Date.parse(from) && Date.parse(i.createdAt) <= Date.parse(to)).length;
  return {
    ok: true,
    gate,
    window: { merges: n, from, to },
    perChange,
    totals: {
      rounds: totalRounds,
      roundsPerMerge: per(totalRounds),
      derivedRounds: totalDerived,
      byCause: totalsByCause,
      byCausePerMerge: Object.fromEntries(ROUND_CAUSES.map((c) => [c, per(totalsByCause[c])])),
    },
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
  const report = await buildReport({ ...values, repo: values.repo.trim(), "merged-prs": path.resolve(values["merged-prs"]), ...(values.issues ? { issues: path.resolve(values.issues) } : {}) }, { repoRoot });
  process.exitCode = emitResult(report, { jq: values.jq, silent: values.silent, stdout, stderr });
}

if (isDirectCliRun(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${formatCliError(error)}\n`);
    process.exitCode = 1;
  });
}
