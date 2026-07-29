import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeGhStub } from "../_helpers.mjs";

import {
  buildFindingsMarker,
  parseFindings,
  parsePostGateFindingsCliArgs,
  postGateFindings,
  renderFindingsCommentBody,
} from "../../scripts/github/post-gate-findings.mjs";

const FINDINGS_JSON = JSON.stringify([
  { severity: "must-fix", angle: "scope", summary: "Scope too broad", disposition: "accepted-for-fix", files: ["src/a.mjs:12"] },
  { severity: "worth-fixing-now", angle: "dry", summary: "DRY violation", disposition: "deferred" },
  { severity: "defer", angle: "naming", summary: "Style nit" },
]);

// ---------------------------------------------------------------------------
// Arg parsing + path-segment validation
// ---------------------------------------------------------------------------

test("parsePostGateFindingsCliArgs parses all required args", () => {
  const result = parsePostGateFindingsCliArgs([
    "--repo", "owner/repo",
    "--pr", "42",
    "--gate", "draft_gate",
    "--head-sha", "abc1234567890abcdef",
    "--findings", "[]",
  ]);
  assert.deepEqual(result, {
    help: false,
    repo: "owner/repo",
    pr: 42,
    gate: "draft_gate",
    headSha: "abc1234567890abcdef",
    findings: "[]",
    findingsFile: undefined,
  });
});

test("parsePostGateFindingsCliArgs rejects invalid gate", () => {
  assert.throws(() => {
    parsePostGateFindingsCliArgs([
      "--repo", "a/b", "--pr", "1", "--gate", "bad_gate",
      "--head-sha", "abc12345", "--findings", "[]",
    ]);
  }, /gate/);
});

test("parsePostGateFindingsCliArgs rejects invalid head SHA", () => {
  assert.throws(() => {
    parsePostGateFindingsCliArgs([
      "--repo", "a/b", "--pr", "1", "--gate", "draft_gate",
      "--head-sha", "short", "--findings", "[]",
    ]);
  }, /hex SHA/);
});

test("parsePostGateFindingsCliArgs rejects missing required args", () => {
  assert.throws(() => {
    parsePostGateFindingsCliArgs(["--repo", "a/b", "--pr", "1"]);
  }, /Missing required/);
});

test("parsePostGateFindingsCliArgs rejects repo with dot segment", () => {
  assert.throws(() => {
    parsePostGateFindingsCliArgs([
      "--repo", "./repo", "--pr", "1", "--gate", "draft_gate",
      "--head-sha", "abc12345", "--findings", "[]",
    ]);
  }, /owner\/name/);
});

test("parsePostGateFindingsCliArgs rejects repo with double-dot segment", () => {
  assert.throws(() => {
    parsePostGateFindingsCliArgs([
      "--repo", "owner/..", "--pr", "1", "--gate", "draft_gate",
      "--head-sha", "abc12345", "--findings", "[]",
    ]);
  }, /owner\/name/);
});

test("parsePostGateFindingsCliArgs rejects repo with whitespace segment", () => {
  assert.throws(() => {
    parsePostGateFindingsCliArgs([
      "--repo", "owner/re po", "--pr", "1", "--gate", "draft_gate",
      "--head-sha", "abc12345", "--findings", "[]",
    ]);
  }, /owner\/name/);
});

test("parsePostGateFindingsCliArgs rejects malformed repo (no slash)", () => {
  assert.throws(() => {
    parsePostGateFindingsCliArgs([
      "--repo", "no-slash", "--pr", "1", "--gate", "draft_gate",
      "--head-sha", "abc12345", "--findings", "[]",
    ]);
  }, /owner\/name/);
});

// ---------------------------------------------------------------------------
// Findings parsing
// ---------------------------------------------------------------------------

test("parseFindings rejects non-array JSON", () => {
  assert.throws(() => parseFindings('{"not":"array"}'), /array/);
});

test("parseFindings rejects invalid severity", () => {
  assert.throws(() => parseFindings(JSON.stringify([{ severity: "bad", angle: "scope", summary: "x" }])), /severity/);
});

