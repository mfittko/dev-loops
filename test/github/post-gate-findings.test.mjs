import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeGhStub } from "../_helpers.mjs";

import {
  buildFindingsMarker,
  findMarkedComment,
  GITHUB_COMMENT_MAX_CHARS,
  parseFindings,
  parsePostGateFindingsCliArgs,
  postGateFindings,
  renderBoundedFindingsCommentBody,
  renderFindingsCommentBody,
  sanitizeInline,
} from "../../scripts/github/post-gate-findings.mjs";

// #1592: several fixtures below deliberately keep pre-rename severity
// spellings ("must-fix"/"worth-fixing-now"/"nice-to-have") as INPUT — this is
// intentional backward-compat coverage (normalizeSeverity normalizes them on
// read), not stale fixture drift; do not mass-rewrite them to the canonical
// spelling.
// postGateFindings resolves the authenticated `gh` viewer's login (the
// author-scoping trust boundary for findMarkedComment) as its first gh call
// whenever gates.postFindingsComments does not short-circuit it. Every
// existing-comment fixture below defaults its author to this login so prior
// idempotent-match coverage keeps passing unchanged.
const AUTHENTICATED_LOGIN = "gate-bot";

function userEntry({ login = AUTHENTICATED_LOGIN } = {}) {
  return {
    assertArgs: ["api", "user"],
    stdout: `${JSON.stringify({ login })}\n`,
  };
}

