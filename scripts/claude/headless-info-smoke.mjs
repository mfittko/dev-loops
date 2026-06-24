#!/usr/bin/env node
/**
 * Headless read-only dev-loop info smoke (#775).
 *
 * Exercises a read-only dev-loop info path non-interactively (no LLM, no interactive session,
 * no `@earendil-works/pi-*`), so CI / the Docker image can verify the headless info surface.
 * Parallel to the Pi Docker smoke (dual-harness). Exits 0 on success.
 *
 * Default: `dev-loops status` — a fully offline readiness snapshot that needs no GitHub auth
 * (it reports "needs setup" rather than failing), so it is safe in a hermetic CI verify job.
 *
 * `--loop-info --issue <n>` (or `--pr <n>`) additionally runs `dev-loops loop info`, which
 * queries GitHub and therefore needs read access (a token / `gh` auth). Opt-in: skipped by
 * default so the smoke stays secret-free.
 *
 * Usage: node scripts/claude/headless-info-smoke.mjs [--loop-info --issue <n> | --pr <n>]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const opts = { loopInfo: false };
  const requireValue = (name, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--loop-info") opts.loopInfo = true;
    else if (a === "--issue") { opts.issue = requireValue(a, i); i++; }
    else if (a === "--pr") { opts.pr = requireValue(a, i); i++; }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.issue != null && opts.pr != null) {
    throw new Error("--issue and --pr are mutually exclusive");
  }
  return opts;
}

function runCli(cliEntry, repoRoot, args) {
  return spawnSync(process.execPath, [cliEntry, ...args], { cwd: repoRoot, encoding: "utf8" });
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + "\n");
    return 1;
  }
  const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const cliEntry = path.join(repoRoot, "cli", "index.mjs");

  // Offline, secret-free read-only info path — the CI/Docker smoke.
  const statusRes = runCli(cliEntry, repoRoot, ["status"]);
  if (statusRes.status !== 0) {
    process.stderr.write(
      JSON.stringify({ ok: false, error: "headless `dev-loops status` smoke failed", status: statusRes.status, stderr: statusRes.stderr }) + "\n",
    );
    return statusRes.status ?? 1;
  }
  process.stdout.write(statusRes.stdout);

  // Opt-in GitHub-backed info path (needs read access; not run by the hermetic CI smoke).
  if (opts.loopInfo) {
    if (opts.issue == null && opts.pr == null) {
      process.stderr.write(
        JSON.stringify({ ok: false, error: "--loop-info requires an explicit --issue <n> or --pr <n> target" }) + "\n",
      );
      return 1;
    }
    const target = opts.pr ? ["--pr", String(opts.pr)] : ["--issue", String(opts.issue)];
    const infoRes = runCli(cliEntry, repoRoot, ["loop", "info", ...target]);
    if (infoRes.status !== 0) {
      process.stderr.write(
        JSON.stringify({ ok: false, error: "headless `dev-loops loop info` smoke failed (needs GitHub read access)", status: infoRes.status, stderr: infoRes.stderr }) + "\n",
      );
      return infoRes.status ?? 1;
    }
    process.stdout.write(infoRes.stdout);
  }

  process.stdout.write(JSON.stringify({ ok: true, smoke: "headless-info", loopInfo: opts.loopInfo }) + "\n");
  return 0;
}

process.exit(main(process.argv.slice(2)));
