import assert from "node:assert/strict";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveApprovalState, stripNonAssertionMarkdown, verifyReleaseApproval } from "../../scripts/release/verify-release-approval.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "release", "verify-release-approval.mjs");
const runCli = (args, env = {}) => spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

// Reference release-commit timestamp for the pure-decision tests, plus a
// helper for a comment created AFTER it (a genuine post-cut approval) and
// BEFORE it (a stale carry-over).
const RELEASE_REF = "2026-09-04T12:00:00Z";
const AFTER = "2026-09-04T12:05:00Z";
const BEFORE = "2026-09-04T11:00:00Z";

/**
 * Write a fake `gh` into a fresh PATH dir. The stub answers the two gh calls
 * the CLI makes for a stable version (candidate search + comment fetch) with
 * scripted payloads; any unmatched invocation exits 1 so a test cannot pass
 * by accident.
 */
function stubbedGhDir(responses) {
  const dir = mkdtempSync(path.join(tmpdir(), "verify-release-approval-"));
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const stub = `const responses = ${JSON.stringify(responses)};
const args = process.argv.slice(2).join(" ");
for (const [match, payload] of responses) {
  if (new RegExp(match).test(args)) {
    process.stdout.write(typeof payload === "string" ? payload : JSON.stringify(payload));
    process.exit(0);
  }
}
process.stderr.write("stub gh: no scripted response for: " + args);
process.exit(1);
`;
  const ghPath = path.join(binDir, "gh");
  // A node wrapper with a shebang keeps quoting deterministic across shells.
  writeFileSync(ghPath, "#!/usr/bin/env node\n" + stub);
  chmodSync(ghPath, 0o755);
  return { env: { PATH: binDir + ":" + process.env.PATH }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Pure gate decision (resolveApprovalState)
// ---------------------------------------------------------------------------

test("resolveApprovalState: a fresh operator comment stating 'approve release v<version>' satisfies the gate", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "mfittko",
    releaseRef: RELEASE_REF,
    comments: [{ author: "mfittko", body: "approve release v1.0.0", createdAt: AFTER }],
  });
  assert.equal(d.applies, true);
  assert.equal(d.approved, true);
  assert.equal(d.refusal, null);
});

test("resolveApprovalState: whitespace and missing-v forms still match; surrounding prose is allowed", () => {
  for (const body of [
    "approve release 1.0.0",
    "APPROVE RELEASE V1.0.0",
    "I approve release v1.0.0 as the operator-authorized stable cut.",
    "Approved: approve release   v1.0.0.",
  ]) {
    const d = resolveApprovalState({
      version: "1.0.0",
      operator: "op",
      releaseRef: RELEASE_REF,
      comments: [{ author: "op", body, createdAt: AFTER }],
    });
    assert.equal(d.approved, true, `expected approval for body: ${body}`);
  }
});

test("resolveApprovalState: approval for a DIFFERENT version does not satisfy the gate", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "op",
    releaseRef: RELEASE_REF,
    comments: [
      { author: "op", body: "approve release v0.9.0", createdAt: AFTER },
      { author: "op", body: "approve release v1.0.0-rc.7", createdAt: AFTER },
    ],
  });
  assert.equal(d.approved, false);
  assert.match(d.refusal, /no explicit operator release approval record/);
});

test("resolveApprovalState: a comment by anyone other than the operator is refused", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "op",
    releaseRef: RELEASE_REF,
    comments: [{ author: "someone-else", body: "approve release v1.0.0", createdAt: AFTER }],
  });
  assert.equal(d.approved, false);
  assert.match(d.refusal, /no explicit operator release approval record/);
});

test("resolveApprovalState: blanket merge authorizations and generic 'continue' never satisfy the gate (#1901)", () => {
  for (const body of [
    "merge approved on gate clean, only stop at release gate",
    "continue",
    "Approved — go ahead and continue the whole queue.",
    "Approve the release process in general.",
  ]) {
    const d = resolveApprovalState({
      version: "1.0.0",
      operator: "op",
      releaseRef: RELEASE_REF,
      comments: [{ author: "op", body, createdAt: AFTER }],
    });
    assert.equal(d.approved, false, `blanket/generic record must not pass: ${body}`);
    assert.ok(d.refusal && d.refusal.length > 0);
  }
});