const FINDINGS_JSON = JSON.stringify([
  { severity: "must-fix", angle: "scope", summary: "Scope too broad", disposition: "accepted-for-fix", files: ["src/a.mjs:12"] },
  { severity: "worth-fixing-now", angle: "dry", summary: "DRY violation", disposition: "deferred" },
  { severity: "nice-to-have", angle: "naming", summary: "Style nit" },
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

test("parsePostGateFindingsCliArgs accepts --findings-file", () => {
  const result = parsePostGateFindingsCliArgs([
    "--repo", "owner/repo",
    "--pr", "42",
    "--gate", "draft_gate",
    "--head-sha", "abc1234567890abcdef",
    "--findings-file", "/tmp/findings.json",
  ]);
  assert.equal(result.findingsFile, "/tmp/findings.json");
  assert.equal(result.findings, undefined);
});

test("parsePostGateFindingsCliArgs rejects --findings and --findings-file together", () => {
  assert.throws(() => {
    parsePostGateFindingsCliArgs([
      "--repo", "a/b", "--pr", "1", "--gate", "draft_gate",
      "--head-sha", "abc12345", "--findings", "[]", "--findings-file", "/tmp/findings.json",
    ]);
  }, /mutually exclusive/);
});

test("parsePostGateFindingsCliArgs rejects when neither --findings nor --findings-file is given", () => {
  assert.throws(() => {
    parsePostGateFindingsCliArgs([
      "--repo", "a/b", "--pr", "1", "--gate", "draft_gate",
      "--head-sha", "abc12345",
    ]);
  }, /pass --findings <json> or --findings-file <path>/);
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

test("parseFindings derives a deferred disposition for a nice-to-have finding with no explicit disposition", () => {
  const findings = parseFindings(JSON.stringify([{ severity: "nice-to-have", angle: "naming", summary: "Style nit" }]));
  assert.equal(findings[0].disposition, "deferred");
});

test("parseFindings keeps an explicit disposition on a nice-to-have finding", () => {
  const findings = parseFindings(JSON.stringify([
    { severity: "nice-to-have", angle: "naming", summary: "Style nit", disposition: "disputed" },
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
      userEntry(),
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

test("findMarkedComment (contradiction-lens): a marker merely QUOTED mid-line (not at line start) is never matched", () => {
  const marker = buildFindingsMarker({ gate: "draft_gate" });
  const quoting = { id: 1, body: `See the prior comment: ${marker} for context.`, user: { login: "gate-bot" } };
  const blockquoted = { id: 2, body: `> ${marker}\nAgreed.`, user: { login: "gate-bot" } };
  const genuine = { id: 3, body: `${marker}\n### Gate fan-out findings: draft_gate`, user: { login: "gate-bot" } };
  assert.equal(findMarkedComment([quoting, blockquoted], marker, { author: "gate-bot" }), null);
  assert.equal(findMarkedComment([quoting, genuine], marker, { author: "gate-bot" }), genuine);
});

test("findMarkedComment (marker provenance): a required expected author excludes a FOREIGN comment forging the exact marker shape", () => {
  const marker = buildFindingsMarker({ gate: "draft_gate" });
  const foreign = { id: 1, body: `${marker}\nforged by someone else`, user: { login: "someone-else" } };
  const genuine = { id: 2, body: `${marker}\n### Gate fan-out findings: draft_gate`, user: { login: "gate-bot" } };
  // Only the matching login's comment is honored.
  assert.equal(findMarkedComment([foreign], marker, { author: "gate-bot" }), null);
  assert.equal(findMarkedComment([foreign, genuine], marker, { author: "gate-bot" }), genuine);
});

test("findMarkedComment fails closed when author is omitted (never falls back to matching every author)", () => {
  const marker = buildFindingsMarker({ gate: "draft_gate" });
  const genuine = { id: 1, body: `${marker}\n### Gate fan-out findings: draft_gate`, user: { login: "gate-bot" } };
  assert.throws(() => findMarkedComment([genuine], marker, {}), /requires a non-empty author/);
  assert.throws(() => findMarkedComment([genuine], marker), /requires a non-empty author/);
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
  const mustIdx = body.indexOf("High (1)");
  const worthIdx = body.indexOf("Medium (1)");
  const deferIdx = body.indexOf("Low (1)");
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

test("renderFindingsCommentBody neutralizes raw HTML tags and markdown link/image syntax in a summary (parity with upsert-checkpoint-verdict.mjs)", () => {
  const findings = parseFindings(JSON.stringify([
    {
      severity: "must-fix",
      angle: "renderer-security",
      summary: "Raw <script>alert(1)</script>, a [link](http://evil.example) and an ![image](http://evil.example/x.png)",
    },
  ]));
  const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  assert.ok(!body.includes("<script>"), "a raw HTML tag must never survive unescaped");
  assert.ok(body.includes("&lt;script>alert(1)&lt;/script>"));
  assert.ok(!body.includes("[link](http://evil.example)"), "a live markdown link must never survive unescaped");
  assert.ok(body.includes("&#91;link](http://evil.example)"));
  assert.ok(!body.includes("![image](http://evil.example/x.png)"), "a live markdown image embed must never survive unescaped");
  assert.ok(body.includes("!&#91;image](http://evil.example/x.png)"));
});

// Composition regression (renderer-security): sanitizeCodeSpan must NOT layer
// entity encoding on top of a value that is about to be wrapped in its own
// backtick code span — a code span is already inert (CommonMark parses it
// before link/image/HTML syntax), so encoding `[` there would render the
// entity's own literal text (`app/&#91;id]/page.tsx`) instead of the legible
// bracketed path. The same value rendered as bare prose (summary, no code
// span) still needs the full neutralization since it is NOT inert there.
test("sanitizeCodeSpan leaves a bracketed path verbatim inside its code span; sanitizeInline still neutralizes the same value in prose", () => {
  const findings = parseFindings(JSON.stringify([
    {
      severity: "must-fix",
      angle: "renderer-security",
      summary: "Route param mismatch in app/[id]/page.tsx",
      files: ["app/[id]/page.tsx"],
    },
  ]));
  const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  // The file ref, rendered inside its own code span, survives verbatim.
  const filesLine = body.split("\n").find(line => line.trim().startsWith("- files:"));
  assert.ok(filesLine, "expected a files line for the finding");
  assert.equal(filesLine.trim(), "- files: `app/[id]/page.tsx`");
  // The same value in the bare-prose summary field is neutralized.
  assert.ok(body.includes("Route param mismatch in app/&#91;id]/page.tsx"), "the same value in bare prose must still be neutralized");
});

// ---------------------------------------------------------------------------
// Idempotent create / update via stubbed gh
// ---------------------------------------------------------------------------

// The consolidated findings comment is a SECOND surface, opt-in via
// gates.postFindingsComments (default false), so every posting test needs a
// repo root that has explicitly opted in.
async function optedInRepoRoot() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "post-gate-findings-repo-"));
  await writeFile(path.join(repoRoot, ".devloops"), "version: 1\ngates:\n  postFindingsComments: true\n", "utf8");
  return repoRoot;
}

test("postGateFindings creates a comment when none exists", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "post-gate-findings-"));
  const repoRoot = await optedInRepoRoot();
  try {
    const { env, ghPath } = await writeGhStub(tmpDir, [
      userEntry(),
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
    // Result-shape invariant: omittedFindingsCount is documented (USAGE
    // above) as present ONLY when the render degraded. This round is far
    // under the comment length limit, so the field must be entirely absent,
    // not merely falsy/zero.
    assert.ok(!("omittedFindingsCount" in result), "omittedFindingsCount must be absent on a non-degraded round");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("postGateFindings updates the existing marked comment (idempotent, no duplicate)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "post-gate-findings-"));
  const repoRoot = await optedInRepoRoot();
  try {
    // Existing comment carries the marker but stale body → triggers PATCH, not a new create.
    const marker = buildFindingsMarker({ gate: "draft_gate" });
    const existingComment = { id: 55, html_url: "https://github.com/owner/repo/pull/42#issuecomment-55", body: `${marker}\nstale body`, user: { login: AUTHENTICATED_LOGIN } };
    const { env, ghPath } = await writeGhStub(tmpDir, [
      userEntry(),
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
  const repoRoot = await optedInRepoRoot();
  try {
    const findings = parseFindings(FINDINGS_JSON);
    const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
    const existingComment = { id: 77, html_url: "https://github.com/owner/repo/pull/42#issuecomment-77", body, user: { login: AUTHENTICATED_LOGIN } };
    const { env, ghPath } = await writeGhStub(tmpDir, [
      userEntry(),
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
  const repoRoot = await optedInRepoRoot();
  try {
    // Existing comment was created earlier with a SHORT head prefix; re-running
    // now with the FULL SHA for the same gate must still match the gate-only
    // marker and PATCH in place rather than creating a second comment.
    const findings = parseFindings(FINDINGS_JSON);
    const existingBody = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
    const existingComment = { id: 88, html_url: "https://github.com/owner/repo/pull/42#issuecomment-88", body: existingBody, user: { login: AUTHENTICATED_LOGIN } };
    const { env, ghPath } = await writeGhStub(tmpDir, [
      userEntry(),
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

test("postGateFindings searches for its existing comment using the SAME sanitized gate the render itself embeds in the marker (regression: an un-sanitized search marker would re-create a duplicate)", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "post-gate-findings-"));
  const repoRoot = await optedInRepoRoot();
  try {
    // A gate value sanitizeInline changes but that does not collide with a
    // real known gate (see the dedicated collision-rejection test above) — a
    // value the render seam still accepts, just not byte-identical to what
    // was passed in.
    const rawGate = "draft_gate[extra]";
    const sanitizedGate = sanitizeInline(rawGate);
    assert.notEqual(sanitizedGate, rawGate, "fixture assumption: this gate value must actually require sanitization");
    const findings = parseFindings(FINDINGS_JSON);
    const existingBody = renderFindingsCommentBody({ gate: sanitizedGate, headSha: "abc1234", findings });
    const existingComment = { id: 99, html_url: "https://github.com/owner/repo/pull/42#issuecomment-99", body: existingBody, user: { login: AUTHENTICATED_LOGIN } };
    const { env, ghPath } = await writeGhStub(tmpDir, [
      userEntry(),
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/42/comments?per_page=100"],
        stdout: JSON.stringify([[existingComment]]) + "\n",
      },
      // No mutation entry: an unsanitized search marker would miss this
      // existing comment and call create instead, overflowing the stub.
    ]);
    const result = await postGateFindings(
      { repo: "owner/repo", pr: 42, gate: rawGate, headSha: "abc1234", findings: FINDINGS_JSON },
      { env, ghCommand: ghPath, repoRoot },
    );
    assert.equal(result.action, "noop");
    assert.equal(result.commentId, 99);
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
  const repoRoot = await optedInRepoRoot();
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

test("postGateFindings falls back to the default (skips) when the config fails to load/validate", async () => {
  // loadDevLoopConfig never throws; a config that fails schema validation yields a
  // non-empty errors array. We must treat that as config-unavailable and fall back to
  // the default behavior (postFindingsComments default-off => skip the second
  // surface), NOT silently trust the malformed/partial config object.
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "post-gate-findings-"));
  const repoRoot = await optedInRepoRoot();
  try {
    // postFindingsComments must be a boolean; a string value fails validation.
    await writeFile(
      path.join(repoRoot, ".devloops"),
      "version: 1\ngates:\n  postFindingsComments: \"yes\"\n",
      "utf8",
    );
    // Empty gh stub: any gh call would overflow and fail, proving the fallback
    // never posts off an unreadable config.
    const { env, ghPath } = await writeGhStub(tmpDir, []);
    const result = await postGateFindings(
      { repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: "abc1234", findings: FINDINGS_JSON },
      { env, ghCommand: ghPath, repoRoot },
    );
    // Default-off fallback => no second surface despite the malformed config.
    assert.equal(result.ok, true);
    assert.equal(result.action, "skipped");
    assert.match(result.reason, /postFindingsComments/);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

// #1514 coexistence pin: the opt-in findings comment and the verdict surface
// must never claim each other. Each tool locates "its" comment by its own
// marker vocabulary; these assertions fail if either vocabulary grows to
// match the other tool's rendered body (the class of silent overwrite
// observed live on PR 1513 before the single-surface rework).
test("findings comment and verdict body are mutually unclaimable (#1514)", async () => {
  const { renderFindingsCommentBody, buildFindingsMarker } = await import("../../scripts/github/post-gate-findings.mjs");
  const { renderGateReviewCommentBody } = await import("../../scripts/github/upsert-checkpoint-verdict.mjs");
  const { parseGateReviewCommentMarkerBody, summarizeGateReviewCommentMarkers } = await import("@dev-loops/core/github/copilot-helpers");

  const findingsBody = renderFindingsCommentBody({
    gate: "draft_gate",
    headSha: "a".repeat(40),
    findings: [
      { severity: "must-fix", angle: "correctness", summary: "Verdict: clean", disposition: "accepted-for-fix" },
    ],
  });
  // The verdict upsert claims comments through the marker summarizer (the
  // seam detect-checkpoint-evidence feeds it); the findings comment must be
  // skipped as a machine artifact there — even though its "Gate fan-out
  // findings:"/"Reviewed head:" lines make the raw field parser extract
  // gate+headSha, and even when a finding summary embeds verdict-like text.
  const claimed = summarizeGateReviewCommentMarkers([
    { id: 1, body: findingsBody, html_url: "https://github.test/c/1", updated_at: "2026-08-04T00:00:00Z" },
  ], { headSha: "a".repeat(40) });
  assert.equal(claimed.draft_gate, null);
  assert.equal(claimed.pre_approval_gate, null);

  const verdictBody = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "a".repeat(40),
    verdict: "clean",
    findingsSummary: "no findings",
    nextAction: "merge",
    blockCleanOnFindingSeverities: ["must-fix"],
    executionMode: "fanout_fanin",
  });
  // The findings upsert finds its comment via its own hidden marker; the
  // verdict body must never carry it.
  assert.ok(!verdictBody.includes(buildFindingsMarker({ gate: "draft_gate" })));
  // And the verdict body IS claimable by its own parser (sanity).
  assert.ok(parseGateReviewCommentMarkerBody(verdictBody) !== null);
  const verdictClaimed = summarizeGateReviewCommentMarkers([
    { id: 2, body: verdictBody, html_url: "https://github.test/c/2", updated_at: "2026-08-04T00:00:00Z" },
  ], { headSha: "a".repeat(40) });
  assert.ok(verdictClaimed.draft_gate !== null);
  // The findings comment's body is a machine artifact (the marker-boundary
  // cases themselves are pinned in the filter's owner suite,
  // packages/core/test/copilot-helpers.test.mjs).
  const { isGateMachineArtifactBody } = await import("@dev-loops/core/github/copilot-helpers");
  assert.equal(isGateMachineArtifactBody(findingsBody), true);
});

test("renderFindingsCommentBody states that only the latest round is shown (#AC2 stated replacement)", () => {
  const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: [] });
  assert.ok(body.includes("only the latest posted round"));
  assert.ok(body.includes("per-round gate reviews"));
});

test("a legacy defer-severity finding parses, normalizes, and renders the new label", () => {
  const findings = parseFindings(JSON.stringify([{ severity: "defer", angle: "docs", summary: "legacy entry" }]));
  assert.equal(findings[0].severity, "low");
  assert.equal(findings[0].disposition, "deferred");
  const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  assert.ok(body.includes("Low (1)"));
  assert.ok(!body.includes("[`defer`]"));
});

// Every pre-rename severity spelling still parses and renders under its
// canonical label — the full sweep, not just "defer".
test("every legacy severity spelling parses, normalizes, and renders under its canonical label", () => {
  const findings = parseFindings(JSON.stringify([
    { severity: "must-fix", angle: "security", summary: "sql injection" },
    { severity: "worth-fixing-now", angle: "perf", summary: "n+1 query" },
    { severity: "nice-to-have", angle: "naming", summary: "casing nit" },
  ]));
  assert.deepEqual(findings.map((f) => f.severity), ["high", "medium", "low"]);
  const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  assert.ok(body.includes("High (1)"));
  assert.ok(body.includes("Medium (1)"));
  assert.ok(body.includes("Low (1)"));
});

// #1592: the two non-defect categories render under their own labels too.
test("renderFindingsCommentBody renders Question and Nit group labels", () => {
  const findings = parseFindings(JSON.stringify([
    { severity: "question", angle: "scope", summary: "why this approach?" },
    { severity: "nit", angle: "naming", summary: "casing nit" },
  ]));
  const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  assert.ok(body.includes("Question (1)"));
  assert.ok(body.includes("Nit (1)"));
});

// A low/nit finding with no explicit disposition defaults to "deferred".
// This shape carries no `line` field at all, so a question here can never be
// proven LOCATABLE — it defaults to "deferred" too (never "needs-answer",
// which is reserved for a locatable question elsewhere in the pipeline —
// see write-gate-findings-log.mjs/consolidateFanin, which do carry `line`).

// ---------------------------------------------------------------------------
// Sanitisation parity with upsert-checkpoint-verdict.mjs's renderer
// ---------------------------------------------------------------------------

// The two known bypasses, run through BOTH gate finding renderers. Both
// renderers import the identical sanitizeInline/sanitizeCodeSpan pair from
// this file (post-gate-findings.mjs) rather than each keeping a copy (see
// upsert-checkpoint-verdict.mjs's own comment on its sanitizeStructured*
// aliases), so these tests fail if EITHER renderer stops sanitizing — whether
// by a regression in the shared functions or by either file reverting to its
// own duplicate copy.
//
// The exact crafted VALUES differ per renderer because the two renderers wrap
// severity/disposition differently: post-gate-findings.mjs renders `summary`
// AND `disposition` as bare prose on the same list line (so the classic
// bypass can split across the two), while upsert-checkpoint-verdict.mjs wraps
// severity/disposition in their own backtick code spans — already inert to
// link/image syntax regardless of sanitization, since a code span is parsed
// before link/image syntax (see sanitizeCodeSpan's own doc comment) — leaving
// `summary` as its ONLY bare-prose field. A payload built only from a
// severity/disposition value shaped like `must-fix](url)` would sit inside
// upsert-checkpoint-verdict.mjs's own code-span backticks and can never form a
// live link there no matter what the sanitizer does, so asserting against
// that shape would pass vacuously for that renderer — the payload for each
// renderer targets a field that is actually exercised there.
test("both gate finding renderers neutralize a link-injection payload built entirely from bare-prose fields (parity guard: sanitizeInline / sanitizeStructuredInline)", async () => {
  const { renderGateReviewCommentBody } = await import("../../scripts/github/upsert-checkpoint-verdict.mjs");

  // post-gate-findings.mjs: a dangling `[` in `summary` completes into a live
  // link when combined with `](url)` supplied by `disposition`, another bare
  // field rendered on the same line.
  const linkInjectionFindings = parseFindings(JSON.stringify([
    {
      severity: "high",
      angle: "renderer-security",
      summary: "See [details for more info",
      disposition: "must-fix](https://evil.example)",
    },
  ]));
  const postGateBody = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: linkInjectionFindings });
  assert.ok(
    !/\[[^\]]*\]\(https:\/\/evil\.example\)/.test(postGateBody),
    "post-gate-findings.mjs must never render a live markdown link from a crafted summary/disposition pair",
  );

  // upsert-checkpoint-verdict.mjs: the entire payload has to live inside
  // `summary`, its only bare-prose field.
  const verdictBody = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      {
        angle: "renderer-security",
        verdict: "findings_present",
        findings: [
          { severity: "high", summary: "See [details for more info](https://evil.example) trailing" },
        ],
      },
    ],
  });
  assert.ok(
    !/\[[^\]]*\]\(https:\/\/evil\.example\)/.test(verdictBody),
    "upsert-checkpoint-verdict.mjs must never render a live markdown link from a crafted `summary` value",
  );
});

test("both gate finding renderers neutralize a backtick-unbalance payload that would otherwise unwrap a later field's code span (parity guard: sanitizeCodeSpan / sanitizeStructuredCodeSpan)", async () => {
  const { renderGateReviewCommentBody } = await import("../../scripts/github/upsert-checkpoint-verdict.mjs");

  // A stray backtick in `summary` (bare prose) can shift CommonMark's
  // left-to-right backtick pairing and steal a LATER field's own opening
  // code-span delimiter, leaving that field's crafted `](url)` to combine
  // with an EARLIER unescaped `[` into a live link instead of inert code
  // text.
  const backtickFindings = parseFindings(JSON.stringify([
    {
      severity: "high",
      angle: "renderer-security",
      summary: "guard [missing for ` value",
      files: ["a.mjs](https://evil.example)"],
    },
  ]));
  const backtickBody = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: backtickFindings });
  // The file ref's own code span still forms intact around the WHOLE crafted
  // value: no earlier stray backtick stole its opening delimiter. A bare
  // substring match on the closed span alone would pass even if an earlier
  // unstripped backtick had already shifted CommonMark's pairing (the field
  // would still literally CONTAIN that substring, just not as its own
  // matched span) — assert PAIRING directly instead: an EVEN number of
  // backticks must precede the span's own opening delimiter, so it starts a
  // fresh pair rather than continuing one left open earlier in the line.
  const fileRefSpan = "`a.mjs](https://evil.example)`";
  const fileRefIndex = backtickBody.indexOf(fileRefSpan);
  assert.ok(fileRefIndex > -1, "expected the file ref's own code span in the rendered body");
  const precedingBackticks = (backtickBody.slice(0, fileRefIndex).match(/`/g) ?? []).length;
  assert.equal(precedingBackticks % 2, 0, "an even number of backticks must precede the file ref's own opening delimiter (odd means an earlier stray backtick shifted the pairing)");
  assert.ok(!backtickBody.includes("for ` value"), "the stray backtick in summary must be stripped, not survive to shift pairing");

  // Same shape against upsert-checkpoint-verdict.mjs's structured renderer:
  // `summary` is bare prose, `file` is rendered inside its own code span.
  const verdictBacktickBody = renderGateReviewCommentBody({
    gate: "draft_gate",
    headSha: "abc1234000000000000000000000000000000000",
    verdict: "findings_present",
    findingsSummary: "ignored",
    nextAction: "fix",
    executionMode: "fanout_fanin",
    structuredFindings: [
      {
        angle: "renderer-security",
        verdict: "findings_present",
        findings: [
          { severity: "high", summary: "guard [missing for ` value", file: "a.mjs](https://evil.example)" },
        ],
      },
    ],
  });
  const verdictFileRefIndex = verdictBacktickBody.indexOf(fileRefSpan);
  assert.ok(verdictFileRefIndex > -1, "expected the file ref's own code span in the rendered body");
  const verdictPrecedingBackticks = (verdictBacktickBody.slice(0, verdictFileRefIndex).match(/`/g) ?? []).length;
  assert.equal(verdictPrecedingBackticks % 2, 0, "an even number of backticks must precede the file ref's own opening delimiter (odd means an earlier stray backtick shifted the pairing)");
  assert.ok(!verdictBacktickBody.includes("for ` value"), "the stray backtick in summary must be stripped, not survive to shift pairing");
});

// ---------------------------------------------------------------------------
// Length bound (GitHub's 65536-char comment limit)
// ---------------------------------------------------------------------------

function buildOversizedFindings({ nitCount = 2000 } = {}) {
  const findings = [{ severity: "high", angle: "scope", summary: "A must-fix that must always survive degradation" }];
  for (let i = 0; i < nitCount; i += 1) {
    findings.push({ severity: "nit", angle: "naming", summary: `Nit finding number ${i} padded with filler text so the round is large`.repeat(3) });
  }
  return findings;
}

test("renderBoundedFindingsCommentBody degrades a too-large ledger into a posted-size comment, naming what is omitted", () => {
  const findings = parseFindings(JSON.stringify(buildOversizedFindings()));
  const unbounded = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  assert.ok(unbounded.length > GITHUB_COMMENT_MAX_CHARS, "fixture must actually exceed the limit to exercise degradation");
  const { body, omittedCounts } = renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  assert.ok(body.length <= GITHUB_COMMENT_MAX_CHARS, `degraded body must fit within the limit (got ${body.length})`);
  assert.ok(omittedCounts.length > 0, "expected at least one severity group to be dropped");
  assert.equal(omittedCounts[0].severity, "nit", "least-urgent severity is dropped first");
  // Omission is NAMED with a pointer to the durable record — never silent.
  // Assert the omission note's actual TEXT, not just that some sentence
  // fragment is present: the leading omitted-total count, the applied limit
  // (not a hand-copied constant that could drift from the maxChars this
  // render actually used), and the per-severity breakdown label (derived
  // from SEVERITY_LABELS, not hand-copied — a broken derivation would render
  // "undefined" here).
  const omittedTotal = omittedCounts.reduce((sum, { count }) => sum + count, 0);
  assert.match(body, new RegExp(`${omittedTotal} finding\\(s\\) omitted from this comment \\(${omittedCounts[0].count} Nit\\)`));
  assert.match(body, new RegExp(`this comment's ${GITHUB_COMMENT_MAX_CHARS}-character limit`));
  assert.match(body, /disposition ledger/);
  // The high finding is never dropped while a less-urgent group is available to drop instead.
  assert.ok(body.includes("A must-fix that must always survive degradation"));
});

test("renderBoundedFindingsCommentBody drops only as many low-priority findings as it takes for a round only slightly over the limit (proportional, not whole-group)", () => {
  const findings = parseFindings(JSON.stringify(buildOversizedFindings({ nitCount: 50 })));
  const unbounded = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  const maxChars = unbounded.length - 10; // only 10 chars over the limit
  const { body, omittedCounts } = renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings, maxChars });
  assert.ok(body.length <= maxChars, `degraded body must fit within the limit (got ${body.length})`);
  assert.ok(body.includes("A must-fix that must always survive degradation"), "the high-severity finding must survive a small overflow");
  const omittedTotal = omittedCounts.reduce((sum, { count }) => sum + count, 0);
  assert.equal(omittedTotal, 2, `expected exactly the 2 least-urgent nit findings needed to absorb a 10-char overflow, got ${omittedTotal}`);
  assert.ok(omittedCounts.every(({ severity }) => severity === "nit"), "a 10-char overflow must never spill into a more-urgent group");
  // Names the NON-DEFAULT limit actually applied (this test's own `maxChars`,
  // not the GitHub default constant) and the per-severity breakdown label.
  assert.match(body, new RegExp(`finding\\(s\\) omitted from this comment \\(2 Nit\\)`));
  assert.match(body, new RegExp(`this comment's ${maxChars}-character limit`));
});

test("renderBoundedFindingsCommentBody drops question last among the below-high severities (nit/low/medium fully dropped before question is touched)", () => {
  const padded = (label) => `${label} finding with enough padding text to add real bulk to the rendered comment body`.repeat(3);
  const findings = [{ severity: "high", angle: "scope", summary: "A must-fix that must always survive degradation" }];
  for (let i = 0; i < 200; i += 1) findings.push({ severity: "nit", angle: "naming", summary: padded(`Nit ${i}`) });
  for (let i = 0; i < 200; i += 1) findings.push({ severity: "low", angle: "naming", summary: padded(`Low ${i}`) });
  for (let i = 0; i < 200; i += 1) findings.push({ severity: "medium", angle: "naming", summary: padded(`Medium ${i}`) });
  for (let i = 0; i < 200; i += 1) findings.push({ severity: "question", angle: "naming", summary: padded(`Question ${i}`) });
  const parsed = parseFindings(JSON.stringify(findings));
  // Bound tight enough that nit/low/medium must ALL be dropped, but generous
  // enough for the high finding plus every question finding to survive.
  const questionOnly = parseFindings(JSON.stringify([findings[0], ...findings.filter((f) => f.severity === "question")]));
  const maxChars = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: questionOnly }).length + 500;
  const { body, omittedCounts } = renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: parsed, maxChars });
  assert.ok(body.length <= maxChars, `degraded body must fit within the limit (got ${body.length})`);
  assert.deepEqual(
    omittedCounts.map(({ severity }) => severity),
    ["nit", "low", "medium"],
    "nit/low/medium must be dropped in that order, with question surviving fully",
  );
  assert.ok(omittedCounts.every(({ count }) => count === 200), "each of the three droppable groups must be dropped in full before question is touched");
  assert.ok(body.includes("Question (200)"), "every question finding must survive while nit/low/medium are fully dropped");
});

test("renderBoundedFindingsCommentBody normalizes legacy (pre-rename) severity spellings when deciding what is droppable and what was omitted", () => {
  const padded = (label) => `${label} finding with enough padding text to add real bulk to the rendered comment body`.repeat(3);
  // Deliberately raw, pre-#1592 severity spellings, calling
  // renderBoundedFindingsCommentBody directly (bypassing parseFindings'/
  // validateFindingsArray's own normalization) so this exercises
  // summarizeDroppedBySeverity's and dropOrder's OWN normalize-at-read
  // behavior. Without it: summarizeDroppedBySeverity would report an empty
  // omittedCounts (findings dropped with no omission note — silent
  // truncation), and dropOrder would treat the legacy-spelled findings as
  // undroppable (a small overflow fails closed instead of degrading).
  const findings = [{ severity: "must-fix", angle: "scope", summary: "A must-fix that must always survive degradation" }];
  for (let i = 0; i < 30; i += 1) findings.push({ severity: "worth-fixing-now", angle: "naming", summary: padded(`Medium ${i}`) });
  for (let i = 0; i < 30; i += 1) findings.push({ severity: "nice-to-have", angle: "naming", summary: padded(`Legacy-low ${i}`) });
  // Bound tight enough that the legacy-low group must be fully dropped, but
  // generous enough for the high finding and every medium finding to survive.
  const mediumOnly = [findings[0], ...findings.filter((f) => f.severity === "worth-fixing-now")];
  const maxChars = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: mediumOnly }).length + 500;
  const { body, omittedCounts } = renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings, maxChars });
  assert.ok(body.length <= maxChars, `degraded body must fit within the limit (got ${body.length})`);
  assert.deepEqual(omittedCounts, [{ severity: "low", count: 30 }], "the 30 legacy nice-to-have findings must be counted under their canonical (low) label");
  assert.match(body, /30 finding\(s\) omitted from this comment \(30 Low\)/);
  assert.ok(body.includes("A must-fix that must always survive degradation"), "the high (legacy must-fix) finding must survive");
  assert.ok(body.includes("Medium (30)"), "every medium (legacy worth-fixing-now) finding must survive");
});

test("renderBoundedFindingsCommentBody preserves each surviving finding's original relative order within its own severity group when only some of the group is dropped", () => {
  const highFinding = { severity: "high", angle: "s", summary: "must survive" };
  const nit0 = { severity: "nit", angle: "n", summary: `nit-zero ${"x".repeat(400)}` };
  const nit1 = { severity: "nit", angle: "n", summary: "nit-one" };
  const nit2 = { severity: "nit", angle: "n", summary: "nit-two" };
  const findings = [highFinding, nit0, nit1, nit2];
  const fullBody = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  // A bound that fits once the single largest (nit0, first in the array)
  // finding is dropped, but not the full render.
  const withoutNit0 = renderFindingsCommentBody({
    gate: "draft_gate",
    headSha: "abc1234",
    findings: [highFinding, nit1, nit2],
    omittedCounts: [{ severity: "nit", count: 1 }],
  });
  const maxChars = withoutNit0.length;
  assert.ok(fullBody.length > maxChars, "fixture assumption: dropping nit0 must be required to fit");
  const { body, omittedCounts } = renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings, maxChars });
  assert.deepEqual(omittedCounts, [{ severity: "nit", count: 1 }]);
  assert.ok(!body.includes("nit-zero"), "the dropped (first-in-array) nit must not be rendered");
  const nit1Index = body.indexOf("nit-one");
  const nit2Index = body.indexOf("nit-two");
  assert.ok(nit1Index > -1 && nit2Index > -1, "both surviving nits must render");
  assert.ok(nit1Index < nit2Index, "surviving findings within the group must keep their original relative order, not be reversed");
});

