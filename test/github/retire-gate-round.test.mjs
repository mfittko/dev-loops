import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { retireGateRound, parseRetireGateRoundArgs } from "../../scripts/github/retire-gate-round.mjs";
import { verifyDispatchPromptLayoutForHead } from "../../scripts/github/verify-dispatch-prompt-layout.mjs";
import { dispatchPromptLayoutRecordPath, recordDispatchPromptLayout } from "../../scripts/github/record-dispatch-prompt-layout.mjs";
import { bindCompactReference } from "../_helpers.mjs";

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
  assert.throws(() => parseRetireGateRoundArgs(["--gate", "draft_gate", "--head-sha", "abc1234", "--reason", "x"]), /FULL 40- or 64-char/);
  assert.throws(() => parseRetireGateRoundArgs(["--gate", "draft_gate", "--head-sha", HEAD_A]), /--reason/);
  assert.throws(() => parseRetireGateRoundArgs(["--head-sha", HEAD_A, "--reason", "x"]), /--gate/);
  const parsed = parseRetireGateRoundArgs(["--gate", "draft_gate", "--head-sha", HEAD_A.toUpperCase(), "--reason", "rebuilt", "--findings-dir", "/tmp/x", "--repo", "owner/repo", "--pr", "7", "--no-findings-artifacts", "--tmp-root", "tmp2"]);
  assert.equal(parsed.headSha, HEAD_A);
  assert.equal(parsed.gate, "draft_gate");
  assert.equal(parsed.findingsDir, "/tmp/x");
  assert.equal(parsed.repo, "owner/repo");
  assert.equal(parsed.pr, 7);
  assert.equal(parsed.noFindingsArtifacts, true);
  assert.equal(parsed.tmpRoot, "tmp2");
  // A 64-hex (SHA-256) head SHA is accepted (#1652).
  const sha256 = "c3".repeat(32);
  const parsed256 = parseRetireGateRoundArgs(["--gate", "draft_gate", "--head-sha", sha256, "--reason", "rebuilt"]);
  assert.equal(parsed256.headSha, sha256);
  assert.equal(parsed256.gate, "draft_gate");
  // repo/pr default to null when not supplied.
  const bare = parseRetireGateRoundArgs(["--gate", "draft_gate", "--head-sha", HEAD_A, "--reason", "rebuilt"]);
  assert.equal(bare.repo, null);
  assert.equal(bare.pr, null);
  assert.equal(bare.noFindingsArtifacts, false);
});

test("retire-then-refan: retirement clears the round's sentinels so a fresh run passes at the same head", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-coverage", HEAD_A)), "{}\n", "utf8");
    // A different round's sentinel must be untouched.
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_B)), "{}\n", "utf8");

    const result = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "prefix rebuilt from corrected PR body", noFindingsArtifacts: true, tmpRoot });
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