test("parseFindings rejects missing angle", () => {
  assert.throws(() => parseFindings(JSON.stringify([{ severity: "must-fix", summary: "x" }])), /angle/);
});

test("parseFindings rejects missing summary", () => {
  assert.throws(() => parseFindings(JSON.stringify([{ severity: "must-fix", angle: "scope" }])), /summary/);
});

test("parseFindings derives a deferred disposition for a defer-severity finding with no explicit disposition", () => {
  const findings = parseFindings(JSON.stringify([{ severity: "defer", angle: "naming", summary: "Style nit" }]));
  assert.equal(findings[0].disposition, "deferred");
});

test("parseFindings keeps an explicit disposition on a defer-severity finding", () => {
  const findings = parseFindings(JSON.stringify([
    { severity: "defer", angle: "naming", summary: "Style nit", disposition: "disputed" },
  ]));
  assert.equal(findings[0].disposition, "disputed");
});

// ---------------------------------------------------------------------------
// --findings-file (mutually exclusive with --findings, identical validation)
// ---------------------------------------------------------------------------

test("postGateFindings accepts findings from --findings-file", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "post-gate-findings-file-"));
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "post-gate-findings-repo-"));
  try {
    const findingsFile = path.join(tmpDir, "findings.json");
    await writeFile(findingsFile, FINDINGS_JSON, "utf8");
    const { env, ghPath } = await writeGhStub(tmpDir, [
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/42/comments?per_page=100"],
        stdout: "[[]]\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/42/comments", "-f"],
        assertArgContains: ["dev-loops:gate-findings"],
        stdout: JSON.stringify({ id: 303, html_url: "https://github.com/owner/repo/pull/42#issuecomment-303" }) + "\n",
      },
    ]);
    const result = await postGateFindings(
      { repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: "abc1234", findingsFile },
      { env, ghCommand: ghPath, repoRoot },
    );
    assert.equal(result.ok, true);
    assert.equal(result.findingsCount, 3);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("postGateFindings rejects both --findings and --findings-file", async () => {
  await assert.rejects(
    () => postGateFindings({ repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: "abc1234", findings: "[]", findingsFile: "/tmp/x.json" }),
    /mutually exclusive/,
  );
});

test("postGateFindings rejects a missing --findings-file", async () => {
  await assert.rejects(
    () => postGateFindings({
      repo: "owner/repo",
      pr: 42,
      gate: "draft_gate",
      headSha: "abc1234",
      findingsFile: "/nonexistent/post-gate-findings-file-does-not-exist.json",
    }),
    /Cannot read --findings-file/,
  );
});

// ---------------------------------------------------------------------------
// Rendering: severity grouping + file refs
// ---------------------------------------------------------------------------

test("buildFindingsMarker is keyed by gate only (head-SHA independent)", () => {
  const marker = buildFindingsMarker({ gate: "draft_gate" });
  assert.equal(marker, "<!-- dev-loops:gate-findings gate=draft_gate -->");
  // Marker must not embed the head SHA: different prefix lengths / full SHA for
  // the same head must still match the single per-gate comment.
  assert.ok(!marker.includes("head="));
  assert.equal(
    buildFindingsMarker({ gate: "draft_gate", headSha: "abc1234" }),
    buildFindingsMarker({ gate: "draft_gate", headSha: "abc1234567890abcdef" }),
  );
});

test("renderFindingsCommentBody groups by severity and renders file refs", () => {
  const findings = parseFindings(FINDINGS_JSON);
  const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  // Hidden marker present.
  assert.ok(body.includes(buildFindingsMarker({ gate: "draft_gate" })));
  // Title and unwrapped head SHA (autolinkable, no backticks).
  assert.ok(body.includes("### Gate fan-out findings: draft_gate"));
  assert.ok(body.includes("Reviewed head: abc1234"));
  assert.ok(!body.includes("`abc1234`"));
  // Severity group headings, most-blocking first.
  const mustIdx = body.indexOf("Must fix (1)");
  const worthIdx = body.indexOf("Worth fixing now (1)");
  const deferIdx = body.indexOf("Defer (1)");
  assert.ok(mustIdx >= 0 && worthIdx >= 0 && deferIdx >= 0);
  assert.ok(mustIdx < worthIdx && worthIdx < deferIdx);
  // Angle as code literal, summary as prose, disposition rendered.
  assert.ok(body.includes("`scope`: Scope too broad"));
  assert.ok(body.includes("accepted-for-fix"));
  // File refs rendered as path:line.
  assert.ok(body.includes("`src/a.mjs:12`"));
});