test("renderBoundedFindingsCommentBody drops every finding, and states so, when even a single finding cannot fit (all-omitted branch)", () => {
  const findings = parseFindings(JSON.stringify([{ severity: "high", angle: "scope", summary: "x".repeat(2000) }]));
  const maxChars = 700;
  const zeroFindingsNote = renderFindingsCommentBody({
    gate: "draft_gate",
    headSha: "abc1234",
    findings: [],
    omittedCounts: [{ severity: "high", count: 1 }],
    maxChars,
  });
  assert.ok(zeroFindingsNote.length <= maxChars, "fixture assumption: the fully-degraded (zero-findings) note itself must fit within maxChars");
  const { body, omittedCounts } = renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings, maxChars });
  assert.ok(body.length <= maxChars, `degraded body must fit within the limit (got ${body.length})`);
  assert.deepEqual(omittedCounts, [{ severity: "high", count: 1 }]);
  assert.match(body, /none survived the comment length bound/);
});

test("renderBoundedFindingsCommentBody posts the fitting single-survivor render instead of failing closed when dropping the very last finding makes the render LONGER (the zero-findings sentence can outgrow a tiny finding's own line)", () => {
  const highFinding = { severity: "high", angle: "s", summary: "x" };
  const nitCount = 50;
  const findings = [highFinding];
  for (let i = 0; i < nitCount; i += 1) {
    findings.push({ severity: "nit", angle: "n", summary: `nit ${i} padding text here to add bulk`.repeat(2) });
  }
  const parsed = parseFindings(JSON.stringify(findings));
  const highOnly = parsed.filter((f) => f.severity === "high");
  const nitOmitted = [{ severity: "nit", count: nitCount }];
  const allOmitted = [{ severity: "high", count: 1 }, { severity: "nit", count: nitCount }];
  // Render once (at the default limit) to learn a candidate length, then
  // re-render WITH that candidate as maxChars: the omission note embeds
  // maxChars itself, so its digit count (and therefore the body's own
  // length) depends on which maxChars produced it — deriving the "fits
  // exactly" bound from a render that used the much-larger default limit's
  // digit count understates the true bound by the digit-count difference.
  const candidateMaxChars = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: highOnly, omittedCounts: nitOmitted }).length;
  const maxChars = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: highOnly, omittedCounts: nitOmitted, maxChars: candidateMaxChars }).length;
  // The render with every nit dropped but the sole high finding still
  // rendered (one survivor), versus dropping that last survivor too (zero
  // findings, the "none survived" sentence) — both rendered against the
  // same self-consistent maxChars so each fixture's own note text matches
  // the bound actually being tested against.
  const oneSurvivorBody = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: highOnly, omittedCounts: nitOmitted, maxChars });
  const zeroSurvivorBody = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: [], omittedCounts: allOmitted, maxChars });
  assert.equal(oneSurvivorBody.length, maxChars, "fixture assumption: the one-survivor render must fit maxChars exactly");
  assert.ok(zeroSurvivorBody.length > oneSurvivorBody.length, "fixture assumption: dropping the very last finding must make the render LONGER, not shorter, to reproduce the bug");
  // A maxChars that fits the one-survivor render exactly, but not the
  // (longer) zero-survivor render — a probe of only `k = n` (drop
  // everything) would wrongly conclude nothing fits and fail closed.
  const { body, omittedCounts } = renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: parsed, maxChars });
  assert.ok(body.length <= maxChars, `degraded body must fit within the limit (got ${body.length})`);
  assert.deepEqual(omittedCounts, nitOmitted, "must stop at dropping every nit and keep the sole surviving high finding, not drop it too");
  assert.ok(body.includes("`s`"), "the sole surviving high finding must still be rendered");
});

