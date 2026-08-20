#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import {
  applyJudgeDispositions,
  validateJudgeVerdict,
} from "@dev-loops/core/loop/gate-fanin";
import { resolveFindingsInput } from "../github/_findings-input.mjs";
import {
  JQ_OUTPUT_PARSE_OPTIONS,
  JQ_OUTPUT_USAGE,
  emitResult,
  matchJqOutputToken,
} from "../lib/jq-output.mjs";

const USAGE = `Usage: judge-pass.mjs --repo <owner/name> --pr <number> --gate <draft_gate|pre_approval_gate> --head-sha <sha> --findings-file <path> --judge-verdict <path> [--out <act-list-path>] [--ledger-out <path>] [--repo-root <path>]

Bridge the judge pass between gate fan-in (Phase 3) and the fixer pass (Phase 4).
Reads the judge agent's verdict artifact, enforces current-head freshness, applies
the judge's relevance dispositions (act/defer/reject) to the consolidated ledger,
and emits the fixer's ACT list — the findings the judge marked 'act' that the fix
pass executes (#1658).

Inputs:
  --findings-file <path>       The consolidated flat ledger from consolidate-fanin
                               --ledger-out ({ overallVerdict, findings } wrapper,
                               or a bare findings array). Same unwrap semantics as
                               write-gate-findings-log --findings-file.
  --judge-verdict <path>       The judge agent's verdict artifact (JSON) at the
                               deterministic tmp/gate-judge/.../judge-verdict.json
                               path. Validated by validateJudgeVerdict and must be
                               current-head (headSha == --head-sha) or the pass
                               FAILS CLOSED — a stale verdict must not feed the
                               fixer's act list.
  --head-sha <sha>             The round's current head. The verdict's headSha must
                               equal this (trim+lowercase compare) or the pass fails
                               closed.
  --repo <owner/name>          Echoed onto the result (owner/name format checked).
  --pr <number>                Echoed onto the result.
  --gate <name>                Echoed onto the result (draft_gate|pre_approval_gate).
  --out <path>                 Write the fixer's ACT list (enriched findings with
                               judgeDisposition === "act") to this path as JSON.
  --ledger-out <path>          Write the enriched { overallVerdict, findings, scopeDrift }
                               to this path as JSON, so the durable disposition ledger
                               carries what the judge consciously marked act/defer/reject.
  --repo-root <path>           Root used to resolve relative --findings-file /
                               --judge-verdict / --out / --ledger-out paths
                               (default: process.cwd()).

${JQ_OUTPUT_USAGE}

Exit codes:
  0   Success
  1   Fail closed (stale verdict head, malformed verdict, out-of-range disposition, etc.)
  2   Invalid --jq filter
`.trim();

const GATES = Object.freeze(["draft_gate", "pre_approval_gate"]);

function parseError(message) {
  return Object.assign(new Error(message), { usage: USAGE });
}

export function parseJudgePassCliArgs(argv) {
  const options = {
    repo: undefined,
    pr: undefined,
    gate: undefined,
    headSha: undefined,
    findingsFile: undefined,
    judgeVerdict: undefined,
    out: undefined,
    ledgerOut: undefined,
    repoRoot: undefined,
    jq: undefined,
    silent: false,
  };
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      gate: { type: "string" },
      "head-sha": { type: "string" },
      "findings-file": { type: "string" },
      "judge-verdict": { type: "string" },
      out: { type: "string" },
      "ledger-out": { type: "string" },
      "repo-root": { type: "string" },
      help: { type: "boolean", short: "h" },
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
      continue;
    }
    if (matchJqOutputToken(token, options)) continue;
    if (token.name === "repo") {
      options.repo = token.value;
      continue;
    }
    if (token.name === "pr") {
      options.pr = token.value;
      continue;
    }
    if (token.name === "gate") {
      options.gate = token.value;
      continue;
    }
    if (token.name === "head-sha") {
      options.headSha = token.value;
      continue;
    }
    if (token.name === "findings-file") {
      options.findingsFile = token.value;
      continue;
    }
    if (token.name === "judge-verdict") {
      options.judgeVerdict = token.value;
      continue;
    }
    if (token.name === "out") {
      options.out = token.value;
      continue;
    }
    if (token.name === "ledger-out") {
      options.ledgerOut = token.value;
      continue;
    }
    if (token.name === "repo-root") {
      options.repoRoot = token.value;
      continue;
    }
    throw parseError(`Unknown argument: ${token.rawName}`);
  }
  return validateCliArgs(options);
}