test("resolveApprovalState: negated operator text never satisfies the gate (#1901 fail-open fix)", () => {
  for (const body of [
    "do not approve release v1.0.0",
    "does not approve release v1.0.0",
    "don't approve release v1.0.0",
    "won't approve release v1.0.0",
    "never approve release v1.0.0",
    "will not approve release v1.0.0",
    "must not approve release v1.0.0",
    "should not approve release v1.0.0",
    "not approve release v1.0.0",
    "I decline to approve release v1.0.0",
    "I refuse to approve release v1.0.0",
    "I reject approve release v1.0.0",
    "unapprove release v1.0.0",
    "disapprove release v1.0.0",
    "I do not want to approve release v1.0.0",
    "I never said approve release v1.0.0",
    "I cannot in good conscience approve release v1.0.0",
    "no need to approve release v1.0.0",
    "no need approve release v1.0.0",
    "not required to approve release v1.0.0",
    "approve release v1.0.0 without approval",
    "approve release v1.0.0; do not proceed",
    "approve release v1.0.0, do not publish",
  ]) {
    const d = resolveApprovalState({
      version: "1.0.0",
      operator: "op",
      releaseRef: RELEASE_REF,
      comments: [{ author: "op", body, createdAt: AFTER }],
    });
    assert.equal(d.approved, false, `negated form must not pass: ${body}`);
    assert.ok(d.refusal && d.refusal.length > 0);
  }
});

test("resolveApprovalState: a negation in a different sentence does not refuse a clear approval (clause-scoped)", () => {
  for (const body of [
    "This is not a prerelease; approve release v1.0.0",
    "I will not be available tomorrow. Approve release v1.0.0",
    "approve release v1.0.0. I will not be available tomorrow",
  ]) {
    const d = resolveApprovalState({
      version: "1.0.0",
      operator: "op",
      releaseRef: RELEASE_REF,
      comments: [{ author: "op", body, createdAt: AFTER }],
    });
    assert.equal(d.approved, true, `distant negation must not refuse: ${body}`);
  }
});

test("resolveApprovalState: a trailing benign 'no further changes needed' still approves (no false refusal)", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "op",
    releaseRef: RELEASE_REF,
    comments: [{ author: "op", body: "approve release v1.0.0, no further changes needed", createdAt: AFTER }],
  });
  assert.equal(d.approved, true);
});

test("resolveApprovalState: a mixed comment that negates and later approves is refused (fail closed)", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "op",
    releaseRef: RELEASE_REF,
    comments: [{ author: "op", body: "do not approve release v1.0.0 yet; approve release v1.0.0 once green", createdAt: AFTER }],
  });
  assert.equal(d.approved, false);
});

test("resolveApprovalState: version boundary — v1.0.0.1 text does not approve v1.0.0", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "op",
    releaseRef: RELEASE_REF,
    comments: [{ author: "op", body: "approve release v1.0.0.1", createdAt: AFTER }],
  });
  assert.equal(d.approved, false);
});

test("resolveApprovalState: prerelease versions do not apply the gate (prerelease flow unchanged)", () => {
  for (const version of ["1.0.0-rc.7", "1.0.0-next.1", "1.0.0-beta.2"]) {
    const d = resolveApprovalState({ version, operator: "op", releaseRef: RELEASE_REF, comments: [] });
    assert.equal(d.applies, false);
    assert.equal(d.approved, false);
    assert.equal(d.refusal, null);
  }
});

test("resolveApprovalState: empty/garbage input throws (fail closed)", () => {
  assert.throws(() => resolveApprovalState({ version: "", operator: "op", releaseRef: RELEASE_REF, comments: [] }));
  assert.throws(() => resolveApprovalState({ version: "1.0.0", operator: "", releaseRef: RELEASE_REF, comments: [] }));
  assert.throws(() => resolveApprovalState({ version: "foo", operator: "op", releaseRef: RELEASE_REF, comments: [] }), /not a valid SemVer/);
});

