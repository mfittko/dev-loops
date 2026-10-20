import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "bun:test";

import { detectAcDodMatrix } from "@dev-loops/core/loop/issue-refinement-artifact";
import { runCli } from "../../cli/index.mjs";
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

async function fixtureRepo({ rules, decisions = {}, files = {} } = {}) {
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
  if (Object.keys(decisions).length > 0) {
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
  await expectPathRefusal(await fixtureRepo(), "src/../etc/passwd");
});

test("--help documents the flags, the output shape and the exit codes", async () => {
  const output = io();
  assert.equal((await run(output, ["--help"])).code, 0);
  const usage = output.stdout.read();
  for (const fragment of ["--body-file", "--paths", "--repo-root", "--jq", "Exit codes", "adrTripwirePaths", "requiredReads"]) {
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

test("a root-level existing citation is claimed", async () => {
  const root = await fixtureRepo({ files: { "AGENTS.md": "# Agents\n" } });
  const brief = await buildImplementationBrief({ body: `${MATRIX}\nUpdate AGENTS.md next.\n`, repoRoot: root });
  assert.deepEqual(brief.touchedPaths, ["AGENTS.md"]);
});

test("an existing extensionless root citation is claimed, including ./ and sentence punctuation", async () => {
  const root = await fixtureRepo({ files: { LICENSE: "License text\n" } });
  for (const citation of ["LICENSE", "./LICENSE"]) {
    const brief = await buildImplementationBrief({ body: `${MATRIX}\nUpdate ${citation}.\n`, repoRoot: root });
    assert.deepEqual(brief.touchedPaths, ["LICENSE"]);
  }
});

test("extensionless candidates still require existence and containment, and exclude URL schemes", async () => {
  const root = await fixtureRepo({ files: { https: "Not a citation\n" } });
  const outside = await fixtureRepo({ files: { LICENSE: "Outside license\n" } });
  await symlink(path.join(outside, "LICENSE"), path.join(root, "LICENSE"));
  const brief = await buildImplementationBrief({
    body: `${MATRIX}\nUpdate MISSING and LICENSE. See https://example.com/LICENSE.\n`,
    repoRoot: root,
  });
  assert.deepEqual(brief.touchedPaths, []);
  assert.deepEqual(brief.unresolvedPaths, []);
});

test("a URL's path segment is not claimed", async () => {
  const root = await fixtureRepo({ files: { "a/b.mjs": "export const b = 1;\n" } });
  const brief = await buildImplementationBrief({
    // Avoid MATRIX's standalone "A", which names the fixture's a/ directory
    // on case-insensitive filesystems once extensionless citations are allowed.
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
  const inside = await buildImplementationBrief({ body: MATRIX, repoRoot: root, paths: ["linked.mjs"] });
  assert.deepEqual(inside.touchedPaths, ["linked.mjs"]);
  assert.deepEqual(inside.unresolvedPaths, []);
});

test("a body citation written with a ./ prefix still resolves", async () => {
  const root = await fixtureRepo({ files: { "src/dotted.mjs": "export const dotted = 1;\n" } });
  const brief = await buildImplementationBrief({ body: `${MATRIX}\nEdits ./src/dotted.mjs next.\n`, repoRoot: root });
  assert.deepEqual(brief.touchedPaths, ["src/dotted.mjs"]);
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
  const first = await fixtureRepo(tree);
  const second = await fixtureRepo(tree);
  const body = `${MATRIX}\nFollows ADR 0010.\n`;
  const argvFor = (root, bodyFile) => ["--body-file", bodyFile, "--repo-root", root, "--paths", "src/touched.mjs"];
  const left = io();
  const right = io();
  assert.equal((await run(left, argvFor(first, await writeBody(first, body)))).code, 0);
  assert.equal((await run(right, argvFor(second, await writeBody(second, body)))).code, 0);
  assert.equal(left.stdout.read(), right.stdout.read());
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

const GATE_JUDGE_REVIEW_MODULE_RE = /(?:gate|emit|dispatch|verify|judge|review)/iu;
// The developer agent is the brief's ONE intended consumer (its own test below);
// every other agent definition must stay a non-consumer.
const BRIEF_CONSUMER_AGENTS = new Set(["developer.agent.md"]);

async function collectSurface(dir, accept) {
  const entries = await readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile() && accept(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

test("no gate, judge or reviewer surface consumes the brief", async () => {
  // Scan the whole gate/judge/reviewer surface instead of a hand-picked list, so
  // a brief import wired into any OTHER gate, emit, verify or judge module fails
  // this suite too.
  const surfaces = [
    ...(await collectSurface(path.join(repoRoot, "scripts", "github"), (name) => name.endsWith(".mjs") && GATE_JUDGE_REVIEW_MODULE_RE.test(name))),
    ...(await collectSurface(path.join(repoRoot, "scripts", "loop"), (name) => name.endsWith(".mjs") && GATE_JUDGE_REVIEW_MODULE_RE.test(name))),
    ...(await collectSurface(path.join(repoRoot, "agents"), (name) => name.endsWith(".agent.md") && !BRIEF_CONSUMER_AGENTS.has(name))),
  ];
  assert.ok(surfaces.length > 0, "the scan must find the gate/judge/reviewer surface");
  for (const relPath of [
    "scripts/github/write-gate-context.mjs",
    "scripts/loop/judge-pass.mjs",
    "scripts/loop/emit-judge-work-order.mjs",
    "scripts/loop/resolve-gate-dispatch.mjs",
    "agents/review.agent.md",
  ]) {
    assert.ok(surfaces.includes(path.join(repoRoot, relPath)), `the scan must cover ${relPath}`);
  }
  for (const file of surfaces) {
    const content = await readFile(file, "utf8");
    assert.ok(!content.includes("implementation-brief"), `${path.relative(repoRoot, file)} must not consume the brief`);
  }
});

test("both the developer agent source and its generated mirror carry the brief instruction", async () => {
  const source = await readFile(path.join(repoRoot, "agents/developer.agent.md"), "utf8");
  const generated = await readFile(path.join(repoRoot, ".claude/agents/developer.md"), "utf8");
  assert.ok(source.includes("node <dev-loops-package-root>/cli/index.mjs loop implementation-brief"));
  assert.ok(generated.includes("dev-loops-run cli/index.mjs loop implementation-brief"));
  assert.ok(!generated.includes("<dev-loops-package-root>"), "the Pi token must not reach the Claude mirror");
  for (const doc of [source, generated]) {
    for (const fragment of ["adrTripwirePaths", "adrNeed", "first commit"]) {
      assert.ok(doc.includes(fragment), `both agent surfaces must carry ${fragment}`);
    }
  }
});