test("retire-then-refan: changed prefix and grouped correctness scope pass the real dispatch verifier", async () => {
  await withTmpRoot(async (tmpRoot) => {
    const contextDir = path.join(tmpRoot, "gate-context", "o-r", "pr-1");
    await mkdir(contextDir, { recursive: true });
    const prefixPath = path.join(contextDir, `draft_gate-${HEAD_A}.briefing-prefix.txt`);
    const emittedPath = (scope) => path.join(contextDir, `draft_gate-${HEAD_A}.dispatch-prompt-${scope}.txt`);
    // Match the existing verifier fixtures: canonical emitted-unit bytes plus
    // the real recorder and the emitter's compact-reference binding.
    const writeUnit = async (scope, prefix) => {
      const promptText = `${prefix}## Scope: ${scope}\n`;
      await writeFile(emittedPath(scope), promptText);
      const captured = await recordDispatchPromptLayout({ scope, headSha: HEAD_A, prefixPath, promptText, tmpRoot });
      assert.equal(captured.recorded, true);
      await bindCompactReference(tmpRoot, scope, HEAD_A);
    };
    const oldScope = "draft-gate-correctness";
    const freshScope = "draft-gate-group-correctness-input";
    await writeFile(prefixPath, "## Invariant prefix\nPR body: old\n");
    await writeUnit(oldScope, "## Invariant prefix\nPR body: old\n");
    await writeFile(path.join(tmpRoot, sentinelName(oldScope, HEAD_A)), "{}\n");
    const original = await readFile(dispatchPromptLayoutRecordPath(tmpRoot, oldScope, HEAD_A));
    const before = await verifyDispatchPromptLayoutForHead(tmpRoot, HEAD_A);
    assert.equal(before.verified, true, JSON.stringify(before));
    assert.equal(before.recordCount, 1);

    const retired = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "PR body corrected; grouped unit plan rebuilt", noFindingsArtifacts: true, tmpRoot });
    await writeFile(prefixPath, "## Invariant prefix\nPR body: corrected\n");
    await rm(emittedPath(oldScope));
    await writeUnit(freshScope, "## Invariant prefix\nPR body: corrected\n");
    const fresh = await verifyDispatchPromptLayoutForHead(tmpRoot, HEAD_A);
    assert.equal(fresh.verified, true, JSON.stringify(fresh));
    assert.equal(fresh.recordCount, 1); // Never a vacuous zero-record pass.
    const oldName = path.basename(dispatchPromptLayoutRecordPath(tmpRoot, oldScope, HEAD_A));
    assert.deepEqual(retired.dispatchPromptRecords, [oldName]);
    assert.deepEqual(await readFile(path.join(retired.retirementDir, oldName)), original);

    // Retirement must not weaken verification of invalid NEW provenance.
    await writeFile(emittedPath(freshScope), "## Invariant prefix\nPR body: corrected\nALTERED\n");
    const invalid = await verifyDispatchPromptLayoutForHead(tmpRoot, HEAD_A);
    assert.equal(invalid.verified, false);
    assert.equal(invalid.recordCount, 1);
    assert.equal(invalid.misaligned[0].scope, freshScope);
    assert.match(invalid.misaligned[0].reason, /recorded prompt bytes do not match/);
  });
});

test("retirement of a head with no sentinels is a no-op, not an error", async () => {
  await withTmpRoot(async (tmpRoot) => {
    const result = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "nothing to do", noFindingsArtifacts: true, tmpRoot });
    assert.deepEqual(result, { ok: true, gate: "draft_gate", headSha: HEAD_A, retired: 0, sentinels: [], dispatchPromptRecords: [], findingsDirRetired: false, retirementDir: null, noop: true });
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
    // recoverable from the retirement directory for audit only.
    await assert.rejects(() => readFile(path.join(findingsDir, "scope.json")));
    const moved = JSON.parse(await readFile(path.join(result.retirementDir, "findings-artifacts", "scope.json"), "utf8"));
    assert.equal(moved.angle, "scope");
  });
});

test("repeated retirements at the same head get distinct audited directories", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    const first = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "first rebuild", noFindingsArtifacts: true, tmpRoot });
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    const second = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "second rebuild", noFindingsArtifacts: true, tmpRoot });
    assert.notEqual(first.retirementDir, second.retirementDir);
  });
});