// ---------------------------------------------------------------------------
// #1941: quoted / instructional / stale occurrences must all be refused
// ---------------------------------------------------------------------------

test("resolveApprovalState: the phrase quoted in a code span / fence / block quote does NOT count (#1941)", () => {
  // Real false-positive fixtures: agent-authored handoff/summary comments that
  // quote the phrase in backticks on #1842 were matched by the old matcher.
  for (const body of [
    "Post `approve release v1.0.0` as a comment on the tracking issue.",
    "This requires an operator comment stating `approve release v1.0.0` before the tag push.",
    "Next: the operator-owned `approve release v1.0.0` + tag push completes the cut.",
    "```\napprove release v1.0.0\n```",
    "```sh\ngh issue comment --body 'approve release v1.0.0'\n```",
    "> approve release v1.0.0",
    "See the runbook step ``approve release v1.0.0`` (double-backtick span).",
  ]) {
    const d = resolveApprovalState({
      version: "1.0.0",
      operator: "op",
      releaseRef: RELEASE_REF,
      comments: [{ author: "op", body, createdAt: AFTER }],
    });
    assert.equal(d.approved, false, `quoted/instructional occurrence must not approve: ${body}`);
    assert.ok(d.refusal && d.refusal.length > 0);
  }
});

test("resolveApprovalState: an un-quoted instructional/handoff occurrence does NOT count (#1941)", () => {
  for (const body of [
    "Post approve release v1.0.0 as a comment when gates are clean.",
    "The workflow requires approve release v1.0.0 from the operator.",
    "The runbook instructs approve release v1.0.0 as the final step.",
  ]) {
    const d = resolveApprovalState({
      version: "1.0.0",
      operator: "op",
      releaseRef: RELEASE_REF,
      comments: [{ author: "op", body, createdAt: AFTER }],
    });
    assert.equal(d.approved, false, `instructional occurrence must not approve: ${body}`);
  }
});

test("resolveApprovalState: a code span whose content contains backticks does NOT count (#1941 review, Copilot fail-open)", () => {
  // CommonMark longer-delimiter spans, and spans with an inner backtick pair,
  // must not let the phrase survive backtick blanking as bare prose.
  for (const body of [
    "`` `approve release v1.0.0` ``",
    "`` `x` approve release v1.0.0 ``",
    "``code ` here`` approve release v1.0.0 ``x``",
    "`` approve release v1.0.0 ``",
    "```` `approve release v1.0.0` ````",
  ]) {
    const d = resolveApprovalState({
      version: "1.0.0",
      operator: "op",
      releaseRef: RELEASE_REF,
      comments: [{ author: "op", body, createdAt: AFTER }],
    });
    assert.equal(d.approved, false, `backtick-content code span must not approve: ${JSON.stringify(body)}`);
  }
});

test("stripNonAssertionMarkdown: a backtick-content span is fully stripped, a trailing genuine phrase survives (#1941 review)", () => {
  assert.doesNotMatch(stripNonAssertionMarkdown("`` `approve release v1.0.0` ``"), /approve release/i);
  assert.doesNotMatch(stripNonAssertionMarkdown("`` `x` approve release v1.0.0 ``"), /approve release/i);
  // A genuine assertion with an unrelated trailing inline code span still survives.
  assert.match(stripNonAssertionMarkdown("approve release v1.0.0 `see notes`"), /approve release/i);
});

test("resolveApprovalState: a match with an unverifiable timestamp gets a distinct 'cannot be verified' refusal, not the stale one (#1941 review)", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "op",
    releaseRef: RELEASE_REF,
    comments: [{ author: "op", body: "approve release v1.0.0", createdAt: "not-a-date" }],
  });
  assert.equal(d.approved, false);
  assert.match(d.refusal, /freshness cannot be verified|no parseable created_at/i);
  assert.doesNotMatch(d.refusal, /predate|stale/i);
});

