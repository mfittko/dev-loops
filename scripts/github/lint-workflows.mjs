#!/usr/bin/env node
// GitHub-Actions-semantic validation for .github/workflows/*.yml (issue #1409,
// root cause #1385): gate-evidence-workflow.test.mjs only YAML-parses the
// workflow file, so an invalid Actions construct (e.g. the
// `pull_request_review_thread` non-event that #1385 shipped) is syntactically
// valid YAML and slips straight through review. actionlint understands Actions
// semantics (valid `on:` events, expression syntax, permissions, shellcheck of
// `run:` steps) and GitHub rejects the whole workflow server-side on the same
// class of error, so this is the real backstop.
//
// actionlint is a Go binary, not an npm dependency, so it is not guaranteed to
// be on a contributor's PATH. Missing binary -> warn and exit 0 (never blocks
// local `npm run verify` on a tooling-availability gap). A real lint FINDING
// with the binary present -> exit non-zero, same as any other failing verify
// leg. CI always installs the pinned version below, so the enforcement itself
// never has a way to no-op.
import { spawnSync } from "node:child_process";
import { isDirectCliRun } from "../_core-helpers.mjs";
import { resolveRepoRoot } from "../loop/_repo-root-resolver.mjs";

// Keep in sync with the `Install actionlint` step in .github/workflows/ci.yml.
export const ACTIONLINT_VERSION = "1.7.12";

export function runActionlint(args, { cwd = process.cwd(), actionlintBin = "actionlint" } = {}) {
  return spawnSync(actionlintBin, args, { cwd, encoding: "utf8" });
}

function main() {
  const repoRoot = resolveRepoRoot(process.cwd());
  const result = runActionlint([], { cwd: repoRoot });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      console.warn(
        `actionlint not installed — install to lint workflows locally (pinned v${ACTIONLINT_VERSION}: `
        + "https://github.com/rhysd/actionlint/releases); enforced in CI.",
      );
      process.exit(0);
    }
    console.error(`actionlint failed to run: ${result.error.message}`);
    process.exit(1);
  }

  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  process.exit(result.status ?? 1);
}

if (isDirectCliRun(import.meta.url)) main();