test("renderFindingsCommentBody renders a no-findings note when empty", () => {
  const body = renderFindingsCommentBody({ gate: "pre_approval_gate", headSha: "deadbeef0", findings: [] });
  assert.ok(body.includes("No findings"));
  assert.ok(body.includes(buildFindingsMarker({ gate: "pre_approval_gate" })));
});

test("renderFindingsCommentBody collapses multi-line/whitespace summary into one clean line", () => {
  const findings = parseFindings(JSON.stringify([
    {
      severity: "must-fix",
      angle: "scope",
      summary: "First line\nsecond line\t\twith   extra    spaces\n\n  and a trailing newline\n",
      disposition: "accepted\nfor-fix",
    },
  ]));
  const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  // The whole finding renders as exactly one Markdown list line (no embedded newlines).
  const listLine = body.split("\n").find(line => line.startsWith("- `scope`:"));
  assert.ok(listLine, "expected a single list line for the finding");
  assert.equal(
    listLine,
    "- `scope`: First line second line with extra spaces and a trailing newline — _accepted for-fix_",
  );
});

test("renderFindingsCommentBody sanitizes file refs (collapses whitespace/newlines, drops empties)", () => {
  const findings = parseFindings(JSON.stringify([
    {
      severity: "must-fix",
      angle: "scope",
      summary: "Scope too broad",
      // File refs carrying embedded whitespace/newlines plus an all-whitespace entry.
      files: ["src/a.mjs:12\n", "  src/b.mjs:\t34  ", "  \n  "],
    },
  ]));
  const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  // The files sub-bullet renders as exactly one clean line (no embedded newlines/tabs).
  const filesLine = body.split("\n").find(line => line.trimStart().startsWith("- files:"));
  assert.ok(filesLine, "expected a single files sub-line for the finding");
  assert.equal(filesLine, "  - files: `src/a.mjs:12`, `src/b.mjs: 34`");
  // No stray empty backtick pair from the all-whitespace entry.
  assert.ok(!body.includes("``"));
});

test("renderFindingsCommentBody neutralizes bare @copilot/`/copilot`* tokens so the rendered body cannot arm the anti-summon guard", async () => {
  const { containsBareCopilotSummon } = await import("../../scripts/_core-helpers.mjs");
  const findings = parseFindings(JSON.stringify([
    {
      severity: "must-fix",
      angle: "scope",
      summary: "Finding: this comment violates the /copilot prohibition rule.",
    },
  ]));
  const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  assert.match(body, /`\/copilot`/);
  assert.equal(containsBareCopilotSummon(body), false, "rendered findings body must not arm the anti-summon guard");
});

test("renderFindingsCommentBody sanitizes an angle containing a backtick + newline into a single clean code span", () => {
  const findings = parseFindings(JSON.stringify([
    {
      severity: "must-fix",
      // angle from a scoped-review agent carrying a backtick (would close the
      // code span) and an embedded newline (would split the list item).
      angle: "sco`pe\ninjection",
      summary: "Scope too broad",
    },
  ]));
  const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  // The finding renders as exactly one Markdown list line (no embedded newline).
  const listLine = body.split("\n").find(line => line.startsWith("- `"));
  assert.ok(listLine, "expected a single list line for the finding");
  // Backtick is stripped (cannot break out of the code span) and the newline is
  // collapsed to a single space, yielding one clean inline span.
  assert.equal(listLine, "- `scope injection`: Scope too broad");
  // No stray backtick leaked from the angle into the rendered body beyond the
  // two that delimit the code span (and the colon/summary that follow).
  assert.ok(!body.includes("sco`pe"));
});