test("resolveApprovalState: a genuine approval that predates the release commit is refused as stale (#1941)", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "op",
    releaseRef: RELEASE_REF,
    comments: [{ author: "op", body: "approve release v1.0.0", createdAt: BEFORE }],
  });
  assert.equal(d.approved, false);
  assert.match(d.refusal, /stale|predate/i);
});

test("resolveApprovalState: a genuine approval with a missing/unparseable timestamp cannot verify as fresh (#1941)", () => {
  for (const createdAt of [undefined, null, "", "not-a-date"]) {
    const d = resolveApprovalState({
      version: "1.0.0",
      operator: "op",
      releaseRef: RELEASE_REF,
      comments: [{ author: "op", body: "approve release v1.0.0", createdAt }],
    });
    assert.equal(d.approved, false, `unverifiable timestamp must not approve: ${String(createdAt)}`);
  }
});

test("resolveApprovalState: a stable release with an unparseable releaseRef fails closed (throws)", () => {
  assert.throws(
    () => resolveApprovalState({ version: "1.0.0", operator: "op", releaseRef: "nope", comments: [] }),
    /releaseRef must be a parseable/,
  );
  assert.throws(
    () => resolveApprovalState({ version: "1.0.0", operator: "op", comments: [] }),
    /releaseRef must be a parseable/,
  );
});

test("resolveApprovalState: a fresh genuine approval among stale/quoted noise still approves (#1941)", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "op",
    releaseRef: RELEASE_REF,
    comments: [
      { author: "op", body: "Post `approve release v1.0.0` when ready.", createdAt: AFTER },
      { author: "op", body: "approve release v1.0.0", createdAt: BEFORE }, // stale carry-over
      { author: "op", body: "Re-cut looks good — approve release v1.0.0", createdAt: AFTER }, // the real one
    ],
  });
  assert.equal(d.approved, true);
});

test("stripNonAssertionMarkdown: removes inline spans, fences, and block quotes", () => {
  assert.doesNotMatch(stripNonAssertionMarkdown("Post `approve release v1.0.0`."), /approve release/i);
  assert.doesNotMatch(stripNonAssertionMarkdown("```\napprove release v1.0.0\n```"), /approve release/i);
  assert.doesNotMatch(stripNonAssertionMarkdown("> approve release v1.0.0"), /approve release/i);
  // Prose outside a span is preserved.
  assert.match(stripNonAssertionMarkdown("approve release v1.0.0 `noise`"), /approve release/i);
});

test("stripNonAssertionMarkdown: tilde fences, unterminated fences, and indented code blocks are all stripped (#1941 review)", () => {
  // `~~~` (tilde) fenced block — the `~{3,}` alternation.
  assert.doesNotMatch(stripNonAssertionMarkdown("~~~\napprove release v1.0.0\n~~~"), /approve release/i);
  // Unterminated fence to EOF (opening fence, no close).
  assert.doesNotMatch(stripNonAssertionMarkdown("```\napprove release v1.0.0"), /approve release/i);
  // Indented code block: 4-space and tab lead both render as code on GitHub.
  assert.doesNotMatch(stripNonAssertionMarkdown("    approve release v1.0.0"), /approve release/i);
  assert.doesNotMatch(stripNonAssertionMarkdown("\tapprove release v1.0.0"), /approve release/i);
});

test("resolveApprovalState: an indented-code-block quote does NOT count (#1941 review — 4th code form)", () => {
  for (const body of ["    approve release v1.0.0", "\tapprove release v1.0.0", "~~~\napprove release v1.0.0\n~~~"]) {
    const d = resolveApprovalState({
      version: "1.0.0",
      operator: "op",
      releaseRef: RELEASE_REF,
      comments: [{ author: "op", body, createdAt: AFTER }],
    });
    assert.equal(d.approved, false, `indented/tilde code quote must not approve: ${JSON.stringify(body)}`);
  }
});

test("resolveApprovalState: a comment created at the EXACT release-commit instant is refused (strict post-date boundary, #1941 review)", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "op",
    releaseRef: RELEASE_REF,
    comments: [{ author: "op", body: "approve release v1.0.0", createdAt: RELEASE_REF }], // created == release commit instant
  });
  assert.equal(d.approved, false);
  assert.match(d.refusal, /stale|predate/i);
});