function requireValue(value, flag, parseErr) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw parseErr(`${flag} requires a non-empty value`);
  }
  return value.trim();
}

export function validateCliArgs(options) {
  const missing = [];
  for (const key of ["repo", "pr", "gate", "headSha", "findingsFile", "judgeVerdict"]) {
    if (options[key] === undefined) missing.push(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  if (missing.length > 0) {
    throw parseError(`Missing required arguments: ${missing.join(", ")}`);
  }
  try {
    parseRepoSlug(requireValue(options.repo, "--repo", parseError));
  } catch (error) {
    throw parseError(error instanceof Error ? error.message : String(error));
  }
  if (!/^\d+$/.test(String(options.pr).trim())) {
    throw parseError("--pr must be a positive integer");
  }
  const gate = String(options.gate).trim().toLowerCase();
  if (!GATES.includes(gate)) {
    throw parseError(`--gate must be one of: ${GATES.join(", ")}`);
  }
  options.gate = gate;
  const sha = requireValue(options.headSha, "--head-sha", parseError);
  if (!/^[0-9a-fA-F]{7,64}$/.test(sha)) {
    throw parseError("--head-sha must be a 7-64 char hex SHA");
  }
  options.headSha = sha;
  options.findingsFile = requireValue(options.findingsFile, "--findings-file", parseError);
  options.judgeVerdict = requireValue(options.judgeVerdict, "--judge-verdict", parseError);
  // Every configured path flag must be pairwise distinct: inputs must never be
  // clobbered by an output, and --out must never be silently deduped against
  // --ledger-out (which would yield no act list with no warning).
  const pathFlags = ["findingsFile", "judgeVerdict", "out", "ledgerOut"].filter(
    (k) => options[k] !== undefined,
  );
  for (let i = 0; i < pathFlags.length; i += 1) {
    for (let j = i + 1; j < pathFlags.length; j += 1) {
      if (options[pathFlags[i]] === options[pathFlags[j]]) {
        const flag = (k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
        throw parseError(`${flag(pathFlags[i])} and ${flag(pathFlags[j])} must be different paths`);
      }
    }
  }
  return options;
}

/**
 * Apply a valid, current-head judge verdict to a consolidated findings ledger and
 * derive the fixer's ACT list. Pure + fail-closed:
 *   - validates the verdict shape (`validateJudgeVerdict`)
 *   - enforces current-head freshness: verdict.headSha must equal `headSha`
 *     (trim+lowercase) or the pass fails closed — a stale verdict staged from an
 *     earlier head must never feed the fixer's act list
 *   - applies the judge's relevance dispositions via `applyJudgeDispositions`
 *     (fail-closed on an out-of-range index and on undisposed findings)
 *
 * The fix pass consumes ONLY the returned `act` list (`GATE-EXEC-JUDGE-AUTHORITY-SPLIT`);
 * the returned `enriched` ledger carries `judgeDisposition` / `judgeRationale` /
 * `judgeCriterion` / `followUpDraft` so the durable ledger and posted findings comment
 * show what was consciously not acted on and why.
 *
 * @param {Array<object>} findings — the flat consolidated findings array (already unwrapped)
 * @param {object} judgeVerdict — the judge agent's verdict artifact (JSON object)
 * @param {string} headSha — the round's current head (the verdict must be current-head)
 * @returns {{ enriched: Array<object>, act: Array<object>, scopeDrift: object,
 *             counts: { act: number, defer: number, reject: number }, headSha: string }}
 */
export function runJudgePass(findings, judgeVerdict, headSha) {
  const validated = validateJudgeVerdict(judgeVerdict);
  const verdictHead = validated.headSha.trim().toLowerCase();
  const currentHead = String(headSha).trim().toLowerCase();
  if (verdictHead !== currentHead) {
    throw new Error(
      `judge verdict headSha ${JSON.stringify(validated.headSha)} does not match current head ${JSON.stringify(headSha)} — refuse a stale verdict; re-run the judge at the current head`
    );
  }
  // applyJudgeDispositions fails closed on both an out-of-range index and an
  // undisposed finding (the coverage check lives in that shared pure seam),
  // so runJudgePass inherits fail-closed coverage without restating it here.
  const applied = applyJudgeDispositions(findings, judgeVerdict);
  const enriched = applied.findings;
  const act = enriched.filter((f) => f.judgeDisposition === "act");
  const counts = { act: 0, defer: 0, reject: 0 };
  for (const f of enriched) {
    if (f.judgeDisposition === "act") counts.act += 1;
    else if (f.judgeDisposition === "defer") counts.defer += 1;
    else if (f.judgeDisposition === "reject") counts.reject += 1;
  }
  return {
    enriched,
    act,
    scopeDrift: applied.scopeDrift,
    counts,
    headSha: validated.headSha,
  };
}

async function resolvePayload(options, repoRoot) {
  const findingsInput = await resolveFindingsInput(
    { findingsFile: path.resolve(repoRoot, options.findingsFile) },
    { parseError, validate: validateFindingsArray },
  );
  return { findings: findingsInput.findings, overallVerdict: findingsInput.overallVerdict };
}

function validateFindingsArray(parsed, flagLabel) {
  if (!Array.isArray(parsed)) {
    throw parseError(`${flagLabel} must resolve to a findings array`);
  }
  return parsed.map((f, i) => {
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      throw parseError(`${flagLabel}[${i}] must be a finding object`);
    }
    return f;
  });
}

async function readJudgeVerdict(judgePath, parseErr) {
  let raw;
  try {
    raw = await readFile(judgePath, "utf8");
  } catch (error) {
    throw parseErr(`Cannot read --judge-verdict "${judgePath}": ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw parseErr(`--judge-verdict "${judgePath}" must contain valid JSON`);
  }
  return parsed;
}

export async function judgePassCli(options, { repoRoot = process.cwd() } = {}) {
  const resolvedRoot = options.repoRoot ? path.resolve(repoRoot, options.repoRoot) : repoRoot;
  const { findings, overallVerdict } = await resolvePayload(options, resolvedRoot);
  const judgeVerdict = await readJudgeVerdict(
    path.resolve(resolvedRoot, options.judgeVerdict),
    parseError,
  );
  const result = runJudgePass(findings, judgeVerdict, options.headSha);

  const written = new Set();
  if (options.ledgerOut) {
    const ledgerPath = path.resolve(resolvedRoot, options.ledgerOut);
    await mkdir(path.dirname(ledgerPath), { recursive: true });
    await writeFile(
      ledgerPath,
      JSON.stringify({ overallVerdict, findings: result.enriched, scopeDrift: result.scopeDrift }, null, 2) + "\n",
    );
    written.add(ledgerPath);
  }
  if (options.out) {
    const outPath = path.resolve(resolvedRoot, options.out);
    if (!written.has(outPath)) {
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify(result.act, null, 2) + "\n");
    }
  }

  const payload = {
    ok: true,
    gate: options.gate,
    repo: options.repo,
    pr: Number(options.pr),
    headSha: result.headSha,
    scopeDrift: result.scopeDrift,
    counts: result.counts,
    actCount: result.counts.act,
    act: result.act,
    ledgerOut: options.ledgerOut || undefined,
    out: options.out || undefined,
  };
  return payload;
}

function main() {
  let opts;
  try {
    opts = parseJudgePassCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    if (err && err.usage) process.stderr.write(`\n${err.usage}\n`);
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  judgePassCli(opts)
    .then((payload) => {
      process.exitCode = emitResult(payload, { jq: opts.jq, silent: opts.silent });
    })
    .catch((err) => {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    });
}

const isDirectRun =
  process.argv[1] && process.argv[1].endsWith(path.sep + "judge-pass.mjs");
if (isDirectRun) {
  main();
}
