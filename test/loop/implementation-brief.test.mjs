import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "bun:test";

import { detectAcDodMatrix } from "@dev-loops/core/loop/issue-refinement-artifact";
import { runCli } from "../../cli/index.mjs";
import { runGitFixture } from "../_helpers.mjs";
import { buildImplementationBrief, main } from "../../scripts/loop/implementation-brief.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const MATRIX = [
  "## AC / DoD matrix",
  "",
  "| Acceptance criterion | Required completion evidence |",
  "| --- | --- |",
  "| The brief carries the matrix. | A fixture body yields the same rows. |",
  "| The brief lists the non-goals. | The non-goal items match the body. |",
  "",
].join("\n");

function record({ title, status = "Accepted — 2026-01-01", body = "Text." }) {
  return `# ${title}\n\n## Status\n\n${status}\n\n## Context\n\n${body}\n`;
}

async function fixtureRepo({ rules, decisions = {}, files = {}, withDecisions = true, git = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "implementation-brief-"));
  tempDirs.push(root);
  await mkdir(path.join(root, "skills", "docs"), { recursive: true });
  if (rules !== null) {
    await writeFile(
      path.join(root, "skills", "docs", "required-rules.json"),
      rules === undefined
        ? JSON.stringify({ requiredRules: [{ id: "KNOWN-RULE-ID" }], optOutRules: [] })
        : typeof rules === "string" ? rules : JSON.stringify(rules),
    );
  }
  // A present record index is the normal shape; a checkout without docs/decisions
  // is the exceptional one the missing_decision_records fixture covers.
  if (withDecisions) {
    await mkdir(path.join(root, "docs", "decisions"), { recursive: true });
  }
  for (const [name, text] of Object.entries(decisions)) {
    await writeFile(path.join(root, "docs", "decisions", name), text);
  }
  for (const [relPath, text] of Object.entries(files)) {
    const target = path.join(root, ...relPath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, text);
  }
  // A work tree by default: the inventory and importers read `git ls-files`.
  if (git) runGitFixture(root, ["init", "-q"]);
  return root;
}

async function writeBody(root, body) {
  const file = path.join(root, "spec-body.md");
  await writeFile(file, body);
  return file;
}

function buffer() {
  let text = "";
  return { stream: new Writable({ write(chunk, _enc, cb) { text += chunk; cb(); } }), read: () => text };
}

async function run(io, argv) {
  const code = await main(argv, { stdout: io.stdout.stream, stderr: io.stderr.stream });
  return { code, stdout: io.stdout.read(), stderr: io.stderr.read() };
}

function io() {
  return { stdout: buffer(), stderr: buffer() };
}

async function expectPathRefusal(root, bad) {
  const bodyFile = await writeBody(root, MATRIX);
  const output = io();
  const result = await run(output, ["--body-file", bodyFile, "--repo-root", root, "--paths", bad]);
  assert.equal(result.code, 1, `${bad} must exit 1`);
  assert.equal(result.stdout, "", `${bad} must print no brief`);
  assert.equal(JSON.parse(result.stderr.trim()).ok, false);
  assert.match(JSON.parse(result.stderr.trim()).error, /repo-relative path/u);
}

test("the brief carries the body's AC/DoD matrix rows and non-goals unchanged", async () => {
  const root = await fixtureRepo();
  const body = `${MATRIX}\n## Non-goals\n\n- No reuse map.\n- No gate credit.\n`;
  const brief = await buildImplementationBrief({ body, repoRoot: root });
  assert.deepEqual(brief.matrix, detectAcDodMatrix(body).rows);
  assert.equal(brief.matrix.length, 2);
  assert.deepEqual(brief.nonGoals, ["No reuse map.", "No gate credit."]);
  assert.deepEqual(brief.findings, []);
});

test("a wrapped non-goal keeps its continuation line instead of truncating", async () => {
  const root = await fixtureRepo();
  const body = `${MATRIX}\n## Non-goals\n\n- No gate credit.\n  The brief adds no authority.\n`;
  const brief = await buildImplementationBrief({ body, repoRoot: root });
  assert.deepEqual(brief.nonGoals, ["No gate credit. The brief adds no authority."]);
});

test("a non-goals list written with numbered markers is read instead of dropped", async () => {
  const root = await fixtureRepo();
  const body = `${MATRIX}\n## Non-goals\n\n1. No gate credit.\n2. No reuse map.\n`;
  const brief = await buildImplementationBrief({ body, repoRoot: root });
  assert.deepEqual(brief.nonGoals, ["No gate credit.", "No reuse map."]);
});

test("a standalone paragraph after the non-goals list is not absorbed into the last item", async () => {
  const root = await fixtureRepo();
  const body = `${MATRIX}\n## Non-goals\n\n- No gate credit.\n\nImplementation notes are tracked separately.\n`;
  const brief = await buildImplementationBrief({ body, repoRoot: root });
  assert.deepEqual(brief.nonGoals, ["No gate credit."]);
});

test("non-goals headings match the canonical forms and reject unrelated sections", async () => {
  const root = await fixtureRepo();
  for (const heading of ["Non-goals", "Non goals", "Explicit non-goals", "Out of scope", "Non-goals (slice 1)"]) {
    const brief = await buildImplementationBrief({ body: `${MATRIX}\n## ${heading}\n\n- No gate credit.\n`, repoRoot: root });
    assert.deepEqual(brief.nonGoals, ["No gate credit."], heading);
  }
  for (const heading of ["Goals", "In scope", "Open questions"]) {
    const brief = await buildImplementationBrief({ body: `${MATRIX}\n## ${heading}\n\n- Not a non-goal.\n`, repoRoot: root });
    assert.deepEqual(brief.nonGoals, [], heading);
  }
});

test("a fenced example inside the non-goals section is not read as non-goal items", async () => {
  const root = await fixtureRepo();
  const body = `${MATRIX}\n## Non-goals\n\n- No gate credit.\n\`\`\`\n- example\n\`\`\`\n`;
  const brief = await buildImplementationBrief({ body, repoRoot: root });
  assert.deepEqual(brief.nonGoals, ["No gate credit."]);
});

test("a body without a matrix yields matrix null, a missing_ac_dod_matrix finding and exit 0", async () => {
  const root = await fixtureRepo();
  const body = "## Problem\n\nProse only.\n";
  const brief = await buildImplementationBrief({ body, repoRoot: root });
  assert.equal(brief.matrix, null);
  assert.deepEqual(brief.findings.map(({ kind }) => kind), ["missing_ac_dod_matrix"]);
  assert.deepEqual(brief.nonGoals, []);

  const output = io();
  const bodyFile = await writeBody(root, body);
  assert.equal((await run(output, ["--body-file", bodyFile, "--repo-root", root])).code, 0);
  assert.equal(JSON.parse(output.stdout.read()).matrix, null);
});

test("cited ADRs, accepted ADRs naming a touched path and amending records are all listed", async () => {
  const root = await fixtureRepo({
    decisions: {
      "0010-base.md": record({ title: "0010. Base record" }),
      "0011-amender.md": record({
        title: "0011. Amender record",
        status: "Accepted — 2026-01-02\n\nAmends [0010](./0010-base.md): narrows it.",
      }),
      "0020-names-a-path.md": record({
        title: "0020. Names a path",
        status: "Accepted — 2026-01-03",
        body: "Applies to src/touched.mjs only.",
      }),
      "0030-proposed.md": record({
        title: "0030. Proposed",
        status: "Proposed",
        body: "Also mentions src/touched.mjs.",
      }),
      "0040-replaced.md": record({ title: "0040. Replaced record", status: "Superseded by ADR 0041" }),
      "0041-replacement.md": record({ title: "0041. Replacement record" }),
    },
    files: { "src/touched.mjs": "export const value = 1;\n" },
  });
  const brief = await buildImplementationBrief({
    body: "Follows ADR 0010 and ADR 0040.",
    repoRoot: root,
    paths: ["src/touched.mjs"],
  });

  assert.deepEqual(brief.adrs.map(({ number }) => number), ["0010", "0020", "0040"]);
  const [base, byPath, superseded] = brief.adrs;
  assert.equal(base.title, "Base record");
  assert.equal(base.path, "docs/decisions/0010-base.md");
  assert.deepEqual(base.amendedBy.map(({ number, title, path: recordPath }) => ({ number, title, path: recordPath })), [
    { number: "0011", title: "Amender record", path: "docs/decisions/0011-amender.md" },
  ]);
  assert.equal(base.supersededBy, null);
  assert.equal(byPath.title, "Names a path");
  assert.deepEqual(superseded.supersededBy, {
    number: "0041",
    title: "Replacement record",
    path: "docs/decisions/0041-replacement.md",
  });
});

