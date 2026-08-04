import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { retireGateRound, parseRetireGateRoundArgs } from "../../scripts/github/retire-gate-round.mjs";

const HEAD_A = "a1".repeat(20);
const HEAD_B = "b2".repeat(20);

async function withTmpRoot(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "retire-gate-round-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function sentinelName(scope, head) {
  return `checkpoint-context-sentinel-${scope}-${head}.json`;
}

test("parseRetireGateRoundArgs requires a full head SHA and a reason", () => {
  assert.throws(() => parseRetireGateRoundArgs(["--reason", "x"]), /--head-sha/);
  assert.throws(() => parseRetireGateRoundArgs(["--head-sha", "abc1234", "--reason", "x"]), /FULL 40-char/);
  assert.throws(() => parseRetireGateRoundArgs(["--head-sha", HEAD_A]), /--reason/);
  const parsed = parseRetireGateRoundArgs(["--head-sha", HEAD_A.toUpperCase(), "--reason", "rebuilt"]);
  assert.equal(parsed.headSha, HEAD_A);
});

test("retire-then-refan: retirement clears the round's sentinels so a fresh run passes at the same head", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-coverage", HEAD_A)), "{}\n", "utf8");
    // A different round's sentinel must be untouched.
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_B)), "{}\n", "utf8");

    const result = await retireGateRound({ headSha: HEAD_A, reason: "prefix rebuilt from corrected PR body", tmpRoot });
    assert.equal(result.retired, 2);
    assert.equal(result.noop, false);

    // The retired sentinels are out of the live namespace; the other round's stays.
    await assert.rejects(() => readFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A))));
    await readFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_B)));

    // The audit record names head, reason, and moved sentinels.
    const record = JSON.parse(await readFile(path.join(result.retirementDir, "retirement.json"), "utf8"));
    assert.equal(record.headSha, HEAD_A);
    assert.equal(record.reason, "prefix rebuilt from corrected PR body");
    assert.deepEqual(record.sentinels.sort(), [
      sentinelName("draft-gate-coverage", HEAD_A),
      sentinelName("draft-gate-scope", HEAD_A),
    ]);

    // Re-fan at the same head: writing a fresh sentinel at the old path works
    // (nothing left to collide with), modelling verify-fresh-review-context's
    // atomic create.
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", { flag: "wx" });
  });
});

test("retirement of a head with no sentinels is a no-op, not an error", async () => {
  await withTmpRoot(async (tmpRoot) => {
    const result = await retireGateRound({ headSha: HEAD_A, reason: "nothing to do", tmpRoot });
    assert.deepEqual(result, { ok: true, headSha: HEAD_A, retired: 0, sentinels: [], findingsDirRetired: false, retirementDir: null, noop: true });
  });
});

test("retirement moves the findings-artifacts directory when given, keeping it recoverable", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    const findingsDir = path.join(tmpRoot, "gate-findings", "pr-1", `draft_gate-${HEAD_A}`);
    await mkdir(findingsDir, { recursive: true });
    await writeFile(path.join(findingsDir, "scope.json"), JSON.stringify({ angle: "scope", verdict: "clean", findings: [], headSha: HEAD_A }), "utf8");

    const result = await retireGateRound({ headSha: HEAD_A, reason: "rebuilt", findingsDir, tmpRoot });
    assert.equal(result.findingsDirRetired, true);
    // Explicit discard: the artifacts are out of the live fan-in path but
    // recoverable from the retirement directory (the explicit carry).
    await assert.rejects(() => readFile(path.join(findingsDir, "scope.json")));
    const moved = JSON.parse(await readFile(path.join(result.retirementDir, "findings-artifacts", "scope.json"), "utf8"));
    assert.equal(moved.angle, "scope");
  });
});

test("repeated retirements at the same head get distinct audited directories", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    const first = await retireGateRound({ headSha: HEAD_A, reason: "first rebuild", tmpRoot });
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    const second = await retireGateRound({ headSha: HEAD_A, reason: "second rebuild", tmpRoot });
    assert.notEqual(first.retirementDir, second.retirementDir);
  });
});

test("retired sentinels are invisible to verify-briefing-prefixes' flat round scan", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), JSON.stringify({ prefixHash: "h1" }), "utf8");
    const result = await retireGateRound({ headSha: HEAD_A, reason: "rebuilt", tmpRoot });
    assert.equal(result.retired, 1);
    // verify-briefing-prefixes reads sentinels via a flat readdir of the tmp
    // root; after retirement nothing sentinel-shaped remains there for that
    // head, so the old prefix can never mix into a new consolidation.
    const { readdir } = await import("node:fs/promises");
    const flat = (await readdir(tmpRoot)).filter((n) => n.includes(HEAD_A) && n.startsWith("checkpoint-context-sentinel-"));
    assert.deepEqual(flat, []);
  });
});
