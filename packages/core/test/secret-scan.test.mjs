import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOW_MARKER,
  DETECTOR_CLASSES,
  allowlistReason,
  parseAddedLines,
  scanDiffText,
  scanLineText,
  shannonEntropy,
} from "../src/security/secret-scan.mjs";

// Fixture literals below are assembled from split fragments at RUNTIME rather
// than written as a single contiguous token in this file's SOURCE — this
// module's own scanner runs as a pre-commit hook over every worktree in this
// repo (including the one this test file itself is committed through), so a
// literal fixture secret written whole would trip that live hook on its own
// commit. Splitting keeps the fixture a genuine, full-strength trigger at
// scan time while leaving no matching substring in the committed diff.
function join(...parts) {
  return parts.join("");
}

// ---------------------------------------------------------------------------
// shannonEntropy
// ---------------------------------------------------------------------------

test("shannonEntropy: empty string is zero entropy", () => {
  assert.equal(shannonEntropy(""), 0);
});

test("shannonEntropy: a single repeated character is zero entropy", () => {
  assert.equal(shannonEntropy("aaaaaaaaaa"), 0);
});

test("shannonEntropy: a mixed-alphabet random-looking run scores higher than a plain word of the same length", () => {
  const randomLooking = join("kZ9mQ2", "vL7pR4", "wT8nJ1", "zY6cF3");
  const plainWord = "thisisaplainenglishword";
  assert.ok(shannonEntropy(randomLooking) > shannonEntropy(plainWord));
});

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

test("allowlistReason: the marker works under any comment syntax — it is a plain substring test", () => {
  assert.equal(allowlistReason(`<!-- ${ALLOW_MARKER} html comment reason -->`), "html comment reason -->");
});

// ---------------------------------------------------------------------------
// Detector 1 — literal credential formats (provider prefixes + PEM headers)
// ---------------------------------------------------------------------------

test("detector 1 (literal-credential): a full-length GitHub classic PAT blocks", () => {
  const token = join("ghp_", "A".repeat(20), "b1");
  const findings = scanLineText(`const t = "${token}";`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].detectorClass, DETECTOR_CLASSES.LITERAL_CREDENTIAL);
  assert.match(findings[0].reason, /github-pat-classic/);
  // The finding must never carry the matched value.
  assert.ok(!JSON.stringify(findings).includes(token));
});

test("detector 1 (literal-credential): an AWS access key id blocks", () => {
  const key = join("AKIA", "ABCDEFGHIJKLMNOP");
  const findings = scanLineText(`aws_access_key_id = ${key}`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].detectorClass, DETECTOR_CLASSES.LITERAL_CREDENTIAL);
});

test("detector 1 (literal-credential): a PEM private-key header blocks", () => {
  const header = join("-----BEGIN ", "RSA PRIVATE KEY", "-----");
  const findings = scanLineText(header);
  assert.equal(findings.length, 1);
  assert.match(findings[0].reason, /pem-private-key/);
});

test("detector 1 (literal-credential): a value stored base64-encoded still decodes and blocks", () => {
  const credentialValue = join("ghp_", "A".repeat(20), "b1");
  const encoded = Buffer.from(credentialValue, "utf8").toString("base64");
  const findings = scanLineText(`const t = "${encoded}";`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].detectorClass, DETECTOR_CLASSES.LITERAL_CREDENTIAL);
  assert.ok(!JSON.stringify(findings).includes(credentialValue), "never the decoded value either");
});

// One positive fixture per remaining literal-credential provider prefix
// (github_pat fine-grained, gho_/ghu_/ghs_/ghr_, slack xox-) — previously
// only ghp_/AKIA/PEM were individually asserted, so a regex typo in any of
// these could ship silently.
const LITERAL_PROVIDER_FIXTURES = [
  { provider: "github-pat-fine-grained", token: join("github_pat_", "A".repeat(20), "b1") },
  { provider: "github-oauth-token", token: join("gho_", "A".repeat(20), "b1") },
  { provider: "github-user-to-server-token", token: join("ghu_", "A".repeat(20), "b1") },
  { provider: "github-server-to-server-token", token: join("ghs_", "A".repeat(20), "b1") },
  { provider: "github-refresh-token", token: join("ghr_", "A".repeat(20), "b1") },
  { provider: "slack-token", token: join("xoxb-", "A".repeat(10), "b1") },
];

