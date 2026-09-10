import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { renderBriefingPointerLine, sha256Hex, DISPATCH_PROMPT_LEADING_CAP_BYTES } from "@dev-loops/core/loop/review-dispatch-plan";
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

// Simulate the sanctioned emitter's canonical emitted-prompt file
// (`<gate>-<headSha>.dispatch-prompt-<scope>.txt`, written by
// compose-reviewer-prompt.mjs sibling to the invariant prefix).
async function writeEmittedPrompt(tmpDir, scope, content, headSha = HEAD_SHA) {
  const dir = path.join(tmpDir, "tmp", "gate-context", "o-r", "pr-1");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${GATE}-${headSha}.dispatch-prompt-${scope}.txt`), content, "utf8");
}

// ---------------------------------------------------------------------------
// Pure function: evaluateDispatchPromptLayout (emitted-unit binding)
// ---------------------------------------------------------------------------

test("evaluateDispatchPromptLayout: zero records is trivially verified (progressive/optional capture)", () => {
  const result = evaluateDispatchPromptLayout([], new Map());
  assert.equal(result.verified, true);
  assert.match(result.reason, /no dispatch-prompt records/);
});

test("evaluateDispatchPromptLayout: a record bound to the inline-aligned emitted unit verifies", () => {
  const prefixPath = "tmp/gate-context/o-r/pr-1/draft_gate-abc.briefing-prefix.txt";
  const emitted = `${PREFIX_BYTES}## Angle: coverage\n`;
  const result = evaluateDispatchPromptLayout(
    [{ scope: "draft-gate-coverage", prefixPath, leading: emitted, promptContentHash: sha256Hex(emitted) }],
    new Map([[prefixPath, PREFIX_BYTES]]),
    new Map([["draft-gate-coverage", { contentHash: sha256Hex(emitted), inlineAligned: true }]]),
  );
  assert.equal(result.verified, true);
});

test("evaluateDispatchPromptLayout: REJECTS a record with no promptContentHash (coordinator-authored, never grandfathered)", () => {
  const prefixPath = "tmp/gate-context/o-r/pr-1/draft_gate-abc.briefing-prefix.txt";
  const result = evaluateDispatchPromptLayout(
    [{ scope: "draft-gate-coverage", prefixPath, leading: `${PREFIX_BYTES}x`, promptContentHash: null }],
    new Map([[prefixPath, PREFIX_BYTES]]),
    new Map([["draft-gate-coverage", { contentHash: sha256Hex(`${PREFIX_BYTES}x`), inlineAligned: true }]]),
  );
  assert.equal(result.verified, false);
  assert.match(result.misaligned[0].reason, /no promptContentHash/);
});

test("evaluateDispatchPromptLayout: REJECTS when no sanctioned emitted file exists for the scope", () => {
  const prefixPath = "tmp/gate-context/o-r/pr-1/draft_gate-abc.briefing-prefix.txt";
  const emitted = `${PREFIX_BYTES}## Angle: coverage\n`;
  const result = evaluateDispatchPromptLayout(
    [{ scope: "draft-gate-coverage", prefixPath, leading: emitted, promptContentHash: sha256Hex(emitted) }],
    new Map([[prefixPath, PREFIX_BYTES]]),
    new Map(), // no emitted file discovered
  );
  assert.equal(result.verified, false);
  assert.match(result.misaligned[0].reason, /no sanctioned emitter emitted-prompt file/);
});

