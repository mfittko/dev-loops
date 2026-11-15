import assert from "node:assert/strict";
import { test } from "node:test";

import { ALLOW_MARKER, allowlistReason, parseAddedLines, scanDiffText } from "../src/security/secret-scan.mjs";

// Fixture credentials are assembled from fragments at runtime so this file's
// own committed diff carries no whole credential for the scanner to flag.
function join(...parts) {
  return parts.join("");
}

// A unified diff that adds `lines` to a new file `file`.
function addedDiff(file, lines) {
  return [
    `diff --git a/${file} b/${file}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// allowlistReason
// ---------------------------------------------------------------------------

test("allowlistReason: no marker on the line returns null", () => {
  assert.equal(allowlistReason('const x = "plain value";'), null);
});

test(`allowlistReason: a ${ALLOW_MARKER} marker plus a reason is captured verbatim`, () => {
  assert.equal(
    allowlistReason(`const x = "y"; # ${ALLOW_MARKER} test fixture, not a real credential`),
    "test fixture, not a real credential",
  );
});

test("allowlistReason: a bare marker with no reason returns null", () => {
  assert.equal(allowlistReason(`const x = "y"; // ${ALLOW_MARKER}`), null);
});

// ---------------------------------------------------------------------------
// AC2: literal-credential parity through secretlint
// ---------------------------------------------------------------------------

const PEM_BLOCK = [
  join("-----BEGIN RSA ", "PRIVATE KEY-----"),
  ..."MIIEow".padEnd(192, "Ab3d").match(/.{1,64}/gu),
  join("-----END RSA ", "PRIVATE KEY-----"),
];

const CREDENTIAL_FIXTURES = [
  { kind: "GitHub classic PAT", ruleId: "@secretlint/secretlint-rule-github", lines: [`const t = "${join("ghp_", "A".repeat(34), "b1")}";`] },
  { kind: "GitHub fine-grained PAT", ruleId: "@secretlint/secretlint-rule-github", lines: [`const t = "${join("github_pat_", "A".repeat(22), "_", "B".repeat(59))}";`] },
  { kind: "GitHub OAuth token", ruleId: "@secretlint/secretlint-rule-github", lines: [`const t = "${join("gho_", "A".repeat(34), "b1")}";`] },
  { kind: "GitHub user-to-server token", ruleId: "@secretlint/secretlint-rule-github", lines: [`const t = "${join("ghu_", "A".repeat(34), "b1")}";`] },
  { kind: "GitHub server-to-server token", ruleId: "@secretlint/secretlint-rule-github", lines: [`const t = "${join("ghs_", "A".repeat(34), "b1")}";`] },
  { kind: "GitHub refresh token", ruleId: "@secretlint/secretlint-rule-github", lines: [`const t = "${join("ghr_", "A".repeat(34), "b1")}";`] },
  { kind: "Slack token", ruleId: "@secretlint/secretlint-rule-slack", lines: [`SLACK=${join("xoxb-", "1234567890-1234567890-", "abcdefghijABCDEFGHIJabcd")}`] },
  { kind: "AWS access key id (enableIDScanRule)", ruleId: "@secretlint/secretlint-rule-aws", lines: [`aws_access_key_id = ${join("AKIA", "Q3EGRZ7XYTQ2WBNM")}`] },
  { kind: "PEM private key", ruleId: "@secretlint/secretlint-rule-privatekey", lines: PEM_BLOCK },
];

