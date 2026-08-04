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
  assert.throws(() => parseRetireGateRoundArgs(["--gate", "draft_gate", "--reason", "x"]), /--head-sha/);
  assert.throws(() => parseRetireGateRoundArgs(["--gate", "draft_gate", "--head-sha", "abc1234", "--reason", "x"]), /FULL 40-char/);
  assert.throws(() => parseRetireGateRoundArgs(["--gate", "draft_gate", "--head-sha", HEAD_A]), /--reason/);
  assert.throws(() => parseRetireGateRoundArgs(["--head-sha", HEAD_A, "--reason", "x"]), /--gate/);
  const parsed = parseRetireGateRoundArgs(["--gate", "draft_gate", "--head-sha", HEAD_A.toUpperCase(), "--reason", "rebuilt", "--findings-dir", "/tmp/x", "--tmp-root", "tmp2"]);
  assert.equal(parsed.headSha, HEAD_A);
  assert.equal(parsed.gate, "draft_gate");
  assert.equal(parsed.findingsDir, "/tmp/x");
  assert.equal(parsed.tmpRoot, "tmp2");
});

test("retire-then-refan: retirement clears the round's sentinels so a fresh run passes at the same head", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-coverage", HEAD_A)), "{}\n", "utf8");
    // A different round's sentinel must be untouched.
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_B)), "{}\n", "utf8");

    const result = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "prefix rebuilt from corrected PR body", tmpRoot });
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
    const result = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "nothing to do", tmpRoot });
    assert.deepEqual(result, { ok: true, gate: "draft_gate", headSha: HEAD_A, retired: 0, sentinels: [], findingsDirRetired: false, retirementDir: null, noop: true });
  });
});

test("retirement moves the findings-artifacts directory when given, keeping it recoverable", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    const findingsDir = path.join(tmpRoot, "gate-findings", "pr-1", `draft_gate-${HEAD_A}`);
    await mkdir(findingsDir, { recursive: true });
    await writeFile(path.join(findingsDir, "scope.json"), JSON.stringify({ angle: "scope", verdict: "clean", findings: [], headSha: HEAD_A }), "utf8");

    const result = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "rebuilt", findingsDir, tmpRoot });
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
    const first = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "first rebuild", tmpRoot });
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    const second = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "second rebuild", tmpRoot });
    assert.notEqual(first.retirementDir, second.retirementDir);
  });
});

test("retired sentinels are invisible to verify-briefing-prefixes' flat round scan", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), JSON.stringify({ prefixHash: "h1" }), "utf8");
    const result = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "rebuilt", tmpRoot });
    assert.equal(result.retired, 1);
    // verify-briefing-prefixes reads sentinels via a flat readdir of the tmp
    // root; after retirement nothing sentinel-shaped remains there for that
    // head, so the old prefix can never mix into a new consolidation.
    const { readdir } = await import("node:fs/promises");
    const flat = (await readdir(tmpRoot)).filter((n) => n.includes(HEAD_A) && n.startsWith("checkpoint-context-sentinel-"));
    assert.deepEqual(flat, []);
  });
});

test("retirement is gate-scoped: the other gate's live round at the same head is never swept", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    await writeFile(path.join(tmpRoot, sentinelName("pre-approval-gate-yagni", HEAD_A)), "{}\n", "utf8");
    const result = await retireGateRound({ gate: "pre_approval_gate", headSha: HEAD_A, reason: "PA rebuild", tmpRoot });
    assert.deepEqual(result.sentinels, [sentinelName("pre-approval-gate-yagni", HEAD_A)]);
    // The draft gate's sentinel is untouched.
    await readFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)));
  });
});

test("an explicitly named --findings-dir that does not exist fails closed", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    await assert.rejects(
      () => retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "typo", findingsDir: path.join(tmpRoot, "nope"), tmpRoot }),
      /not an existing directory/,
    );
    // Fail-closed means nothing moved either.
    await readFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)));
  });
});

test("the retirement sequence is max-based: a deleted earlier round never causes a number reuse", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    // Simulate a surviving round-3 with round-1/2 deleted.
    await mkdir(path.join(tmpRoot, "retired-gate-rounds", HEAD_A, "round-3"), { recursive: true });
    const result = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "gap", tmpRoot });
    assert.equal(path.basename(result.retirementDir), "round-4");
  });
});

test("CLI entry point: help, arg errors, success, and invalid --jq map to the documented exit codes", async () => {
  const { spawnSync } = await import("node:child_process");
  const scriptPath = path.resolve("scripts/github/retire-gate-round.mjs");
  const run = (args, cwd) => spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: "utf8" });
  await withTmpRoot(async (tmpRoot) => {
    const help = run(["--help"], tmpRoot);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /rebuild-and-retire/);

    const argErr = run(["--head-sha", HEAD_A, "--reason", "x"], tmpRoot);
    assert.equal(argErr.status, 1);
    assert.match(argErr.stderr, /--gate/);

    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    const okRun = run(["--gate", "draft_gate", "--head-sha", HEAD_A, "--reason", "cli test", "--tmp-root", "."], tmpRoot);
    assert.equal(okRun.status, 0, okRun.stderr);
    assert.equal(JSON.parse(okRun.stdout).retired, 1);

    const badJq = run(["--gate", "draft_gate", "--head-sha", HEAD_A, "--reason", "x", "--tmp-root", ".", "--jq", "((("], tmpRoot);
    assert.equal(badJq.status, 2);
  });
});

test("retireGateRound re-validates headSha and reason at the function boundary", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await assert.rejects(
      () => retireGateRound({ gate: "draft_gate", headSha: "abc1234", reason: "x", tmpRoot }),
      /FULL 40-char/,
    );
    await assert.rejects(
      () => retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "   ", tmpRoot }),
      /non-empty string/,
    );
  });
});
