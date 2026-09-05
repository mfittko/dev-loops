import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const composeCliPath = path.resolve("scripts/github/compose-reviewer-prompt.mjs");
const verifyCliPath = path.resolve("scripts/github/verify-dispatch-prompt-layout.mjs");

function runComposeCli(args = [], opts = {}) {
  return spawnSync("node", [composeCliPath, ...args], { encoding: "utf8", ...opts });
}

function runVerifyCli(args = [], opts = {}) {
  return spawnSync("node", [verifyCliPath, ...args], { encoding: "utf8", ...opts });
}

async function withTmpDir(fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-compose-reviewer-prompt-"));
  try {
    return await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const HEAD_SHA = "b".repeat(40);
const GATE = "draft_gate";
const REPO = "o/r";
const PR = "1";
const PREFIX_BYTES = "## Invariant prefix\nrepo: o/r\nhead: b\n";
const VOLATILE_BYTES = "# volatile tail\ngate: draft_gate\n";

async function seedGateContext(tmpDir, { withVolatile = true } = {}) {
  const dir = path.join(tmpDir, "tmp", "gate-context", "o-r", "pr-1");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${GATE}-${HEAD_SHA}.briefing-prefix.txt`), PREFIX_BYTES, "utf8");
  if (withVolatile) {
    await writeFile(path.join(dir, `${GATE}-${HEAD_SHA}.briefing-volatile.txt`), VOLATILE_BYTES, "utf8");
  }
  return dir;
}

test("compose-reviewer-prompt.mjs --help exits 0", () => {
  const result = runComposeCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /compose-reviewer-prompt/);
});

test("compose-reviewer-prompt.mjs requires --repo/--pr/--gate/--head-sha/--scope/--angle-suffix-file", () => {
  assert.equal(runComposeCli([]).status, 2);
  assert.equal(runComposeCli(["--repo", REPO]).status, 2);
});

test("compose-reviewer-prompt.mjs refuses (exit 1) when no invariant-prefix record exists for (gate, headSha)", async () => {
  await withTmpDir(async (tmpDir) => {
    const suffixFile = path.join(tmpDir, "angle.txt");
    await writeFile(suffixFile, "## Angle: coverage\nDo the thing.", "utf8");
    const result = runComposeCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--scope", "draft-gate-coverage", "--angle-suffix-file", suffixFile],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.composed, false);
    assert.match(payload.reason, /no invariant-prefix record/);
  });
});

test("composes an inline-prefix-first prompt, writes it, and records the layout so verify binds", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedGateContext(tmpDir);
    const suffixFile = path.join(tmpDir, "angle.txt");
    await writeFile(suffixFile, "## Angle: coverage\nDo the thing.", "utf8");

    const result = runComposeCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--scope", "draft-gate-coverage", "--angle-suffix-file", suffixFile],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.composed, true);
    assert.equal(payload.recorded, true);

    const promptText = await readFile(payload.promptPath, "utf8");
    assert.equal(promptText, `${PREFIX_BYTES}${VOLATILE_BYTES}## Angle: coverage\nDo the thing.`);
    assert.ok(promptText.startsWith(PREFIX_BYTES), "composed prompt must lead with the invariant prefix bytes");

    const verifyResult = runVerifyCli(["--head-sha", HEAD_SHA], { cwd: tmpDir });
    assert.equal(verifyResult.status, 0, verifyResult.stderr);
    const verifyPayload = JSON.parse(verifyResult.stdout);
    assert.equal(verifyPayload.verified, true);
    assert.equal(verifyPayload.recordCount, 1);
  });
});

// Issue #1957: an underscore gate-id-derived group scope must compose on the
// first attempt (no hyphen self-correction retry).
test("composes with an underscore gate-id-derived group scope without retry", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedGateContext(tmpDir);
    const suffixFile = path.join(tmpDir, "angle.txt");
    await writeFile(suffixFile, "## Group: docs-surface\nReview docs surface.", "utf8");

    const result = runComposeCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--scope", "draft_gate-group-docs-surface", "--angle-suffix-file", suffixFile],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.composed, true);
    assert.equal(payload.recorded, true);
  });
});