test("amendedBy keeps only later-numbered accepted amenders, as loop spec-lint does", async () => {
  const amends = (status) => `${status}\n\nAmends [0010](./0010-base.md): narrows it.`;
  const root = await fixtureRepo({
    decisions: {
      "0005-lower.md": record({ title: "0005. Lower amender", status: amends("Accepted — 2026-01-01") }),
      "0010-base.md": record({ title: "0010. Base record" }),
      "0011-accepted.md": record({ title: "0011. Accepted amender", status: amends("Accepted — 2026-01-02") }),
      "0012-proposed.md": record({ title: "0012. Proposed amender", status: amends("Proposed") }),
      "0013-superseded.md": record({ title: "0013. Superseded amender", status: amends("Superseded by ADR 0011") }),
    },
  });
  const brief = await buildImplementationBrief({ body: "Follows ADR 0010.", repoRoot: root });
  assert.deepEqual(brief.adrs[0].amendedBy.map(({ number }) => number), ["0011"]);
});

test("a fenced ADR need heading is not the spec's ADR need", async () => {
  const root = await fixtureRepo();
  const brief = await buildImplementationBrief({
    body: "```\n## ADR need\n\nOne record for X.\n```\n",
    repoRoot: root,
  });
  assert.equal(brief.adrNeed, "unstated");
});

test("a path-shaped token longer than PATH_MAX is unresolved under any root depth", async () => {
  // One 256-char segment exceeds NAME_MAX, so stat returns ENAMETOOLONG on Linux and macOS.
  const token = `${Array.from({ length: 5 }, () => "a".repeat(256)).join("/")}.md`;
  const body = `${MATRIX}\nSee ${token} here.\n`;
  const shallow = await fixtureRepo();
  const deep = await fixtureRepo({ files: { [`${"d".repeat(100)}/x.txt`]: "x\n" } });
  const left = await buildImplementationBrief({ body, repoRoot: shallow });
  const right = await buildImplementationBrief({ body, repoRoot: path.join(deep, "d".repeat(100)) });
  assert.deepEqual(left.touchedPaths, []);
  assert.deepEqual(right.touchedPaths, []);
  assert.deepEqual(left.unresolvedPaths, right.unresolvedPaths);
});

// uid 0 ignores directory permission bits, so stat never throws EACCES.
const SKIP_UNDER_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

test("an EACCES on --repo-root itself is not treated as missing and is no usage error", { skip: SKIP_UNDER_ROOT }, async () => {
  const parent = await fixtureRepo();
  await mkdir(path.join(parent, "locked", "child"), { recursive: true });
  await chmod(path.join(parent, "locked"), 0o000);
  try {
    await assert.rejects(
      () => buildImplementationBrief({ body: MATRIX, repoRoot: path.join(parent, "locked", "child") }),
      (error) => error.code === "EACCES" && error.exitCode !== 1,
    );
  } finally {
    await chmod(path.join(parent, "locked"), 0o755);
  }
});

test("adrNeed carries the ADR need section, and reads unstated when the body has none", async () => {
  const root = await fixtureRepo();
  const stated = await buildImplementationBrief({
    body: "## ADR need\n\nOne record for the new CLI verb.\n\n## Problem\n\nText.\n",
    repoRoot: root,
  });
  assert.equal(stated.adrNeed, "One record for the new CLI verb.");
  const unstated = await buildImplementationBrief({ body: MATRIX, repoRoot: root });
  assert.equal(unstated.adrNeed, "unstated");
});

test("adrTripwirePaths holds the tripwire-shaped touched paths from the imported matchers", async () => {
  const root = await fixtureRepo({
    files: {
      "skills/docs/example-contract.md": "# Example contract\n",
      "packages/core/src/config/extension-defaults.yaml": "gates: {}\n",
      ".devloops": "version: 1\n",
      "scripts/loop/thing.mjs": "export const thing = 1;\n",
    },
  });
  const brief = await buildImplementationBrief({
    body: MATRIX,
    repoRoot: root,
    paths: [
      "skills/docs/example-contract.md",
      "packages/core/src/config/extension-defaults.yaml",
      ".devloops",
      "scripts/loop/thing.mjs",
    ],
  });
  assert.deepEqual(brief.adrTripwirePaths, [
    ".devloops",
    "packages/core/src/config/extension-defaults.yaml",
    "skills/docs/example-contract.md",
  ]);
});

test("requiredReads always names the structural-quality rule and the changelog fragment README", async () => {
  const root = await fixtureRepo();
  for (const body of [MATRIX, "## Problem\n\nProse only.\n"]) {
    const brief = await buildImplementationBrief({ body, repoRoot: root });
    assert.deepEqual(brief.requiredReads, ["skills/docs/structural-quality.md", "changes/README.md"]);
  }
});

test("declared paths are resolved, de-duplicated and reported when missing", async () => {
  const root = await fixtureRepo({ files: { "scripts/loop/known.mjs": "export const known = 1;\n" } });
  const brief = await buildImplementationBrief({
    body: MATRIX,
    repoRoot: root,
    paths: ["scripts/loop/known.mjs", "scripts/loop/missing.mjs", "scripts/loop/known.mjs"],
  });
  // A declared path is a touched path even before it exists; unresolvedPaths is
  // the additional not-found marker.
  assert.deepEqual(brief.touchedPaths, ["scripts/loop/known.mjs", "scripts/loop/missing.mjs"]);
  assert.deepEqual(brief.unresolvedPaths, ["scripts/loop/missing.mjs"]);
});

test("a declared but missing tripwire path still reaches adrTripwirePaths", async () => {
  const root = await fixtureRepo();
  const brief = await buildImplementationBrief({
    body: MATRIX,
    repoRoot: root,
    paths: ["skills/docs/new-thing-contract.md"],
  });
  assert.deepEqual(brief.touchedPaths, ["skills/docs/new-thing-contract.md"]);
  assert.deepEqual(brief.unresolvedPaths, ["skills/docs/new-thing-contract.md"]);
  assert.deepEqual(brief.adrTripwirePaths, ["skills/docs/new-thing-contract.md"]);
});

test("a repo-relative --paths entry stays accepted", async () => {
  const root = await fixtureRepo({ files: { "src/a.mjs": "export const a = 1;\n" } });
  const bodyFile = await writeBody(root, MATRIX);
  const output = io();
  const result = await run(output, ["--body-file", bodyFile, "--repo-root", root, "--paths", "src/a.mjs"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).touchedPaths, ["src/a.mjs"]);
});

test("a ./-prefixed --paths entry stays accepted", async () => {
  const root = await fixtureRepo({ files: { "src/a.mjs": "export const a = 1;\n" } });
  const bodyFile = await writeBody(root, MATRIX);
  const output = io();
  const result = await run(output, ["--body-file", bodyFile, "--repo-root", root, "--paths", "./src/a.mjs"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout).touchedPaths, ["src/a.mjs"]);
});

