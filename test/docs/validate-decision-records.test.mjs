import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createGitClient,
  detectIndexErrors,
  firstMeaningfulLine,
  isAcceptedOrSuperseded,
  run,
  splitStatus,
  validateDecisionRecords,
} from "../../scripts/docs/validate-decision-records.mjs";

const ACCEPTED_4047 = `# 0047. Something

## Status

Accepted — 2026-08-04 ([issue 1](https://github.com/mfittko/dev-loops/issues/1))

## Context

Context text.
`;

const ACCEPTED_4047_EDITED = `# 0047. Something

## Status

Accepted — 2026-08-04 ([issue 1](https://github.com/mfittko/dev-loops/issues/1))

## Context

Context text edited.
`;

const SUPERSEDED_4047 = `# 0047. Something

## Status

Superseded by [0048](./0048-x.md) — 2026-08-07 ([issue 2](https://github.com/mfittko/dev-loops/issues/2))

## Context

Context text.
`;

async function fixture(files, git) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dev-loops-decisions-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return { root, git: git ?? makeGit() };
}

/** Fake git client: origin/main at a base whose decision files are served by the map. */
function makeGit(baseFiles = {}) {
  return {
    async symbolicRef() {
      return "refs/remotes/origin/main";
    },
    async mergeBase() {
      return "base-sha";
    },
    async diffNameOnly(_base, _head, dir) {
      return Object.keys(baseFiles).filter((f) => f.startsWith(dir));
    },
    async show(spec) {
      const rel = spec.replace(/^base-sha:/, "");
      const content = baseFiles[rel];
      if (content === undefined) {
        const err = new Error(`no such file ${rel}`);
        err.code = 1;
        throw err;
      }
      return content;
    },
    async pathExistsIn(_rev, rel) {
      return Object.prototype.hasOwnProperty.call(baseFiles, rel);
    },
  };
}