// ---------------------------------------------------------------------------
// verifyReleaseApproval (gh-facing shell, injected runChild + injected git)
// ---------------------------------------------------------------------------

test("verifyReleaseApproval: stable + no approval record -> named refusal", () => {
  const result = verifyReleaseApproval({
    version: "1.0.0",
    repo: "mfittko/dev-loops",
    operator: "mfittko",
    releaseCommitDate: RELEASE_REF,
    runChild: () => JSON.stringify({ items: [] }), // search returns no candidates
  });
  assert.equal(result.ok, false);
  assert.equal(result.applies, true);
  assert.match(result.refusal, /no explicit operator release approval record/);
  assert.match(result.refusal, /Blanket merge authorizations and generic continue instructions do NOT satisfy/);
});

test("verifyReleaseApproval: a search hit whose comments contain no matching operator comment still refuses", () => {
  // The search (commenter + phrase) can return an issue where the operator
  // commented on something else and another user wrote the phrase — the
  // comment-level verification must catch that instead of trusting the search.
  let call = 0;
  const result = verifyReleaseApproval({
    version: "1.0.0",
    repo: "o/n",
    operator: "op",
    releaseCommitDate: RELEASE_REF,
    runChild: () => (call++ === 0 ? JSON.stringify({ items: [{ number: 42 }] }) : JSON.stringify([
      { user: { login: "other" }, body: "approve release v1.0.0", created_at: AFTER },
    ])),
  });
  assert.equal(result.ok, false);
  assert.match(result.refusal, /no explicit operator release approval record/);
});