test("a POSIX-absolute --paths entry exits 1", async () => {
  await expectPathRefusal(await fixtureRepo(), "/etc/passwd");
});

test("a Windows drive-letter --paths entry exits 1", async () => {
  await expectPathRefusal(await fixtureRepo(), "C:\\tmp\\x");
});

test("a UNC --paths entry exits 1 instead of becoming repo-relative", async () => {
  await expectPathRefusal(await fixtureRepo(), "\\\\server\\share\\x");
});

test("a parent-relative --paths entry exits 1", async () => {
  for (const bad of ["src/../etc/passwd", "../outside"]) {
    await expectPathRefusal(await fixtureRepo(), bad);
  }
});

test("a --paths entry carrying a file:line citation exits 1 instead of resolving nothing", async () => {
  const root = await fixtureRepo({ files: { "src/a.mjs": "export const a = 1;\n" } });
  await expectPathRefusal(root, "src/a.mjs:42");
});

test("a --paths entry that normalizes to an empty path exits 1 instead of vanishing", async () => {
  await expectPathRefusal(await fixtureRepo(), ".");
});

test("a doc path and a ./-prefixed directory stay accepted --paths entries", async () => {
  const root = await fixtureRepo({ files: { "docs/structural-quality.md": "# Structural quality\n" } });
  const bodyFile = await writeBody(root, MATRIX);
  for (const [entry, expected] of [["docs/structural-quality.md", "docs/structural-quality.md"], ["./docs", "docs"]]) {
    const output = io();
    const result = await run(output, ["--body-file", bodyFile, "--repo-root", root, "--paths", entry]);
    assert.equal(result.code, 0, `${entry} must be accepted`);
    assert.deepEqual(JSON.parse(result.stdout).touchedPaths, [expected]);
  }
});

test("--help documents the flags, the output shape and the exit codes", async () => {
  const output = io();
  assert.equal((await run(output, ["--help"])).code, 0);
  const usage = output.stdout.read();
  for (const fragment of ["--body-file", "--paths", "--repo-root", "--jq", "Exit codes", "adrTripwirePaths", "requiredReads", "helperInventory", "importers", "importers_unavailable"]) {
    assert.ok(usage.includes(fragment), `--help must document ${fragment}`);
  }
});

test("a missing --body-file and an unknown flag are usage errors that exit 1", async () => {
  for (const argv of [["--repo-root", repoRoot], ["--body-file", "spec.md", "--bogus"]]) {
    const output = io();
    assert.equal((await run(output, argv)).code, 1);
    assert.equal(output.stdout.read(), "");
    assert.equal(JSON.parse(output.stderr.read().trim()).ok, false);
  }
});

test("an empty or whitespace --repo-root is a usage error that exits 1", async () => {
  for (const value of ["", "   "]) {
    const output = io();
    assert.equal((await run(output, ["--body-file", "spec.md", "--repo-root", value])).code, 1);
    assert.equal(output.stdout.read(), "");
    assert.equal(JSON.parse(output.stderr.read().trim()).ok, false);
  }
});

test("a touched rule registry does not count as a citing file", async () => {
  const root = await fixtureRepo({
    rules: { requiredRules: [{ id: "RULE-AA" }, { id: "RULE-BB" }, { id: "RULE-CC" }], optOutRules: [] },
    files: { "skills/docs/foo-contract.md": "<!-- rule: RULE-AA -->\n`RULE-AA`: Foo.\n" },
  });
  const only = await buildImplementationBrief({ body: "No rules.", repoRoot: root, paths: ["skills/docs/required-rules.json"] });
  assert.deepEqual(only.rules, []);
  const mixed = await buildImplementationBrief({ body: "Cites RULE-BB.", repoRoot: root, paths: ["skills/docs/required-rules.json", "skills/docs/foo-contract.md"] });
  assert.deepEqual(mixed.rules.map(({ id }) => id), ["RULE-AA", "RULE-BB"]);
});

test("an unregistered rule ID is absent and a missing registry is a finding, not silence", async () => {
  const root = await fixtureRepo({
    files: { "skills/docs/owner.md": "<!-- rule: KNOWN-RULE-ID -->\n`KNOWN-RULE-ID`: Owner doc.\n" },
  });
  const cited = await buildImplementationBrief({ body: "Cites KNOWN-RULE-ID and MISSING-RULE-ID.", repoRoot: root });
  assert.deepEqual(cited.rules, [{ id: "KNOWN-RULE-ID", doc: "skills/docs/owner.md" }]);
  // `loop spec-lint` reads the body through the same fence-stripping helper, so
  // an ID that only appears inside a fenced example is not a citation.
  const fencedBody = `${MATRIX}\n\`\`\`\nExample mentions KNOWN-RULE-ID.\n\`\`\`\n`;
  assert.deepEqual((await buildImplementationBrief({ body: fencedBody, repoRoot: root })).rules, []);

  const absent = await fixtureRepo({ rules: null });
  const brief = await buildImplementationBrief({ body: "Cites KNOWN-RULE-ID.", repoRoot: absent });
  assert.deepEqual(brief.rules, []);
  assert.deepEqual(brief.findings.map(({ kind }) => kind), ["missing_ac_dod_matrix", "missing_rule_registry"]);
  // The reason must stay root-independent, or two checkouts disagree on the bytes.
  assert.ok(!JSON.stringify(brief).includes(absent), "the finding must not echo the checkout root");
  const otherAbsent = await fixtureRepo({ rules: null });
  const second = await buildImplementationBrief({ body: "Cites KNOWN-RULE-ID.", repoRoot: otherAbsent });
  assert.equal(JSON.stringify(second), JSON.stringify(brief));
});

test("a rule marker in a declared touched doc is reported with its owning doc", async () => {
  const root = await fixtureRepo({
    files: { "skills/docs/touched-rules.md": "<!-- rule: KNOWN-RULE-ID -->\n`KNOWN-RULE-ID`: Touched doc.\n" },
  });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["skills/docs/touched-rules.md"] });
  assert.deepEqual(brief.rules, [{ id: "KNOWN-RULE-ID", doc: "skills/docs/touched-rules.md" }]);
});

test("a registered rule cited in a declared touched source file is reported", async () => {
  const root = await fixtureRepo({
    files: { "scripts/loop/consumer.mjs": "// Implements KNOWN-RULE-ID.\nexport const consumer = 1;\n" },
  });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["scripts/loop/consumer.mjs"] });
  assert.deepEqual(brief.rules, [{ id: "KNOWN-RULE-ID", doc: null }]);
});

test("an unregistered rule ID in a declared touched file stays absent", async () => {
  const root = await fixtureRepo({
    files: { "scripts/loop/consumer.mjs": "// Implements MISSING-RULE-ID.\nexport const consumer = 1;\n" },
  });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["scripts/loop/consumer.mjs"] });
  assert.deepEqual(brief.rules, []);
});

test("a fenced rule mention in a declared touched markdown file is not a citation", async () => {
  const root = await fixtureRepo({
    files: { "skills/docs/notes.md": "# Notes\n\n```\nExample mentions KNOWN-RULE-ID.\n```\n" },
  });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["skills/docs/notes.md"] });
  assert.deepEqual(brief.rules, []);
});

test("accepted-ADR attribution accepts a touched file named as a path token", async () => {
  const root = await fixtureRepo({
    decisions: { "0010-names-a-file.md": record({ title: "0010. Names a file", body: "Applies to src/a.mjs." }) },
    files: { "src/a.mjs": "export const a = 1;\n" },
  });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs"] });
  assert.deepEqual(brief.adrs.map(({ number }) => number), ["0010"]);
});

