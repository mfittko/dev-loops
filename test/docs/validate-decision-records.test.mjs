import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  detectIndexErrors,
  firstMeaningfulLine,
  isAcceptedOrSuperseded,
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
      const changed = new Set(Object.keys(baseFiles).filter((f) => f.startsWith(dir)));
      const all = new Set(["docs/decisions/0047-something.md"]);
      for (const f of all) if (baseFiles[f] !== undefined) changed.add(f);
      return [...changed];
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