for (const { provider, token } of LITERAL_PROVIDER_FIXTURES) {
  test(`detector 1 (literal-credential): a ${provider} token blocks`, () => {
    const findings = scanLineText(`const t = "${token}";`);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].detectorClass, DETECTOR_CLASSES.LITERAL_CREDENTIAL);
    assert.match(findings[0].reason, new RegExp(provider));
    assert.ok(!JSON.stringify(findings).includes(token));
  });
}

// ---------------------------------------------------------------------------
// Detector 2 — high entropy
// ---------------------------------------------------------------------------

test("detector 2 (high-entropy): a long random-looking literal (no known prefix) blocks", () => {
  const value = join("kZ9mQ2", "vL7pR4", "wT8nJ1", "zY6cF3");
  const findings = scanLineText(`const apiValue = "${value}";`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].detectorClass, DETECTOR_CLASSES.HIGH_ENTROPY);
  assert.ok(!JSON.stringify(findings).includes(value));
});

test("detector 2 (high-entropy): a plain long English sentence does NOT block (no digits)", () => {
  const findings = scanLineText('const message = "this is a perfectly ordinary long sentence in the diff";');
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// Detector 3 — sink pattern (secret-named var flowing into an output sink)
// ---------------------------------------------------------------------------

const SINK_TEST_VALUE_NAME = join("MY_", "SEC", "RET_", "TOK", "EN");

test("detector 3 (sink-pattern): a secret-named var echoed blocks with NO literal secret value present", () => {
  const findings = scanLineText(`echo "$${SINK_TEST_VALUE_NAME}"`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].detectorClass, DETECTOR_CLASSES.SINK_PATTERN);
});

test("detector 3 (sink-pattern): base64-piping a credential-named var blocks", () => {
  const findings = scanLineText(`printf '%s' "$${SINK_TEST_VALUE_NAME}" | base64`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].detectorClass, DETECTOR_CLASSES.SINK_PATTERN);
});

test("detector 3 (sink-pattern): redirecting a secret-named var to a file blocks", () => {
  const findings = scanLineText(`printf '%s' "$${SINK_TEST_VALUE_NAME}" > /tmp/out.log`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].detectorClass, DETECTOR_CLASSES.SINK_PATTERN);
});

// The motivating incident: a `::add-mask::` GitHub Actions directive right
// next to the echo does NOT neutralize the hit — masking only redacts what
// CI's log renderer shows LATER, the value still reaches this stream.
test("detector 3 (sink-pattern): a ::add-mask::-adjacent echo of a credential-named var is STILL a hit", () => {
  const findings = scanLineText(`echo "::add-mask::$${SINK_TEST_VALUE_NAME}"`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].detectorClass, DETECTOR_CLASSES.SINK_PATTERN);
});

test("detector 3 (sink-pattern): a bare `::directive::` alone (no credential-named var) does NOT block", () => {
  assert.deepEqual(scanLineText('echo "::notice::build finished"'), []);
});

// False-positive guard: an arrow function or comparison operator must never
// read as a shell redirect just because the line also names a *TOKEN*
// variable — this is the exact JS/TS shape this repo's own helpers use.
test("detector 3 (sink-pattern): a JS arrow function referencing a *TOKEN* name does NOT block", () => {
  assert.deepEqual(scanLineText("const requireTokenValue = (t) => t.value;"), []);
});

test("detector 3 (sink-pattern): a >= comparison on a *token* name does NOT block", () => {
  assert.deepEqual(scanLineText("if (token.length >= 20) return true;"), []);
});