test("retired sentinels are invisible to the real verify-briefing-prefixes scan", async () => {
  const { spawnSync } = await import("node:child_process");
  const verifierPath = path.resolve("scripts/github/verify-briefing-prefixes.mjs");
  const base = await mkdtemp(path.join(os.tmpdir(), "retire-verifier-"));
  try {
    const tmpRoot = path.join(base, "tmp");
    await mkdir(tmpRoot, { recursive: true });
    // Two sentinels with DIFFERENT hashes: the real verifier fails closed on
    // the mixed-hash round before retirement.
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), JSON.stringify({ prefixHash: "a".repeat(64) }), "utf8");
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-coverage", HEAD_A)), JSON.stringify({ prefixHash: "b".repeat(64) }), "utf8");
    const before = spawnSync((Bun.which("node") ?? "node"), [verifierPath, "--head-sha", HEAD_A], { cwd: base, encoding: "utf8" });
    assert.notEqual(before.status, 0);
    const result = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "rebuilt", noFindingsArtifacts: true, tmpRoot });
    assert.equal(result.retired, 2);
    // After retirement the same verifier invocation sees ZERO sentinels for
    // the round and PASSES (zero sentinels evaluate to verified: true) — the
    // retired prefixes can never mix into a new consolidation.
    const after = spawnSync((Bun.which("node") ?? "node"), [verifierPath, "--head-sha", HEAD_A], { cwd: base, encoding: "utf8" });
    assert.equal(after.status, 0);
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test("retirement is gate-scoped: the other gate's live round at the same head is never swept", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    await writeFile(path.join(tmpRoot, sentinelName("pre-approval-gate-yagni", HEAD_A)), "{}\n", "utf8");
    const result = await retireGateRound({ gate: "pre_approval_gate", headSha: HEAD_A, reason: "PA rebuild", noFindingsArtifacts: true, tmpRoot });
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
    const result = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "gap", noFindingsArtifacts: true, tmpRoot });
    assert.equal(path.basename(result.retirementDir), "round-4");
  });
});

test("CLI entry point: help, arg errors, success, and invalid --jq map to the documented exit codes", async () => {
  const { spawnSync } = await import("node:child_process");
  const scriptPath = path.resolve("scripts/github/retire-gate-round.mjs");
  const run = (args, cwd) => spawnSync((Bun.which("node") ?? "node"), [scriptPath, ...args], { cwd, encoding: "utf8" });
  await withTmpRoot(async (tmpRoot) => {
    const help = run(["--help"], tmpRoot);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /rebuild-and-retire/);
    assert.match(help.stdout, /dispatchPromptRecords/);
    assert.match(help.stdout, /partiallyRetiredDispatchPromptRecords/);

    const argErr = run(["--head-sha", HEAD_A, "--reason", "x"], tmpRoot);
    assert.equal(argErr.status, 1);
    assert.match(argErr.stderr, /--gate/);

    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    const dispatchPath = dispatchPromptLayoutRecordPath(tmpRoot, "draft-gate-correctness", HEAD_A);
    await writeFile(dispatchPath, "{ malformed but recoverable\n");
    const okRun = run(["--gate", "draft_gate", "--head-sha", HEAD_A, "--reason", "cli test", "--no-findings-artifacts", "--tmp-root", "."], tmpRoot);
    assert.equal(okRun.status, 0, okRun.stderr);
    assert.equal(JSON.parse(okRun.stdout).retired, 1);
    assert.deepEqual(JSON.parse(okRun.stdout).dispatchPromptRecords, [path.basename(dispatchPath)]);

    const badJq = run(["--gate", "draft_gate", "--head-sha", HEAD_A, "--reason", "x", "--no-findings-artifacts", "--tmp-root", ".", "--jq", "((("], tmpRoot);
    assert.equal(badJq.status, 2);
  });
});

test("parseRetireGateRoundArgs rejects a non-positive-integer --pr (#1626)", () => {
  for (const bad of ["abc", "0", "-1", "1.5"]) {
    assert.throws(
      () => parseRetireGateRoundArgs(["--gate", "draft_gate", "--head-sha", HEAD_A, "--reason", "x", "--pr", bad]),
      /--pr .*positive integer/,
    );
  }
});

test("parseRetireGateRoundArgs rejects an empty --repo (#1626)", () => {
  assert.throws(
    () => parseRetireGateRoundArgs(["--gate", "draft_gate", "--head-sha", HEAD_A, "--reason", "x", "--repo", ""]),
    /--repo requires a non-empty/,
  );
});