test("renderFindingsCommentBody neutralizes an embedded gate-findings marker in free text (no second HTML comment)", () => {
  const injectedMarker = buildFindingsMarker({ gate: "draft_gate" });
  const findings = parseFindings(JSON.stringify([
    {
      severity: "must-fix",
      angle: "scope",
      // A summary that tries to smuggle a second findings marker (HTML comment)
      // into the rendered body, which would break idempotent comment matching.
      summary: `Scope too broad ${injectedMarker} trailing`,
    },
  ]));
  const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  // Exactly ONE real marker (the legitimate one at the top of the body): the
  // injected one is neutralized, so the raw marker string appears only once.
  const occurrences = body.split(injectedMarker).length - 1;
  assert.equal(occurrences, 1, "the injected marker must be neutralized, leaving only the real marker");
  // The injected text is still visible, just with escaped comment delimiters so
  // it cannot form a real HTML comment.
  assert.ok(body.includes("&lt;!-- dev-loops:gate-findings gate=draft_gate --&gt;"));
  // And the rendered body must not contain a second literal `<!--` ... `-->`
  // pair beyond the single legitimate marker on the first line.
  const lines = body.split("\n");
  assert.ok(lines[0] === injectedMarker, "first line is the legitimate marker");
  const rest = lines.slice(1).join("\n");
  assert.ok(!rest.includes("<!--"), "no raw HTML-comment opener in the rendered body beyond the marker");
});

// ---------------------------------------------------------------------------
// Idempotent create / update via stubbed gh
// ---------------------------------------------------------------------------

async function emptyRepoRoot() {
  return mkdtemp(path.join(os.tmpdir(), "post-gate-findings-repo-"));
}