test("renderBoundedFindingsCommentBody fails closed when even the fully-degraded render cannot fit", () => {
  const findings = parseFindings(JSON.stringify([{ severity: "high", angle: "scope", summary: "irrelevant" }]));
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings, maxChars: 10 }),
    /cannot be rendered within/,
  );
});

test("renderBoundedFindingsCommentBody rejects a non-array findings input", () => {
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: null }),
    /findings must be an array, got null/,
  );
  // typeof null === "object", so a naive typeof-only report would say "got
  // object" here — inconsistent with the per-element guard below, which
  // already special-cases null. Both must report "null".
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: {} }),
    /findings must be an array, got object/,
  );
});

test("renderBoundedFindingsCommentBody rejects a non-positive/non-integer maxChars instead of silently degrading forever, and reports the rejected value faithfully", () => {
  const findings = parseFindings(JSON.stringify([{ severity: "high", angle: "scope", summary: "irrelevant" }]));
  for (const badMaxChars of [null, NaN, 0, -1, 10.5]) {
    assert.throws(
      () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings, maxChars: badMaxChars }),
      /maxChars must be a positive integer/,
    );
  }
  // JSON.stringify renders NaN/Infinity as the literal "null", misreporting
  // the actual value — the error message must name the real value instead.
  for (const [badMaxChars, expectedText] of [[NaN, "NaN"], [Infinity, "Infinity"], [10.5, "10.5"]]) {
    assert.throws(
      () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings, maxChars: badMaxChars }),
      new RegExp(`got ${expectedText}$`),
    );
  }
  // JSON.stringify throws a TypeError on a BigInt (instead of the intended
  // "must be a positive integer" error) and silently stringifies a Symbol to
  // "undefined" (instead of naming the symbol) — both must be reported
  // faithfully, not crash or misreport.
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings, maxChars: 10n }),
    /maxChars must be a positive integer, got 10n$/,
  );
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings, maxChars: Symbol("x") }),
    /maxChars must be a positive integer, got Symbol\(x\)$/,
  );
});