test("retireGateRound re-validates headSha and reason at the function boundary", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await assert.rejects(
      () => retireGateRound({ gate: "draft_gate", headSha: "abc1234", reason: "x", tmpRoot }),
      /FULL 40- or 64-char/,
    );
    await assert.rejects(
      () => retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "   ", tmpRoot }),
      /non-empty string/,
    );
  });
});

test("retireGateRound normalizes an uppercase headSha before matching sentinels", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    const result = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A.toUpperCase(), reason: "case", noFindingsArtifacts: true, tmpRoot });
    assert.equal(result.retired, 1);
    assert.equal(result.headSha, HEAD_A);
  });
});

test("a missing tmp root fails closed instead of a vacuous no-op", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "retire-noroot-"));
  try {
    await assert.rejects(
      () => retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "rebuilt", tmpRoot: path.join(base, "does-not-exist") }),
      /not an existing directory/,
    );
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => {});
  }
});

test("a symlinked --findings-dir is rejected", async () => {
  await withTmpRoot(async (tmpRoot) => {
    const { symlink } = await import("node:fs/promises");
    const realDir = path.join(tmpRoot, "real-artifacts");
    await mkdir(realDir);
    const link = path.join(tmpRoot, `link-${HEAD_A}`);
    await symlink(realDir, link);
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    await assert.rejects(
      () => retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "rebuilt", findingsDir: link, tmpRoot }),
      /symlinks are rejected/,
    );
  });
});

test("a --findings-dir whose basename does not name the retired head is rejected", async () => {
  await withTmpRoot(async (tmpRoot) => {
    const otherDir = path.join(tmpRoot, "gate-findings-unrelated");
    await mkdir(otherDir);
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    await assert.rejects(
      () => retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "rebuilt", findingsDir: otherDir, tmpRoot }),
      /does not name head/,
    );
    // The unrelated directory was not moved.
    const { stat } = await import("node:fs/promises");
    assert.ok((await stat(otherDir)).isDirectory());
  });
});

test("retiring without --findings-dir refuses when canonical artifacts exist for the gate+head (#1626)", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    // The canonical per-angle findings directory write-gate-context.mjs writes.
    const canonicalDir = path.join(tmpRoot, "gate-reviews", "owner-repo", "pr-7", `draft_gate-${HEAD_A}`);
    await mkdir(canonicalDir, { recursive: true });
    await writeFile(path.join(canonicalDir, "scope.json"), JSON.stringify({ angle: "scope", verdict: "clean" }), "utf8");
    await assert.rejects(
      () => retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "rebuilt", repo: "owner/repo", pr: 7, tmpRoot }),
      /canonical findings-artifacts directory.*exists.*--no-findings-artifacts/,
    );
    // Fail-closed: nothing moved.
    await readFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)));
    await readFile(path.join(canonicalDir, "scope.json"));
  });
});

test("--no-findings-artifacts opts out of the canonical artifacts check (#1626)", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    const canonicalDir = path.join(tmpRoot, "gate-reviews", "owner-repo", "pr-7", `draft_gate-${HEAD_A}`);
    await mkdir(canonicalDir, { recursive: true });
    const result = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "rebuilt", repo: "owner/repo", pr: 7, noFindingsArtifacts: true, tmpRoot });
    assert.equal(result.retired, 1);
    assert.equal(result.warning, undefined);
    // The canonical artifacts stay live (explicit opt-out).
    const { stat } = await import("node:fs/promises");
    assert.ok((await stat(canonicalDir)).isDirectory());
  });
});

test("retiring without --findings-dir proceeds when no canonical artifacts dir exists (#1626)", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    const result = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "rebuilt", repo: "owner/repo", pr: 7, tmpRoot });
    assert.equal(result.retired, 1);
    assert.equal(result.warning, undefined);
  });
});

