#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { parse as parseYaml } from "yaml";

import { ValidationConfig, resolveValidationConfig } from "@dev-loops/core/config";
import { LOOP_DERIVED_CI_CHECK_NAMES, deriveLoopCiStatusFromRollup, partitionEntriesByCheckName } from "@dev-loops/core/loop/copilot-ci-status";

import { parsePrNumber } from "../_cli-primitives.mjs";
import { isDirectCliRun } from "../_core-helpers.mjs";
import { LIFECYCLE_GATES, normalizeGate, normalizeHeadSha } from "../github/_gate-names.mjs";
import { viewPr } from "../github/view-pr.mjs";
import { buildValidationResultsPath } from "../github/write-gate-context.mjs";
import { JQ_OUTPUT_USAGE, emitResult, preflightJqFilter } from "../lib/jq-output.mjs";
import { buildValidationArtifact, classifyPackageSuites, defaultReadPrTitle, parseRunGateValidationCliArgs, readPackageScripts, runKillable, stripAnsi } from "./run-gate-validation.mjs";
import { resolveRepoRoot } from "./_repo-root-resolver.mjs";
import { DEVLOOPS_CONFIG_PATHS } from "./check-adr-tripwire.mjs";
import { readDefaultBranchConfig } from "./standing-authorization.mjs";

const USAGE = `Usage: dev-loops gate resolve-validation --profile <targeted|full-repository> --repo <owner/name> --pr <number> --gate <gate> --head-sha <full SHA> [--suite <script>]... [--tmp-root <dir>]\nTargeted profile requires at least one explicit --suite.\n${JQ_OUTPUT_USAGE}`;

async function removeParseFailedArtifact(argv) {
  const identity = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--(repo|pr|gate|head-sha|tmp-root)(?:=(.*))?$/.exec(argv[i]);
    if (!match) continue;
    const name = match[1];
    identity[name] = match[2] ?? argv[++i];
  }
  if (!["repo", "pr", "gate", "head-sha"].every((name) => identity[name])) return;
  try {
    const artifactPath = buildValidationResultsPath({
      repo: identity.repo.trim(), pr: parsePrNumber(identity.pr), gate: normalizeGate(identity.gate),
      headSha: normalizeHeadSha(identity["head-sha"]), tmpRoot: identity["tmp-root"]?.trim() ?? "tmp",
    });
    const repoRoot = resolveRepoRoot(process.cwd());
    const absolutePath = path.resolve(repoRoot, artifactPath);
    const relativePath = path.relative(repoRoot, absolutePath);
    if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) return;
    const realRelativePath = path.relative(await realpath(repoRoot), await realpath(path.dirname(absolutePath)));
    if (realRelativePath === ".." || realRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(realRelativePath)) return;
    await rm(absolutePath, { force: true });
  } catch { /* Invalid identity has no trustworthy keyed artifact to remove. */ }
}

export function parseResolveValidationArgs(argv) {
  const args = [...argv];
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const indices = args.flatMap((arg, index) => arg === "--profile" ? [index] : []);
  if (indices.length !== 1 || !args[indices[0] + 1]) throw new Error("exactly one --profile is required");
  const profile = args[indices[0] + 1];
  if (!["targeted", "full-repository"].includes(profile)) throw new Error("--profile must be targeted or full-repository");
  args.splice(indices[0], 2);
  const hasSuite = args.some((arg) => arg === "--suite" || arg.startsWith("--suite="));
  if (profile === "targeted" && !hasSuite) throw new Error("targeted profile requires an explicit --suite");
  if (profile === "full-repository" && !hasSuite) args.push("--suite", "verify");
  const options = parseRunGateValidationCliArgs(args);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.headSha)) throw new Error("--head-sha must be a full 40- or 64-character SHA");
  if (profile === "full-repository" && options.suites.join(",") !== "verify") {
    throw new Error("full-repository profile requires the single verify suite");
  }
  return { ...options, profile };
}

// The PR's head and status rollup, for ci-only mode (ADR 0137).
// A hung gh call rejects after the timeout, so the gate resolves typed incomplete.
export async function defaultReadCi({ repo, pr }, { read = viewPr, timeoutMs = 10_000 } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`reading the PR CI status timed out after ${timeoutMs}ms`)), timeoutMs); });
  try {
    const { pr: view } = await Promise.race([read({ repo, pr, fields: "headRefOid,statusCheckRollup" }, { run: runKillable(timeoutMs) }), timeout]);
    return { headSha: view.headRefOid, rollup: view.statusCheckRollup };
  } finally {
    clearTimeout(timer);
  }
}

