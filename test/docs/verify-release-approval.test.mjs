import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveApprovalState, verifyReleaseApproval } from "../../scripts/release/verify-release-approval.mjs";

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "release", "verify-release-approval.mjs");
const runCli = (args, env = {}) => spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

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

test("resolveApprovalState: an operator comment stating 'approve release v<version>' satisfies the gate", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "mfittko",
    comments: [{ author: "mfittko", body: "approve release v1.0.0" }],
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
      comments: [{ author: "op", body }],
    });
    assert.equal(d.approved, true, `expected approval for body: ${body}`);
  }
});

test("resolveApprovalState: approval for a DIFFERENT version does not satisfy the gate", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "op",
    comments: [
      { author: "op", body: "approve release v0.9.0" },
      { author: "op", body: "approve release v1.0.0-rc.7" },
    ],
  });
  assert.equal(d.approved, false);
  assert.match(d.refusal, /no explicit operator release approval record/);
});

test("resolveApprovalState: a comment by anyone other than the operator is refused", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "op",
    comments: [{ author: "someone-else", body: "approve release v1.0.0" }],
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
      comments: [{ author: "op", body }],
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
    "unapprove release v1.0.0",
    "disapprove release v1.0.0",
  ]) {
    const d = resolveApprovalState({
      version: "1.0.0",
      operator: "op",
      comments: [{ author: "op", body }],
    });
    assert.equal(d.approved, false, `negated form must not pass: ${body}`);
    assert.ok(d.refusal && d.refusal.length > 0);
  }
});

test("resolveApprovalState: a mixed comment that negates and later approves is refused (fail closed)", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "op",
    comments: [{ author: "op", body: "do not approve release v1.0.0 yet; approve release v1.0.0 once green" }],
  });
  assert.equal(d.approved, false);
});

test("resolveApprovalState: version boundary — v1.0.0.1 text does not approve v1.0.0", () => {
  const d = resolveApprovalState({
    version: "1.0.0",
    operator: "op",
    comments: [{ author: "op", body: "approve release v1.0.0.1" }],
  });
  assert.equal(d.approved, false);
});

test("resolveApprovalState: prerelease versions do not apply the gate (prerelease flow unchanged)", () => {
  for (const version of ["1.0.0-rc.7", "1.0.0-next.1", "1.0.0-beta.2"]) {
    const d = resolveApprovalState({ version, operator: "op", comments: [] });
    assert.equal(d.applies, false);
    assert.equal(d.approved, false);
    assert.equal(d.refusal, null);
  }
});

test("resolveApprovalState: empty/garbage input throws (fail closed)", () => {
  assert.throws(() => resolveApprovalState({ version: "", operator: "op", comments: [] }));
  assert.throws(() => resolveApprovalState({ version: "1.0.0", operator: "", comments: [] }));
  assert.throws(() => resolveApprovalState({ version: "foo", operator: "op", comments: [] }), /not a valid SemVer/);
});

// ---------------------------------------------------------------------------
// verifyReleaseApproval (gh-facing shell, injected runChild)
// ---------------------------------------------------------------------------

test("verifyReleaseApproval: stable + no approval record -> named refusal", () => {
  const result = verifyReleaseApproval({
    version: "1.0.0",
    repo: "mfittko/dev-loops",
    operator: "mfittko",
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
    runChild: () => (call++ === 0 ? "42\n" : JSON.stringify([
      { user: { login: "other" }, body: "approve release v1.0.0" },
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
    runChild: () => {
      if (call++ === 0) return JSON.stringify({ items: [{ number: 42 }] });
      return JSON.stringify([
        [{ user: { login: "other" }, body: "noise" }],
        [{ user: { login: "op" }, body: "approve release v1.0.0" }],
      ]);
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /verified/);
});

test("verifyReleaseApproval: an invalid --operator login fails closed before any gh call", () => {
  assert.throws(() => verifyReleaseApproval({
    version: "1.0.0",
    repo: "o/n",
    operator: "op inject:qualifier",
    runChild: () => { throw new Error("gh must not be called"); },
  }), /not a valid GitHub login shape/);
});

test("verifyReleaseApproval: a padded version is trimmed before matching (entrypoint normalization)", () => {
  const result = verifyReleaseApproval({
    version: " 1.0.0 ",
    repo: "o/n",
    operator: "op",
    runChild: () => JSON.stringify({ items: [] }),
  });
  assert.equal(result.ok, false);
  assert.match(result.refusal, /approve release v1\.0\.0/);
});

test("verifyReleaseApproval: prerelease passes through with no gh call at all", () => {
  const result = verifyReleaseApproval({
    version: "1.0.0-rc.7",
    repo: "o/n",
    runChild: () => { throw new Error("gh must not be called for a prerelease"); },
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
  const nodeDir = mkdtempSync(path.join(tmpdir(), "vra-no-gh-path-"));
  const r = runCli(["--version", "1.0.0-rc.1", "--repo", "o/n"], { PATH: path.dirname(process.execPath) });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /does not apply/);
  rmSync(nodeDir, { recursive: true, force: true });
});

test("CLI: stable version with no approval record is refused (exit 1, named refusal)", () => {
  const stub = stubbedGhDir([
    ["search/issues", { items: [] }],
  ]);
  try {
    const r = runCli(["--version", "1.0.0", "--repo", "o/n", "--operator", "op"], stub.env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no explicit operator release approval record found/);
    assert.match(r.stderr, /approve release v1\.0\.0/);
  } finally {
    stub.cleanup();
  }
});

test("CLI: stable version with a matching operator comment passes (exit 0)", () => {
  const stub = stubbedGhDir([
    ["search/issues", { items: [{ number: 42 }] }],
    ["issues/42/comments", [
      { user: { login: "other" }, body: "some noise" },
      { user: { login: "op" }, body: "looks good — approve release v1.0.0" },
    ]],
  ]);
  try {
    const r = runCli(["--version", "1.0.0", "--repo", "o/n", "--operator", "op"], stub.env);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /verified/);
  } finally {
    stub.cleanup();
  }
});

test("CLI: gh failure fails closed (exit 1), never open", () => {
  const stub = stubbedGhDir([]); // stub matches nothing -> every gh call exits 1
  try {
    const r = runCli(["--version", "1.0.0", "--repo", "o/n", "--operator", "op"], stub.env);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /failed closed/);
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