test("evaluateDispatchPromptLayout: REJECTS an altered suffix (matching prefix, hash mismatch to emitted unit)", () => {
  const prefixPath = "tmp/gate-context/o-r/pr-1/draft_gate-abc.briefing-prefix.txt";
  const emitted = `${PREFIX_BYTES}## Angle: coverage\nORIGINAL\n`;
  const delivered = `${PREFIX_BYTES}## Angle: coverage\nPARAPHRASED\n`; // same prefix, altered suffix
  const result = evaluateDispatchPromptLayout(
    [{ scope: "draft-gate-coverage", prefixPath, leading: delivered, promptContentHash: sha256Hex(delivered) }],
    new Map([[prefixPath, PREFIX_BYTES]]),
    new Map([["draft-gate-coverage", { contentHash: sha256Hex(emitted), inlineAligned: true }]]),
  );
  assert.equal(result.verified, false);
  assert.match(result.misaligned[0].reason, /do not match the sanctioned emitter's emitted unit/);
});

test("evaluateDispatchPromptLayout: REJECTS a hand-composed pointer-seeding record (emitted unit not inline-aligned)", () => {
  const prefixPath = "tmp/gate-context/o-r/pr-1/draft_gate-abc.briefing-prefix.txt";
  const pointerLine = renderBriefingPointerLine(prefixPath);
  const emitted = `${pointerLine}\n## Angle: coverage\n`; // pointer-seeded, NOT inline
  const result = evaluateDispatchPromptLayout(
    [{ scope: "draft-gate-coverage", prefixPath, leading: emitted, promptContentHash: sha256Hex(emitted) }],
    new Map([[prefixPath, PREFIX_BYTES]]),
    new Map([["draft-gate-coverage", { contentHash: sha256Hex(emitted), inlineAligned: false }]]),
  );
  assert.equal(result.verified, false);
  assert.match(result.misaligned[0].reason, /does not LEAD with the round's byte-identical invariant prefix INLINE/);
});

test("evaluateDispatchPromptLayout: a record with no matching prefix bytes fails closed", () => {
  const result = evaluateDispatchPromptLayout(
    [{ scope: "draft-gate-coverage", prefixPath: "does/not/exist.txt", leading: "anything", promptContentHash: "sha256:x" }],
    new Map(),
    new Map(),
  );
  assert.equal(result.verified, false);
  assert.match(result.misaligned[0].reason, /no longer names a real on-disk/);
});

test("evaluateDispatchPromptLayout: a malformed record (null prefixPath/leading) fails closed, never grandfathered", () => {
  const result = evaluateDispatchPromptLayout(
    [{ scope: "draft-gate-coverage", prefixPath: null, leading: null, promptContentHash: null }],
    new Map(),
    new Map(),
  );
  assert.equal(result.verified, false);
  assert.match(result.misaligned[0].reason, /never grandfathered/);
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
// verifyDispatchPromptLayoutForHead — programmatic fan-in entry (real I/O)
// ---------------------------------------------------------------------------

test("verifyDispatchPromptLayoutForHead: no records for the head -> verified (offline/legacy path unchanged)", async () => {
  await withTmpDir(async (tmpDir) => {
    const result = await verifyDispatchPromptLayoutForHead(path.join(tmpDir, "tmp"), HEAD_SHA);
    assert.equal(result.verified, true);
    assert.equal(result.recordCount, 0);
  });
});

test("verifyDispatchPromptLayoutForHead: record bound to the on-disk inline-aligned emitted unit verifies", async () => {
  await withTmpDir(async (tmpDir) => {
    const relPath = await writeGateContextPrefix(tmpDir);
    const emitted = `${PREFIX_BYTES}## Angle: coverage\n`;
    await writeEmittedPrompt(tmpDir, "draft-gate-coverage", emitted);
    await writeFile(
      dispatchPromptLayoutRecordPath(path.join(tmpDir, "tmp"), "draft-gate-coverage", HEAD_SHA),
      JSON.stringify({ scope: "draft-gate-coverage", headSha: HEAD_SHA, prefixPath: relPath, leading: emitted, promptContentHash: sha256Hex(emitted) }),
    );
    const result = await verifyDispatchPromptLayoutForHead(path.join(tmpDir, "tmp"), HEAD_SHA);
    assert.equal(result.verified, true);
    assert.equal(result.recordCount, 1);
  });
});

test("verifyDispatchPromptLayoutForHead: fails closed when the recorded prompt does not match the emitted unit (altered suffix)", async () => {
  await withTmpDir(async (tmpDir) => {
    const relPath = await writeGateContextPrefix(tmpDir);
    await writeEmittedPrompt(tmpDir, "draft-gate-coverage", `${PREFIX_BYTES}## Angle: coverage\nORIGINAL\n`);
    const delivered = `${PREFIX_BYTES}## Angle: coverage\nPARAPHRASED\n`;
    await writeFile(
      dispatchPromptLayoutRecordPath(path.join(tmpDir, "tmp"), "draft-gate-coverage", HEAD_SHA),
      JSON.stringify({ scope: "draft-gate-coverage", headSha: HEAD_SHA, prefixPath: relPath, leading: delivered, promptContentHash: sha256Hex(delivered) }),
    );
    const result = await verifyDispatchPromptLayoutForHead(path.join(tmpDir, "tmp"), HEAD_SHA);
    assert.equal(result.verified, false);
    assert.equal(result.misaligned[0].scope, "draft-gate-coverage");
  });
});

test("verifyDispatchPromptLayoutForHead: fails closed when no emitted unit exists on disk (hand-composed dispatch)", async () => {
  await withTmpDir(async (tmpDir) => {
    const relPath = await writeGateContextPrefix(tmpDir);
    const delivered = `${PREFIX_BYTES}## Angle: coverage\n`;
    // record present, but NO <gate>-<headSha>.dispatch-prompt-<scope>.txt emitted file
    await writeFile(
      dispatchPromptLayoutRecordPath(path.join(tmpDir, "tmp"), "draft-gate-coverage", HEAD_SHA),
      JSON.stringify({ scope: "draft-gate-coverage", headSha: HEAD_SHA, prefixPath: relPath, leading: delivered, promptContentHash: sha256Hex(delivered) }),
    );
    const result = await verifyDispatchPromptLayoutForHead(path.join(tmpDir, "tmp"), HEAD_SHA);
    assert.equal(result.verified, false);
    assert.match(result.misaligned[0].reason, /no sanctioned emitter emitted-prompt file/);
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

test("record-dispatch-prompt-layout.mjs records a full-content hash; the round passes only with a matching emitted unit", async () => {
  await withTmpDir(async (tmpDir) => {
    const relPath = await writeGateContextPrefix(tmpDir);
    const promptBody = `${PREFIX_BYTES}## Angle: coverage\nDo the thing.`;
    const promptFile = path.join(tmpDir, "prompt.txt");
    await writeFile(promptFile, promptBody, "utf8");
    // Sanctioned emitter would also write the canonical emitted file:
    await writeEmittedPrompt(tmpDir, "draft-gate-coverage", promptBody);
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
    assert.equal(record.leading, promptBody);
    assert.equal(record.promptContentHash, sha256Hex(promptBody));

    const verifyResult = runVerifyCli(["--head-sha", HEAD_SHA], { cwd: tmpDir });
    assert.equal(verifyResult.status, 0, verifyResult.stderr);
    assert.equal(JSON.parse(verifyResult.stdout).verified, true);
  });
});

// AC1 (representative large prompt): a prompt LONGER than the leading-bytes cap
// still binds by its FULL content — promptContentHash is the sha256 of the whole
// prompt, never of the truncated `leading` capture. A regression that hashed
// `leading` instead of `promptText` would still match a same-truncated emitted
// file and pass every other test; this pins the full-content invariant.
test("record-dispatch-prompt-layout.mjs binds a >cap prompt by FULL content (not the truncated leading capture)", async () => {
  await withTmpDir(async (tmpDir) => {
    const relPath = await writeGateContextPrefix(tmpDir);
    // A prompt comfortably past DISPATCH_PROMPT_LEADING_CAP_BYTES whose bytes
    // AFTER the cap still matter: the emitted file carries the full bytes.
    const bigPrompt = `${PREFIX_BYTES}## Angle: coverage\n${"x".repeat(DISPATCH_PROMPT_LEADING_CAP_BYTES)}TAIL-AFTER-CAP\n`;
    assert.ok(bigPrompt.length > DISPATCH_PROMPT_LEADING_CAP_BYTES);
    const promptFile = path.join(tmpDir, "big-prompt.txt");
    await writeFile(promptFile, bigPrompt, "utf8");
    await writeEmittedPrompt(tmpDir, "draft-gate-coverage", bigPrompt);
    const result = runRecordCli(
      ["--scope", "draft-gate-coverage", "--head-sha", HEAD_SHA, "--prefix-path", relPath, "--prompt-file", promptFile],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).truncated, true);

    const record = JSON.parse(await readFile(dispatchPromptLayoutRecordPath(path.join(tmpDir, "tmp"), "draft-gate-coverage", HEAD_SHA), "utf8"));
    // Hash is over the FULL prompt, never the truncated leading capture.
    assert.equal(record.promptContentHash, sha256Hex(bigPrompt));
    assert.notEqual(record.promptContentHash, sha256Hex(record.leading));
    assert.equal(record.leading.length, DISPATCH_PROMPT_LEADING_CAP_BYTES);

    // Binds against the full-bytes emitted file — the >cap tail is part of the proof.
    const okResult = await verifyDispatchPromptLayoutForHead(path.join(tmpDir, "tmp"), HEAD_SHA);
    assert.equal(okResult.verified, true);

    // A tail-only drift past the cap is still caught (proves the bind is not
    // limited to the first cap bytes).
    await writeEmittedPrompt(tmpDir, "draft-gate-coverage", `${PREFIX_BYTES}## Angle: coverage\n${"x".repeat(DISPATCH_PROMPT_LEADING_CAP_BYTES)}DIFFERENT-TAIL\n`);
    const driftResult = await verifyDispatchPromptLayoutForHead(path.join(tmpDir, "tmp"), HEAD_SHA);
    assert.equal(driftResult.verified, false);
  });
});

// Issue #1957: an underscore gate-id-derived scope must record on the first
// attempt (no hyphen self-correction) and key the record by the canonical
// hyphenated form.
test("record-dispatch-prompt-layout.mjs canonicalizes an underscore gate-id-derived --scope", async () => {
  await withTmpDir(async (tmpDir) => {
    const relPath = await writeGateContextPrefix(tmpDir);
    const promptFile = path.join(tmpDir, "prompt.txt");
    await writeFile(promptFile, `${PREFIX_BYTES}## Angle: coverage\nDo the thing.`, "utf8");
    const result = runRecordCli(
      ["--scope", "draft_gate-group-docs-surface", "--head-sha", HEAD_SHA, "--prefix-path", relPath, "--prompt-file", promptFile],
      { cwd: tmpDir },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).recorded, true);
    // Record keyed and stored under the canonical hyphenated scope.
    const recordRaw = await readFile(
      dispatchPromptLayoutRecordPath(path.join(tmpDir, "tmp"), "draft-gate-group-docs-surface", HEAD_SHA),
      "utf8",
    );
    assert.equal(JSON.parse(recordRaw).scope, "draft-gate-group-docs-surface");
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

test("verify-dispatch-prompt-layout.mjs exits 0 with recordCount 0 when nothing is recorded", async () => {
  await withTmpDir(async (tmpDir) => {
    const result = runVerifyCli(["--head-sha", HEAD_SHA], { cwd: tmpDir });
    assert.equal(result.status, 0);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.verified, true);
    assert.equal(payload.recordCount, 0);
  });
});

test("verify-dispatch-prompt-layout.mjs exits 1 (fails closed) on a hand-composed pointer-seeding dispatch", async () => {
  await withTmpDir(async (tmpDir) => {
    const relPath = await writeGateContextPrefix(tmpDir);
    const pointerLine = renderBriefingPointerLine(relPath);
    // A hand-composed pointer-seeding prompt: leads with the pointer line, not
    // the inlined invariant prefix. The coordinator writes it as the emitted
    // file AND records its hash — but it is NOT inline-aligned, so it fails.
    const promptBody = `${pointerLine}\n## Angle: coverage\nDo the thing.`;
    const promptFile = path.join(tmpDir, "prompt.txt");
    await writeFile(promptFile, promptBody, "utf8");
    await writeEmittedPrompt(tmpDir, "draft-gate-coverage", promptBody);
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

test("verify-dispatch-prompt-layout.mjs recovery: a compliant replacement round passes (audit-preserving)", async () => {
  await withTmpDir(async (tmpDir) => {
    const relPath = await writeGateContextPrefix(tmpDir);
    const compliant = `${PREFIX_BYTES}## Angle: coverage\nDo the thing.`;
    const promptFile = path.join(tmpDir, "prompt.txt");
    await writeFile(promptFile, compliant, "utf8");
    await writeEmittedPrompt(tmpDir, "draft-gate-coverage", compliant);
    runRecordCli(
      ["--scope", "draft-gate-coverage", "--head-sha", HEAD_SHA, "--prefix-path", relPath, "--prompt-file", promptFile],
      { cwd: tmpDir },
    );
    const result = runVerifyCli(["--head-sha", HEAD_SHA], { cwd: tmpDir });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).verified, true);
  });
});

test("verify-dispatch-prompt-layout.mjs rejects a malformed --head-sha", () => {
  const result = runVerifyCli(["--head-sha", "not-hex!"]);
  assert.equal(result.status, 2);
});