test("retiring without --findings-dir, --repo/--pr, or --no-findings-artifacts refuses (#1626)", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    await assert.rejects(
      () => retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "rebuilt", tmpRoot }),
      /requires --repo and --pr.*--no-findings-artifacts/,
    );
    await readFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)));
  });
});

test("retiring sentinels without --findings-dir no longer carries a warning (refusal replaces it, #1626)", async () => {
  await withTmpRoot(async (tmpRoot) => {
    await writeFile(path.join(tmpRoot, sentinelName("draft-gate-scope", HEAD_A)), "{}\n", "utf8");
    const result = await retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "rebuilt", noFindingsArtifacts: true, tmpRoot });
    assert.equal(result.retired, 1);
    assert.equal(result.warning, undefined);
  });
});

for (const [gate, scopePrefix, otherPrefix] of [
  ["draft_gate", "draft-gate-", "pre-approval-gate-"],
  ["pre_approval_gate", "pre-approval-gate-", "draft-gate-"],
]) {
  for (const headSha of [HEAD_A, "c3".repeat(32)]) {
    test(`dispatch-only ${gate} retirement matches regular files at a normalized full ${headSha.length}-hex head and preserves original bytes`, async () => {
      await withTmpRoot(async (tmpRoot) => {
        const correctness = path.basename(dispatchPromptLayoutRecordPath(tmpRoot, `${scopePrefix}correctness`, headSha));
        const yagni = path.basename(dispatchPromptLayoutRecordPath(tmpRoot, `${scopePrefix}yagni`, headSha));
        const originals = new Map([
          [yagni, Buffer.from([0xff, 0x00, 0x7b, 0x0d, 0x0a])], // Malformed UTF-8/JSON remains auditable.
          [correctness, Buffer.from('{\r\n  "capturedAt": "original", "unknown": true\r\n}\r\n')],
        ]);
        for (const [name, bytes] of originals) await writeFile(path.join(tmpRoot, name), bytes);
        const preserved = [
          path.basename(dispatchPromptLayoutRecordPath(tmpRoot, `${otherPrefix}correctness`, headSha)),
          path.basename(dispatchPromptLayoutRecordPath(tmpRoot, `${scopePrefix}correctness`, HEAD_B)),
          path.basename(dispatchPromptLayoutRecordPath(tmpRoot, `${scopePrefix}correctness`, headSha.slice(0, 7))),
          path.basename(dispatchPromptLayoutRecordPath(tmpRoot, `${scopePrefix}correctness`, `f${headSha}`)),
          path.basename(dispatchPromptLayoutRecordPath(tmpRoot, `${scopePrefix.replace(/-$/, "x-")}correctness`, headSha)),
          `${correctness}.bak`,
          `unrelated-${headSha}.json`,
          "link-target.bin",
        ];
        const untouched = Buffer.from("unrelated evidence\r\n");
        for (const name of preserved) await writeFile(path.join(tmpRoot, name), untouched);
        const directoryName = path.basename(dispatchPromptLayoutRecordPath(tmpRoot, `${scopePrefix}directory`, headSha));
        const symlinkName = path.basename(dispatchPromptLayoutRecordPath(tmpRoot, `${scopePrefix}symlink`, headSha));
        await mkdir(path.join(tmpRoot, directoryName));
        await writeFile(path.join(tmpRoot, directoryName, "nested.json"), untouched);
        await symlink("link-target.bin", path.join(tmpRoot, symlinkName));

        const result = await retireGateRound({ gate, headSha: headSha.toUpperCase(), reason: "dispatch-only stale evidence", noFindingsArtifacts: true, tmpRoot });
        assert.equal(result.headSha, headSha);
        assert.equal(result.retired, 0); // Legacy sentinel count, not dispatch count.
        assert.equal(result.noop, false);
        assert.deepEqual(result.sentinels, []);
        assert.deepEqual(result.dispatchPromptRecords, [correctness, yagni]);
        const audit = JSON.parse(await readFile(path.join(result.retirementDir, "retirement.json"), "utf8"));
        assert.deepEqual(audit.dispatchPromptRecords, [correctness, yagni]);
        assert.deepEqual(audit.sentinels, []);
        assert.equal(audit.partial, false);
        assert.equal(audit.findingsDirRetired, false);
        for (const [name, bytes] of originals) {
          await assert.rejects(readFile(path.join(tmpRoot, name)), { code: "ENOENT" });
          assert.deepEqual(await readFile(path.join(result.retirementDir, name)), bytes);
        }
        for (const name of preserved) assert.deepEqual(await readFile(path.join(tmpRoot, name)), untouched);
        assert.ok((await lstat(path.join(tmpRoot, directoryName))).isDirectory());
        assert.deepEqual(await readFile(path.join(tmpRoot, directoryName, "nested.json")), untouched);
        assert.ok((await lstat(path.join(tmpRoot, symlinkName))).isSymbolicLink());
        assert.equal(await readlink(path.join(tmpRoot, symlinkName)), "link-target.bin");
        assert.deepEqual(await readFile(path.join(tmpRoot, symlinkName)), untouched);

        const repeated = await retireGateRound({ gate, headSha, reason: "already retired", noFindingsArtifacts: true, tmpRoot });
        assert.deepEqual(repeated, { ok: true, gate, headSha, retired: 0, sentinels: [], dispatchPromptRecords: [], findingsDirRetired: false, retirementDir: null, noop: true });
        assert.deepEqual(await readdir(path.dirname(result.retirementDir)), ["round-1"]);
      });
    });
  }
}

