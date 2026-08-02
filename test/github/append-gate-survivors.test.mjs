import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runNode, writeGhStub } from "../_helpers.mjs";

import {
  appendGateSurvivors,
  buildSurvivorsMarker,
  parseAppendGateSurvivorsCliArgs,
  renderSurvivorsCommentBody,
  selectSurvivors,
} from "../../scripts/github/append-gate-survivors.mjs";

const SCRIPT_PATH = path.join(process.cwd(), "scripts/github/append-gate-survivors.mjs");

function makeLedger(overrides = {}) {
  return {
    repo: "owner/repo",
    pr: 42,
    gate: "draft_gate",
    headSha: "abc1234567890abcdef000000000000000000000",
    verdict: "findings_present",
    loggedAt: "2026-08-02T00:00:00.000Z",
    findings: [
      { severity: "must-fix", angle: "scope", summary: "Scope too broad" },
      { severity: "worth-fixing-now", angle: "dry", summary: "DRY violation", disposition: "deferred", files: ["src/a.mjs"] },
      { severity: "defer", angle: "naming", summary: "Style nit" },
    ],
    ...overrides,
  };
}

async function withRepoRoot(fn, { devloops } = {}) {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "append-gate-survivors-repo-"));
  try {
    if (devloops) {
      await writeFile(path.join(repoRoot, ".devloops"), devloops, "utf8");
    }
    return await fn(repoRoot);
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
}