for (const { kind, ruleId, lines } of CREDENTIAL_FIXTURES) {
  test(`AC2: a ${kind} produces a value-free finding`, async () => {
    const result = await scanDiffText(addedDiff("config.txt", ["clean first line", ...lines]));
    assert.equal(result.ok, false);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(Object.keys(result.findings[0]).sort(), ["file", "line", "reason", "ruleId"]);
    assert.equal(result.findings[0].file, "config.txt");
    assert.equal(result.findings[0].line, 2);
    assert.equal(result.findings[0].ruleId, ruleId);
    // AC4: no finding field carries the fixture value.
    const serialized = JSON.stringify(result);
    for (const line of lines) {
      for (const token of line.split(/[\s"=;]+/u).filter((t) => t.length >= 16)) {
        assert.ok(!serialized.includes(token), `finding must not carry ${kind} value`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// AC3: recorded false positives produce no finding
// ---------------------------------------------------------------------------

const FALSE_POSITIVE_FIXTURES = [
  { source: "issue 3167 public Actions run URL", line: "See https://github.com/mfittko/dev-loops/actions/runs/19234567890/job/54987654321 for the run." },
  { source: "PR 1923 long ADR file-name link target", line: "See [ADR 0048](./0048-gate-full-dispatches-grouped-two-knob-dispatch-bounds.md)." },
  { source: "PR 2439 test fixture path", line: 'const fixture = ".venv/lib/python3.12/site-packages/m.py";' },
  { source: "PR 2789 public JavaScript property access", line: "assert.equal(process.env.GIT_CONFIG_KEY_0, gitConfigConstants.coreFsyncKeyName);" },
  { source: "issue 3145 Kubernetes Secret object name", line: "  secretName: my-app-database-credentials-secret" },
  { source: "comparison apiKey > 5", line: "if (apiKey > 5) return;" },
];

for (const { source, line } of FALSE_POSITIVE_FIXTURES) {
  test(`AC3: ${source} produces no finding`, async () => {
    assert.deepEqual(await scanDiffText(addedDiff("docs/x.md", [line])), { ok: true, findings: [] });
  });
}

// ---------------------------------------------------------------------------
// AC4: allow marker
// ---------------------------------------------------------------------------

const MARKER_TOKEN = join("ghp_", "C".repeat(34), "d2");

test("AC4: a same-line allow marker with a reason exempts the line", async () => {
  const diff = addedDiff("a.mjs", [`const t = "${MARKER_TOKEN}"; // ${ALLOW_MARKER} public test fixture`]);
  assert.deepEqual(await scanDiffText(diff), { ok: true, findings: [] });
});

test("AC4: an allow marker without a reason exempts nothing", async () => {
  const result = await scanDiffText(addedDiff("a.mjs", [`const t = "${MARKER_TOKEN}"; // ${ALLOW_MARKER}`]));
  assert.equal(result.ok, false);
  assert.equal(result.findings.length, 1);
  assert.ok(!JSON.stringify(result).includes(MARKER_TOKEN));
});

test("AC4: a secretlint-disable comment exempts nothing (the allow marker is the only exemption)", async () => {
  const result = await scanDiffText(addedDiff("a.sh", ["# secretlint-disable", `T="${MARKER_TOKEN}"`]));
  assert.deepEqual(result.findings.map((f) => f.line), [2]);
});

test("AC4: a marker on another line exempts nothing", async () => {
  const result = await scanDiffText(addedDiff("a.mjs", [`// ${ALLOW_MARKER} public test fixture`, `const t = "${MARKER_TOKEN}";`]));
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].line, 2);
});

// ---------------------------------------------------------------------------
// parseAddedLines / scanDiffText — diff-level integration
// ---------------------------------------------------------------------------

test("parseAddedLines: tracks new-file line numbers, skips removed lines, advances on context lines", () => {
  const diff = [
    "diff --git a/f.txt b/f.txt",
    "index 0000000..1111111 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,3 +1,4 @@",
    " context one",
    "-removed line",
    "+added line one",
    "+added line two",
    " context two",
  ].join("\n");
  assert.deepEqual(parseAddedLines(diff), [
    { file: "f.txt", line: 2, text: "added line one" },
    { file: "f.txt", line: 3, text: "added line two" },
  ]);
});

test("parseAddedLines: a binary-file diff (no hunk) yields no entries", () => {
  const diff = ["diff --git a/f.bin b/f.bin", "Binary files a/f.bin and b/f.bin differ"].join("\n");
  assert.deepEqual(parseAddedLines(diff), []);
});

test("parseAddedLines: an added line whose CONTENT starts with '++ ' is content, not a file header", async () => {
  const diff = [
    "diff --git a/config.sh b/config.sh",
    "index 0000000..1111111 100644",
    "--- a/config.sh",
    "+++ b/config.sh",
    "@@ -0,0 +1,1 @@",
    `+++ export TOKEN="${MARKER_TOKEN}"`,
  ].join("\n");
  assert.deepEqual(parseAddedLines(diff), [{ file: "config.sh", line: 1, text: `++ export TOKEN="${MARKER_TOKEN}"` }]);
  const result = await scanDiffText(diff);
  assert.deepEqual(result.findings.map((f) => [f.file, f.line]), [["config.sh", 1]]);
});

test("scanDiffText: hits in two files keep their own file and line", async () => {
  const diff = [addedDiff("one.sh", ["clean", `T="${MARKER_TOKEN}"`]), addedDiff("two.sh", [`T="${MARKER_TOKEN}"`])].join("\n");
  const result = await scanDiffText(diff);
  assert.deepEqual(result.findings.map((f) => [f.file, f.line]), [["one.sh", 2], ["two.sh", 1]]);
});

test("scanDiffText: a clean diff (no findings) reports ok: true", async () => {
  assert.deepEqual(await scanDiffText(addedDiff("README.md", ["# Hello, world"])), { ok: true, findings: [] });
});

// secretlint breaks lines on a lone CR, U+2028 and U+2029; the diff splits on LF only.
for (const [name, separator] of [["a lone CR", "\r"], ["U+2028", String.fromCharCode(0x2028)], ["U+2029", String.fromCharCode(0x2029)]]) {
  test(`scanDiffText: ${name} inside an added line keeps the hit on the credential line`, async () => {
    const result = await scanDiffText(addedDiff("a.mjs", [`a${separator}b`, `const t = "${MARKER_TOKEN}";`]));
    assert.deepEqual(result.findings.map((f) => [f.file, f.line]), [["a.mjs", 2]]);
  });

  test(`scanDiffText: ${name} before a credential does not let a marker on the next line drop it`, async () => {
    const result = await scanDiffText(addedDiff("a.mjs", [`a${separator}b`, `const t = "${MARKER_TOKEN}";`, `// ${ALLOW_MARKER} public test fixture`]));
    assert.deepEqual(result.findings.map((f) => [f.file, f.line]), [["a.mjs", 2]]);
  });

  test(`scanDiffText: ${name} before an allow-marked credential line still honours the marker`, async () => {
    const result = await scanDiffText(addedDiff("a.mjs", [`a${separator}b`, `const t = "${MARKER_TOKEN}"; // ${ALLOW_MARKER} public test fixture`]));
    assert.deepEqual(result, { ok: true, findings: [] });
  });
}

// ---------------------------------------------------------------------------
// Multi-line (PEM) matches span context and added lines
// ---------------------------------------------------------------------------

// A diff that replaces the PEM body between unchanged BEGIN/END delimiters.
function replacedBodyDiff(headerSuffix = "") {
  const [begin, ...rest] = PEM_BLOCK;
  const end = rest.pop();
  return [
    "diff --git a/k.pem b/k.pem",
    "--- a/k.pem",
    "+++ b/k.pem",
    `@@ -1,3 +1,${rest.length + 2} @@`,
    ` ${begin}${headerSuffix}`,
    "-old",
    ...rest.map((line) => `+${line}`),
    ` ${end}`,
  ].join("\n");
}

test("a replaced PEM body between unchanged delimiters is reported", async () => {
  const result = await scanDiffText(replacedBodyDiff());
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].ruleId, "@secretlint/secretlint-rule-privatekey");
  assert.equal(result.findings[0].line, 2);
});

test("an allow marker on the PEM header alone does not suppress unmarked added payload lines", async () => {
  const lines = [...PEM_BLOCK];
  lines[0] = `# ${ALLOW_MARKER} header only ${lines[0]}`;
  const result = await scanDiffText(addedDiff("k.pem", lines));
  assert.equal(result.ok, false);
  assert.equal(result.findings[0].line, 2);
});

test("a PEM block with a marker on every added line is exempt", async () => {
  const lines = PEM_BLOCK.map((line) => `${line} # ${ALLOW_MARKER} public fixture`);
  assert.equal((await scanDiffText(addedDiff("k.pem", lines))).ok, true);
});
