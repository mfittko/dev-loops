import assert from "node:assert/strict";
import test from "node:test";

import {
  parseCodeowners,
  codeownersMatch,
  ownersForPaths,
  loginFromCommitEmail,
  resolveHandoffCandidates,
} from "../../scripts/github/resolve-handoff-candidates.mjs";

// A fake injected run() that dispatches on command + args.
function fakeRun(handlers) {
  return async (cmd, args) => {
    const handler = handlers(cmd, args);
    return handler ?? { code: 0, stdout: "", stderr: "" };
  };
}

// ---------------------------------------------------------------------------
// CODEOWNERS parse + match (last-match-wins)
// ---------------------------------------------------------------------------

test("parseCodeowners: skips comments/blank lines, keeps owners", () => {
  const rules = parseCodeowners(`
# comment
*           @org/all
/docs/      @alice @bob

src/*.mjs   @carol  # trailing comment
`);
  assert.deepEqual(rules, [
    { pattern: "*", owners: ["@org/all"] },
    { pattern: "/docs/", owners: ["@alice", "@bob"] },
    { pattern: "src/*.mjs", owners: ["@carol"] },
  ]);
});

test("parseCodeowners: `#` is a comment only at line start or after whitespace, not mid-token", () => {
  const rules = parseCodeowners(`
# full-line comment
docs/c#sharp/   @alice  # trailing comment
src/* @org/team#sub
`);
  assert.deepEqual(rules, [
    // mid-token `#` in the pattern is preserved; trailing ` # ...` is stripped
    { pattern: "docs/c#sharp/", owners: ["@alice"] },
    // mid-token `#` in an owner handle is preserved (no whitespace before it)
    { pattern: "src/*", owners: ["@org/team#sub"] },
  ]);
});

test("codeownersMatch: anchored, directory, glob, bare-name", () => {
  assert.equal(codeownersMatch("*", "anything/here.txt"), true);
  assert.equal(codeownersMatch("/docs/", "docs/readme.md"), true);
  assert.equal(codeownersMatch("/docs/", "src/docs.md"), false);
  assert.equal(codeownersMatch("src/*.mjs", "src/app.mjs"), true);
  assert.equal(codeownersMatch("src/*.mjs", "src/sub/app.mjs"), false);
  assert.equal(codeownersMatch("build/", "build/out/x.js"), true);
  assert.equal(codeownersMatch("docs", "a/docs/x.md"), true);
});

test("codeownersMatch: dir/ pattern matches at any depth (gitignore semantics)", () => {
  // `build/` has no leading/internal slash -> matches at any depth.
  assert.equal(codeownersMatch("build/", "a/build/file.js"), true);
  assert.equal(codeownersMatch("build/", "build/x"), true);
  // `/src/` keeps its anchor: matches at root only, no prefix leak.
  assert.equal(codeownersMatch("/src/", "src/a.mjs"), true);
  assert.equal(codeownersMatch("/src/", "lib/src/a.mjs"), false);
  // No prefix leak for bare names.
  assert.equal(codeownersMatch("docs/", "docsX/y"), false);
  // `*.mjs` matches at any depth.
  assert.equal(codeownersMatch("*.mjs", "src/sub/app.mjs"), true);
});

test("ownersForPaths: nested dir/ pattern resolves owner at any depth", () => {
  const rules = parseCodeowners(`
build/   @build-team
`);
  const byOwner = ownersForPaths(rules, ["src/build/x.js"]);
  assert.deepEqual([...byOwner.get("build-team")], ["src/build/x.js"]);
});

test("ownersForPaths: last matching rule wins per path", () => {
  const rules = parseCodeowners(`
*         @default
/src/     @src-team
/src/api/ @api-team
`);
  const byOwner = ownersForPaths(rules, ["src/api/handler.mjs", "README.md"]);
  // src/api/handler.mjs -> last match is @api-team (not @src-team / @default)
  assert.deepEqual([...byOwner.get("api-team")], ["src/api/handler.mjs"]);
  assert.equal(byOwner.has("src-team"), false);
  // README.md -> only `*` matches -> @default
  assert.deepEqual([...byOwner.get("default")], ["README.md"]);
});

// ---------------------------------------------------------------------------
// recent-committers email -> login mapping
// ---------------------------------------------------------------------------

test("loginFromCommitEmail: noreply carries login; else local-part", () => {
  assert.equal(loginFromCommitEmail("1234+alice@users.noreply.github.com"), "alice");
  assert.equal(loginFromCommitEmail("bob@users.noreply.github.com"), "bob");
  assert.equal(loginFromCommitEmail("Carol@example.com"), "carol");
  assert.equal(loginFromCommitEmail("no-at-sign"), null);
});

// ---------------------------------------------------------------------------
// resolveHandoffCandidates orchestration
// ---------------------------------------------------------------------------

const enabled = (sources, assignees = []) => ({
  approval: { enabled: true, candidatesFrom: sources, assignees },
});

test("disabled config => no-op offer (no candidates, no sourcing)", async () => {
  let ran = false;
  const out = await resolveHandoffCandidates(
    { repo: "o/n", pr: 1, changedFiles: ["src/a.mjs"], prAuthor: "me" },
    { config: { approval: { enabled: false, candidatesFrom: ["codeowners"], assignees: ["alice"] } },
      run: fakeRun(() => { ran = true; return null; }), readFile: async () => { throw new Error("nope"); } },
  );
  assert.equal(out.enabled, false);
  assert.deepEqual(out.candidates, []);
  assert.equal(ran, false);
});

