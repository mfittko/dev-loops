import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "bun:test";
import { initGitFixture } from "../_helpers.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

// Every script that used to relax a gate on a config load error. Each one must
// exit non-zero with a typed config_load_failed outcome before any gh read.
// request-copilot-review, write-gate-context and detect-checkpoint-evidence need
// gh stubs and carry their own fail-closed tests next to their suites.
const RELAX_TABLE = [
  ["scripts/loop/detect-pr-gate-coordination-state.mjs", ["--repo", "o/r", "--pr", "1"]],
  ["scripts/loop/detect-copilot-loop-state.mjs", ["--input", "in.json"]],
  ["scripts/loop/copilot-pr-handoff.mjs", ["--repo", "o/r", "--pr", "1"]],
  ["scripts/github/write-gate-findings-log.mjs", ["--repo", "o/r", "--pr", "1", "--gate", "draft_gate", "--head-sha", SHA_A, "--execution-mode", "fanout_fanin", "--verdict", "clean", "--findings", "[]"]],
  ["scripts/github/resolve-angle-carry-forward.mjs", ["--repo", "o/r", "--pr", "1", "--gate", "draft_gate", "--prev-head", SHA_A, "--head-sha", SHA_B]],
  ["scripts/loop/resolve-gate-dispatch.mjs", ["--gate", "draft"]],
  ["scripts/github/emit-fanout-dispatch.mjs", ["--repo", "o/r", "--pr", "1", "--gate", "draft_gate", "--head-sha", SHA_A]],
  ["scripts/github/reconcile-draft-gate.mjs", ["--repo", "o/r", "--pr", "1"]],
  ["scripts/loop/emit-judge-work-order.mjs", ["--repo", "o/r", "--pr", "1", "--gate", "draft_gate", "--head-sha", SHA_A, "--findings-file", "f", "--spec-file", "s", "--identity-file", "i"]],
  ["scripts/loop/build-handoff-envelope.mjs", ["--input", "in.json"]],
  ["scripts/github/ready-for-review.mjs", ["--repo", "o/r", "--pr", "1"]],
];

let fixture;
beforeAll(() => {
  fixture = mkdtempSync(path.join(os.tmpdir(), "config-fail-closed-"));
  mkdirSync(path.join(fixture, "bin"));
  // A gh that always fails: a script that reads GitHub before the config gate
  // would report a gh error instead of config_load_failed.
  writeFileSync(path.join(fixture, "bin", "gh"), "#!/bin/sh\necho 'gh stub: no network' >&2\nexit 1\n");
  chmodSync(path.join(fixture, "bin", "gh"), 0o755);
  writeFileSync(path.join(fixture, ".devloops"), "version: 1\nfutureKnob: true\n");
  writeFileSync(path.join(fixture, "in.json"), "{}");
  initGitFixture(fixture);
});
afterAll(() => rmSync(fixture, { recursive: true, force: true }));

describe("a config load error fails closed instead of using defaults", () => {
  for (const [script, args] of RELAX_TABLE) {
    test(script, () => {
      const result = spawnSync("node", [path.resolve(script), ...args], {
        cwd: fixture,
        encoding: "utf8",
        env: { ...process.env, PATH: `${path.join(fixture, "bin")}${path.delimiter}${process.env.PATH}` },
      });
      assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /config_load_failed/);
      const jsonLines = `${result.stdout}\n${result.stderr}`.split("\n").filter((l) => l.startsWith("{"));
      const payload = JSON.parse(jsonLines.at(-1));
      assert.equal(payload.code, "config_load_failed");
      assert.ok(payload.configError.unknownKeys.includes("futureKnob"));
    });
  }
});