// The validation block as the default branch declares it (ADR 0137): the only
// trusted source of the command, mode and paths. The base is `origin/HEAD`, as
// `readStandingAuthorization` reads it, never the checkout's `workflow.baseBranch`
// (a PR could point that at its own branch). A default branch with no `.devloops`
// family file is an absent block, so the `ci-only` default applies. Returns the
// resolved block or a refusal reason.
export function readBaseValidation(repoRoot) {
  const base = readDefaultBranchConfig({ repoRoot });
  if (!base.ok && !base.noConfigFile) return { reason: `cannot read the base branch validation config: ${base.detail}` };
  const doc = base.ok ? base.parsed : undefined;
  if (doc != null && (typeof doc !== "object" || Array.isArray(doc))) return { reason: "base branch validation config is malformed" };
  const parsed = ValidationConfig.optional().safeParse(doc?.validation);
  if (!parsed.success) return { reason: "base branch validation config is malformed" };
  return { validation: resolveValidationConfig({ validation: parsed.data }) };
}

// The checkout's own `.devloops` family file (loader order, first existing file
// wins), so both sides of the comparison read the same layer: the merged loader
// config also carries `.pi/dev-loop/defaults.*`, which the base side never sees.
export function readCheckoutValidation(repoRoot) {
  const name = DEVLOOPS_CONFIG_PATHS.find((candidate) => existsSync(path.join(repoRoot, candidate)));
  let raw;
  try {
    raw = name ? (name.endsWith(".json") ? JSON.parse : parseYaml)(readFileSync(path.join(repoRoot, name), "utf8"))?.validation : undefined;
  } catch { return { reason: `checkout ${name} does not parse` }; }
  const parsed = ValidationConfig.optional().safeParse(raw);
  if (!parsed.success) return { reason: "checkout validation config is malformed" };
  return { validation: resolveValidationConfig({ validation: parsed.data }) };
}

// Secrets stay out of the declared command's environment.
const SECRET_ENV = /token|secret|password|passwd|credential|api_?key|^gh_|^github_|^npm_/i;
// Inherited Git repository pointers would aim a Git command at another repository.
const GIT_POINTER_ENV = /^git_(dir|work_tree|index_file)$/i;
const commandEnv = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => !SECRET_ENV.test(key) && !GIT_POINTER_ENV.test(key)));

// Run the declared full command (the base branch's `validation.fullCommand`,
// never PR content) through `sh -c` and shape its result like a package suite.
function runDeclaredFullCommand(command, { repo, pr, gate, headSha, tmpRoot }, { repoRoot, env }) {
  return new Promise((resolve, reject) => {
    execFile("sh", ["-c", command], { cwd: repoRoot, env: commandEnv(env), maxBuffer: 64 * 1024 * 1024 }, async (error, stdout, stderr) => {
      try {
        const output = stripAnsi(`${stdout ?? ""}${stderr ?? ""}` || (error?.message ?? ""));
        const exitCode = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        const artifactDir = path.dirname(buildValidationResultsPath({ repo, pr, gate, headSha, tmpRoot }));
        const outputPath = path.join(artifactDir, `${gate}-${headSha}.validation-full.log`);
        await mkdir(path.resolve(repoRoot, artifactDir), { recursive: true });
        await writeFile(path.resolve(repoRoot, outputPath), output.endsWith("\n") ? output : `${output}\n`, "utf8");
        resolve({
          ok: true, repo, pr, gate, headSha, generatedAt: new Date().toISOString(), allPassed: exitCode === 0,
          suites: [{ name: "full", command, exitCode, outputTail: output.slice(-4000), outputPath }],
        });
      } catch (writeError) { reject(writeError); }
    });
  });
}