test("accepted-ADR attribution accepts a declared directory named with its trailing slash", async () => {
  const root = await fixtureRepo({
    decisions: { "0010-names-a-directory.md": record({ title: "0010. Names a directory", body: "Covers scripts/ only." }) },
    files: { "scripts/loop/thing.mjs": "export const thing = 1;\n" },
  });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["scripts/"] });
  assert.deepEqual(brief.adrs.map(({ number }) => number), ["0010"]);
});

test("accepted-ADR attribution rejects a record that only names a longer path", async () => {
  const root = await fixtureRepo({
    decisions: { "0010-longer-path.md": record({ title: "0010. Longer path", body: "Applies to src/a.mjs.bak only." }) },
    files: { "src/a.mjs": "export const a = 1;\n" },
  });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs"] });
  assert.deepEqual(brief.adrs.map(({ number }) => number), []);
});

test("accepted-ADR attribution rejects a directory record that only names a sibling path", async () => {
  const root = await fixtureRepo({
    decisions: { "0010-other-dir.md": record({ title: "0010. Other dir", body: "Covers scriptsOther/ only." }) },
    files: { "scripts/loop/thing.mjs": "export const thing = 1;\n" },
  });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["scripts/"] });
  assert.deepEqual(brief.adrs.map(({ number }) => number), []);
});

test("accepted-ADR attribution resolves relative Markdown destinations from the ADR directory", async () => {
  const root = await fixtureRepo({
    decisions: {
      "0052-relative-link.md": record({
        title: "0052. Relative link",
        body: "Enforces [the contract](../../skills/docs/decision-record-contract.md).",
      }),
      "0053-relative-directory.md": record({
        title: "0053. Relative directory",
        body: "Covers [scripts](../../scripts/).",
      }),
    },
    files: { "skills/docs/decision-record-contract.md": "# Contract\n", "scripts/example.mjs": "// Example\n" },
  });
  const brief = await buildImplementationBrief({
    body: MATRIX,
    repoRoot: root,
    paths: ["skills/docs/decision-record-contract.md", "scripts/"],
  });
  assert.deepEqual(brief.adrs.map(({ number }) => number), ["0052", "0053"]);
});

test("ADR-relative links must resolve to the exact touched path, not a suffix or external URL", async () => {
  const root = await fixtureRepo({
    decisions: {
      "0010-wrong-base.md": record({ title: "0010. Wrong base", body: "See [file](../src/a.mjs)." }),
      "0011-longer-path.md": record({ title: "0011. Longer path", body: "See [file](../../src/a.mjs.bak)." }),
      "0012-external.md": record({ title: "0012. External", body: "See [file](https://example.com/src/a.mjs)." }),
      "0013-outside.md": record({ title: "0013. Outside", body: "See [file](../../../src/a.mjs)." }),
      "0014-sibling.md": record({ title: "0014. Sibling", body: "See [directory](../../scriptsOther/)." }),
    },
    files: { "src/a.mjs": "// A\n", "scripts/example.mjs": "// Example\n" },
  });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs", "scripts/"] });
  assert.deepEqual(brief.adrs, []);
});

test("a sentence-final path citation keeps the path and drops the period", async () => {
  const root = await fixtureRepo({ files: { "src/a.mjs": "export const a = 1;\n" } });
  const brief = await buildImplementationBrief({ body: `${MATRIX}\nUpdate src/a.mjs. Done.\n`, repoRoot: root });
  assert.deepEqual(brief.touchedPaths, ["src/a.mjs"]);
  assert.deepEqual(brief.unresolvedPaths, []);
});

for (const citation of ["src/a.mjs:", "src/a.mjs:42", "src/a.mjs:42:7", "AGENTS.md:"]) {
  test(`a colon-delimited citation ${citation} keeps the existing path`, async () => {
    const citedPath = citation.split(":")[0];
    const root = await fixtureRepo({ files: { [citedPath]: "// Citation fixture\n" } });
    const brief = await buildImplementationBrief({
      body: `Update ${citation} change the export.\n`,
      repoRoot: root,
    });
    assert.deepEqual(brief.touchedPaths, [citedPath]);
    assert.deepEqual(brief.unresolvedPaths, []);
  });
}

test("a root-level existing citation is claimed", async () => {
  const root = await fixtureRepo({ files: { "AGENTS.md": "# Agents\n" } });
  const brief = await buildImplementationBrief({ body: `${MATRIX}\nUpdate AGENTS.md next.\n`, repoRoot: root });
  assert.deepEqual(brief.touchedPaths, ["AGENTS.md"]);
});

test("an extensionless root citation is claimed through its ./-prefix signal, not as bare prose", async () => {
  const root = await fixtureRepo({ files: { LICENSE: "License text\n" } });
  const explicit = await buildImplementationBrief({ body: `${MATRIX}\nUpdate ./LICENSE.\n`, repoRoot: root });
  assert.deepEqual(explicit.touchedPaths, ["LICENSE"]);
  // A bare extensionless token is prose far more often than a path, so it needs
  // the signal: "the docs directory" must not enter touchedPaths.
  const bare = await buildImplementationBrief({ body: `${MATRIX}\nUpdate LICENSE.\n`, repoRoot: root });
  assert.deepEqual(bare.touchedPaths, []);
});

test("ordinary prose naming existing root directories is not a touched path", async () => {
  const root = await fixtureRepo({
    files: { "docs/structural-quality.md": "# Structural quality\n", "test/loop/thing.test.mjs": "// Test\n" },
  });
  const brief = await buildImplementationBrief({
    body: `${MATRIX}\nUpdate the docs directory and the test suite.\n`,
    repoRoot: root,
  });
  assert.deepEqual(brief.touchedPaths, []);
  assert.deepEqual(brief.adrs, []);
});

test("a directory citation is claimed only when spelled with its trailing slash", async () => {
  const root = await fixtureRepo({ files: { "docs/decisions/x.md": "# X\n", "changes/n.md": "# N\n" } });
  const spelled = await buildImplementationBrief({ body: `${MATRIX}\nUpdate docs/decisions/ next, then changes/.\n`, repoRoot: root });
  assert.deepEqual(spelled.touchedPaths, ["changes", "docs/decisions"]);
  const prose = await buildImplementationBrief({ body: `${MATRIX}\nMake the changes and update the docs.\n`, repoRoot: root });
  assert.deepEqual(prose.touchedPaths, []);
});

test("a case-variant declared path is unresolved and contributes no rule IDs", async () => {
  const root = await fixtureRepo({
    files: { "a/b.mjs": "// Implements KNOWN-RULE-ID.\nexport const b = 1;\n" },
  });
  const variant = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["A/b.mjs"] });
  assert.deepEqual(variant.unresolvedPaths, ["A/b.mjs"]);
  assert.deepEqual(variant.rules, []);
  const exact = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["a/b.mjs"] });
  assert.deepEqual(exact.unresolvedPaths, []);
  assert.deepEqual(exact.rules, [{ id: "KNOWN-RULE-ID", doc: null }]);
});