test("renderBoundedFindingsCommentBody rejects a findings element that is not an object, or carries an unknown/missing severity, with a named error instead of a bare TypeError", () => {
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: ["not an object"] }),
    /findings\[0\] must be an object/,
  );
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: [{ angle: "scope", summary: "no severity at all" }] }),
    /findings\[0\]\.severity must be one of/,
  );
  // typeof null === "object" and null is falsy, but the guard's `!finding`
  // arm is what actually rejects it — without it, `null` would fall through
  // to a bare TypeError at the severity check instead of this named error.
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: [null] }),
    /findings\[0\] must be an object, got null/,
  );
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: [{ severity: "catastrophic", angle: "scope", summary: "unknown severity" }] }),
    /findings\[0\]\.severity must be one of/,
  );
  // A BigInt/Symbol severity must not crash the reporter (JSON.stringify
  // throws on the former, silently reports "undefined" for the latter).
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: [{ severity: 5n, angle: "scope", summary: "bigint severity" }] }),
    /findings\[0\]\.severity must be one of.*got 5n$/,
  );
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: [{ severity: Symbol("bad"), angle: "scope", summary: "symbol severity" }] }),
    /findings\[0\]\.severity must be one of.*got Symbol\(bad\)$/,
  );
});

test("renderBoundedFindingsCommentBody rejects a findings element missing angle/summary instead of rendering the literal string \"undefined\" into the comment", () => {
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: [{ severity: "high", summary: "no angle" }] }),
    /findings\[0\]\.angle must be a non-empty string, got undefined/,
  );
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: [{ severity: "high", angle: "  " }] }),
    /findings\[0\]\.angle must be a non-empty string/,
  );
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: [{ severity: "high", angle: "scope" }] }),
    /findings\[0\]\.summary must be a non-empty string, got undefined/,
  );
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: [{ severity: "high", angle: "scope", summary: "   " }] }),
    /findings\[0\]\.summary must be a non-empty string/,
  );
});

