import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { declaredGateOf, evaluateBriefingPrefixes } from "../../scripts/github/verify-briefing-prefixes.mjs";

const checkerPath = path.resolve("scripts/github/verify-briefing-prefixes.mjs");
const contextGuardPath = path.resolve("scripts/github/verify-fresh-review-context.mjs");

function runChecker(args = [], opts = {}) {
  return spawnSync("node", [checkerPath, ...args], { encoding: "utf8", ...opts });
}

function runContextGuard(args = [], opts = {}) {
  return spawnSync("node", [contextGuardPath, ...args], { encoding: "utf8", ...opts });
}

function makeGit(tmpDir) {
  // Scrub inherited global/system git config so commit signing/hooks on the host
  // cannot make these tests flaky (mirrors verify-fresh-review-context.test.mjs).
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  return (args) => {
    const r = spawnSync("git", args, { cwd: tmpDir, encoding: "utf8", env: gitEnv });
    assert.equal(r.status, 0, r.stderr);
    return r;
  };
}

// mkdtemp + guaranteed cleanup, for CLI tests that only need a scratch cwd.
async function withTmpDir(fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-briefing-prefixes-"));
  try {
    return await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Writes an on-disk per-gate briefing-prefix record (as write-gate-context.mjs
// would) and returns its sha256 for use as a sentinel's recorded prefixHash.
async function writeBriefingRecord(tmpDir, gate, sha, bytes) {
  const gateContextDir = path.join(tmpDir, "tmp", "gate-context", "mfittko-dev-loops", "pr-1");
  await mkdir(gateContextDir, { recursive: true });
  await writeFile(path.join(gateContextDir, `${gate}-${sha}.briefing-prefix.txt`), bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

// Writes a reviewer sentinel (as verify-fresh-review-context.mjs would).
async function writeSentinel(tmpDir, scope, sha, prefixHash) {
  await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
  await writeFile(
    path.join(tmpDir, "tmp", `checkpoint-context-sentinel-${scope}-${sha}.json`),
    JSON.stringify({ scope, prefixHash }),
  );
}

// ---------------------------------------------------------------------------
// Pure function unit tests (no filesystem/subprocess).
// ---------------------------------------------------------------------------

test("evaluateBriefingPrefixes: zero sentinels is trivially verified (nothing to check)", () => {
  assert.deepEqual(evaluateBriefingPrefixes([]), { verified: true, reason: "no sentinels found for this round" });
});

test("evaluateBriefingPrefixes: a single HASHED sentinel verifies (nothing to mismatch)", () => {
  const one = evaluateBriefingPrefixes([{ scope: "a", prefixHash: "h1" }]);
  assert.equal(one.verified, true);
  assert.equal(one.prefixHash, "h1");
});

test("evaluateBriefingPrefixes: a single HASHLESS sentinel fails closed (one-angle retry round, never grandfathered)", () => {
  const result = evaluateBriefingPrefixes([{ scope: "a", prefixHash: null }]);
  assert.equal(result.verified, false);
  assert.deepEqual(result.missing, ["a"]);
});

test("evaluateBriefingPrefixes: identical hashes across distinct scopes verify (positive case)", () => {
  const result = evaluateBriefingPrefixes([
    { scope: "scope-a", prefixHash: "same-hash" },
    { scope: "scope-b", prefixHash: "same-hash" },
    { scope: "scope-c", prefixHash: "same-hash" },
  ]);
  assert.equal(result.verified, true);
  assert.equal(result.prefixHash, "same-hash");
});

test("evaluateBriefingPrefixes: different hashes fail closed (negative case)", () => {
  const result = evaluateBriefingPrefixes([
    { scope: "scope-a", prefixHash: "hash-1" },
    { scope: "scope-b", prefixHash: "hash-2" },
  ]);
  assert.equal(result.verified, false);
  assert.ok(result.reason.includes("DIFFERENT"));
  assert.equal(result.mismatched.length, 2);
});

test("evaluateBriefingPrefixes: two gates at one head, each matching its own record, both PASS (issue #1246 regression)", () => {
  const records = new Map([["hash-draft", new Set(["draft_gate"])], ["hash-preapproval", new Set(["pre_approval_gate"])]]);
  const result = evaluateBriefingPrefixes([
    { scope: "draft-gate-coverage", prefixHash: "hash-draft" },
    { scope: "draft-gate-correctness", prefixHash: "hash-draft" },
    { scope: "pre-approval-gate-yagni", prefixHash: "hash-preapproval" },
    { scope: "pre-approval-gate-kiss", prefixHash: "hash-preapproval" },
  ], records);
  assert.equal(result.verified, true);
  const byGate = Object.fromEntries(result.gates.map((g) => [g.gate, g.prefixHash]));
  assert.deepEqual(byGate, { draft_gate: "hash-draft", pre_approval_gate: "hash-preapproval" });
});

test("evaluateBriefingPrefixes: a sentinel hash matching NO record fails closed (contaminated/stale briefing, not masked)", () => {
  const records = new Map([["hash-draft", new Set(["draft_gate"])]]);
  const result = evaluateBriefingPrefixes([
    { scope: "draft-gate-coverage", prefixHash: "hash-draft" },
    { scope: "correctness", prefixHash: "hash-bad" }, // bare/stray scope must NOT let it self-verify
  ], records);
  assert.equal(result.verified, false);
  assert.ok(result.reason.includes("matches no gate briefing-prefix record"));
  assert.deepEqual(result.mismatched.map((m) => m.prefixHash), ["hash-bad"]);
});

test("evaluateBriefingPrefixes: a missing hash still fails closed even with records present", () => {
  const records = new Map([["hash-draft", new Set(["draft_gate"])]]);
  const result = evaluateBriefingPrefixes([
    { scope: "draft-gate-coverage", prefixHash: "hash-draft" },
    { scope: "draft-gate-correctness", prefixHash: null },
  ], records);
  assert.equal(result.verified, false);
  assert.deepEqual(result.missing, ["draft-gate-correctness"]);
});

test("evaluateBriefingPrefixes: single gate with a record emits prefixHash and a gates entry with reviewerCount", () => {
  const records = new Map([["hash-draft", new Set(["draft_gate"])]]);
  const result = evaluateBriefingPrefixes([
    { scope: "draft-gate-coverage", prefixHash: "hash-draft" },
    { scope: "draft-gate-correctness", prefixHash: "hash-draft" },
  ], records);
  assert.equal(result.verified, true);
  assert.equal(result.prefixHash, "hash-draft");
  assert.deepEqual(result.gates, [{ gate: "draft_gate", prefixHash: "hash-draft", reviewerCount: 2 }]);
});

test("evaluateBriefingPrefixes: a sentinel whose scope declares one gate but whose hash matches a DIFFERENT gate's record fails closed (wrong-gate briefing)", () => {
  const records = new Map([["hash-draft", new Set(["draft_gate"])], ["hash-preapproval", new Set(["pre_approval_gate"])]]);
  const result = evaluateBriefingPrefixes([
    { scope: "draft-gate-coverage", prefixHash: "hash-draft" },
    { scope: "draft-gate-correctness", prefixHash: "hash-preapproval" }, // wrong-gate: draft scope, pre-approval hash
  ], records);
  assert.equal(result.verified, false);
  assert.ok(result.reason.includes("DIFFERENT gate"));
  assert.deepEqual(result.mismatched.map((m) => m.prefixHash), ["hash-preapproval"]);
});

test("evaluateBriefingPrefixes: a bare (ungated) scope matches by hash alone and does not trigger the wrong-gate check", () => {
  const records = new Map([["hash-draft", new Set(["draft_gate"])]]);
  const result = evaluateBriefingPrefixes([
    { scope: "coverage", prefixHash: "hash-draft" },
  ], records);
  assert.equal(result.verified, true);
});

test("evaluateBriefingPrefixes: wrong-gate briefing fails closed even when the declared gate has no record this round (single-gate round)", () => {
  const records = new Map([["hash-draft", new Set(["draft_gate"])]]); // only draft has recorded this round
  const result = evaluateBriefingPrefixes([
    { scope: "draft-gate-coverage", prefixHash: "hash-draft" },
    { scope: "pre-approval-gate-mistaken", prefixHash: "hash-draft" }, // mis-scoped for an absent gate
  ], records);
  assert.equal(result.verified, false);
  assert.ok(result.reason.includes("DIFFERENT gate"));
  assert.deepEqual(result.mismatched.map((m) => m.scope), ["pre-approval-gate-mistaken"]);
});

test("evaluateBriefingPrefixes: within-gate byte-identity fails closed when one gate has two distinct hashes (AC2)", () => {
  const records = new Map([["h1", new Set(["draft_gate"])], ["h2", new Set(["draft_gate"])]]);
  const result = evaluateBriefingPrefixes([
    { scope: "draft-gate-a", prefixHash: "h1" },
    { scope: "draft-gate-b", prefixHash: "h2" },
  ], records);
  assert.equal(result.verified, false);
  assert.ok(result.reason.includes("within-gate") || result.reason.includes("DIFFERENT"));
});

test("evaluateBriefingPrefixes: a hash valid for multiple gates passes for a scope declaring one of them", () => {
  const records = new Map([["hx", new Set(["draft_gate", "pre_approval_gate"])]]);
  const ok = evaluateBriefingPrefixes([{ scope: "draft-gate-a", prefixHash: "hx" }], records);
  assert.equal(ok.verified, true);
});

test("declaredGateOf: matches the canonical gate vocabulary and returns null for bare scopes", () => {
  assert.equal(declaredGateOf("draft-gate-coverage"), "draft_gate");
  assert.equal(declaredGateOf("pre-approval-gate-yagni"), "pre_approval_gate");
  assert.equal(declaredGateOf("coverage"), null);
});

test("declaredGateOf: uses the LONGEST matching prefix (prefix-extending gate names)", () => {
  const vocab = ["draft_gate", "draft_gate_v2"];
  assert.equal(declaredGateOf("draft-gate-v2-correctness", vocab), "draft_gate_v2");
  assert.equal(declaredGateOf("draft-gate-coverage", vocab), "draft_gate");
});

test("declaredGateOf: matches case-insensitively (mixed-case scope still declares its gate)", () => {
  assert.equal(declaredGateOf("Pre-Approval-Gate-Correctness"), "pre_approval_gate");
  assert.equal(declaredGateOf("DRAFT-GATE-coverage"), "draft_gate");
});

test("evaluateBriefingPrefixes: a mixed-case wrong-gate scope still fails closed (case-insensitive)", () => {
  const records = new Map([["hash-draft", new Set(["draft_gate"])]]);
  const result = evaluateBriefingPrefixes([
    { scope: "Pre-Approval-Gate-x", prefixHash: "hash-draft" }, // declares pre_approval but hash is draft's
  ], records);
  assert.equal(result.verified, false);
  assert.ok(result.reason.includes("DIFFERENT gate"));
});

test("evaluateBriefingPrefixes: no records -> flat fallback, two distinct hashes fail closed", () => {
  const result = evaluateBriefingPrefixes([
    { scope: "a", prefixHash: "h1" },
    { scope: "b", prefixHash: "h2" },
  ]);
  assert.equal(result.verified, false);
  assert.ok(result.reason.includes("DIFFERENT"));
});

test("evaluateBriefingPrefixes: no records -> flat fallback, identical hashes verify", () => {
  const result = evaluateBriefingPrefixes([
    { scope: "a", prefixHash: "same" },
    { scope: "b", prefixHash: "same" },
  ]);
  assert.equal(result.verified, true);
  assert.equal(result.prefixHash, "same");
});

test("evaluateBriefingPrefixes: a missing hash fails closed even when other hashes agree (fail-closed, not grandfathered)", () => {
  const result = evaluateBriefingPrefixes([
    { scope: "scope-a", prefixHash: "same-hash" },
    { scope: "scope-b", prefixHash: "same-hash" },
    { scope: "scope-c", prefixHash: null },
  ]);
  assert.equal(result.verified, false);
  assert.deepEqual(result.missing, ["scope-c"]);
});

test("verify-briefing-prefixes --help prints usage and exits 0", () => {
  const result = runChecker(["--help"]);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes("verify-briefing-prefixes.mjs"));
});

test("verify-briefing-prefixes --head-sha is required", () => {
  const result = runChecker([]);
  assert.equal(result.status, 2);
});

test("verify-briefing-prefixes rejects a malformed --head-sha", () => {
  const result = runChecker(["--head-sha", "not-hex!"]);
  assert.equal(result.status, 2, result.stderr);
});

test("verify-briefing-prefixes rejects a SHORT head SHA (would glob zero sentinels and pass vacuously)", () => {
  const result = runChecker(["--head-sha", "abc1234"]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /FULL 40- or 64-character/);
});

const FULL_TEST_SHA = "abc1234abc1234abc1234abc1234abc1234abc12";
const FULL_TEST_SHA_256 = "d4".repeat(32);

test("verify-briefing-prefixes accepts a 64-hex (SHA-256) head SHA (#1652)", async () => {
  await withTmpDir(async (tmpDir) => {
    const result = runChecker(["--head-sha", FULL_TEST_SHA_256], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
  });
});

test("verify-briefing-prefixes exits 0 with reviewerCount 0 when no sentinels exist for the head SHA", async () => {
  await withTmpDir(async (tmpDir) => {
    const result = runChecker(["--head-sha", FULL_TEST_SHA], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.verified, true);
    assert.equal(output.reviewerCount, 0);
  });
});

test("verify-briefing-prefixes treats a malformed (non-sha256) recorded hash as missing and fails closed", async () => {
  await withTmpDir(async (tmpDir) => {
    await writeSentinel(tmpDir, "correctness", FULL_TEST_SHA, "not-a-real-hash");
    const result = runChecker(["--head-sha", FULL_TEST_SHA], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.verified, false);
    assert.deepEqual(output.missing, ["correctness"]);
  });
});

test("verify-briefing-prefixes: two gates at one head both pass via CLI, verified against on-disk records (issue #1246 regression)", async () => {
  await withTmpDir(async (tmpDir) => {
    const H1 = await writeBriefingRecord(tmpDir, "draft_gate", FULL_TEST_SHA, "DRAFT BRIEFING");
    const H2 = await writeBriefingRecord(tmpDir, "pre_approval_gate", FULL_TEST_SHA, "PREAPPROVAL BRIEFING");
    const sentinels = [
      ["draft-gate-coverage", H1],
      ["draft-gate-correctness", H1],
      ["pre-approval-gate-yagni", H2],
      ["pre-approval-gate-kiss", H2],
    ];
    for (const [scope, prefixHash] of sentinels) {
      await writeSentinel(tmpDir, scope, FULL_TEST_SHA, prefixHash);
    }
    const result = runChecker(["--head-sha", FULL_TEST_SHA], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.verified, true);
    assert.equal(output.reviewerCount, 4);
    const byGate = Object.fromEntries(output.gates.map((g) => [g.gate, g.prefixHash]));
    assert.deepEqual(byGate, { draft_gate: H1, pre_approval_gate: H2 });
  });
});

test("verify-briefing-prefixes: a sentinel hash matching no on-disk gate record fails closed via CLI", async () => {
  await withTmpDir(async (tmpDir) => {
    const H1 = await writeBriefingRecord(tmpDir, "draft_gate", FULL_TEST_SHA, "DRAFT BRIEFING");
    const H2 = await writeBriefingRecord(tmpDir, "pre_approval_gate", FULL_TEST_SHA, "PREAPPROVAL BRIEFING");
    const BOGUS = "c".repeat(64);
    const sentinels = [
      ["draft-gate-coverage", H1],
      ["draft-gate-correctness", BOGUS],
      ["pre-approval-gate-yagni", H2],
      ["pre-approval-gate-kiss", H2],
    ];
    for (const [scope, prefixHash] of sentinels) {
      await writeSentinel(tmpDir, scope, FULL_TEST_SHA, prefixHash);
    }
    const result = runChecker(["--head-sha", FULL_TEST_SHA], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.verified, false);
    assert.ok(output.reason.includes("matches no gate briefing-prefix record"));
  });
});

test("verify-briefing-prefixes: a wrong-gate briefing (scope declares one gate, hash belongs to another) fails closed via CLI", async () => {
  await withTmpDir(async (tmpDir) => {
    const H_DRAFT = await writeBriefingRecord(tmpDir, "draft_gate", FULL_TEST_SHA, "DRAFT BRIEFING");
    await writeBriefingRecord(tmpDir, "pre_approval_gate", FULL_TEST_SHA, "PREAPPROVAL BRIEFING");
    await writeSentinel(tmpDir, "draft-gate-coverage", FULL_TEST_SHA, H_DRAFT);
    // wrong-gate: declares pre-approval, hash is draft's
    await writeSentinel(tmpDir, "pre-approval-gate-mistaken", FULL_TEST_SHA, H_DRAFT);
    const result = runChecker(["--head-sha", FULL_TEST_SHA], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.verified, false);
    assert.ok(output.reason.includes("DIFFERENT gate"));
    assert.ok(output.mismatched.some((m) => m.scope === "pre-approval-gate-mistaken"));
  });
});

test("verify-briefing-prefixes: identical-byte records under different gates attribute deterministically to the first gate (CLI)", async () => {
  await withTmpDir(async (tmpDir) => {
    await writeBriefingRecord(tmpDir, "draft_gate", FULL_TEST_SHA, "IDENTICAL");
    const H = await writeBriefingRecord(tmpDir, "pre_approval_gate", FULL_TEST_SHA, "IDENTICAL");
    await writeSentinel(tmpDir, "coverage", FULL_TEST_SHA, H);
    const result = runChecker(["--head-sha", FULL_TEST_SHA], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.verified, true);
    assert.equal(output.gates[0].gate, "draft_gate");
  });
});

test("verify-briefing-prefixes: a stray non-canonical-gate briefing record is ignored (fails closed)", async () => {
  await withTmpDir(async (tmpDir) => {
    await writeBriefingRecord(tmpDir, "draft_gate", FULL_TEST_SHA, "DRAFT");
    const strayHash = await writeBriefingRecord(tmpDir, "bogus_gate", FULL_TEST_SHA, "STRAY");
    await writeSentinel(tmpDir, "coverage", FULL_TEST_SHA, strayHash);
    const result = runChecker(["--head-sha", FULL_TEST_SHA], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.verified, false);
    assert.ok(output.reason.includes("matches no gate briefing-prefix record"));
  });
});

// ---------------------------------------------------------------------------
// Dogfood-style integration (issue #1207 AC3): simulate the exact live flow —
// write two reviewer sentinels via the REAL verify-fresh-review-context.mjs
// CLI (not hand-rolled fixtures), keyed to a real git head SHA, then run the
// checker against that round.
// ---------------------------------------------------------------------------

test("integration: two reviewers seeded from the SAME prefix file via the real CLI verify clean", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-briefing-prefixes-int-"));
  const git = makeGit(tmpDir);
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "t"]);
    await writeFile(path.join(tmpDir, "a.txt"), "1", "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "c1"]);
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const headSha = git(["rev-parse", "HEAD"]).stdout.trim();

    await writeFile(path.join(tmpDir, "prefix.txt"), "repo/PR/head-sha invariant block", "utf8");

    const r1 = runContextGuard(["--scope", "scope-safety", "--prefix-file", "prefix.txt"], { cwd: tmpDir });
    assert.equal(r1.status, 0, r1.stderr);
    const r2 = runContextGuard(["--scope", "scope-correctness", "--prefix-file", "prefix.txt"], { cwd: tmpDir });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(JSON.parse(r1.stdout.trim()).prefixHash, JSON.parse(r2.stdout.trim()).prefixHash);

    const result = runChecker(["--head-sha", headSha], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.verified, true);
    assert.equal(output.reviewerCount, 2);
    assert.equal(output.prefixHash, JSON.parse(r1.stdout.trim()).prefixHash);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("integration: two reviewers seeded from DIFFERENT prefix content via the real CLI fail closed", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-briefing-prefixes-int-"));
  const git = makeGit(tmpDir);
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "t"]);
    await writeFile(path.join(tmpDir, "a.txt"), "1", "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "c1"]);
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const headSha = git(["rev-parse", "HEAD"]).stdout.trim();

    await writeFile(path.join(tmpDir, "prefix-a.txt"), "invariant block, version A", "utf8");
    await writeFile(path.join(tmpDir, "prefix-b.txt"), "invariant block, version B (angle text leaked in!)", "utf8");

    const r1 = runContextGuard(["--scope", "scope-safety", "--prefix-file", "prefix-a.txt"], { cwd: tmpDir });
    assert.equal(r1.status, 0, r1.stderr);
    const r2 = runContextGuard(["--scope", "scope-correctness", "--prefix-file", "prefix-b.txt"], { cwd: tmpDir });
    assert.equal(r2.status, 0, r2.stderr);

    const result = runChecker(["--head-sha", headSha], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.verified, false);
    assert.equal(output.reviewerCount, 2);
    assert.ok(output.reason.includes("DIFFERENT"));
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("integration: a reviewer sentinel with no recorded prefix hash fails closed even though the others agree", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-briefing-prefixes-int-"));
  const git = makeGit(tmpDir);
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "t"]);
    await writeFile(path.join(tmpDir, "a.txt"), "1", "utf8");
    git(["add", "-A"]);
    git(["commit", "-qm", "c1"]);
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    const headSha = git(["rev-parse", "HEAD"]).stdout.trim();

    await writeFile(path.join(tmpDir, "prefix.txt"), "shared invariant block", "utf8");

    const r1 = runContextGuard(["--scope", "scope-safety", "--prefix-file", "prefix.txt"], { cwd: tmpDir });
    assert.equal(r1.status, 0, r1.stderr);
    // scope-legacy never records a prefix hash (a legacy/pre-#1618 sentinel, or
    // one a caller never seeded with a prefix). #1618 made a prefix hash
    // mandatory on every CLI run, so a hashless sentinel can no longer be
    // CREATED via the tool — write it directly to disk to simulate the legacy
    // case. It must NOT be silently grandfathered in.
    await writeFile(
      path.join(tmpDir, "tmp", `checkpoint-context-sentinel-scope-legacy-${headSha}.json`),
      JSON.stringify({ scope: "scope-legacy", createdAt: "legacy" }) + "\n",
      "utf8",
    );

    const result = runChecker(["--head-sha", headSha], { cwd: tmpDir });
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.verified, false);
    assert.deepEqual(output.missing, ["scope-legacy"]);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