test("a body citation is claimed by path shape, and only for the exact on-disk spelling", async () => {
  const root = await fixtureRepo({
    files: {
      "scripts/loop/implementation-brief.mjs": "export const brief = 1;\n",
      "docs/structural-quality.md": "# Structural quality\n",
      "a/b.mjs": "export const b = 1;\n",
    },
  });
  for (const citation of ["scripts/loop/implementation-brief.mjs", "docs/structural-quality.md", "./docs"]) {
    const brief = await buildImplementationBrief({ body: `${MATRIX}\nUpdate ${citation} next.\n`, repoRoot: root });
    assert.deepEqual(brief.touchedPaths, [citation.replace(/^\.\//u, "")], `${citation} must be claimed`);
  }
  // The host filesystem must not decide the touch set: on a case-insensitive
  // volume `A/b.mjs` resolves to a/b.mjs, on a case-sensitive one it does not.
  const variant = await buildImplementationBrief({ body: `${MATRIX}\nUpdate A/b.mjs next.\n`, repoRoot: root });
  assert.deepEqual(variant.touchedPaths, []);
  const exact = await buildImplementationBrief({ body: `${MATRIX}\nUpdate a/b.mjs next.\n`, repoRoot: root });
  assert.deepEqual(exact.touchedPaths, ["a/b.mjs"]);
});

test("extensionless candidates still require existence and containment, and exclude URL schemes", async () => {
  const root = await fixtureRepo({ files: { https: "Not a citation\n", NOTICE: "Inside\n" } });
  const outside = await fixtureRepo({ files: { LICENSE: "Outside license\n" } });
  await symlink(path.join(outside, "LICENSE"), path.join(root, "LICENSE"));
  const brief = await buildImplementationBrief({
    body: `${MATRIX}\nUpdate ./MISSING and ./LICENSE and ./NOTICE. See https://example.com/LICENSE.\n`,
    repoRoot: root,
  });
  // ./NOTICE resolves inside the root; the escaping symlink and the missing entry stay out.
  assert.deepEqual(brief.touchedPaths, ["NOTICE"]);
  assert.deepEqual(brief.unresolvedPaths, []);
});

test("a URL's path segment is not claimed", async () => {
  const root = await fixtureRepo({ files: { "a/b.mjs": "export const b = 1;\n" } });
  const brief = await buildImplementationBrief({
    body: "See https://example.com/a/b.mjs for details.\n",
    repoRoot: root,
  });
  assert.deepEqual(brief.touchedPaths, []);
});

test("a non-existent path citation is not claimed", async () => {
  const root = await fixtureRepo({ files: { "src/present.mjs": "export const present = 1;\n" } });
  const brief = await buildImplementationBrief({ body: `${MATRIX}\nUpdate src/missing.mjs next.\n`, repoRoot: root });
  assert.deepEqual(brief.touchedPaths, []);
  assert.deepEqual(brief.unresolvedPaths, []);
});

test("a declared path whose real target leaves the repository is refused", async () => {
  const root = await fixtureRepo();
  const outside = await mkdtemp(path.join(os.tmpdir(), "implementation-brief-outside-"));
  tempDirs.push(outside);
  await writeFile(path.join(outside, "escaped.mjs"), "export const escaped = 1;\n");
  await symlink(path.join(outside, "escaped.mjs"), path.join(root, "escaped.mjs"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "inside.mjs"), "export const inside = 1;\n");
  await symlink(path.join(root, "src", "inside.mjs"), path.join(root, "linked.mjs"));

  await assert.rejects(
    () => buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["escaped.mjs"] }),
    (error) => error.exitCode === 1 && /outside --repo-root/u.test(error.message),
  );
  // Wrong case is unresolved with exit 0 on every host, before containment.
  const wrongCase = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["ESCAPED.mjs"] });
  assert.deepEqual(wrongCase.unresolvedPaths, ["ESCAPED.mjs"]);
  const inside = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["linked.mjs"] });
  assert.deepEqual(inside.touchedPaths, ["linked.mjs"]);
  assert.deepEqual(inside.unresolvedPaths, []);
});

test("a body citation written with a ./ prefix still resolves", async () => {
  const root = await fixtureRepo({ files: { "src/dotted.mjs": "export const dotted = 1;\n" } });
  const brief = await buildImplementationBrief({ body: `${MATRIX}\nEdits ./src/dotted.mjs next.\n`, repoRoot: root });
  assert.deepEqual(brief.touchedPaths, ["src/dotted.mjs"]);
});

test("a cited ADR with no record is reported instead of silently dropped", async () => {
  const root = await fixtureRepo({ decisions: { "0010-base.md": record({ title: "0010. Base record" }) } });
  const brief = await buildImplementationBrief({ body: `${MATRIX}\nFollows ADR 0010 and ADR 0081.\n`, repoRoot: root });
  assert.deepEqual(brief.adrs.map(({ number }) => number), ["0010"]);
  assert.deepEqual(brief.findings.map(({ kind, reason }) => [kind, reason]), [
    ["missing_adr_record", "no docs/decisions/0081-*.md record for cited ADR 0081"],
  ]);
});

test("a checkout without docs/decisions reports missing_decision_records", async () => {
  const root = await fixtureRepo({ withDecisions: false });
  const brief = await buildImplementationBrief({ body: `${MATRIX}\nFollows ADR 0081.\n`, repoRoot: root });
  assert.deepEqual(brief.adrs, []);
  assert.deepEqual(brief.findings.map(({ kind }) => kind), ["missing_decision_records"]);
  // The reason must stay root-independent, or two checkouts disagree on the bytes.
  assert.ok(!JSON.stringify(brief).includes(root), "the finding must not echo the checkout root");
});

test("a malformed required-rules.json exits 2", async () => {
  const root = await fixtureRepo({ rules: '{"requiredRules": "not-an-array"}' });
  const bodyFile = await writeBody(root, MATRIX);
  const output = io();
  const result = await run(output, ["--body-file", bodyFile, "--repo-root", root]);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.match(JSON.parse(result.stderr.trim()).error, /Malformed registry/u);
});