test("configured assignees are highest priority and deduped across sources", async () => {
  const out = await resolveHandoffCandidates(
    { repo: "o/n", pr: 1, changedFiles: ["src/a.mjs"], prAuthor: "me" },
    {
      config: enabled(["codeowners", "recent-committers"], ["alice", "bob"]),
      readFile: async () => "src/* @alice\n",
      run: fakeRun((cmd) => cmd === "git" ? { code: 0, stdout: "bob@users.noreply.github.com\ncarol@example.com\n", stderr: "" } : null),
    },
  );
  const logins = out.candidates.map((c) => c.login);
  // alice, bob from assignees first; codeowners alice deduped; carol from committers
  assert.deepEqual(logins, ["alice", "bob", "carol"]);
  assert.equal(out.candidates[0].source, "assignees");
  assert.equal(out.candidates.find((c) => c.login === "carol").source, "recent-committers");
});

test("canonical priority: codeowners ranks above recent-committers regardless of candidatesFrom order", async () => {
  const out = await resolveHandoffCandidates(
    { repo: "o/n", pr: 1, changedFiles: ["src/a.mjs"], prAuthor: "me" },
    {
      // candidatesFrom lists recent-committers FIRST, but canonical order wins.
      config: enabled(["recent-committers", "codeowners"]),
      readFile: async () => "src/* @owner\n",
      run: fakeRun((cmd) => cmd === "git" ? { code: 0, stdout: "committer@users.noreply.github.com\n", stderr: "" } : null),
    },
  );
  assert.deepEqual(out.candidates.map((c) => c.login), ["owner", "committer"]);
  assert.equal(out.candidates[0].source, "codeowners");
  assert.equal(out.candidates[1].source, "recent-committers");
});

test("recent-committers excludes PR author and bots", async () => {
  const out = await resolveHandoffCandidates(
    { repo: "o/n", pr: 1, changedFiles: ["src/a.mjs"], prAuthor: "me" },
    {
      config: enabled(["recent-committers"]),
      run: fakeRun((cmd) => cmd === "git" ? {
        code: 0,
        stdout: ["me@users.noreply.github.com", "dependabot[bot]@users.noreply.github.com", "real@users.noreply.github.com"].join("\n"),
        stderr: "",
      } : null),
    },
  );
  assert.deepEqual(out.candidates.map((c) => c.login), ["real"]);
});

test("codeowners: team handles included and flagged isTeam", async () => {
  const out = await resolveHandoffCandidates(
    { repo: "o/n", pr: 1, changedFiles: ["src/a.mjs"], prAuthor: "me" },
    { config: enabled(["codeowners"]), readFile: async () => "src/* @org/team @alice\n", run: fakeRun(() => null) },
  );
  const team = out.candidates.find((c) => c.login === "org/team");
  assert.equal(team.isTeam, true);
  assert.equal(out.candidates.find((c) => c.login === "alice").isTeam, false);
});

test("fail-soft: missing CODEOWNERS yields no candidates + warning (no abort)", async () => {
  const out = await resolveHandoffCandidates(
    { repo: "o/n", pr: 1, changedFiles: ["src/a.mjs"], prAuthor: "me" },
    { config: enabled(["codeowners"]), readFile: async () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }, run: fakeRun(() => null) },
  );
  assert.equal(out.ok, true);
  assert.deepEqual(out.candidates, []);
  assert.ok(out.warnings.some((w) => w.includes("codeowners")));
});

test("fail-soft: non-ENOENT CODEOWNERS read error surfaces a distinct warning (not 'no file found')", async () => {
  const out = await resolveHandoffCandidates(
    { repo: "o/n", pr: 1, changedFiles: ["src/a.mjs"], prAuthor: "me" },
    {
      config: enabled(["codeowners"]),
      readFile: async () => { const e = new Error("permission denied"); e.code = "EACCES"; throw e; },
      run: fakeRun(() => null),
    },
  );
  assert.equal(out.ok, true);
  assert.deepEqual(out.candidates, []);
  assert.ok(out.warnings.some((w) => /failed to read/.test(w) && /permission denied/.test(w)),
    `expected a real read-error warning, got: ${JSON.stringify(out.warnings)}`);
});

test("fail-soft: git error yields no committers + warning (no abort)", async () => {
  const out = await resolveHandoffCandidates(
    { repo: "o/n", pr: 1, changedFiles: ["src/a.mjs"], prAuthor: "me" },
    { config: enabled(["recent-committers"]), run: fakeRun((cmd) => cmd === "git" ? { code: 128, stdout: "", stderr: "fatal" } : null) },
  );
  assert.equal(out.ok, true);
  assert.deepEqual(out.candidates, []);
  assert.ok(out.warnings.some((w) => w.includes("recent-committers")));
});

test("derives changed files + author from gh pr view when not supplied", async () => {
  const out = await resolveHandoffCandidates(
    { repo: "o/n", pr: 7, prAuthor: null },
    {
      config: enabled(["recent-committers"]),
      run: fakeRun((cmd, args) => {
        if (cmd === "gh") return { code: 0, stdout: JSON.stringify({ files: [{ path: "src/a.mjs" }], author: { login: "me" } }), stderr: "" };
        if (cmd === "git") {
          assert.ok(args.includes("src/a.mjs"));
          return { code: 0, stdout: "me@users.noreply.github.com\nother@users.noreply.github.com\n", stderr: "" };
        }
        return null;
      }),
    },
  );
  assert.deepEqual(out.changedFiles, ["src/a.mjs"]);
  // author "me" excluded
  assert.deepEqual(out.candidates.map((c) => c.login), ["other"]);
});