test("verifyReleaseApproval: multi-page --slurp comment payload is parsed correctly", () => {
  let call = 0;
  const result = verifyReleaseApproval({
    version: "1.0.0",
    repo: "o/n",
    operator: "op",
    releaseCommitDate: RELEASE_REF,
    runChild: () => {
      if (call++ === 0) return JSON.stringify({ items: [{ number: 42 }] });
      return JSON.stringify([
        [{ user: { login: "other" }, body: "noise", created_at: AFTER }],
        [{ user: { login: "op" }, body: "approve release v1.0.0", created_at: AFTER }],
      ]);
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /verified/);
});

test("verifyReleaseApproval: a quoted/agent-authored occurrence in comments does NOT pass (#1941)", () => {
  let call = 0;
  const result = verifyReleaseApproval({
    version: "1.0.0",
    repo: "o/n",
    operator: "op",
    releaseCommitDate: RELEASE_REF,
    runChild: () => {
      if (call++ === 0) return JSON.stringify({ items: [{ number: 42 }] });
      return JSON.stringify([
        { user: { login: "op" }, body: "Post `approve release v1.0.0` as a comment.", created_at: AFTER },
      ]);
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.refusal, /no explicit operator release approval record/);
});

test("verifyReleaseApproval: a stale (pre-release-commit) approval in comments does NOT pass (#1941)", () => {
  let call = 0;
  const result = verifyReleaseApproval({
    version: "1.0.0",
    repo: "o/n",
    operator: "op",
    releaseCommitDate: RELEASE_REF,
    runChild: () => {
      if (call++ === 0) return JSON.stringify({ items: [{ number: 42 }] });
      return JSON.stringify([
        { user: { login: "op" }, body: "approve release v1.0.0", created_at: BEFORE },
      ]);
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.refusal, /stale|predate/i);
});

test("verifyReleaseApproval: a fresh genuine operator approval passes (#1941)", () => {
  let call = 0;
  const result = verifyReleaseApproval({
    version: "1.0.0",
    repo: "o/n",
    operator: "op",
    releaseCommitDate: RELEASE_REF,
    runChild: () => {
      if (call++ === 0) return JSON.stringify({ items: [{ number: 42 }] });
      return JSON.stringify([
        { user: { login: "op" }, body: "Re-cut verified — approve release v1.0.0", created_at: AFTER },
      ]);
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /verified/);
});

test("verifyReleaseApproval: an unresolvable release commit date fails closed (throws)", () => {
  assert.throws(() => verifyReleaseApproval({
    version: "1.0.0",
    repo: "o/n",
    operator: "op",
    runChild: () => JSON.stringify({ items: [] }),
    runGit: () => "not-a-date\n",
  }), /release commit date/);
});

test("verifyReleaseApproval: an invalid --operator login fails closed before any gh call", () => {
  assert.throws(() => verifyReleaseApproval({
    version: "1.0.0",
    repo: "o/n",
    operator: "op inject:qualifier",
    releaseCommitDate: RELEASE_REF,
    runChild: () => { throw new Error("gh must not be called"); },
  }), /not a valid GitHub login shape/);
});

test("verifyReleaseApproval: a padded version is trimmed before matching (entrypoint normalization)", () => {
  const result = verifyReleaseApproval({
    version: " 1.0.0 ",
    repo: "o/n",
    operator: "op",
    releaseCommitDate: RELEASE_REF,
    runChild: () => JSON.stringify({ items: [] }),
  });
  assert.equal(result.ok, false);
  assert.match(result.refusal, /approve release v1\.0\.0/);
});

test("verifyReleaseApproval: default operator resolves from the --repo slug owner, not gh api repo", () => {
  // A local pre-flight run from outside a checkout (or against a different repo
  // than CWD) must still resolve the operator from --repo's owner, never from
  // the CWD's git remote (gh api repo), which would fail closed despite a
  // valid approval record existing for the named repo.
  const result = verifyReleaseApproval({
    version: "1.0.0",
    repo: "acme/widgets",
    releaseCommitDate: RELEASE_REF,
    // operator omitted — the owner must come from the --repo slug
    runChild: (cmd, args) => {
      if (cmd === "gh" && Array.isArray(args) && args[0] === "api" && args[1] === "repo") {
        throw new Error("gh api repo must not be called for default operator resolution");
      }
      return JSON.stringify({ items: [] });
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.refusal, /@acme/);
});

test("verifyReleaseApproval: prerelease passes through with no gh call at all", () => {
  const result = verifyReleaseApproval({
    version: "1.0.0-rc.7",
    repo: "o/n",
    runChild: () => { throw new Error("gh must not be called for a prerelease"); },
    runGit: () => { throw new Error("git must not be called for a prerelease"); },
  });
  assert.equal(result.ok, true);
  assert.equal(result.applies, false);
  assert.match(result.message, /does not apply/);
});

test("verifyReleaseApproval: a gh failure surfaces as a thrown error (the CLI maps it to fail-closed exit 1)", () => {
  assert.throws(() => verifyReleaseApproval({
    version: "1.0.0",
    repo: "o/n",
    operator: "op",
    releaseCommitDate: RELEASE_REF,
    runChild: () => { throw new Error("HTTP 502"); },
  }), /HTTP 502/);
});

// ---------------------------------------------------------------------------
// CLI (spawnSync) — usage contract + real gh-stub end-to-end
// ---------------------------------------------------------------------------

test("CLI: prerelease version passes with no gh invocation at all", () => {
  // PATH keeps node's own dir (spawnSync needs node) but nothing else, so any
  // gh call would fail ENOENT — proving the prerelease pass-through never
  // shells out to gh.
  const r = runCli(["--version", "1.0.0-rc.1", "--repo", "o/n"], { PATH: path.dirname((Bun.which("node") ?? "node")) });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /does not apply/);
});

test("CLI: stable version with no approval record is refused (exit 1, named refusal)", () => {
  const stub = stubbedGhDir([
    ["search/issues", { items: [] }],
  ]);
  try {
    const r = runCli(["--version", "1.0.0", "--repo", "o/n", "--operator", "op", "--release-commit-date", RELEASE_REF], stub.env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no explicit operator release approval record found/);
    assert.match(r.stderr, /approve release v1\.0\.0/);
  } finally {
    stub.cleanup();
  }
});

test("CLI: stable version with a fresh matching operator comment passes (exit 0)", () => {
  const stub = stubbedGhDir([
    ["search/issues", { items: [{ number: 42 }] }],
    ["issues/42/comments", [
      { user: { login: "other" }, body: "some noise", created_at: AFTER },
      { user: { login: "op" }, body: "looks good — approve release v1.0.0", created_at: AFTER },
    ]],
  ]);
  try {
    const r = runCli(["--version", "1.0.0", "--repo", "o/n", "--operator", "op", "--release-commit-date", RELEASE_REF], stub.env);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /verified/);
  } finally {
    stub.cleanup();
  }
});

test("CLI: a stale approval comment is refused end-to-end (exit 1, #1941)", () => {
  const stub = stubbedGhDir([
    ["search/issues", { items: [{ number: 42 }] }],
    ["issues/42/comments", [
      { user: { login: "op" }, body: "approve release v1.0.0", created_at: BEFORE },
    ]],
  ]);
  try {
    const r = runCli(["--version", "1.0.0", "--repo", "o/n", "--operator", "op", "--release-commit-date", RELEASE_REF], stub.env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /stale|predate/i);
  } finally {
    stub.cleanup();
  }
});

test("CLI: a quoted approval occurrence is refused end-to-end (exit 1, #1941)", () => {
  const stub = stubbedGhDir([
    ["search/issues", { items: [{ number: 42 }] }],
    ["issues/42/comments", [
      { user: { login: "op" }, body: "Post `approve release v1.0.0` when ready.", created_at: AFTER },
    ]],
  ]);
  try {
    const r = runCli(["--version", "1.0.0", "--repo", "o/n", "--operator", "op", "--release-commit-date", RELEASE_REF], stub.env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no explicit operator release approval record found/);
  } finally {
    stub.cleanup();
  }
});

test("CLI: gh failure fails closed (exit 1), never open", () => {
  const stub = stubbedGhDir([]); // stub matches nothing -> every gh call exits 1
  try {
    const r = runCli(["--version", "1.0.0", "--repo", "o/n", "--operator", "op", "--release-commit-date", RELEASE_REF], stub.env);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /failed closed/);
  } finally {
    stub.cleanup();
  }
});

test("CLI: candidate search requests per_page=100 (GitHub default 30 would silently truncate)", () => {
  // The stub only answers the search call when the args carry per_page=100;
  // if it regresses the stub exits 1 and the CLI reports gh failure, so this
  // test fails closed on the arg itself.
  const stub = stubbedGhDir([
    ["search/issues .*per_page=100", { items: [] }],
  ]);
  try {
    const r = runCli(["--version", "1.0.0", "--repo", "o/n", "--operator", "op", "--release-commit-date", RELEASE_REF], stub.env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no explicit operator release approval record found/);
    assert.doesNotMatch(r.stdout, /failed closed/);
  } finally {
    stub.cleanup();
  }
});

test("CLI: usage errors exit 2 (no args, missing --repo, missing --version, garbage version, unknown arg)", () => {
  assert.equal(runCli([]).status, 2);
  assert.equal(runCli(["--version", "1.0.0"]).status, 2);
  assert.equal(runCli(["--repo", "o/n"]).status, 2);
  assert.equal(runCli(["--version", "not-semver", "--repo", "o/n"]).status, 2);
  assert.equal(runCli(["--version", "1.0.0", "--repo", "o/n", "--wat"]).status, 2);
});

test("CLI: garbage repo shape exits 2", () => {
  assert.equal(runCli(["--version", "1.0.0", "--repo", "not-a-slug"]).status, 2);
});

test("CLI: --jq and --silent/-s are honored (jq-output CLI contract)", () => {
  const jq = runCli(["--version", "1.0.0-rc.1", "--repo", "o/n", "--jq", ".ok"]);
  assert.equal(jq.status, 0, jq.stderr);
  assert.equal(jq.stdout.trim(), "true");

  const silent = runCli(["--version", "1.0.0-rc.1", "--repo", "o/n", "--silent"]);
  assert.equal(silent.status, 0, silent.stderr);
  assert.equal(silent.stdout.trim(), "");

  const short = runCli(["--version", "1.0.0-rc.1", "--repo", "o/n", "-s"]);
  assert.equal(short.status, 0, short.stderr);
});