test("--jq filters the brief through the shared emitResult seam", async () => {
  const root = await fixtureRepo();
  const bodyFile = await writeBody(root, MATRIX);
  const output = io();
  const result = await run(output, ["--body-file", bodyFile, "--repo-root", root, "--jq", ".requiredReads | length"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "2");
});

test("the same inputs produce byte-identical output across two checkout roots", async () => {
  const tree = {
    decisions: { "0010-base.md": record({ title: "0010. Base record" }) },
    files: { "src/touched.mjs": "export const value = 1;\n", ".devloops": "version: 1\n" },
  };
  tree.files["src/user.mjs"] = 'import { value } from "./touched.mjs";\n';
  const first = await trackedRepo(tree.files, { decisions: tree.decisions });
  const second = await trackedRepo(tree.files, { decisions: tree.decisions });
  const body = `${MATRIX}\nFollows ADR 0010.\n`;
  const argvFor = (root, bodyFile) => ["--body-file", bodyFile, "--repo-root", root, "--paths", "src/touched.mjs"];
  const left = io();
  const right = io();
  assert.equal((await run(left, argvFor(first, await writeBody(first, body)))).code, 0);
  assert.equal((await run(right, argvFor(second, await writeBody(second, body)))).code, 0);
  const output = left.stdout.read();
  assert.equal(output, right.stdout.read());
  // The populated importers and inventory branches are the ones compared.
  assert.deepEqual(JSON.parse(output).importers, { "src/touched.mjs": { files: ["src/user.mjs"] } });
});

// The network modules the brief must never reach.
const NETWORK_MODULES = new Set(["node:dgram", "node:dns", "node:http", "node:http2", "node:https", "node:net", "node:tls"]);
const IMPORT_SPECIFIER_RE = /(?:\bimport\b|\bexport\b)[^"'`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/gsu;

/** Resolve a local workspace-package specifier through the package's own exports
 * map, so a reachable dependency is walked instead of treated as an opaque bare
 * import. */
function workspaceExportTarget(specifier, exportsMap) {
  if (!specifier.startsWith("@dev-loops/core")) return null;
  const key = `.${specifier.slice("@dev-loops/core".length)}`;
  const entry = exportsMap[key];
  const target = typeof entry === "string" ? entry : entry?.import ?? entry?.default;
  if (typeof target !== "string" || !target.startsWith("./")) return null;
  return path.join(repoRoot, "packages", "core", target);
}

/** Every module reachable from `entry` through relative imports and through the
 * local `@dev-loops/core` package exports, plus every import specifier the graph
 * names. */
async function importGraph(entry) {
  const { exports: coreExports } = JSON.parse(await readFile(path.join(repoRoot, "packages", "core", "package.json"), "utf8"));
  const seen = new Set();
  const specifiers = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    // A `import("./types.js")` JSDoc type reference names no runtime module, so
    // an unreadable target is skipped; the positive assertions below keep the
    // walk honest about the modules it must reach.
    const source = await readFile(file, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (source === null) continue;
    for (const match of source.matchAll(IMPORT_SPECIFIER_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      specifiers.add(specifier);
      const target = specifier.startsWith(".")
        ? path.resolve(path.dirname(file), specifier)
        : workspaceExportTarget(specifier, coreExports);
      if (target && /\.m?js$/u.test(target)) queue.push(target);
    }
  }
  return { modules: [...seen].sort(), specifiers: [...specifiers].sort() };
}

test("the brief's import graph reaches no network module, so its offline claim is asserted", async () => {
  const graph = await importGraph(path.join(repoRoot, "scripts", "loop", "implementation-brief.mjs"));
  assert.ok(graph.modules.length > 1, "the walk must follow relative imports");
  assert.ok(
    graph.modules.includes(path.join(repoRoot, "scripts", "lib", "jq-output.mjs")),
    "the walk must reach a transitive relative module",
  );
  // The brief imports @dev-loops/core subpaths, so an un-followed workspace
  // package would leave their transitive imports outside the guard.
  assert.ok(
    graph.modules.includes(path.join(repoRoot, "packages", "core", "src", "loop", "issue-refinement-artifact.mjs")),
    "the walk must reach a package-resolved transitive module",
  );
  assert.deepEqual(graph.specifiers.filter((specifier) => NETWORK_MODULES.has(specifier)), []);
});

test("cli/index.mjs registers and describes the implementation-brief verb", async () => {
  const viaCli = (argv) => {
    const output = io();
    return runCli({ argv, stdout: output.stdout.stream, stderr: output.stderr.stream, cwd: repoRoot })
      .then((code) => ({ code, stdout: output.stdout.read() }));
  };
  const help = await viaCli(["loop", "implementation-brief", "--help"]);
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes("Usage: dev-loops loop implementation-brief"));
  assert.equal((await viaCli(["loop", "implementation-brief"])).code, 1);
  const described = await viaCli(["loop", "--help"]);
  assert.match(described.stdout, /implementation-brief\s+Print the canonical review expectations/u);
});

// The developer agent is the brief's ONE intended consumer (its own test below);
// every other agent definition must stay a non-consumer.
const BRIEF_CONSUMER_AGENTS = new Set(["developer.agent.md"]);
// The brief's own registration surfaces: the CLI route table and the tool itself.
// They are the only shipped modules allowed to name it, and the scan asserts both
// are still covered so a stale allowlist entry cannot hide a renamed route.
const BRIEF_REGISTRATION_MODULES = new Set([
  path.join("cli", "index.mjs"),
  path.join("scripts", "loop", "implementation-brief.mjs"),
]);

async function collectSurface(dir, accept, { recursive = false } = {}) {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const files = entries
    .filter((entry) => entry.isFile() && accept(entry.name))
    .map((entry) => path.join(dir, entry.name));
  if (recursive) {
    for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
      files.push(...(await collectSurface(path.join(dir, entry.name), accept, { recursive })));
    }
  }
  return files.sort();
}

test("no gate, judge or reviewer surface consumes the brief", async () => {
  // Scan every shipped module under scripts/, packages/core/src and cli instead
  // of admitting files by a gate|emit|dispatch|verify|judge|review filename
  // token: a brief import wired into a gate-authority module whose NAME carries
  // none of those tokens (merge-pr.mjs, upsert-checkpoint-verdict.mjs,
  // validate-pr-body-spec.mjs) has to fail this suite too. Only the brief's own
  // registration surfaces are allowlisted, and they must still be covered.
  const scanned = [];
  for (const root of ["scripts", path.join("packages", "core", "src"), "cli"]) {
    scanned.push(...(await collectSurface(path.join(repoRoot, root), (name) => name.endsWith(".mjs"), { recursive: true })));
  }
  for (const relPath of BRIEF_REGISTRATION_MODULES) {
    assert.ok(scanned.includes(path.join(repoRoot, relPath)), `the scan must cover the registration surface ${relPath}`);
  }
  const surfaces = [
    ...scanned.filter((file) => !BRIEF_REGISTRATION_MODULES.has(path.relative(repoRoot, file))),
    ...(await collectSurface(path.join(repoRoot, "agents"), (name) => name.endsWith(".agent.md") && !BRIEF_CONSUMER_AGENTS.has(name))),
  ];
  assert.ok(surfaces.length > 100, `the scan must cover the shipped module surface, found ${surfaces.length}`);
  for (const relPath of [
    "scripts/github/write-gate-context.mjs",
    "scripts/github/upsert-checkpoint-verdict.mjs",
    "scripts/github/merge-pr.mjs",
    "scripts/github/detect-checkpoint-evidence.mjs",
    "scripts/loop/judge-pass.mjs",
    "scripts/loop/emit-judge-work-order.mjs",
    "scripts/loop/resolve-gate-dispatch.mjs",
    "scripts/loop/validate-pr-body-spec.mjs",
    "scripts/loop/check-pre-push-delta.mjs",
    "packages/core/src/loop/gate-fanin.mjs",
    "packages/core/src/loop/review-dispatch-plan.mjs",
    "agents/review.agent.md",
  ]) {
    assert.ok(surfaces.includes(path.join(repoRoot, relPath)), `the scan must cover ${relPath}`);
  }
  // The rule-ownership validator lists agent docs as contract files to parse for
  // rule markers; it is the brief's own import and no gate input.
  const AGENT_DOC_LISTERS = new Set([path.join("scripts", "docs", "validate-rule-ownership.mjs")]);
  for (const file of surfaces) {
    const content = await readFile(file, "utf8");
    assert.ok(!content.includes("implementation-brief"), `${path.relative(repoRoot, file)} must not consume the brief`);
    // The brief's instruction lives in the developer agent doc, so a surface that
    // reads that doc also consumes the brief indirectly.
    if (AGENT_DOC_LISTERS.has(path.relative(repoRoot, file))) continue;
    assert.ok(!content.includes("developer.agent"), `${path.relative(repoRoot, file)} must not read the developer instruction`);
  }
});

test("both the developer agent source and its generated mirror carry the brief instruction", async () => {
  const source = await readFile(path.join(repoRoot, "agents/developer.agent.md"), "utf8");
  const generated = await readFile(path.join(repoRoot, ".claude/agents/developer.md"), "utf8");
  assert.ok(source.includes("node <dev-loops-package-root>/cli/index.mjs loop implementation-brief"));
  assert.ok(generated.includes("dev-loops-run cli/index.mjs loop implementation-brief"));
  assert.ok(!generated.includes("<dev-loops-package-root>"), "the Pi token must not reach the Claude mirror");
  for (const doc of [source, generated]) {
    for (const fragment of ["adrTripwirePaths", "adrNeed", "first commit", "--jq .issue.body", "--jq .pr.body", "helperInventory", "`importers`", "before hand-back"]) {
      assert.ok(doc.includes(fragment), `both agent surfaces must carry ${fragment}`);
    }
  }
});

test("a non-goals section organized under nested headings keeps every item", async () => {
  const root = await fixtureRepo();
  const body = `${MATRIX}\n## Non-goals\n\n### Slice 1\n\n- No reuse map.\n\n### Slice 2\n\n- No gate credit.\n\n## Other\n\n- Not a non-goal.\n`;
  const brief = await buildImplementationBrief({ body, repoRoot: root });
  assert.deepEqual(brief.nonGoals, ["No reuse map.", "No gate credit."]);
});

test("an ADR whose only link is a root-style destination does not claim the root file", async () => {
  const root = await fixtureRepo({
    decisions: { "0010-root-style.md": record({ title: "0010. Root style", body: "See [file](src/a.mjs)." }) },
    files: { "src/a.mjs": "// A\n" },
  });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs"] });
  assert.deepEqual(brief.adrs, []);
});

test("a registered rule ID with one-character segments is cited from the spec and a touched file", async () => {
  const id = "LOCAL-PHASE-ONE-AT-A-TIME";
  const root = await fixtureRepo({
    rules: { requiredRules: [{ id }], optOutRules: [] },
    files: { "scripts/loop/consumer.mjs": `// Implements ${id}.\n` },
  });
  const fromSpec = await buildImplementationBrief({ body: `Cites ${id}.`, repoRoot: root });
  assert.deepEqual(fromSpec.rules.map((r) => r.id), [id]);
  const fromFile = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["scripts/loop/consumer.mjs"] });
  assert.deepEqual(fromFile.rules.map((r) => r.id), [id]);
});