export async function resolveValidation(options, { repoRoot = resolveRepoRoot(process.cwd()), env = process.env, readCi = defaultReadCi, readPrTitle = defaultReadPrTitle } = {}) {
  const artifactPath = path.resolve(repoRoot, buildValidationResultsPath(options));
  // An incomplete outcome replaces any earlier same-head evidence with a typed
  // incomplete record, so the verdict writer sees that the round resolved its
  // validation and every reader sees `allPassed: false`. The old file goes
  // first: a failed write leaves the artifact absent, never a stale pass.
  // A tree whose HEAD is not the requested head gets no artifact at all: the
  // run is in the wrong checkout, so the verdict writer must see it as absent.
  const incomplete = async (reason, { writeArtifact = true } = {}) => {
    await rm(artifactPath, { force: true });
    if (!writeArtifact) {
      return { ok: false, status: "incomplete", allPassed: false, profile: options.profile, headSha: options.headSha, toolchain: null, reason };
    }
    const artifact = {
      ok: false, status: "incomplete", allPassed: false,
      repo: options.repo, pr: options.pr, gate: options.gate, headSha: options.headSha,
      profile: options.profile, reason, generatedAt: new Date().toISOString(), suites: [],
    };
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return { ok: false, status: "incomplete", allPassed: false, profile: options.profile, headSha: options.headSha, toolchain: null, reason, artifactPath: buildValidationResultsPath(options) };
  };
  // An exception writes a typed artifact only when the head check confirmed
  // the requested head and a re-check at the throw still confirms it: a suite
  // may have moved HEAD before a later step threw.
  const gitEnv = { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
  const readHead = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8", env: gitEnv, stdio: ["ignore", "pipe", "ignore"] }).trim().toLowerCase();
  let headConfirmed = false;
  try {
    const currentTreeProblem = () => {
      headConfirmed = false;
      const actualHead = readHead();
      headConfirmed = actualHead === options.headSha;
      if (!headConfirmed) return { reason: `worktree HEAD ${actualHead} differs from requested head`, writeArtifact: false };
      // Untracked .pi/agents is generated at provision time (decision record 0173), not a tree change.
      // Tracked changes under it still count as dirt.
      const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repoRoot, encoding: "utf8", env: gitEnv })
        .split("\n").filter((l) => l && !l.startsWith("?? .pi/agents/")).join("\n").trim();
      return dirty ? { reason: "validation requires a clean worktree at the requested head", writeArtifact: true } : null;
    };
    const beforeProblem = currentTreeProblem();
    if (beforeProblem) return incomplete(beforeProblem.reason, beforeProblem);
    const checkout = readCheckoutValidation(repoRoot);
    if (checkout.reason) return incomplete(checkout.reason);
    const base = readBaseValidation(repoRoot);
    if (base.reason) return incomplete(base.reason);
    // A PR that edits its own validation block never runs what it declared.
    if (JSON.stringify(checkout.validation) !== JSON.stringify(base.validation)) {
      return incomplete("validation config differs from the base branch: a config-source change needs review before validation runs");
    }
    const { mode, fullCommand } = base.validation;
    // A declared command also serves a targeted request in a repo without package.json.
    const declared = mode === "local" && fullCommand && (options.profile === "full-repository" || !existsSync(path.join(repoRoot, "package.json"))) && fullCommand;
    let pinned = null;
    let artifact;
    if (mode === "ci-only") {
      // ADR 0137: current-head CI is the only validation authority for every profile; no local suite runs.
      const ci = await readCi({ repo: options.repo, pr: options.pr });
      const ciStatus = ci.headSha?.toLowerCase() === options.headSha ? deriveLoopCiStatusFromRollup(ci.rollup).status : "wrong-head";
      if (ciStatus !== "success" && ciStatus !== "failure") return incomplete(ciStatus === "wrong-head" ? `PR head ${ci.headSha} differs from requested head` : `current-head CI is ${ciStatus}`);
      // SKIPPED and NEUTRAL count as success in the shared rollup status, but a rollup with no SUCCESS entry ran no suite.
      const ranSuite = partitionEntriesByCheckName(ci.rollup, LOOP_DERIVED_CI_CHECK_NAMES).rest
        .some((entry) => String(entry?.conclusion ?? "").toUpperCase() === "SUCCESS" || String(entry?.state ?? "").toUpperCase() === "SUCCESS");
      if (ciStatus === "success" && !ranSuite) return incomplete("current-head CI ran no checks");
      artifact = { ok: ciStatus === "success", status: ciStatus === "success" ? "complete" : "failed", allPassed: ciStatus === "success", ...(ciStatus === "success" ? { authority: "ci-authoritative" } : { reason: "current-head CI is failure" }), repo: options.repo, pr: options.pr, gate: options.gate, headSha: options.headSha, profile: options.profile, generatedAt: new Date().toISOString(), suites: [] };
    } else if (declared) {
      artifact = { ...await runDeclaredFullCommand(declared, options, { repoRoot, env }), profile: options.profile };
    } else {
      const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
      pinned = packageJson.packageManager;
      if (!/^bun@\d+\.\d+\.\d+$/.test(pinned ?? "")) return incomplete("packageManager does not pin an exact Bun version");
      const installed = execFileSync("bun", ["--version"], { cwd: repoRoot, encoding: "utf8", env }).trim();
      if (`bun@${installed}` !== pinned) return incomplete(`installed bun@${installed} differs from ${pinned}`);
      const scripts = await readPackageScripts(repoRoot);
      const classification = classifyPackageSuites(options.suites, scripts);
      if (options.profile === "targeted" && classification === "full-repository") return incomplete("targeted profile cannot run full-repository validation");
      if (options.profile === "targeted" && classification !== "targeted") return incomplete("targeted profile requires a validation suite");
      if (options.profile === "full-repository" && classification !== "full-repository") return incomplete("verify script is not classified as full-repository validation");
      // Reuse another lifecycle gate's passing artifact for the same head, profile, toolchain and suites.
      // The suites consume the PR title (DEVLOOPS_PR_TITLE), so the title is part of the match key; an unreadable title never reuses.
      // ponytail: reused suites keep the source gate's outputPath log; a rerun of that gate at the same head may overwrite it.
      const currentTitle = await Promise.resolve(readPrTitle({ repo: options.repo, pr: options.pr }, env)).then((t) => (typeof t === "string" && t.trim() !== "" ? t : null), () => null);
      for (const gate of currentTitle !== null && LIFECYCLE_GATES.includes(options.gate) ? LIFECYCLE_GATES.filter((g) => g !== options.gate) : []) {
        try {
          const prior = JSON.parse(await readFile(path.resolve(repoRoot, buildValidationResultsPath({ ...options, gate })), "utf8"));
          if (prior.ok === true && prior.allPassed === true
            && prior.repo === options.repo && prior.pr === options.pr && String(prior.headSha).toLowerCase() === options.headSha
            && prior.profile === options.profile && prior.toolchain === pinned && prior.prTitle === currentTitle
            && JSON.stringify(prior.suites.map((s) => s.name)) === JSON.stringify(options.suites)
            && prior.suites.every((s) => s.exitCode === 0)) {
            artifact = { ...prior, gate: options.gate, generatedAt: new Date().toISOString(), reusedFrom: prior.reusedFrom ?? gate };
            break;
          }
        } catch { /* An unreadable or malformed prior artifact is never reused. */ }
      }
      artifact ??= { ...await buildValidationArtifact(options, { repoRoot, readPrTitle }), profile: options.profile, toolchain: pinned };
    }
    const afterProblem = currentTreeProblem();
    if (afterProblem) return incomplete(`validation changed the worktree: ${afterProblem.reason}`, afterProblem);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    // HEAD can move between the check above and the write: re-check after it.
    const writtenProblem = currentTreeProblem();
    if (writtenProblem) return incomplete(`worktree moved during the artifact write: ${writtenProblem.reason}`, writtenProblem);
    return { ok: artifact.allPassed, status: artifact.allPassed ? "complete" : "failed", allPassed: artifact.allPassed, profile: options.profile, headSha: options.headSha, toolchain: pinned, artifactPath: buildValidationResultsPath(options), artifact };
  } catch (error) {
    let stillConfirmed = false;
    try { stillConfirmed = headConfirmed && readHead() === options.headSha; } catch { /* An unconfirmable head writes no artifact. */ }
    return incomplete(error instanceof Error ? error.message : String(error), { writeArtifact: stillConfirmed });
  }
}

export async function main(argv = process.argv.slice(2)) {
  let result;
  let options;
  try {
    options = parseResolveValidationArgs(argv);
    if (options.help) { process.stdout.write(`${USAGE}\n`); return; }
    if (preflightJqFilter(options.jq) === 2) { await removeParseFailedArtifact(argv); process.exitCode = 2; return; }
    result = await resolveValidation(options);
  } catch (error) {
    if (!options) await removeParseFailedArtifact(argv);
    result = { ok: false, status: "incomplete", allPassed: false, profile: null, headSha: null, toolchain: null, reason: error instanceof Error ? error.message : String(error) };
  }
  const emitted = emitResult(result, { jq: options?.jq, silent: options?.silent });
  process.exitCode = emitted === 2 ? 2 : result.ok ? 0 : 1;
}

if (isDirectCliRun(import.meta.url)) await main();
