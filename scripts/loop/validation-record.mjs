#!/usr/bin/env node
/**
 * validation-record.mjs: the `local` producer of the head-pinned validation
 * record (issue 2866). A sanctioned local run launcher: foreground, bounded
 * timeout, no detached mode and no completion file. Nothing reads the record yet.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

import { resolveTargetedValidation } from "@dev-loops/core/loop/validation-classify";
import { parseValidationRecord, validationRecordPath } from "@dev-loops/core/loop/validation-record";

import { JQ_OUTPUT_PARSE_OPTIONS, JQ_OUTPUT_USAGE, emitResult, preflightJqFilter } from "../lib/jq-output.mjs";
import { buildParseError,formatCliError, isDirectCliRun } from "../_core-helpers.mjs";
import { resolveRepoRoot } from "./_repo-root-resolver.mjs";
import { readBaseValidation, readCheckoutValidation } from "./resolve-validation.mjs";
import { buildValidationArtifact, classifyPackageSuites, readPackageScripts } from "./run-gate-validation.mjs";

const DEFAULT_TIMEOUT_S = 540;
// DEV-LOOP-PROBE-TIMEOUT-CEILING: stay below the 600 s tool-call ceiling.
const MAX_TIMEOUT_S = 570;
const GIT_TIMEOUT_MS = 30000;

const USAGE = `Usage: dev-loops loop validation-record --repo <owner/name> --head-sha <full SHA> --title <PR title> [--timeout <seconds>] [--tmp-root <dir>]
Run the selected validation profile at a clean, confirmed head and write the head record
tmp/validation-records/<owner>/<repo>/<headSha>.json. The producer runs in the foreground.
Required:
  --repo <owner/name>
  --head-sha <sha>     Full 40- or 64-character SHA; the worktree HEAD must equal it
  --title <title>      PR title the suites consume (DEVLOOPS_PR_TITLE)
Optional:
  --timeout <seconds>  Suite deadline, positive, at most ${MAX_TIMEOUT_S} (default ${DEFAULT_TIMEOUT_S})
  --tmp-root <dir>     Root tmp directory (default: tmp)
Output (stdout, JSON): the record, or { "ok": false, "status": "incomplete", "reason": "..." } with no record written.
Exit codes: 0 all suites passed; 1 failed suite (failed record written) or incomplete; 2 usage error.
${JQ_OUTPUT_USAGE}`;
const parseError = buildParseError(USAGE);

export function parseValidationRecordArgs(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { help: { type: "boolean", short: "h" }, repo: { type: "string" }, "head-sha": { type: "string" }, title: { type: "string" }, timeout: { type: "string" }, "tmp-root": { type: "string" }, ...JQ_OUTPUT_PARSE_OPTIONS },
      allowPositionals: false,
      strict: true,
    }));
  } catch (error) {
    throw parseError(error.message);
  }
  if (values.help) return { help: true };
  const missing = ["repo", "head-sha", "title"].filter((name) => !values[name]?.trim());
  if (missing.length > 0) throw parseError(`Missing required arguments: ${missing.join(", ")}`);
  if (values.timeout !== undefined && !/^\d+(\.\d+)?$/.test(values.timeout)) throw parseError("--timeout must be a decimal number of seconds");
  const timeoutSeconds = values.timeout === undefined ? DEFAULT_TIMEOUT_S : Number(values.timeout);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > MAX_TIMEOUT_S) {
    throw parseError(`VALIDATE-LOCAL-RECORD-PRODUCER: --timeout must be a positive number of seconds, at most ${MAX_TIMEOUT_S}`);
  }
  const options = { jq: values.jq, silent: values.silent, fields: values.fields, repo: values.repo.trim(), headSha: values["head-sha"].trim(), title: values.title, timeoutSeconds, tmpRoot: values["tmp-root"]?.trim() || "tmp" };
  try {
    validationRecordPath(options);
  } catch (error) {
    throw parseError(error.message);
  }
  return options;
}

export async function produceValidationRecord(options, { repoRoot = resolveRepoRoot(process.cwd()), env = process.env } = {}) {
  const incomplete = (reason) => ({ ok: false, status: "incomplete", reason });
  const gitEnv = { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
  const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS });
  const treeProblem = () => {
    const head = git(["rev-parse", "HEAD"]).trim().toLowerCase();
    if (head !== options.headSha) return `worktree HEAD ${head} differs from requested head`;
    return git(["status", "--porcelain"]).trim() ? "validation requires a clean worktree at the requested head" : null;
  };
  const relRecordPath = validationRecordPath(options);
  const recordPath = path.resolve(repoRoot, relRecordPath);
  try {
    // A stale record for this head never survives an incomplete run: remove it before any check.
    await rm(recordPath, { force: true });
    const before = treeProblem();
    if (before) return incomplete(before);
    try {
      git(["rev-parse", "--verify", "--quiet", "origin/HEAD^{commit}"]);
    } catch {
      return incomplete("origin/HEAD does not resolve; run git fetch origin and git remote set-head origin -a");
    }
    const checkout = readCheckoutValidation(repoRoot);
    if (checkout.reason) return incomplete(checkout.reason);
    const base = readBaseValidation(repoRoot);
    if (base.reason) return incomplete(base.reason);
    if (JSON.stringify(checkout.validation) !== JSON.stringify(base.validation)) {
      return incomplete("validation config differs from the base branch: a config-source change needs review before validation runs");
    }
    if (base.validation.mode !== "local") {
      return incomplete(`base validation mode resolves to ${JSON.stringify(base.validation.mode)}; ci-only selects the ci producer (ADR 0170), so the local producer runs nothing`);
    }
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    const pinned = packageJson.packageManager;
    if (!/^bun@\d+\.\d+\.\d+$/.test(pinned ?? "")) return incomplete("packageManager does not pin an exact Bun version");
    const installed = execFileSync("bun", ["--version"], { cwd: repoRoot, encoding: "utf8", env, timeout: GIT_TIMEOUT_MS }).trim();
    if (`bun@${installed}` !== pinned) return incomplete(`installed bun@${installed} differs from ${pinned}`);

    const paths = git(["diff", "--name-only", "--no-renames", "-z", `origin/HEAD...${options.headSha}`]).split("\0").filter(Boolean).sort();
    const selected = resolveTargetedValidation(paths, base.validation.paths ?? []);
    const scripts = await readPackageScripts(repoRoot);
    let profile = "full-repository";
    let suites = ["verify"];
    if (selected.profile === "targeted" && selected.gateSuites.length > 0 && paths.every((p) => resolveTargetedValidation([p], base.validation.paths ?? []).gateSuites.length > 0) && classifyPackageSuites(selected.gateSuites, scripts) === "targeted") {
      profile = "targeted";
      suites = selected.gateSuites;
    } else if (classifyPackageSuites(suites, scripts) !== "full-repository") {
      return incomplete("verify script is not classified as full-repository validation");
    }

    // ADR 0137: the base block's fullCommand is authoritative for the full profile; this producer only runs `verify`.
    if (profile === "full-repository" && base.validation.fullCommand) {
      return incomplete(`base validation declares fullCommand ${JSON.stringify(base.validation.fullCommand)}; the producer does not run it, use gate resolve-validation`);
    }

    const logDir =relRecordPath.replace(/\.json$/, ".logs");
    const artifact = await buildValidationArtifact(
      { repo: options.repo, headSha: options.headSha, suites, tmpRoot: options.tmpRoot },
      { repoRoot, env, readPrTitle: () => options.title, timeoutMs: options.timeoutSeconds * 1000, logDir },
    );
    const after = treeProblem();
    if (after) return incomplete(`validation changed the worktree: ${after}`);

    const record = {
      repo: options.repo, headSha: options.headSha, producer: "local", profile, toolchain: pinned,
      requestedSuites: suites,
      suites: artifact.suites.map(({ name, command, exitCode, outputPath }) => ({ name, command, exitCode, outputPath })),
      prTitle: options.title, generatedAt: artifact.generatedAt, allPassed: artifact.allPassed,
    };
    const parsed = parseValidationRecord(record, options);
    if (!parsed.ok) return incomplete(`record failed validation: ${parsed.reason}`);
    await mkdir(path.dirname(recordPath), { recursive: true });
    const tmpPath = `${recordPath}.tmp-${process.pid}`;
    await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    await rename(tmpPath, recordPath);
    return record;
  } catch (error) {
    await rm(recordPath, { force: true }).catch(() => {});
    if (error?.timedOut) return incomplete(`validation timed out after ${options.timeoutSeconds} s`);
    return incomplete(error instanceof Error ? error.message : String(error));
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseValidationRecordArgs(argv);
  } catch (error) {
    process.stderr.write(`${formatCliError(error, { usage: USAGE })}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (preflightJqFilter(options.jq) === 2) { process.exitCode = 2; return; }
  const result = await produceValidationRecord(options);
  const emitted = emitResult(result, { jq: options.jq, silent: options.silent, fields: options.fields });
  process.exitCode = emitted === 2 ? 2 : result.allPassed === true ? 0 : 1;
}

if (isDirectCliRun(import.meta.url)) await main();