test("splitStatus separates Status section from the rest", () => {
  const { status, rest } = splitStatus(ACCEPTED_4047);
  assert.match(status, /Accepted — 2026-08-04/);
  assert.match(rest, /## Context/);
  assert.doesNotMatch(rest, /Accepted — 2026-08-04/);
});

test("isAcceptedOrSuperseded is true for Accepted and Superseded, false for Proposed", () => {
  assert.equal(isAcceptedOrSuperseded(splitStatus(ACCEPTED_4047).status), true);
  assert.equal(isAcceptedOrSuperseded(splitStatus(SUPERSEDED_4047).status), true);
  assert.equal(isAcceptedOrSuperseded(splitStatus("## Status\n\nProposed\n").status), false);
});

test("firstMeaningfulLine ignores the template's HTML comment", () => {
  assert.equal(
    firstMeaningfulLine("<!-- exactly one of: ... -->\nProposed"),
    "Proposed",
  );
});

// --- Rule 1: malformed filename (ADR-PATH-NUMBERING) ---
test("a malformed decision-record filename fails, naming ADR-PATH-NUMBERING", async () => {
  const { root, git } = await fixture({
    "docs/decisions/0047-something.md": ACCEPTED_4047,
    "docs/decisions/not-a-number.md": "# X\n",
  }, makeGit());
  try {
    const result = await validateDecisionRecords({ root, git });
    assert.equal(result.ok, false);
    const error = result.errors.find((e) => e.kind === "adr_filename");
    assert.ok(error);
    assert.equal(error.rule, "ADR-PATH-NUMBERING");
    assert.equal(error.file, "not-a-number.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Rule 2: duplicate prefix (ADR-PATH-NUMBERING) ---
test("a duplicate four-digit prefix fails, naming ADR-PATH-NUMBERING", async () => {
  const { root, git } = await fixture({
    "docs/decisions/0047-something.md": ACCEPTED_4047,
    "docs/decisions/0047-other.md": "# Y\n",
  }, makeGit());
  try {
    const result = await validateDecisionRecords({ root, git });
    assert.equal(result.ok, false);
    const error = result.errors.find((e) => e.kind === "adr_duplicate_prefix");
    assert.ok(error);
    assert.equal(error.rule, "ADR-PATH-NUMBERING");
    assert.equal(error.prefix, "0047");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("0000-template.md is exempt from numbering checks", () => {
  const errors = detectIndexErrors(["0000-template.md"]);
  assert.deepEqual(errors, []);
});

// --- Rule 3: post-acceptance edit outside Status section (ADR-SUPERSEDE-NOT-REWRITE) ---
test("a post-acceptance edit outside the Status section fails, naming ADR-SUPERSEDE-NOT-REWRITE", async () => {
  const { root, git } = await fixture({
    "docs/decisions/0047-something.md": ACCEPTED_4047_EDITED,
  }, makeGit({ "docs/decisions/0047-something.md": ACCEPTED_4047 }));
  try {
    const result = await validateDecisionRecords({ root, git });
    assert.equal(result.ok, false);
    const error = result.errors.find((e) => e.kind === "adr_post_acceptance_rewrite");
    assert.ok(error);
    assert.equal(error.rule, "ADR-SUPERSEDE-NOT-REWRITE");
    assert.equal(error.file, "docs/decisions/0047-something.md");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a sanctioned Status flip (Accepted to Superseded) passes", async () => {
  const { root, git } = await fixture({
    "docs/decisions/0047-something.md": SUPERSEDED_4047,
  }, makeGit({ "docs/decisions/0047-something.md": ACCEPTED_4047 }));
  try {
    const result = await validateDecisionRecords({ root, git });
    assert.equal(result.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new record added at the next free number passes", async () => {
  const { root, git } = await fixture({
    "docs/decisions/0048-new-record.md": "# 0048. New\n",
  }, makeGit());
  try {
    const result = await validateDecisionRecords({ root, git });
    assert.equal(result.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a still-Proposed record may be edited outside its Status section (passes)", async () => {
  const PROPOSED_BASE = `# 0047. Something\n\n## Status\n\nProposed — 2026-07-01\n\n## Context\n\nOriginal.\n`;
  const PROPOSED_EDITED = `# 0047. Something\n\n## Status\n\nProposed — 2026-07-01\n\n## Context\n\nEdited.\n`;
  const { root, git } = await fixture({
    "docs/decisions/0047-something.md": PROPOSED_EDITED,
  }, makeGit({ "docs/decisions/0047-something.md": PROPOSED_BASE }));
  try {
    const result = await validateDecisionRecords({ root, git });
    assert.equal(result.ok, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deleting an accepted record fails, naming ADR-SUPERSEDE-NOT-REWRITE", async () => {
  const { root, git } = await fixture({
    "docs/decisions/0048-new-record.md": "# 0048. New\n",
  }, makeGit({ "docs/decisions/0047-something.md": ACCEPTED_4047 }));
  try {
    const result = await validateDecisionRecords({ root, git });
    assert.equal(result.ok, false);
    const error = result.errors.find((e) => e.kind === "adr_post_acceptance_rewrite");
    assert.ok(error);
    assert.equal(error.rule, "ADR-SUPERSEDE-NOT-REWRITE");
    assert.match(error.message, /deleted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an already-Superseded record is also protected from non-status edits", async () => {
  const { root, git } = await fixture({
    "docs/decisions/0047-something.md": ACCEPTED_4047_EDITED,
  }, makeGit({ "docs/decisions/0047-something.md": SUPERSEDED_4047 }));
  try {
    const result = await validateDecisionRecords({ root, git });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.kind === "adr_post_acceptance_rewrite"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Rule 3: graceful degradation when base ref unavailable ---
test("an unavailable base ref degrades gracefully instead of failing", async () => {
  const { root, git } = await fixture({
    "docs/decisions/0047-something.md": ACCEPTED_4047_EDITED,
  }, {
    async symbolicRef() {
      throw new Error("no origin/HEAD");
    },
    async mergeBase() {
      throw new Error("fatal: Not a valid object name");
    },
  });
  try {
    const result = await validateDecisionRecords({ root, git });
    assert.equal(result.ok, true); // rule 3 skipped, index checks pass
    assert.equal(result.rule3.state, "degraded");
    assert.ok(result.rule3.notice);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a malformed filename in an unavailable-base repo still fails the index rule", async () => {
  const { root, git } = await fixture({
    "docs/decisions/0047-something.md": ACCEPTED_4047,
    "docs/decisions/bad.md": "# X\n",
  }, {
    async symbolicRef() {
      throw new Error("no origin/HEAD");
    },
  });
  try {
    const result = await validateDecisionRecords({ root, git });
    assert.equal(result.ok, false); // index check still enforced
    assert.ok(result.errors.some((e) => e.rule === "ADR-PATH-NUMBERING"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- splitStatus: benign heading drift must not fail open ---
test("splitStatus tolerates benign trailing punctuation on the Status heading", () => {
  const text = `# 0047. Something\n\n## Status:\n\nAccepted — 2026-08-04\n\n## Context\n\nContext text.\n`;
  const { status, rest } = splitStatus(text);
  assert.match(status, /Accepted — 2026-08-04/);
  assert.doesNotMatch(rest, /Accepted — 2026-08-04/);
  assert.equal(isAcceptedOrSuperseded(splitStatus(text).status), true);
});

// --- Rule 3: a real git failure fails closed (path absent from base still skips) ---
test("a real git.show failure fails closed instead of silently skipping rule 3", async () => {
  const base = makeGit({ "docs/decisions/0047-something.md": ACCEPTED_4047 });
  const git = {
    ...base,
    async show(_spec) {
      throw new Error("fatal: object corrupt");
    },
  };
  const { root } = await fixture({
    "docs/decisions/0047-something.md": ACCEPTED_4047_EDITED,
  }, git);
  try {
    // The record exists in base (pathExistsIn true), so a git.show failure is a
    // real error and must propagate — not "continue" past the guard.
    await assert.rejects(
      () => validateDecisionRecords({ root, git }),
      /corrupt/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- Rule 3 rename-protection: mutation-anchored on the --no-renames flag ---
test("rename-protection is mutation-anchored: diffNameOnly passes --no-renames", async () => {
  const calls = [];
  const exec = async (_cmd, args) => {
    calls.push(args);
    return { stdout: "docs/decisions/0047-something.md\n" };
  };
  const git = createGitClient("/tmp", exec);
  const out = await git.diffNameOnly("base-sha", "HEAD", "docs/decisions");
  assert.deepEqual(out, ["docs/decisions/0047-something.md"]);
  const diffCall = calls.find((a) => a.includes("--name-only"));
  assert.ok(diffCall, "expected a git diff invocation");
  assert.ok(
    diffCall.includes("--no-renames"),
    "--no-renames must be passed so a git mv (rename) cannot collapse to the destination path and evade rule 3",
  );
});

// --- readdir: fail closed when docs/decisions is unreadable/missing ---
test("a missing docs/decisions directory fails closed instead of passing with 0 records", async () => {
  const { root, git } = await fixture({}, makeGit());
  try {
    await assert.rejects(
      () => validateDecisionRecords({ root, git }),
      /unable to read docs\/decisions/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- pathExistsIn: absent path -> false, real git failure fails closed ---
test("pathExistsIn: absent path -> false (new record), real git failure fails closed", async () => {
  const corrupt = new Error("fatal: not a tree object");
  corrupt.code = 128;
  let calls = 0;
  const exec = async () => {
    calls += 1;
    if (calls === 1) return { stdout: "" }; // absent from base (new record) -> false
    if (calls === 2) return { stdout: "100644 blob abcd\tdocs/decisions/0047-something.md" }; // exists -> true
    throw corrupt; // real git failure -> fail closed
  };
  const git = createGitClient("/tmp", exec);
  // Absent from base (a newly added record): rule 3 safely skips it.
  assert.equal(await git.pathExistsIn("base-sha", "docs/decisions/0048-new.md"), false);
  // Present in base.
  assert.equal(await git.pathExistsIn("base-sha", "docs/decisions/0047-something.md"), true);
  // A genuine git failure (corrupt object / invalid rev) must surface, not be swallowed.
  await assert.rejects(() => git.pathExistsIn("base-sha", "docs/decisions/0047.md"), /tree object/);
});

// --- main()/run(): the CI-degrade fail-closed guard is mutation-anchored ---
test("run(): degraded rule 3 exits 1 in CI (fail closed), 0 outside CI", async () => {
  const { root } = await fixture({
    "docs/decisions/0047-something.md": ACCEPTED_4047,
  });
  const degradeGit = {
    async symbolicRef() {
      throw new Error("no origin/HEAD");
    },
    async mergeBase() {
      throw new Error("fatal: Not a valid object name");
    },
  };
  const silent = { write() {} };
  try {
    const ciCode = await run({ root, git: degradeGit, env: { CI: "1" }, out: silent });
    assert.equal(ciCode, 1, "CI with a degraded rule 3 must fail closed (exit 1)");
    const localCode = await run({ root, git: degradeGit, env: {}, out: silent });
    assert.equal(localCode, 0, "a degraded rule 3 outside CI must pass gracefully (exit 0)");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run(): a clean non-degraded result exits 0 even in CI", async () => {
  const { root } = await fixture({
    "docs/decisions/0047-something.md": ACCEPTED_4047,
  }, makeGit({ "docs/decisions/0047-something.md": ACCEPTED_4047 }));
  const silent = { write() {} };
  try {
    const code = await run({ root, git: makeGit({ "docs/decisions/0047-something.md": ACCEPTED_4047 }), env: { CI: "1" }, out: silent });
    assert.equal(code, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