test("dispatch records stay live and byte-identical through every retirement preflight refusal", async () => {
  await withTmpRoot(async (tmpRoot) => {
    const dispatchPath = dispatchPromptLayoutRecordPath(tmpRoot, "draft-gate-correctness", HEAD_A);
    const sentinelPath = path.join(tmpRoot, sentinelName("draft-gate-correctness", HEAD_A));
    const bytes = Buffer.from("{ unparsed preflight evidence\r\n");
    await writeFile(dispatchPath, bytes);
    await writeFile(sentinelPath, bytes);
    const unrelatedDir = path.join(tmpRoot, "unrelated-findings");
    await mkdir(unrelatedDir);
    const linkedDir = path.join(tmpRoot, `linked-${HEAD_A}`);
    await symlink(unrelatedDir, linkedDir);
    const fileDir = path.join(tmpRoot, `file-${HEAD_A}`);
    await writeFile(fileDir, bytes);
    const canonicalDir = path.join(tmpRoot, "gate-reviews", "owner-repo", "pr-7", `draft_gate-${HEAD_A}`);
    await mkdir(canonicalDir, { recursive: true });
    const base = { gate: "draft_gate", headSha: HEAD_A, reason: "refusal", noFindingsArtifacts: true, tmpRoot };
    for (const [options, message] of [
      [{ gate: "unknown" }, /Unknown gate/],
      [{ headSha: HEAD_A.slice(0, 7) }, /FULL 40- or 64-char/],
      [{ reason: " " }, /non-empty string/],
      [{ findingsDir: path.join(tmpRoot, "missing") }, /not an existing directory/],
      [{ findingsDir: fileDir }, /not an existing directory/],
      [{ findingsDir: linkedDir }, /symlinks are rejected/],
      [{ findingsDir: unrelatedDir }, /does not name head/],
      [{ noFindingsArtifacts: false }, /requires --repo and --pr/],
      [{ noFindingsArtifacts: false, repo: "owner/repo", pr: 7 }, /canonical findings-artifacts directory/],
    ]) {
      await assert.rejects(retireGateRound({ ...base, ...options }), message);
      assert.deepEqual(await readFile(dispatchPath), bytes);
      assert.deepEqual(await readFile(sentinelPath), bytes);
      await assert.rejects(lstat(path.join(tmpRoot, "retired-gate-rounds")), { code: "ENOENT" });
    }
  });
});