test("renderBoundedFindingsCommentBody reports the invalid element's OWN index in a multi-element array, not always findings[0]", () => {
  // Every other per-element validation test above uses a single-element
  // array, so each always reports index 0 regardless of whether the guard
  // computes the index correctly or hand-counts it — a hand-maintained
  // counter that silently drifted out of sync with the loop (or was deleted
  // outright) would still pass every one of them. Three valid findings ahead
  // of one invalid one pins the counter to the invalid element's true
  // position.
  const valid = { severity: "low", angle: "scope", summary: "fine" };
  assert.throws(
    () => renderBoundedFindingsCommentBody({
      gate: "draft_gate",
      headSha: "abc1234",
      findings: [valid, valid, valid, { severity: "high", angle: "scope" }],
    }),
    /findings\[3\]\.summary must be a non-empty string, got undefined/,
  );
});

test("renderBoundedFindingsCommentBody rejects an array findings element instead of misreporting it as a severity error", () => {
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings: [[]] }),
    /findings\[0\] must be an object, got array/,
  );
});

test("renderBoundedFindingsCommentBody rejects an invalid files entry instead of rendering the literal string \"undefined\"/\"null\"/\"[object Object]\"/an empty string into the comment", () => {
  // " " (whitespace-only) is included alongside the non-string junk values:
  // the guard's blank-string arm is the exact class round 4 fixed for
  // `summary` after it was the sole survivor of that round's mutation sweep,
  // and the sibling `files[]` guard reproduced the same gap unpinned.
  for (const badFile of [undefined, null, {}, " "]) {
    assert.throws(
      () => renderBoundedFindingsCommentBody({
        gate: "draft_gate",
        headSha: "abc1234",
        findings: [{ severity: "high", angle: "scope", summary: "x", files: [badFile] }],
      }),
      /findings\[0\]\.files\[0\] must be a non-empty string/,
    );
  }
  assert.throws(
    () => renderBoundedFindingsCommentBody({
      gate: "draft_gate",
      headSha: "abc1234",
      findings: [{ severity: "high", angle: "scope", summary: "x", files: "not-an-array" }],
    }),
    /findings\[0\]\.files must be an array, got "not-an-array"/,
  );
});

