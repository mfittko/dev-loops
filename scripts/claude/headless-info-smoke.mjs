#!/usr/bin/env node
/**
 * Headless read-only dev-loop info smoke (#775).
 *
 * Exercises the read-only `dev-loops loop info` path non-interactively (no LLM, no interactive
 * session, no `@earendil-works/pi-*` required) so CI / the Docker image can verify the headless
 * info surface works. Parallel to the Pi Docker smoke (dual-harness). Exits 0 on success.
 *
 * Usage: node scripts/claude/headless-info-smoke.mjs [--issue <n>] [--pr <n>]
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--issue") opts.issue = argv[++i];
    else if (argv[i] === "--pr") opts.pr = argv[++i];
  }
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);
  const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const cliEntry = path.join(repoRoot, "cli", "index.mjs");

  const target = opts.pr ? ["--pr", String(opts.pr)] : ["--issue", String(opts.issue ?? "775")];
  const res = spawnSync(process.execPath, [cliEntry, "loop", "info", ...target], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (res.status !== 0) {
    process.stderr.write(
      JSON.stringify({ ok: false, error: "headless `dev-loops loop info` smoke failed", status: res.status, stderr: res.stderr }) + "\n",
    );
    return res.status ?? 1;
  }
  process.stdout.write(res.stdout);
  process.stdout.write(JSON.stringify({ ok: true, smoke: "headless-info", target }) + "\n");
  return 0;
}

process.exit(main(process.argv.slice(2)));