// ---------------------------------------------------------------------------
// Must-pass fixtures (DoD): safe env-var-only pattern, allowlisted value,
// non-credential base64.
// ---------------------------------------------------------------------------

test("must-pass: a secret-named var read from process.env with no sink on the line passes", () => {
  assert.deepEqual(scanLineText("const token = process.env.GITHUB_TOKEN;"), []);
});

test("must-pass: an allowlisted literal credential passes despite being real-shaped", () => {
  const token = join("ghp_", "A".repeat(20), "b1");
  const line = `const t = "${token}"; # ${ALLOW_MARKER} test fixture, not a real credential`;
  assert.deepEqual(scanLineText(line), []);
});

test("must-pass: a short, non-credential base64 literal passes (below both the length and entropy floors)", () => {
  assert.deepEqual(scanLineText('const greeting = "aGVsbG8=";'), []);
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
  const entries = parseAddedLines(diff);
  assert.deepEqual(entries, [
    { file: "f.txt", line: 2, text: "added line one" },
    { file: "f.txt", line: 3, text: "added line two" },
  ]);
});

test("parseAddedLines: a binary-file diff (no hunk) yields no entries", () => {
  const diff = ["diff --git a/f.bin b/f.bin", "Binary files a/f.bin and b/f.bin differ"].join("\n");
  assert.deepEqual(parseAddedLines(diff), []);
});

test("parseAddedLines: an added line whose CONTENT starts with '+ ' (raw diff line '+++ ...') is content, not a file header — regression for the fail-open where such a line was skipped from every detector", () => {
  const token = join("ghp_", "A".repeat(20), "b1");
  // Content is `++ export TOKEN="..."` — prefixed with the added-line marker
  // `+`, the raw diff line is `+++ export TOKEN="..."`, indistinguishable
  // from a `+++ ` file header by a naive prefix test alone.
  const diff = [
    "diff --git a/config.sh b/config.sh",
    "index 0000000..1111111 100644",
    "--- a/config.sh",
    "+++ b/config.sh",
    "@@ -0,0 +1,1 @@",
    `+++ export TOKEN="${token}"`,
  ].join("\n");
  const entries = parseAddedLines(diff);
  assert.deepEqual(entries, [{ file: "config.sh", line: 1, text: `++ export TOKEN="${token}"` }]);

  const result = scanDiffText(diff);
  assert.equal(result.ok, false);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(
    { file: result.findings[0].file, line: result.findings[0].line, detectorClass: result.findings[0].detectorClass },
    { file: "config.sh", line: 1, detectorClass: DETECTOR_CLASSES.LITERAL_CREDENTIAL },
  );
  assert.ok(!JSON.stringify(result).includes(token));
});

test("scanDiffText: attributes a hit to the correct file/line and never carries the value", () => {
  const token = join("ghp_", "A".repeat(20), "b1");
  const diff = [
    "diff --git a/config.sh b/config.sh",
    "index 0000000..1111111 100644",
    "--- a/config.sh",
    "+++ b/config.sh",
    "@@ -0,0 +1,2 @@",
    "+line one is clean",
    `+export TOKEN="${token}"`,
  ].join("\n");
  const result = scanDiffText(diff);
  assert.equal(result.ok, false);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(
    { file: result.findings[0].file, line: result.findings[0].line, detectorClass: result.findings[0].detectorClass },
    { file: "config.sh", line: 2, detectorClass: DETECTOR_CLASSES.LITERAL_CREDENTIAL },
  );
  assert.ok(!JSON.stringify(result).includes(token));
});

test("scanDiffText: a clean diff (no findings) reports ok: true", () => {
  const diff = [
    "diff --git a/README.md b/README.md",
    "index 0000000..1111111 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -0,0 +1,1 @@",
    "+# Hello, world",
  ].join("\n");
  assert.deepEqual(scanDiffText(diff), { ok: true, findings: [] });
});
