import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { judgePassCli, parseJudgePassCliArgs } from "../../scripts/loop/judge-pass.mjs";
import { judgeSkipRefusal } from "../../scripts/loop/judge-skip.mjs";

const HEAD = "0123456789abcdef".padEnd(40, "0");
const SPEC = { acceptanceCriteria: ["a"], definitionOfDone: ["d"], nonGoals: ["n"] };

async function setup(findings) {
  const root = await mkdtemp(path.join(os.tmpdir(), "judge-skip-"));
  await writeFile(path.join(root, "findings.json"), JSON.stringify({ overallVerdict: "clean", findings }));
  await writeFile(path.join(root, "spec.json"), JSON.stringify(SPEC));
  const options = parseJudgePassCliArgs([
    "--repo", "o/r", "--pr", "1", "--gate", "draft_gate", "--head-sha", HEAD, "--judge-skip",
    "--findings-file", "findings.json", "--ledger-out", "ledger.json", "--out", "act.json",
    "--spec-file", "spec.json", "--content-digest", `sha256:${"a".repeat(64)}`, "--tmp-root", "tmp",
  ]);
  return { root, options };
}

test("GATE-EXEC-JUDGE-SKIP-EMPTY: a zero-finding round skips the judge and records the skip, scope drift and notice", async () => {
  const { root, options } = await setup([]);
  const result = await judgePassCli(options, { repoRoot: root });
  assert.equal(result.ok, true);
  assert.match(result.judgeSkipped.reason, /nothing for the judge/);
  assert.equal(result.scopeDrift.verdict, "within_scope");
  assert.match(result.scopeDrift.rationale, /spec identity sha256:/);
  assert.match(result.findingsSummary, /Judge skipped: .*no consolidated findings/);
  const ledger = JSON.parse(await readFile(path.join(root, "ledger.json"), "utf8"));
  assert.equal(ledger.overallVerdict, "clean");
  assert.deepEqual(ledger.findings, []);
  assert.ok(ledger.judgeSkipped.reason);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "act.json"), "utf8")), []);
});

test("a round with a finding still requires the judge", async () => {
  const { root, options } = await setup([{ severity: "low", angle: "x", summary: "s", disposition: "unjudged" }]);
  await assert.rejects(judgePassCli(options, { repoRoot: root }), /judge-skip refused.*1 consolidated finding/);
});

test("a carried act item still requires the judge", () => {
  assert.match(judgeSkipRefusal({ findings: [], priorActItems: [{ fingerprint: "f" }] }), /carried act item/);
  assert.equal(judgeSkipRefusal({ findings: [], priorActItems: [] }), null);
});

test("an escalation needs a finding, so it still requires the judge", () => {
  const escalating = { severity: "medium", summary: "recurs", judgeDisposition: "act" };
  assert.match(judgeSkipRefusal({ findings: [escalating], priorActItems: [{ fingerprint: "f" }] }), /consolidated finding/);
});

test("--judge-skip refuses judge artifact flags", () => {
  assert.throws(() => parseJudgePassCliArgs(["--repo", "o/r", "--pr", "1", "--gate", "draft_gate", "--head-sha", HEAD, "--judge-skip", "--findings-file", "f.json", "--judge-verdict", "v.json"]), /judge-skip takes no --judge-verdict/);
});