test("AC1: two different dispatch units of the same round share a byte-identical leading prefix span, and both bind on verify", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedGateContext(tmpDir);
    const coverageFile = path.join(tmpDir, "coverage.txt");
    const securityFile = path.join(tmpDir, "security.txt");
    await writeFile(coverageFile, "## Angle: coverage\nDo coverage things.", "utf8");
    await writeFile(securityFile, "## Angle: security\nDo security things (a longer, different suffix).", "utf8");

    const coverageResult = runComposeCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--scope", "draft-gate-coverage", "--angle-suffix-file", coverageFile],
      { cwd: tmpDir },
    );
    const securityResult = runComposeCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--scope", "draft-gate-security", "--angle-suffix-file", securityFile],
      { cwd: tmpDir },
    );
    assert.equal(coverageResult.status, 0, coverageResult.stderr);
    assert.equal(securityResult.status, 0, securityResult.stderr);

    const coveragePayload = JSON.parse(coverageResult.stdout);
    const securityPayload = JSON.parse(securityResult.stdout);
    const coverageText = await readFile(coveragePayload.promptPath, "utf8");
    const securityText = await readFile(securityPayload.promptPath, "utf8");

    assert.notEqual(coverageText, securityText);
    const sharedSpanLength = (PREFIX_BYTES + VOLATILE_BYTES).length;
    assert.equal(coverageText.slice(0, sharedSpanLength), securityText.slice(0, sharedSpanLength));

    const verifyResult = runVerifyCli(["--head-sha", HEAD_SHA], { cwd: tmpDir });
    assert.equal(verifyResult.status, 0, verifyResult.stderr);
    assert.equal(JSON.parse(verifyResult.stdout).recordCount, 2);
  });
});

test("composes with an absent volatile tail as best-effort empty (never blocks composing)", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedGateContext(tmpDir, { withVolatile: false });
    const suffixFile = path.join(tmpDir, "angle.txt");
    await writeFile(suffixFile, "## Angle: coverage\nDo the thing.", "utf8");

    const result = runComposeCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--scope", "draft-gate-coverage", "--angle-suffix-file", suffixFile],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const promptText = await readFile(payload.promptPath, "utf8");
    assert.equal(promptText, `${PREFIX_BYTES}## Angle: coverage\nDo the thing.`);
  });
});

test("refuses (exit 1) an empty --angle-suffix-file", async () => {
  await withTmpDir(async (tmpDir) => {
    await seedGateContext(tmpDir);
    const suffixFile = path.join(tmpDir, "angle.txt");
    await writeFile(suffixFile, "", "utf8");

    const result = runComposeCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", HEAD_SHA, "--scope", "draft-gate-coverage", "--angle-suffix-file", suffixFile],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 1, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.composed, false);
    assert.match(payload.reason, /non-empty angleSuffix/);
  });
});

test("rejects a malformed --head-sha (short SHA is not accepted — matches record-dispatch-prompt-layout.mjs's own requirement)", async () => {
  await withTmpDir(async (tmpDir) => {
    const suffixFile = path.join(tmpDir, "angle.txt");
    await writeFile(suffixFile, "## Angle: coverage\nDo the thing.", "utf8");
    const result = runComposeCli(
      ["--repo", REPO, "--pr", PR, "--gate", GATE, "--head-sha", "abc1234", "--scope", "draft-gate-coverage", "--angle-suffix-file", suffixFile],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 2);
  });
});

test("rejects an unknown --gate", async () => {
  await withTmpDir(async (tmpDir) => {
    const suffixFile = path.join(tmpDir, "angle.txt");
    await writeFile(suffixFile, "## Angle: coverage\nDo the thing.", "utf8");
    const result = runComposeCli(
      ["--repo", REPO, "--pr", PR, "--gate", "not_a_gate", "--head-sha", HEAD_SHA, "--scope", "draft-gate-coverage", "--angle-suffix-file", suffixFile],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 2);
  });
});
