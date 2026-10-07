import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { writeGateFindingsLog } from "../../scripts/github/write-gate-findings-log.mjs";

const HEAD = "abc1234567890abcdef000000000000000000000";
const ESCALATION = { surfaceKey: { file: "src/guard.mjs", symbol: "isSameDefect" }, rounds: 3, heads: ["1".repeat(40), "2".repeat(40), HEAD], fingerprint: "fp1", summary: "s" };

async function writeLog(wrapper) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "gate-findings-escalations-"));
  try {
    const run = () => writeGateFindingsLog({
      repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: HEAD, verdict: "findings_present",
      findings: JSON.stringify(wrapper), tmpRoot: tmpDir,
    });
    return { run, read: async () => JSON.parse(await readFile(path.join(tmpDir, "gate-findings", "owner-repo", "pr-42", `draft_gate-${HEAD}.json`), "utf8")), done: () => rm(tmpDir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(tmpDir, { recursive: true, force: true });
    throw error;
  }
}

const FINDINGS = [{ severity: "low", angle: "scope", summary: "a gap" }];

test("the wrapper's escalations[] reach the durable gate-findings ledger", async () => {
  const c = await writeLog({ overallVerdict: "findings_present", findings: FINDINGS, escalations: [ESCALATION] });
  try {
    await c.run();
    assert.deepEqual((await c.read()).escalations, [ESCALATION]);
  } finally { await c.done(); }
});

test("a wrapper without escalations writes a ledger without the field", async () => {
  const c = await writeLog({ overallVerdict: "findings_present", findings: FINDINGS });
  try {
    await c.run();
    assert.equal("escalations" in (await c.read()), false);
  } finally { await c.done(); }
});

test("a malformed escalations[] fails closed", async () => {
  const c = await writeLog({ overallVerdict: "findings_present", findings: FINDINGS, escalations: ["x"] });
  try {
    await assert.rejects(c.run(), /escalations/);
  } finally { await c.done(); }
});