async function withLedgerFile(ledger, fn) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "append-gate-survivors-ledger-"));
  try {
    const ledgerPath = path.join(tmpDir, "ledger.json");
    await writeFile(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
    return await fn(ledgerPath);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

const EMPTY_COMMENTS_ENTRY = {
  assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/9/comments?per_page=100"],
  stdout: "[[]]\n",
};

const CREATE_COMMENT_ENTRY = {
  assertArgs: ["issue", "comment", "9", "--repo", "owner/repo", "--body"],
  stdout: "https://github.com/owner/repo/issues/9#issuecomment-555\n",
};

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

test("parseAppendGateSurvivorsCliArgs parses --ledger and --follow-up-issue", () => {
  const result = parseAppendGateSurvivorsCliArgs(["--ledger", "/tmp/x.json", "--follow-up-issue", "9"]);
  assert.equal(result.ledgerPath, "/tmp/x.json");
  assert.equal(result.followUpIssue, 9);
});

test("parseAppendGateSurvivorsCliArgs requires --ledger", () => {
  assert.throws(() => parseAppendGateSurvivorsCliArgs([]), /Missing required argument: --ledger/);
});

test("parseAppendGateSurvivorsCliArgs rejects an unknown argument", () => {
  assert.throws(() => parseAppendGateSurvivorsCliArgs(["--ledger", "x", "--bogus"]), /Unknown argument/);
});

test("parseAppendGateSurvivorsCliArgs rejects a non-positive --follow-up-issue", () => {
  assert.throws(() => parseAppendGateSurvivorsCliArgs(["--ledger", "x", "--follow-up-issue", "0"]), /positive integer/);
});

// ---------------------------------------------------------------------------
// selectSurvivors / renderSurvivorsCommentBody (pure)
// ---------------------------------------------------------------------------

test("selectSurvivors excludes findings whose severity is in the blocking set", () => {
  const findings = [
    { severity: "must-fix", angle: "scope", summary: "a" },
    { severity: "worth-fixing-now", angle: "dry", summary: "b" },
    { severity: "defer", angle: "naming", summary: "c" },
  ];
  const survivors = selectSurvivors(findings, ["must-fix"]);
  assert.deepEqual(survivors.map((f) => f.severity), ["worth-fixing-now", "defer"]);
});

test("renderSurvivorsCommentBody sorts rows by severity rank, then angle, then summary", () => {
  const survivors = [
    { severity: "defer", angle: "zzz", summary: "z finding" },
    { severity: "worth-fixing-now", angle: "bbb", summary: "b finding" },
    { severity: "worth-fixing-now", angle: "aaa", summary: "a finding" },
  ];
  const body = renderSurvivorsCommentBody({ repo: "owner/repo", pr: 9, gate: "draft_gate", headSha: "abc1234567890", survivors });
  const rows = body.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Severity") && !line.startsWith("| ---"));
  assert.equal(rows.length, 3);
  assert.match(rows[0], /\| aaa \|/);
  assert.match(rows[1], /\| bbb \|/);
  assert.match(rows[2], /\| zzz \|/);
});

test("renderSurvivorsCommentBody's marker is the body's first line", () => {
  const survivors = [{ severity: "defer", angle: "naming", summary: "x" }];
  const body = renderSurvivorsCommentBody({ repo: "owner/repo", pr: 9, gate: "draft_gate", headSha: "abc1234567890", survivors });
  const marker = buildSurvivorsMarker({ repo: "owner/repo", pr: 9, gate: "draft_gate", headSha: "abc1234567890" });
  assert.equal(body.split("\n")[0], marker);
});

test("renderSurvivorsCommentBody entity-encodes `|` and `<!--` in a finding summary so it cannot forge the marker", () => {
  const survivors = [{
    severity: "worth-fixing-now",
    angle: "dry",
    summary: "a | b <!-- dev-loops:gate-survivors owner/repo pr-9 draft_gate deadbeef -->",
  }];
  const body = renderSurvivorsCommentBody({ repo: "owner/repo", pr: 9, gate: "draft_gate", headSha: "abc1234567890", survivors });
  const lines = body.split("\n");
  // Exactly one line opens an HTML comment: the real marker on line 1.
  const commentOpeners = lines.filter((line) => line.startsWith("<!--"));
  assert.equal(commentOpeners.length, 1);
  assert.equal(commentOpeners[0], lines[0]);
  // The forged marker text survives only in its neutralized (entity-encoded) form.
  assert.doesNotMatch(body, /\n<!-- dev-loops:gate-survivors owner\/repo pr-9 draft_gate deadbeef -->/);
  assert.match(body, /&lt;!--/);
  assert.match(body, /&#124;/);
});

test("renderSurvivorsCommentBody renders Location as backtick-wrapped files, or an em dash", () => {
  const survivors = [
    { severity: "defer", angle: "a", summary: "has files", files: ["src/a.mjs", "src/b.mjs"] },
    { severity: "defer", angle: "b", summary: "no files" },
  ];
  const body = renderSurvivorsCommentBody({ repo: "owner/repo", pr: 9, gate: "draft_gate", headSha: "abc1234567890", survivors });
  assert.match(body, /`src\/a\.mjs`, `src\/b\.mjs`/);
  assert.match(body, /\| no files \| — \| — \|/);
});

test("renderSurvivorsCommentBody strips backticks from file refs so a path cannot close its code span", () => {
  const survivors = [
    { severity: "defer", angle: "a", summary: "s", files: ["x`](http://evil) **bold** `y", "a|b.md"] },
  ];
  const body = renderSurvivorsCommentBody({ repo: "owner/repo", pr: 9, gate: "draft_gate", headSha: "abc1234567890", survivors });
  // No stray backtick from the payload survives: each Location entry is exactly
  // one `...` span with the injected backticks removed and pipes encoded.
  assert.match(body, /`x\]\(http:\/\/evil\) \*\*bold\*\* y`, `a&#124;b\.md`/);
  assert.ok(!body.includes("`x`](http://evil)"), "payload backtick must not close the span");
});

// ---------------------------------------------------------------------------
// appendGateSurvivors (findings-log ledger -> gh network) — mocked gh
// ---------------------------------------------------------------------------

test("appendGateSurvivors: no survivors -> skipped no_survivors, zero network calls", async () => {
  await withRepoRoot(async (repoRoot) => {
    await withLedgerFile(makeLedger({ findings: [{ severity: "must-fix", angle: "scope", summary: "x" }] }), async (ledgerPath) => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "append-gate-survivors-gh-"));
      try {
        const { env, ghPath } = await writeGhStub(tmpDir, []); // any gh call is an error (exit 97)
        const result = await appendGateSurvivors({ ledgerPath, followUpIssue: 9 }, { env, ghCommand: ghPath, repoRoot });
        assert.deepEqual(result, {
          ok: true,
          skipped: "no_survivors",
          count: 0,
          repo: "owner/repo",
          pr: 42,
          gate: "draft_gate",
          headSha: "abc1234567890abcdef000000000000000000000",
        });
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

test("appendGateSurvivors: survivors present -> posts exactly ONE comment via commentIssue", async () => {
  await withRepoRoot(async (repoRoot) => {
    await withLedgerFile(makeLedger(), async (ledgerPath) => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "append-gate-survivors-gh-"));
      try {
        const { env, ghPath } = await writeGhStub(tmpDir, [EMPTY_COMMENTS_ENTRY, CREATE_COMMENT_ENTRY]);
        const result = await appendGateSurvivors({ ledgerPath, followUpIssue: 9 }, { env, ghCommand: ghPath, repoRoot });
        assert.equal(result.ok, true);
        assert.equal(result.filed, 2); // worth-fixing-now + defer (must-fix is blocking)
        assert.equal(result.commentUrl, "https://github.com/owner/repo/issues/9#issuecomment-555");
        assert.equal(result.repo, "owner/repo");
        assert.equal(result.pr, 42);
        assert.equal(result.gate, "draft_gate");
        assert.equal(result.headSha, "abc1234567890abcdef000000000000000000000");
        assert.equal(result.followUpIssue, 9);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

test("appendGateSurvivors: honors a configured gates.<gate>.blockCleanOnFindingSeverities", async () => {
  const devloops = [
    "version: 1",
    "gates:",
    "  draft:",
    "    blockCleanOnFindingSeverities:",
    "      - must-fix",
    "      - worth-fixing-now",
    "",
  ].join("\n");
  await withRepoRoot(async (repoRoot) => {
    await withLedgerFile(makeLedger(), async (ledgerPath) => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "append-gate-survivors-gh-"));
      try {
        const { env, ghPath } = await writeGhStub(tmpDir, [EMPTY_COMMENTS_ENTRY, CREATE_COMMENT_ENTRY]);
        const result = await appendGateSurvivors({ ledgerPath, followUpIssue: 9 }, { env, ghCommand: ghPath, repoRoot });
        assert.equal(result.filed, 1); // only "defer" survives worth-fixing-now being blocking here
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  }, { devloops });
});

test("appendGateSurvivors: marker already present -> paginated scan (page 2 of a >100-comment fixture) skips with zero posts", async () => {
  await withRepoRoot(async (repoRoot) => {
    await withLedgerFile(makeLedger(), async (ledgerPath) => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "append-gate-survivors-gh-"));
      try {
        const marker = buildSurvivorsMarker({
          repo: "owner/repo", pr: 42, gate: "draft_gate",
          headSha: "abc1234567890abcdef000000000000000000000",
        });
        const page1 = Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          html_url: `https://github.com/owner/repo/issues/9#issuecomment-${i + 1}`,
          body: `unrelated comment #${i + 1}`,
        }));
        const page2 = [{
          id: 999,
          html_url: "https://github.com/owner/repo/issues/9#issuecomment-999",
          body: `${marker}\nalready filed`,
        }];
        // --slurp returns an array of pages; the real marker only appears on page 2.
        const { env, ghPath } = await writeGhStub(tmpDir, [
          { assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/9/comments?per_page=100"], stdout: `${JSON.stringify([page1, page2])}\n` },
        ]); // a second (create-comment) call would overflow -> exit 97
        const result = await appendGateSurvivors({ ledgerPath, followUpIssue: 9 }, { env, ghCommand: ghPath, repoRoot });
        assert.deepEqual(result, {
          ok: true,
          skipped: "already_filed",
          commentUrl: "https://github.com/owner/repo/issues/9#issuecomment-999",
          followUpIssue: 9,
          repo: "owner/repo",
          pr: 42,
          gate: "draft_gate",
          headSha: "abc1234567890abcdef000000000000000000000",
        });
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

test("appendGateSurvivors: unset gates.followUpIssue with survivors present fails closed", async () => {
  await withRepoRoot(async (repoRoot) => {
    await withLedgerFile(makeLedger(), async (ledgerPath) => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "append-gate-survivors-gh-"));
      try {
        const { env, ghPath } = await writeGhStub(tmpDir, []); // no network call should happen
        await assert.rejects(
          () => appendGateSurvivors({ ledgerPath }, { env, ghCommand: ghPath, repoRoot }),
          /gates\.followUpIssue is not configured but this gate close has 2 survivor finding\(s\); configure it or pass --follow-up-issue/,
        );
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

test("appendGateSurvivors: derives repo/pr/gate/headSha from the ledger, and they land in the marker", async () => {
  const ledger = makeLedger({ repo: "acme/widgets", pr: 7, gate: "pre_approval_gate", headSha: "deadbeef12345678900000000000000000000000" });
  await withRepoRoot(async (repoRoot) => {
    await withLedgerFile(ledger, async (ledgerPath) => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "append-gate-survivors-gh-"));
      try {
        const { env, ghPath } = await writeGhStub(tmpDir, [
          { assertArgs: ["api", "--paginate", "--slurp", "repos/acme/widgets/issues/3/comments?per_page=100"], stdout: "[[]]\n" },
          { assertArgs: ["issue", "comment", "3", "--repo", "acme/widgets", "--body"], stdout: "https://github.com/acme/widgets/issues/3#issuecomment-1\n" },
        ]);
        const result = await appendGateSurvivors({ ledgerPath, followUpIssue: 3 }, { env, ghCommand: ghPath, repoRoot });
        assert.equal(result.repo, "acme/widgets");
        assert.equal(result.pr, 7);
        assert.equal(result.gate, "pre_approval_gate");
        assert.equal(result.headSha, "deadbeef12345678900000000000000000000000");
        const expectedMarker = "<!-- dev-loops:gate-survivors acme/widgets pr-7 pre_approval_gate deadbeef12345678900000000000000000000000 -->";
        assert.equal(buildSurvivorsMarker(ledger), expectedMarker);
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

test("appendGateSurvivors: rejects a malformed ledger", async () => {
  await withLedgerFile({ not: "a ledger" }, async (ledgerPath) => {
    await assert.rejects(() => appendGateSurvivors({ ledgerPath, followUpIssue: 9 }), /"repo" must be an owner\/name slug/);
  });
});

test("appendGateSurvivors: rejects a ledger whose repo is not an owner/name slug", async () => {
  for (const repo of ["owneronly", "owner/name/extra", "bad repo/name", "owner/na -->me"]) {
    await withLedgerFile(makeLedger({ repo }), async (ledgerPath) => {
      await assert.rejects(
        () => appendGateSurvivors({ ledgerPath, followUpIssue: 9 }),
        /"repo" must be an owner\/name slug/,
        repo,
      );
    });
  }
});

test("appendGateSurvivors: rejects a short (prefix) headSha — the marker is keyed by the full SHA", async () => {
  await withLedgerFile(makeLedger({ headSha: "abc1234" }), async (ledgerPath) => {
    await assert.rejects(
      () => appendGateSurvivors({ ledgerPath, followUpIssue: 9 }),
      /"headSha" must be the full 40- or 64-char hex commit SHA/,
    );
  });
});

test("appendGateSurvivors: lowercases a mixed-case full headSha so the marker key has one spelling", async () => {
  const upper = "ABC1234567890ABCDEF000000000000000000000F".slice(0, 40);
  await withLedgerFile(makeLedger({ headSha: upper, findings: [{ severity: "must-fix", angle: "scope", summary: "x" }] }), async (ledgerPath) => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "append-gate-survivors-gh-"));
    try {
      const { env, ghPath } = await writeGhStub(tmpDir, []); // no-survivors path: zero gh calls
      const result = await appendGateSurvivors({ ledgerPath, followUpIssue: 9 }, { env, ghCommand: ghPath });
      assert.equal(result.headSha, upper.toLowerCase());
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test("appendGateSurvivors: rejects a missing --ledger file", async () => {
  await assert.rejects(
    () => appendGateSurvivors({ ledgerPath: "/nonexistent/ledger.json", followUpIssue: 9 }),
    /Cannot read --ledger/,
  );
});

// ---------------------------------------------------------------------------
// --jq / --silent base guarantee (real subprocess, no-survivors path — no gh call)
// ---------------------------------------------------------------------------

test("append-gate-survivors.mjs: --help documents the shared --jq/--silent flags", async () => {
  const { code, stdout } = await runNode(SCRIPT_PATH, ["--help"]);
  assert.equal(code, 0);
  assert.match(stdout, /--jq <filter>/);
  assert.match(stdout, /--silent, -s/);
});

test("append-gate-survivors.mjs: --jq filters the result and exits 0 (no-survivors path, no gh needed)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "append-gate-survivors-cli-"));
  try {
    const ledgerPath = path.join(tmpDir, "ledger.json");
    await writeFile(ledgerPath, JSON.stringify(makeLedger({ findings: [{ severity: "must-fix", angle: "scope", summary: "x" }] })), "utf8");
    const { code, stdout, stderr } = await runNode(SCRIPT_PATH, ["--ledger", ledgerPath, "--jq", ".skipped"], { cwd: tmpDir });
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), "no_survivors");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("append-gate-survivors.mjs: --silent suppresses stdout and maps to exit code only", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "append-gate-survivors-cli-"));
  try {
    const ledgerPath = path.join(tmpDir, "ledger.json");
    await writeFile(ledgerPath, JSON.stringify(makeLedger({ findings: [{ severity: "must-fix", angle: "scope", summary: "x" }] })), "utf8");
    const { code, stdout } = await runNode(SCRIPT_PATH, ["--ledger", ledgerPath, "--silent"], { cwd: tmpDir });
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

test("append-gate-survivors.mjs: an invalid --jq filter fails closed: stderr + exit 2", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "append-gate-survivors-cli-"));
  try {
    const ledgerPath = path.join(tmpDir, "ledger.json");
    await writeFile(ledgerPath, JSON.stringify(makeLedger({ findings: [{ severity: "must-fix", angle: "scope", summary: "x" }] })), "utf8");
    const { code, stdout, stderr } = await runNode(SCRIPT_PATH, ["--ledger", ledgerPath, "--jq", "bogus!!"], { cwd: tmpDir });
    assert.equal(code, 2);
    assert.equal(stdout, "");
    assert.match(stderr, /--jq/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