test("postGateFindings creates a comment when none exists", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "post-gate-findings-"));
  const repoRoot = await emptyRepoRoot();
  try {
    const { env, ghPath } = await writeGhStub(tmpDir, [
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/42/comments?per_page=100"],
        stdout: "[[]]\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/42/comments", "-f"],
        assertArgContains: ["dev-loops:gate-findings"],
        stdout: JSON.stringify({ id: 101, html_url: "https://github.com/owner/repo/pull/42#issuecomment-101" }) + "\n",
      },
    ]);
    const result = await postGateFindings(
      { repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: "abc1234", findings: FINDINGS_JSON },
      { env, ghCommand: ghPath, repoRoot },
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, "created");
    assert.equal(result.commentId, 101);
    assert.equal(result.findingsCount, 3);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("postGateFindings updates the existing marked comment (idempotent, no duplicate)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "post-gate-findings-"));
  const repoRoot = await emptyRepoRoot();
  try {
    // Existing comment carries the marker but stale body → triggers PATCH, not a new create.
    const marker = buildFindingsMarker({ gate: "draft_gate" });
    const existingComment = { id: 55, html_url: "https://github.com/owner/repo/pull/42#issuecomment-55", body: `${marker}\nstale body` };
    const { env, ghPath } = await writeGhStub(tmpDir, [
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/42/comments?per_page=100"],
        stdout: JSON.stringify([[existingComment]]) + "\n",
      },
      {
        assertArgs: ["api", "-X", "PATCH", "repos/owner/repo/issues/comments/55", "-f"],
        stdout: JSON.stringify({ id: 55, html_url: existingComment.html_url }) + "\n",
      },
    ]);
    const result = await postGateFindings(
      { repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: "abc1234", findings: FINDINGS_JSON },
      { env, ghCommand: ghPath, repoRoot },
    );
    assert.equal(result.action, "updated");
    assert.equal(result.commentId, 55);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("postGateFindings no-ops when the existing comment body already matches", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "post-gate-findings-"));
  const repoRoot = await emptyRepoRoot();
  try {
    const findings = parseFindings(FINDINGS_JSON);
    const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
    const existingComment = { id: 77, html_url: "https://github.com/owner/repo/pull/42#issuecomment-77", body };
    const { env, ghPath } = await writeGhStub(tmpDir, [
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/42/comments?per_page=100"],
        stdout: JSON.stringify([[existingComment]]) + "\n",
      },
      // No mutation entry: a second gh call would overflow the stub and fail.
    ]);
    const result = await postGateFindings(
      { repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: "abc1234", findings: FINDINGS_JSON },
      { env, ghCommand: ghPath, repoRoot },
    );
    assert.equal(result.action, "noop");
    assert.equal(result.commentId, 77);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("postGateFindings updates the same per-gate comment when re-run with a different head-SHA length (no duplicate)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "post-gate-findings-"));
  const repoRoot = await emptyRepoRoot();
  try {
    // Existing comment was created earlier with a SHORT head prefix; re-running
    // now with the FULL SHA for the same gate must still match the gate-only
    // marker and PATCH in place rather than creating a second comment.
    const findings = parseFindings(FINDINGS_JSON);
    const existingBody = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
    const existingComment = { id: 88, html_url: "https://github.com/owner/repo/pull/42#issuecomment-88", body: existingBody };
    const { env, ghPath } = await writeGhStub(tmpDir, [
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/42/comments?per_page=100"],
        stdout: JSON.stringify([[existingComment]]) + "\n",
      },
      {
        assertArgs: ["api", "-X", "PATCH", "repos/owner/repo/issues/comments/88", "-f"],
        stdout: JSON.stringify({ id: 88, html_url: existingComment.html_url }) + "\n",
      },
    ]);
    const result = await postGateFindings(
      { repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: "abc1234567890abcdef0123", findings: FINDINGS_JSON },
      { env, ghCommand: ghPath, repoRoot },
    );
    assert.equal(result.action, "updated");
    assert.equal(result.commentId, 88);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Config opt-out: postFindingsComments: false → skipped no-op (no gh call)
// ---------------------------------------------------------------------------

test("postGateFindings is a skipped no-op when gates.postFindingsComments is false", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "post-gate-findings-"));
  const repoRoot = await emptyRepoRoot();
  try {
    await writeFile(
      path.join(repoRoot, ".devloops"),
      "version: 1\ngates:\n  postFindingsComments: false\n",
      "utf8",
    );
    // Empty gh stub: any gh call would overflow and fail (proving the opt-out
    // suppresses the comment entirely).
    const { env, ghPath } = await writeGhStub(tmpDir, []);
    const result = await postGateFindings(
      { repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: "abc1234", findings: FINDINGS_JSON },
      { env, ghCommand: ghPath, repoRoot },
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, "skipped");
    assert.match(result.reason, /postFindingsComments/);
    assert.equal(result.findingsCount, 3);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("postGateFindings falls back to default-on (posts) when the config fails to load/validate", async () => {
  // loadDevLoopConfig never throws; a config that fails schema validation yields a
  // non-empty errors array. We must treat that as config-unavailable and fall back to
  // the default behavior (postFindingsComments default-on => proceed to post), NOT
  // silently trust the malformed/partial config object.
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "post-gate-findings-"));
  const repoRoot = await emptyRepoRoot();
  try {
    // postFindingsComments must be a boolean; a string value fails validation.
    await writeFile(
      path.join(repoRoot, ".devloops"),
      "version: 1\ngates:\n  postFindingsComments: \"yes\"\n",
      "utf8",
    );
    const { env, ghPath } = await writeGhStub(tmpDir, [
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/42/comments?per_page=100"],
        stdout: "[[]]\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/42/comments", "-f"],
        assertArgContains: ["dev-loops:gate-findings"],
        stdout: JSON.stringify({ id: 202, html_url: "https://github.com/owner/repo/pull/42#issuecomment-202" }) + "\n",
      },
    ]);
    const result = await postGateFindings(
      { repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: "abc1234", findings: FINDINGS_JSON },
      { env, ghCommand: ghPath, repoRoot },
    );
    // Default-on fallback => the comment is created despite the malformed config.
    assert.equal(result.ok, true);
    assert.equal(result.action, "created");
    assert.equal(result.commentId, 202);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});