test("a checkbox non-goal yields the same item as the canonical spec reader", async () => {
  const root = await fixtureRepo();
  const body = `${MATRIX}\n## Non-goals\n\n- [ ] No gate credit.\n`;
  const brief = await buildImplementationBrief({ body, repoRoot: root });
  assert.deepEqual(brief.nonGoals, ["No gate credit."]);
});

async function trackedRepo(files, options = {}) {
  const root = await fixtureRepo({ ...options, files });
  runGitFixture(root, ["add", "-A"]);
  return root;
}

test("the helper inventory lists sorted exported names per module in touched dirs and scripts/lib", async () => {
  const root = await trackedRepo({
    "src/a.mjs": "export function zeta() {}\nexport const alpha = 1;\nconst x = 1;\nexport { x as mid };\n",
    "src/notes.md": "export const ignored = 1;\n",
    "scripts/lib/util.mjs": "export class Util {}\n",
    "src/t.ts": "export interface Options {}\nexport type Id = string;\nexport enum Mode { A }\nexport abstract class Base {}\nexport { type Opts };\n// export interface Commented {}\nexport type { Hidden } from \"./h.mjs\";\nexportinterface Glued {}\n",
  });
  const { helperInventory } = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs"] });
  assert.deepEqual(helperInventory, {
    modules: [
      { path: "scripts/lib/util.mjs", exports: ["Util"] },
      { path: "src/a.mjs", exports: ["alpha", "mid", "zeta"] },
      { path: "src/t.ts", exports: ["Base", "Hidden", "Id", "Mode", "Options", "Opts"] },
    ],
    overflowModules: [],
  });
});

test("inline inventory names stop at 2,000 characters and the overflow lists module paths only", async () => {
  const names = (prefix) => Array.from({ length: 60 }, (_, i) => `export const ${prefix}${String(i).padStart(3, "0")}_${"x".repeat(12)} = 1;`).join("\n");
  const root = await trackedRepo({ "src/a.mjs": names("a"), "src/b.mjs": names("b"), "src/c.mjs": names("c"), "src/d.mjs": "export const z = 1;\n" });
  const { helperInventory } = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src"] });
  // Each module joins to 1,079 characters, so a second module would reach 2,159.
  assert.deepEqual(helperInventory.modules.map((m) => m.path), ["src/a.mjs"]);
  assert.deepEqual(helperInventory.overflowModules, ["src/b.mjs", "src/c.mjs", "src/d.mjs"]);
});

test("inline inventory names that join to exactly 2,000 characters stay inline", async () => {
  // 69 names of 28 characters joined by 68 commas: 69 * 28 + 68 = 2,000.
  const exact = Array.from({ length: 69 }, (_, i) => `export const n${String(i).padStart(2, "0")}${"x".repeat(25)} = 1;`).join("\n");
  const root = await trackedRepo({ "src/a.mjs": exact, "src/b.mjs": "export const z = 1;\n" });
  const { helperInventory } = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src"] });
  assert.equal(helperInventory.modules.flatMap((m) => m.exports).join(",").length, 2000);
  assert.deepEqual(helperInventory.modules.map((m) => m.path), ["src/a.mjs"]);
  // One more name would make 2,002 characters, so it moves to the overflow.
  assert.deepEqual(helperInventory.overflowModules, ["src/b.mjs"]);
});

test("importers lists the sorted tracked files that import a touched module, and an empty list when none", async () => {
  const root = await trackedRepo({
    "src/a.mjs": "export const a = 1;\n",
    "src/lonely.mjs": "export const l = 1;\n",
    "src/z-user.mjs": 'import { a } from "./a.mjs";\n',
    "lib/b-user.mjs": 'export { a } from "../src/a.mjs";\nconst m = await import("../src/a.mjs");\n',
    "lib/other.mjs": 'import x from "../src/lonely-not.mjs";\n',
  });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs", "src/lonely.mjs"] });
  assert.deepEqual(brief.importers, {
    "src/a.mjs": { files: ["lib/b-user.mjs", "src/z-user.mjs"] },
    "src/lonely.mjs": { files: [] },
  });
});

test("importers match extensionless, directory-index and .js-for-.ts relative specifiers, and reject near misses", async () => {
  const root = await trackedRepo({
    "src/a.cjs": "module.exports = 1;\n",
    "src/lib/index.js": "export const l = 1;\n",
    "src/c.ts": "export const c = 1;\n",
    "src/t/a.ts": "export const t = 1;\n",
    "src/exact.cjs": 'require("./a.cjs");\n',
    "src/b.cjs": 'require("./a");\nrequire("./lib");\n',
    "src/c-user.ts": 'import { c } from "./c.js";\n',
    "src/t/user.ts": 'import { t } from "./a";\n',
    "src/near.cjs": 'require("./ab");\nrequire("./a.cjs.bak");\nrequire("a");\nrequire("./a/b");\n',
  });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.cjs", "src/lib/index.js", "src/c.ts", "src/t/a.ts"] });
  assert.deepEqual(brief.importers, {
    "src/a.cjs": { files: ["src/b.cjs", "src/exact.cjs"] },
    "src/lib/index.js": { files: ["src/b.cjs"] },
    "src/c.ts": { files: ["src/c-user.ts"] },
    "src/t/a.ts": { files: ["src/t/user.ts"] },
  });
});

test("importers ignore import text inside comments, strings and templates", async () => {
  const root = await trackedRepo({
    "src/a.mjs": "export const a = 1;\n",
    "src/e1.mjs": "const example = 'import { a } from \"./a.mjs\";';\n",
    "src/e2.mjs": "// import { a } from \"./a.mjs\";\n/* require(\"./a.mjs\") */\n",
    "src/e3.mjs": "const t = `import(\"./a.mjs\")`;\n",
    "src/z-real.mjs": "import { a } from \"./a.mjs\";\n",
  });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs"] });
  assert.deepEqual(brief.importers, { "src/a.mjs": { files: ["src/z-real.mjs"] } });
});

test("a JavaScript importer of ./a.js does not count as a caller of a.ts, a TypeScript importer does", async () => {
  const root = await trackedRepo({
    "src/a.js": "export const a = 1;\n",
    "src/a.ts": "export const a = 1;\n",
    "src/js-user.mjs": "import { a } from \"./a.js\";\n",
    "src/ts-user.ts": "import { a } from \"./a.js\";\n",
  });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.ts"] });
  assert.deepEqual(brief.importers, { "src/a.ts": { files: ["src/ts-user.ts"] } });
});