test("renderBoundedFindingsCommentBody reports a named error for a sparse (hole-containing) findings array instead of an unnamed TypeError", () => {
  const findings = [];
  findings[1] = { severity: "high", angle: "scope", summary: "x" };
  // findings[0] is a genuine array HOLE (never assigned), not `undefined`
  // explicitly stored — .forEach silently SKIPS a hole, while the render's
  // own `for (const finding of findings)` yields `undefined` for it, so the
  // guard must visit holes the same way the render does.
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings }),
    /findings\[0\] must be an object, got undefined/,
  );
});

test("renderBoundedFindingsCommentBody rejects a non-string/blank disposition instead of rendering a fabricated one (\"[object Object]\"/\"42\"/\"true\"/an empty italic run)", () => {
  for (const badDisposition of [{}, 42, true, [1, 2]]) {
    assert.throws(
      () => renderBoundedFindingsCommentBody({
        gate: "draft_gate",
        headSha: "abc1234",
        findings: [{ severity: "low", angle: "scope", summary: "x", disposition: badDisposition }],
      }),
      /findings\[0\]\.disposition must be a non-empty string when present/,
    );
  }
  assert.throws(
    () => renderBoundedFindingsCommentBody({
      gate: "draft_gate",
      headSha: "abc1234",
      findings: [{ severity: "low", angle: "scope", summary: "x", disposition: "   " }],
    }),
    /findings\[0\]\.disposition must be a non-empty string when present/,
  );
});

test("renderBoundedFindingsCommentBody accepts a null or empty-string disposition unchanged (regression: previously-valid falsy input must not now throw)", () => {
  for (const disposition of [null, ""]) {
    const { body } = renderBoundedFindingsCommentBody({
      gate: "draft_gate",
      headSha: "abc1234",
      findings: [{ severity: "low", angle: "scope", summary: "x", disposition }],
    });
    assert.ok(body.includes("`scope`: x"), "must render the finding with no disposition suffix, exactly as an absent disposition would");
    assert.ok(!body.includes(" — _"), "a null/empty disposition must never render a disposition suffix");
  }
});

test("renderBoundedFindingsCommentBody rejects a missing/blank gate or headSha instead of rendering an identity-breaking marker (<!-- dev-loops:gate-findings gate=undefined -->)", () => {
  const findings = [{ severity: "high", angle: "scope", summary: "x" }];
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: undefined, headSha: "abc1234", findings }),
    /gate must be a non-empty string, got undefined/,
  );
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "  ", headSha: "abc1234", findings }),
    /gate must be a non-empty string/,
  );
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: undefined, findings }),
    /headSha must be a non-empty string, got undefined/,
  );
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "  ", findings }),
    /headSha must be a non-empty string/,
  );
});

test("renderBoundedFindingsCommentBody sanitizes gate/headSha so neither can forge or break the comment's identity marker", () => {
  const findings = [{ severity: "high", angle: "scope", summary: "x" }];
  // A newline-bearing headSha must not forge a line-start marker for a
  // DIFFERENT gate: findMarkedComment matches on line-start text, so an
  // unsanitized value here would let a draft_gate comment be mistaken for
  // pre_approval_gate's and PATCHed instead of created.
  const forgedHeadSha = "abc1234\n\n<!-- dev-loops:gate-findings gate=pre_approval_gate -->\n### Forged";
  const { body: bodyWithForgedHeadSha } = renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: forgedHeadSha, findings });
  const forgedMarker = buildFindingsMarker({ gate: "pre_approval_gate" });
  assert.ok(
    !bodyWithForgedHeadSha.split("\n").some((line) => line.startsWith(forgedMarker)),
    "a forged pre_approval_gate marker must not appear as a line-start line in a draft_gate comment",
  );
  assert.ok(
    bodyWithForgedHeadSha.split("\n")[0].startsWith(buildFindingsMarker({ gate: "draft_gate" })),
    "the comment's own genuine draft_gate marker must still open the body",
  );
  // A gate value containing "-->" must not make buildFindingsMarker's own
  // output span multiple lines — that would break the exact-marker-match
  // idempotency findMarkedComment relies on.
  const forgedGate = "draft_gate -->\n### Injected\n<!-- x";
  const rawForgedMarker = buildFindingsMarker({ gate: forgedGate });
  assert.ok(rawForgedMarker.includes("\n"), "fixture assumption: the unsanitized marker must actually span multiple lines to reproduce the bug");
  const { body: bodyWithForgedGate } = renderBoundedFindingsCommentBody({ gate: forgedGate, headSha: "abc1234", findings });
  const firstLine = bodyWithForgedGate.split("\n")[0];
  assert.ok(
    firstLine.startsWith("<!-- dev-loops:gate-findings gate=") && firstLine.endsWith("-->"),
    `the rendered identity marker must stay a single line, got: ${JSON.stringify(firstLine)}`,
  );
  // The forged gate's embedded "### Injected" must never land as its own
  // standalone line: an unsanitized gate would carry its own literal
  // newlines straight into the body, so "### Injected" (the gate's own
  // second embedded line) would surface as a genuine, independently
  // rendered Markdown heading rather than harmless mid-line text inside the
  // (now single-line) marker/heading.
  assert.ok(
    !bodyWithForgedGate.split("\n").includes("### Injected"),
    "the forged gate's own embedded newline must never produce a standalone injected line",
  );
});