for (const withSentinel of [false, true]) {
  test(`failed findings move audits successful dispatch moves separately (${withSentinel ? "with sentinel" : "dispatch-only"})`, async () => {
    await withTmpRoot(async (base) => {
      // Moving a directory into its own descendant deterministically fails on
      // real filesystems, AFTER its flat records move. No injection or race.
      const tmpRoot = path.join(base, `round-${HEAD_A}`);
      await mkdir(tmpRoot);
      const dispatchPath = dispatchPromptLayoutRecordPath(tmpRoot, "draft-gate-correctness", HEAD_A);
      const bytes = Buffer.from("{ partial evidence\r\n");
      await writeFile(dispatchPath, bytes);
      const sentinels = withSentinel ? [sentinelName("draft-gate-correctness", HEAD_A)] : [];
      for (const name of sentinels) await writeFile(path.join(tmpRoot, name), bytes);
      let failure;
      await assert.rejects(
        retireGateRound({ gate: "draft_gate", headSha: HEAD_A, reason: "deterministic findings failure", findingsDir: tmpRoot, tmpRoot }),
        (error) => {
          failure = error;
          assert.match(error.message, /partial retirement/);
          assert.deepEqual(error.partiallyRetired, sentinels);
          assert.deepEqual(error.partiallyRetiredDispatchPromptRecords, [path.basename(dispatchPath)]);
          return true;
        },
      );
      const audit = JSON.parse(await readFile(path.join(failure.retirementDir, "retirement.json"), "utf8"));
      assert.equal(audit.partial, true);
      assert.equal(audit.findingsDirRetired, false);
      assert.equal(audit.findingsDir, tmpRoot);
      assert.deepEqual(audit.sentinels, sentinels);
      assert.deepEqual(audit.dispatchPromptRecords, [path.basename(dispatchPath)]);
      assert.deepEqual(await readFile(path.join(failure.retirementDir, path.basename(dispatchPath))), bytes);
      await assert.rejects(readFile(dispatchPath), { code: "ENOENT" });
      assert.ok((await lstat(tmpRoot)).isDirectory());
    });
  });
}

test("CLI partial failure serializes both successful-move arrays and the durable partial audit", async () => {
  const { spawnSync } = await import("node:child_process");
  const scriptPath = path.resolve("scripts/github/retire-gate-round.mjs");
  await withTmpRoot(async (base) => {
    const tmpRoot = path.join(base, `round-${HEAD_A}`);
    await mkdir(tmpRoot);
    const dispatchPath = dispatchPromptLayoutRecordPath(tmpRoot, "draft-gate-correctness", HEAD_A);
    await writeFile(dispatchPath, "{ malformed partial evidence\n");
    const sentinel = sentinelName("draft-gate-correctness", HEAD_A);
    await writeFile(path.join(tmpRoot, sentinel), "{}\n");
    const result = spawnSync((Bun.which("node") ?? "node"), [
      scriptPath, "--gate", "draft_gate", "--head-sha", HEAD_A, "--reason", "cli partial test",
      "--tmp-root", tmpRoot, "--findings-dir", tmpRoot,
    ], { cwd: base, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.ok, false);
    assert.deepEqual(failure.partiallyRetired, [sentinel]);
    assert.deepEqual(failure.partiallyRetiredDispatchPromptRecords, [path.basename(dispatchPath)]);
    const audit = JSON.parse(await readFile(path.join(failure.retirementDir, "retirement.json"), "utf8"));
    assert.equal(audit.partial, true);
    assert.deepEqual(audit.sentinels, failure.partiallyRetired);
    assert.deepEqual(audit.dispatchPromptRecords, failure.partiallyRetiredDispatchPromptRecords);
  });
});