test("a filesystem error on a tracked entry is a runtime error, not an importers_unavailable finding", { skip: SKIP_UNDER_ROOT }, async () => {
  const root = await trackedRepo({ "src/a.mjs": "export const a = 1;\n", "locked/x.mjs": "export const x = 1;\n" });
  await chmod(path.join(root, "locked"), 0o000);
  try {
    await assert.rejects(buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs"] }), (error) => error.code === "EACCES");
  } finally {
    await chmod(path.join(root, "locked"), 0o755);
  }
});

test("a git ls-files failure yields null importers and an importers_unavailable finding", async () => {
  const root = await fixtureRepo({ files: { "src/a.mjs": "export const a = 1;\n" }, git: false });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs"] });
  assert.equal(brief.importers, null);
  assert.deepEqual(brief.helperInventory, { modules: [], overflowModules: [] });
  assert.ok(brief.findings.some((f) => f.kind === "importers_unavailable" && f.reason));
});

test("a non-git --repo-root nested inside a work tree is not read through the enclosing repository", async () => {
  const parent = await trackedRepo({ "README.md": "Parent.\n" });
  const nested = path.join(parent, "nested");
  await mkdir(path.join(nested, "src"), { recursive: true });
  await writeFile(path.join(nested, "src", "a.mjs"), "export const a = 1;\n");
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: nested, paths: ["src/a.mjs"] });
  assert.equal(brief.importers, null);
  assert.ok(brief.findings.some((f) => f.kind === "importers_unavailable"));
});

test("the inventory and importers skip tracked directory symlinks and symlinks leaving the root", async () => {
  const root = await fixtureRepo({ files: { "src/a.mjs": "export const a = 1;\n", "src/real/keep.mjs": "export const k = 1;\n" } });
  const outside = await mkdtemp(path.join(os.tmpdir(), "implementation-brief-outside-"));
  tempDirs.push(outside);
  await writeFile(path.join(outside, "x.mjs"), 'export const leaked = 1;\nimport "../src/a.mjs";\n');
  await symlink(path.join(root, "src", "real"), path.join(root, "src", "dir.mjs"));
  await symlink(path.join(root, "src", "real"), path.join(root, "src", "dirlink.js"));
  await symlink(path.join(outside, "x.mjs"), path.join(root, "src", "link.mjs"));
  runGitFixture(root, ["add", "-A"]);
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs"] });
  assert.deepEqual(brief.helperInventory.modules.map((m) => m.path), ["src/a.mjs"]);
  assert.deepEqual(brief.importers, { "src/a.mjs": { files: [] } });
});

test("a tracked entry beneath a directory symlink leaving the root, a non-source entry and a missing entry are skipped", async () => {
  const root = await trackedRepo({ "src/a.mjs": "export const a = 1;\n", "vendor/x.mjs": "export const v = 1;\n", "src/gone.mjs": "export const g = 1;\n", "src/d.mjs/inner.txt": "x\n" });
  const outside = await mkdtemp(path.join(os.tmpdir(), "implementation-brief-outside-"));
  tempDirs.push(outside);
  await writeFile(path.join(outside, "x.mjs"), 'export const leaked = 1;\nimport "../src/a.mjs";\n');
  await rm(path.join(root, "vendor"), { recursive: true });
  await symlink(outside, path.join(root, "vendor"));
  await rm(path.join(root, "src", "gone.mjs"));
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs"] });
  assert.deepEqual(brief.helperInventory.modules.map((m) => m.path), ["src/a.mjs"]);
  assert.deepEqual(brief.importers, { "src/a.mjs": { files: [] } });
});

test("a tracked file symlink resolving to a file inside the root stays listed", async () => {
  const root = await trackedRepo({ "src/a.mjs": "export const a = 1;\n", "src/real.mjs": "export const r = 1;\n" });
  await symlink(path.join(root, "src", "real.mjs"), path.join(root, "src", "alias.mjs"));
  runGitFixture(root, ["add", "-A"]);
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs"] });
  assert.deepEqual(brief.helperInventory.modules.map((m) => m.path), ["src/a.mjs", "src/alias.mjs", "src/real.mjs"]);
});

test("the inventory omits untracked and ignored source files", async () => {
  const root = await trackedRepo({ "src/a.mjs": "export const a = 1;\n", ".gitignore": "src/ignored.mjs\n" });
  await writeFile(path.join(root, "src", "scratch.mjs"), "export const scratch = 1;\n");
  await writeFile(path.join(root, "src", "ignored.mjs"), "export const ignored = 1;\n");
  const { helperInventory } = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs"] });
  assert.deepEqual(helperInventory.modules.map((m) => m.path), ["src/a.mjs"]);
});

test("a wrong-case parent of an unresolved declared path adds no inventory module", async () => {
  const root = await trackedRepo({ "src/a.mjs": "export const a = 1;\n" });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["SRC/new.mjs"] });
  assert.deepEqual(brief.unresolvedPaths, ["SRC/new.mjs"]);
  assert.deepEqual(brief.helperInventory, { modules: [], overflowModules: [] });
});

test("a directory symlink leaving the root adds no inventory module for an unresolved path beneath it", async () => {
  const root = await trackedRepo({ "src/a.mjs": "export const a = 1;\n" });
  const outside = await mkdtemp(path.join(os.tmpdir(), "implementation-brief-outside-"));
  tempDirs.push(outside);
  await writeFile(path.join(outside, "x.mjs"), "export const leaked = 1;\n");
  await symlink(outside, path.join(root, "ext"));
  runGitFixture(root, ["add", "-A"]);
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["ext/new.mjs"] });
  assert.deepEqual(brief.unresolvedPaths, ["ext/new.mjs"]);
  assert.deepEqual(brief.helperInventory, { modules: [], overflowModules: [] });
});

test("an unresolved declared source path has no importers entry", async () => {
  const root = await trackedRepo({ "src/a.mjs": "export const a = 1;\n" });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs", "src/new-helper.mjs"] });
  assert.deepEqual(brief.touchedPaths, ["src/a.mjs", "src/new-helper.mjs"]);
  assert.deepEqual(brief.unresolvedPaths, ["src/new-helper.mjs"]);
  assert.deepEqual(Object.keys(brief.importers), ["src/a.mjs"]);
});

test("export lists drop comments, a type prefix and non-identifier items", async () => {
  const root = await trackedRepo({
    "src/a.mjs": "export {\n  one, // note, fake\n  /* block, hidden */ two,\n  type Three,\n  four as Four,\n};\n",
  });
  const { helperInventory } = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs"] });
  assert.deepEqual(helperInventory.modules.find((m) => m.path === "src/a.mjs").exports, ["Four", "Three", "one", "two"]);
});

test("a non-source touched path has no importers entry", async () => {
  const root = await trackedRepo({ "docs/readme.md": "Text.\n" });
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["docs/readme.md"] });
  assert.deepEqual(brief.importers, {});
});

test("more than 50 importers are capped and flagged importersTruncated", async () => {
  const files = { "src/a.mjs": "export const a = 1;\n" };
  for (let i = 0; i < 55; i += 1) files[`use/u${String(i).padStart(2, "0")}.mjs`] = 'import { a } from "../src/a.mjs";\n';
  const root = await trackedRepo(files);
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs"] });
  const entry = brief.importers["src/a.mjs"];
  assert.equal(entry.files.length, 50);
  assert.equal(entry.importersTruncated, true);
  assert.deepEqual(entry.files, [...entry.files].sort());
});

test("exactly 50 importers are listed without importersTruncated", async () => {
  const files = { "src/a.mjs": "export const a = 1;\n" };
  for (let i = 0; i < 50; i += 1) files[`use/u${String(i).padStart(2, "0")}.mjs`] = 'import { a } from "../src/a.mjs";\n';
  const root = await trackedRepo(files);
  const brief = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["src/a.mjs"] });
  const entry = brief.importers["src/a.mjs"];
  assert.equal(entry.files.length, 50);
  assert.equal("importersTruncated" in entry, false);
});
