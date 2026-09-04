import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { renderBriefingPointerLine } from "@dev-loops/core/loop/review-dispatch-plan";
import { evaluateDispatchPromptLayout, verifyDispatchPromptLayoutForHead } from "../../scripts/github/verify-dispatch-prompt-layout.mjs";
import { validateBriefingPrefixPath, dispatchPromptLayoutRecordPath } from "../../scripts/github/record-dispatch-prompt-layout.mjs";

const recordCliPath = path.resolve("scripts/github/record-dispatch-prompt-layout.mjs");
const verifyCliPath = path.resolve("scripts/github/verify-dispatch-prompt-layout.mjs");

function runRecordCli(args = [], opts = {}) {
  return spawnSync("node", [recordCliPath, ...args], { encoding: "utf8", ...opts });
}

function runVerifyCli(args = [], opts = {}) {
  return spawnSync("node", [verifyCliPath, ...args], { encoding: "utf8", ...opts });
}

async function withTmpDir(fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-dispatch-prompt-layout-"));
  try {
    return await fn(tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

const HEAD_SHA = "abc1234abc1234abc1234abc1234abc1234abc12";
const GATE = "draft_gate";
const PREFIX_BYTES = "## Invariant prefix\nrepo: o/r\nhead: abc\n";

async function writeGateContextPrefix(tmpDir, headSha = HEAD_SHA, bytes = PREFIX_BYTES) {
  const dir = path.join(tmpDir, "tmp", "gate-context", "o-r", "pr-1");
  await mkdir(dir, { recursive: true });
  const relPath = path.join("tmp", "gate-context", "o-r", "pr-1", `${GATE}-${headSha}.briefing-prefix.txt`);
  await writeFile(path.join(tmpDir, relPath), bytes, "utf8");
  return relPath;
}

// ---------------------------------------------------------------------------
// Pure function: evaluateDispatchPromptLayout
// ---------------------------------------------------------------------------

test("evaluateDispatchPromptLayout: zero records is trivially verified (progressive/optional capture)", () => {
  const result = evaluateDispatchPromptLayout([], new Map());
  assert.equal(result.verified, true);
  assert.match(result.reason, /no dispatch-prompt records/);
});

test("evaluateDispatchPromptLayout: a prefix-first (inline) record verifies", () => {
  const prefixPath = "tmp/gate-context/o-r/pr-1/draft_gate-abc.briefing-prefix.txt";
  const result = evaluateDispatchPromptLayout(
    [{ scope: "draft-gate-coverage", prefixPath, leading: `${PREFIX_BYTES}## Angle: coverage\n` }],
    new Map([[prefixPath, PREFIX_BYTES]]),
  );
  assert.equal(result.verified, true);
});

test("evaluateDispatchPromptLayout: REJECTS an angle-first record (dynamic prose ahead of the prefix)", () => {
  const prefixPath = "tmp/gate-context/o-r/pr-1/draft_gate-abc.briefing-prefix.txt";
  const result = evaluateDispatchPromptLayout(
    [{ scope: "draft-gate-coverage", prefixPath, leading: `## Angle: coverage\n${PREFIX_BYTES}` }],
    new Map([[prefixPath, PREFIX_BYTES]]),
  );
  assert.equal(result.verified, false);
  assert.equal(result.misaligned.length, 1);
  assert.equal(result.misaligned[0].scope, "draft-gate-coverage");
});

test("evaluateDispatchPromptLayout: a record with no matching prefix bytes fails closed", () => {
  const result = evaluateDispatchPromptLayout(
    [{ scope: "draft-gate-coverage", prefixPath: "does/not/exist.txt", leading: "anything" }],
    new Map(),
  );
  assert.equal(result.verified, false);
  assert.match(result.misaligned[0].reason, /no longer names a real on-disk/);
});

test("evaluateDispatchPromptLayout: a malformed record (null prefixPath/leading) fails closed, never grandfathered", () => {
  const result = evaluateDispatchPromptLayout(
    [{ scope: "draft-gate-coverage", prefixPath: null, leading: null }],
    new Map(),
  );
  assert.equal(result.verified, false);
  assert.match(result.misaligned[0].reason, /never grandfathered/);
});

test("evaluateDispatchPromptLayout: a pointer-mode record verifies against the byte-identical pointer line", () => {
  const prefixPath = "tmp/gate-context/o-r/pr-1/draft_gate-abc.briefing-prefix.txt";
  const pointerLine = renderBriefingPointerLine(prefixPath);
  const result = evaluateDispatchPromptLayout(
    [{ scope: "draft-gate-coverage", prefixPath, leading: `${pointerLine}\n## Angle: coverage\n` }],
    new Map([[prefixPath, PREFIX_BYTES]]),
  );
  assert.equal(result.verified, true);
});

// ---------------------------------------------------------------------------
// validateBriefingPrefixPath — basename-canonical naming guard (pure, no I/O)
// ---------------------------------------------------------------------------

test("validateBriefingPrefixPath: accepts a canonical <gate>-<headSha>.briefing-prefix.txt basename", () => {
  const check = validateBriefingPrefixPath(`tmp/gate-context/o-r/pr-1/${GATE}-${HEAD_SHA}.briefing-prefix.txt`, HEAD_SHA);
  assert.equal(check.ok, true);
  assert.equal(check.gate, GATE);
});

test("validateBriefingPrefixPath: rejects an unknown gate name", () => {
  const check = validateBriefingPrefixPath(`tmp/gate-context/o-r/pr-1/not_a_gate-${HEAD_SHA}.briefing-prefix.txt`, HEAD_SHA);
  assert.equal(check.ok, false);
});

test("validateBriefingPrefixPath: rejects a non-canonical basename (wrong head SHA)", () => {
  const check = validateBriefingPrefixPath(`tmp/gate-context/o-r/pr-1/${GATE}-${HEAD_SHA}.briefing-prefix.txt`, "f".repeat(40));
  assert.equal(check.ok, false);
});

// ---------------------------------------------------------------------------
// verifyDispatchPromptLayoutForHead — programmatic fan-in entry
// ---------------------------------------------------------------------------

test("verifyDispatchPromptLayoutForHead: no records for the head -> verified (offline/legacy path unchanged)", async () => {
  await withTmpDir(async (tmpDir) => {
    const result = await verifyDispatchPromptLayoutForHead(path.join(tmpDir, "tmp"), HEAD_SHA);
    assert.equal(result.verified, true);
    assert.equal(result.recordCount, 0);
  });
});

test("verifyDispatchPromptLayoutForHead: reads a real record + real prefix file and verifies a prefix-first prompt", async () => {
  await withTmpDir(async (tmpDir) => {
    const relPath = await writeGateContextPrefix(tmpDir);
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    await writeFile(
      dispatchPromptLayoutRecordPath(path.join(tmpDir, "tmp"), "draft-gate-coverage", HEAD_SHA),
      JSON.stringify({ scope: "draft-gate-coverage", headSha: HEAD_SHA, prefixPath: relPath, leading: `${PREFIX_BYTES}## Angle: coverage\n` }),
    );
    const result = await verifyDispatchPromptLayoutForHead(path.join(tmpDir, "tmp"), HEAD_SHA);
    assert.equal(result.verified, true);
    assert.equal(result.recordCount, 1);
  });
});

test("verifyDispatchPromptLayoutForHead: fails closed on a real angle-first record", async () => {
  await withTmpDir(async (tmpDir) => {
    const relPath = await writeGateContextPrefix(tmpDir);
    await mkdir(path.join(tmpDir, "tmp"), { recursive: true });
    await writeFile(
      dispatchPromptLayoutRecordPath(path.join(tmpDir, "tmp"), "draft-gate-coverage", HEAD_SHA),
      JSON.stringify({ scope: "draft-gate-coverage", headSha: HEAD_SHA, prefixPath: relPath, leading: `## Angle: coverage\n${PREFIX_BYTES}` }),
    );
    const result = await verifyDispatchPromptLayoutForHead(path.join(tmpDir, "tmp"), HEAD_SHA);
    assert.equal(result.verified, false);
    assert.equal(result.misaligned[0].scope, "draft-gate-coverage");
  });
});

// ---------------------------------------------------------------------------
// CLI: record-dispatch-prompt-layout.mjs
// ---------------------------------------------------------------------------

test("record-dispatch-prompt-layout.mjs --help exits 0", () => {
  const result = runRecordCli(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /record-dispatch-prompt-layout/);
});

test("record-dispatch-prompt-layout.mjs writes a record readable back by the verifier and passes the round", async () => {
  await withTmpDir(async (tmpDir) => {
    const relPath = await writeGateContextPrefix(tmpDir);
    const promptFile = path.join(tmpDir, "prompt.txt");
    await writeFile(promptFile, `${PREFIX_BYTES}## Angle: coverage\nDo the thing.`, "utf8");
    const result = runRecordCli(
      ["--scope", "draft-gate-coverage", "--head-sha", HEAD_SHA, "--prefix-path", relPath, "--prompt-file", promptFile],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.recorded, true);

    const recordRaw = await readFile(dispatchPromptLayoutRecordPath(path.join(tmpDir, "tmp"), "draft-gate-coverage", HEAD_SHA), "utf8");
    const record = JSON.parse(recordRaw);
    assert.equal(record.prefixPath, relPath);
    assert.equal(record.leading, `${PREFIX_BYTES}## Angle: coverage\nDo the thing.`);

    const verifyResult = runVerifyCli(["--head-sha", HEAD_SHA], { cwd: tmpDir });
    assert.equal(verifyResult.status, 0, verifyResult.stderr);
    assert.equal(JSON.parse(verifyResult.stdout).verified, true);
  });
});

test("record-dispatch-prompt-layout.mjs refuses (exit 1) a non-canonical --prefix-path basename", async () => {
  await withTmpDir(async (tmpDir) => {
    const promptFile = path.join(tmpDir, "prompt.txt");
    await writeFile(promptFile, "anything", "utf8");
    const result = runRecordCli(
      ["--scope", "draft-gate-coverage", "--head-sha", HEAD_SHA, "--prefix-path", "not-a-real-record.txt", "--prompt-file", promptFile],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).recorded, false);
  });
});

test("record-dispatch-prompt-layout.mjs validates --prefix-path BEFORE reading --prompt-file (fail-fast: an unreadable --prompt-file never masks a bad --prefix-path)", () => {
  const result = runRecordCli([
    "--scope", "draft-gate-coverage", "--head-sha", HEAD_SHA,
    "--prefix-path", "not-a-real-record.txt",
    // A nonexistent --prompt-file: if the CLI read it BEFORE validating
    // --prefix-path, the reason would report an unreadable prompt-file
    // instead of the (earlier, real) prefix-path defect.
    "--prompt-file", "/nonexistent/path/does-not-exist.txt",
  ]);
  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.recorded, false);
  assert.match(payload.reason, /canonical/);
  assert.doesNotMatch(payload.reason, /unreadable/);
});

test("record-dispatch-prompt-layout.mjs requires --scope/--head-sha/--prefix-path/--prompt-file", () => {
  assert.equal(runRecordCli([]).status, 2);
  assert.equal(runRecordCli(["--scope", "a"]).status, 2);
});

// ---------------------------------------------------------------------------
// CLI: verify-dispatch-prompt-layout.mjs
// ---------------------------------------------------------------------------

test("verify-dispatch-prompt-layout.mjs --help exits 0", () => {
  const result = runVerifyCli(["--help"]);
  assert.equal(result.status, 0);
});

test("verify-dispatch-prompt-layout.mjs exits 0 with reviewerCount 0 when nothing is recorded", async () => {
  await withTmpDir(async (tmpDir) => {
    const result = runVerifyCli(["--head-sha", HEAD_SHA], { cwd: tmpDir });
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verified, true);
    assert.equal(payload.recordCount, 0);
  });
});

test("verify-dispatch-prompt-layout.mjs exits 1 (fails closed) on an angle-first dispatched prompt", async () => {
  await withTmpDir(async (tmpDir) => {
    const relPath = await writeGateContextPrefix(tmpDir);
    const promptFile = path.join(tmpDir, "prompt.txt");
    // Angle-first: dynamic per-unit prose BEFORE the invariant prefix.
    await writeFile(promptFile, `## Angle: coverage\nDo the thing.\n${PREFIX_BYTES}`, "utf8");
    const recordResult = runRecordCli(
      ["--scope", "draft-gate-coverage", "--head-sha", HEAD_SHA, "--prefix-path", relPath, "--prompt-file", promptFile],
      { cwd: tmpDir },
    );
    assert.equal(recordResult.status, 0, recordResult.stderr);

    const result = runVerifyCli(["--head-sha", HEAD_SHA], { cwd: tmpDir });
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verified, false);
    assert.equal(payload.misaligned[0].scope, "draft-gate-coverage");
  });
});

test("verify-dispatch-prompt-layout.mjs rejects a malformed --head-sha", () => {
  const result = runVerifyCli(["--head-sha", "not-hex!"]);
  assert.equal(result.status, 2);
});