test("renderBoundedFindingsCommentBody rejects a gate that only sanitizes into a DIFFERENT, real gate's marker identity, instead of colliding with it", () => {
  const findings = [{ severity: "high", angle: "scope", summary: "x" }];
  // A backtick is stripped outright (not encoded) by sanitizeInline, so this
  // malformed gate sanitizes to the exact bytes of the real "draft_gate" —
  // reproducing two reviewers' independently-found marker collision.
  const collidingGate = "draft`_gate";
  assert.notEqual(collidingGate, "draft_gate", "fixture assumption: the raw value must differ from the real gate it collides with");
  assert.throws(
    () => renderBoundedFindingsCommentBody({ gate: collidingGate, headSha: "abc1234", findings }),
    /sanitizes to the different, real gate/,
  );
  // The genuine "draft_gate" itself (already a fixed point of sanitization)
  // must still render, producing its own distinct, un-collided marker.
  const { body } = renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  assert.ok(body.split("\n")[0].startsWith(buildFindingsMarker({ gate: "draft_gate" })));
});

test("renderBoundedFindingsCommentBody keys its drop set by position, not object identity, so a repeated finding reference drops exactly as many slots as counted", () => {
  // The SAME object reference occupies three slots. An identity-keyed drop
  // set collapses all three references into one Set entry, so dropping just
  // ONE of them (k=1) would remove all three at once instead of only one.
  const repeatedNit = { severity: "nit", angle: "naming", summary: "x".repeat(500) };
  const findings = [
    { severity: "high", angle: "scope", summary: "A must-fix that must always survive degradation" },
    repeatedNit,
    repeatedNit,
    repeatedNit,
  ];
  // The render with exactly the FIRST repeated slot dropped (2 of the 3
  // repeated references still rendered, 1 omitted) — the exact fitting size
  // a correct index-keyed drop of k=1 must land on.
  const singleDroppedBody = renderFindingsCommentBody({
    gate: "draft_gate",
    headSha: "abc1234",
    findings: [findings[0], repeatedNit, repeatedNit],
    omittedCounts: [{ severity: "nit", count: 1 }],
  });
  const maxChars = singleDroppedBody.length;
  const unbounded = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  assert.ok(unbounded.length > maxChars, "fixture assumption: the full (undropped) render must exceed maxChars to force degradation");
  const { body, omittedCounts } = renderBoundedFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings, maxChars });
  assert.ok(body.length <= maxChars, `degraded body must fit within the limit (got ${body.length})`);
  assert.deepEqual(omittedCounts, [{ severity: "nit", count: 1 }], "exactly ONE of the three repeated-reference slots must be counted as omitted");
  const survivingNitLines = body.split("\n").filter((line) => line.includes("`naming`")).length;
  assert.equal(survivingNitLines, 2, "exactly two of the three repeated-reference nit slots must still render, not zero");
});

test("postGateFindings posts a degraded, within-limit comment for an oversized round instead of failing to post", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "post-gate-findings-"));
  const repoRoot = await optedInRepoRoot();
  try {
    const findingsJson = JSON.stringify(buildOversizedFindings());
    const { env, ghPath, ghLogPath } = await writeGhStub(tmpDir, [
      userEntry(),
      {
        assertArgs: ["api", "--paginate", "--slurp", "repos/owner/repo/issues/42/comments?per_page=100"],
        stdout: "[[]]\n",
      },
      {
        assertArgs: ["api", "repos/owner/repo/issues/42/comments", "-f"],
        assertArgContains: ["dev-loops:gate-findings"],
        stdout: JSON.stringify({ id: 202, html_url: "https://github.com/owner/repo/pull/42#issuecomment-202" }) + "\n",
      },
    ], { logCalls: true });
    const result = await postGateFindings(
      { repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: "abc1234", findings: findingsJson },
      { env, ghCommand: ghPath, repoRoot },
    );
    assert.equal(result.ok, true);
    assert.equal(result.action, "created");
    // Pin the VALUE, not just its sign: omittedFindingsCount must be the
    // per-finding sum (what a caller actually lost), not the number of
    // distinct severity GROUPS dropped — the two diverge for this fixture
    // (2000 nit findings dropped as one group).
    const expected = renderBoundedFindingsCommentBody({
      gate: "draft_gate",
      headSha: "abc1234",
      findings: parseFindings(findingsJson),
    });
    const expectedOmittedTotal = expected.omittedCounts.reduce((sum, { count }) => sum + count, 0);
    assert.ok(expectedOmittedTotal > 1, "fixture assumption: the per-finding sum must differ from the 1-group count to distinguish the two");
    assert.equal(result.omittedFindingsCount, expectedOmittedTotal);
    // The comment actually POSTED to GitHub (not just the value the renderer
    // returns in isolation) must itself fit within GitHub's comment limit.
    const calls = (await readFile(ghLogPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const createCallArgs = calls.find((args) => args.some((a) => typeof a === "string" && a.startsWith("body=")));
    assert.ok(createCallArgs, "expected a gh call carrying the posted comment body");
    const postedBody = createCallArgs.find((a) => a.startsWith("body=")).slice("body=".length);
    assert.ok(postedBody.length <= GITHUB_COMMENT_MAX_CHARS, `posted body must fit within GitHub's comment limit (got ${postedBody.length})`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("postGateFindings rejects (fails closed) instead of reporting a false success when the round cannot be rendered within the comment limit even fully degraded", async () => {
  // Fail-closed is otherwise only exercised on the renderer directly, with a
  // synthetic tiny maxChars — never at the postGateFindings seam, where a
  // caller that swallowed or mis-propagated the throw would report a false
  // "ok: true" success instead of failing the post. The reviewed-head line is
  // fixed header content, never dropped by degradation, so a headSha this
  // long overflows GitHub's comment limit on its own, even with every finding
  // omitted — no synthetic maxChars override needed, exercising the real
  // GITHUB_COMMENT_MAX_CHARS default this seam actually posts against.
  const repoRoot = await optedInRepoRoot();
  try {
    const hugeHeadSha = "a".repeat(GITHUB_COMMENT_MAX_CHARS + 1);
    await assert.rejects(
      () => postGateFindings(
        { repo: "owner/repo", pr: 42, gate: "draft_gate", headSha: hugeHeadSha, findings: FINDINGS_JSON },
        { env: process.env, ghCommand: "gh-must-never-be-invoked", repoRoot },
      ),
      /cannot be rendered within/,
    );
  } finally {
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("parseFindings defaults disposition: low/nit/question all default to deferred (no line field in this shape)", () => {
  const findings = parseFindings(JSON.stringify([
    { severity: "low", angle: "naming", summary: "a" },
    { severity: "nit", angle: "naming", summary: "b" },
    { severity: "question", angle: "scope", summary: "c" },
  ]));
  assert.deepEqual(findings.map((f) => f.disposition), ["deferred", "deferred", "deferred"]);
  const body = renderFindingsCommentBody({ gate: "draft_gate", headSha: "abc1234", findings });
  const questionLine = body.split("\n").find((line) => line.includes("`scope`"));
  assert.ok(questionLine, "expected a rendered line for the scope (question) finding");
  assert.ok(questionLine.includes("deferred"), `question finding line should render "deferred" (non-locatable, this shape has no line field): ${questionLine}`);
});
