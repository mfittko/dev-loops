import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import {
  ADR_PATH_RE,
  CONTRACT_DOC_RE,
  computeAdrTripwire,
  extractRuleModalities,
  runCli,
  unquoteGitPath,
  parseCheckAdrTripwireCliArgs,
  parseNameStatus,
} from "../../scripts/loop/check-adr-tripwire.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONTRACT_DOC = "skills/docs/decision-record-contract.md";
const GATE_CONFIG = "packages/core/src/config/extension-defaults.yaml";
const ADR_FILE = "docs/decisions/0052-adr-tripwire-fail-closed.md";

const BASE_CONTRACT = `# Decision record contract

| Rule ID | Rule |
|---|---|
| <!-- rule: ADR-WORTHY-PERSIST --> \`ADR-WORTHY-PERSIST\` | An accepted policy-level choice MUST be persisted as an ADR. |
| <!-- rule: ADR-SOFT-HINT --> \`ADR-SOFT-HINT\` | A routine choice SHOULD be recorded when convenient. |

The practice is advisory-first.
`;

const HEAD_CONTRACT_REVERSED = BASE_CONTRACT.replace(
  "A routine choice SHOULD be recorded when convenient.",
  "A routine choice MUST be recorded.",
);

// A contract doc edit that touches no rule line at all.
const HEAD_CONTRACT_PROSE_ONLY = BASE_CONTRACT + "\nExtra prose paragraph.\n";

function ns(entries) {
  return entries.map((e) => (Array.isArray(e) ? e.join("\t") : e)).join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Path matchers
// ---------------------------------------------------------------------------

test("CONTRACT_DOC_RE matches skills/docs *-contract.md only", () => {
  assert.equal(CONTRACT_DOC_RE.test("skills/docs/decision-record-contract.md"), true);
  assert.equal(CONTRACT_DOC_RE.test("skills/docs/public-dev-loop-contract.md"), true);
  assert.equal(CONTRACT_DOC_RE.test("skills/docs/decision-record-contract.md.bak"), false);
  assert.equal(CONTRACT_DOC_RE.test("skills/docs/required-rules.json"), false);
  assert.equal(CONTRACT_DOC_RE.test("skills/dev-loop/SKILL.md"), false);
  assert.equal(CONTRACT_DOC_RE.test("docs/decisions/0000-template.md"), false);
  // generated mirror is not the canonical surface
  assert.equal(CONTRACT_DOC_RE.test(".claude/skills/docs/decision-record-contract.md"), false);
});

test("ADR_PATH_RE matches numbered decision records", () => {
  assert.equal(ADR_PATH_RE.test("docs/decisions/0052-adr-tripwire-fail-closed.md"), true);
  assert.equal(ADR_PATH_RE.test("docs/decisions/0000-template.md"), true);
  assert.equal(ADR_PATH_RE.test("docs/decisions/52-adr.md"), false);
  assert.equal(ADR_PATH_RE.test("docs/decisions/not-a-record.md"), false);
});

// ---------------------------------------------------------------------------
// parseNameStatus
// ---------------------------------------------------------------------------

test("parseNameStatus: plain add/modify and rename rows", () => {
  const files = parseNameStatus(ns(["M\tskills/docs/x-contract.md", "A\tdocs/decisions/0052-a.md", "R087\told-contract.md\tskills/docs/new-contract.md"]));
  assert.deepEqual(files, [
    { status: "M", path: "skills/docs/x-contract.md", origPath: null },
    { status: "A", path: "docs/decisions/0052-a.md", origPath: null },
    { status: "R087", path: "skills/docs/new-contract.md", origPath: "old-contract.md" },
  ]);
});

// ---------------------------------------------------------------------------
// extractRuleModalities
// ---------------------------------------------------------------------------

test("extractRuleModalities: inline-table and own-line markers", () => {
  const content = `| <!-- rule: R-INLINE --> \`R-INLINE\` | Work MUST happen now. |

<!-- rule: R-OWNLINE -->
This rule SHOULD wait until later, and MAY never run.
`;
  const m = extractRuleModalities(content);
  assert.equal(m.get("R-INLINE"), "must");
  assert.equal(m.get("R-OWNLINE"), "should");
});

test("extractRuleModalities: MUST NOT stays must-family, no keyword yields null", () => {
  const content = `<!-- rule: R-NEG -->
You MUST NOT do this.

<!-- rule: R-EMPTY -->
No modality keyword on this line.
`;
  const m = extractRuleModalities(content);
  assert.equal(m.get("R-NEG"), "must");
  assert.equal(m.get("R-EMPTY"), null);
});

// ---------------------------------------------------------------------------
// computeAdrTripwire — fail-closed paths (issue AC 1)
// ---------------------------------------------------------------------------

test("contract-doc touch without ADR or waiver blocks", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + CONTRACT_DOC]),
    baseContents: { [CONTRACT_DOC]: BASE_CONTRACT },
    headContents: { [CONTRACT_DOC]: HEAD_CONTRACT_PROSE_ONLY },
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.deepEqual(r.triggers, [{ type: "contract-doc", path: CONTRACT_DOC }]);
  assert.deepEqual(r.adrFiles, []);
  assert.equal(r.waiver.valid, false);
  assert.ok(r.reasons.length > 0);
});

test("gate-config touch without ADR or waiver blocks", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + GATE_CONFIG]),
    baseContents: {},
    headContents: {},
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.deepEqual(r.triggers, [{ type: "gate-config", path: GATE_CONFIG }]);
});

test("rule-modality reversal MUST→SHOULD and SHOULD→MUST both block (AC 1)", () => {
  const reversed = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + CONTRACT_DOC]),
    baseContents: { [CONTRACT_DOC]: BASE_CONTRACT },
    headContents: { [CONTRACT_DOC]: HEAD_CONTRACT_REVERSED },
    prBody: "",
  });
  assert.equal(reversed.outcome, "block");
  assert.ok(reversed.triggers.some((t) => t.type === "rule-modality-reversal" && t.ruleId === "ADR-SOFT-HINT" && t.from === "should" && t.to === "must"));

  const loosened = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + CONTRACT_DOC]),
    baseContents: { [CONTRACT_DOC]: HEAD_CONTRACT_REVERSED },
    headContents: { [CONTRACT_DOC]: BASE_CONTRACT },
    prBody: "",
  });
  assert.equal(loosened.outcome, "block");
  assert.ok(loosened.triggers.some((t) => t.type === "rule-modality-reversal" && t.ruleId === "ADR-SOFT-HINT" && t.from === "must" && t.to === "should"));
});

test("changed rule-bearing doc with unresolvable base+head content fails closed", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + CONTRACT_DOC]),
    baseContents: {},
    headContents: {},
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.ok(r.triggers.some((t) => t.type === "unresolvable-rule-scan" && t.path === CONTRACT_DOC));
});

test("waiver marker without a reason is invalid — still blocks", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + CONTRACT_DOC]),
    baseContents: { [CONTRACT_DOC]: BASE_CONTRACT },
    headContents: { [CONTRACT_DOC]: HEAD_CONTRACT_PROSE_ONLY },
    prBody: "Some body\nadr-tripwire:allow\nmore",
  });
  assert.equal(r.outcome, "block");
  assert.equal(r.waiver.valid, false);
});

// ---------------------------------------------------------------------------
// Satisfaction paths (issue AC 2)
// ---------------------------------------------------------------------------

test("waiver marker with a reason passes a contract-doc touch", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + CONTRACT_DOC]),
    baseContents: { [CONTRACT_DOC]: BASE_CONTRACT },
    headContents: { [CONTRACT_DOC]: HEAD_CONTRACT_PROSE_ONLY },
    prBody: "Body text.\nadr-tripwire:allow deliberate advisory-only contract tweak\nEnd.",
  });
  assert.equal(r.outcome, "pass");
  assert.equal(r.satisfiedBy, "waiver");
  assert.equal(r.waiver.reason, "deliberate advisory-only contract tweak");
});

test("waiver with reason passes a gate-config touch", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + GATE_CONFIG]),
    baseContents: {},
    headContents: {},
    prBody: "adr-tripwire:allow gate threshold re-tune recorded in issue #1867",
  });
  assert.equal(r.outcome, "pass");
  assert.equal(r.satisfiedBy, "waiver");
});

test("adding an ADR file satisfies a decision-shaped touch", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + CONTRACT_DOC, "A\t" + ADR_FILE]),
    baseContents: { [CONTRACT_DOC]: BASE_CONTRACT },
    headContents: { [CONTRACT_DOC]: HEAD_CONTRACT_PROSE_ONLY },
    prBody: "",
  });
  assert.equal(r.outcome, "pass");
  assert.equal(r.satisfiedBy, "adr");
  assert.deepEqual(r.adrFiles, [ADR_FILE]);
});

test("updating an existing ADR file also satisfies", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + GATE_CONFIG, "M\tdocs/decisions/0051-net-reduction-disposition-policy.md"]),
    baseContents: {},
    headContents: {},
    prBody: "",
  });
  assert.equal(r.outcome, "pass");
  assert.equal(r.satisfiedBy, "adr");
});

// ---------------------------------------------------------------------------
// No false-fail (issue AC 3)
// ---------------------------------------------------------------------------

test("code-only diff passes without ADR or waiver", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\tsrc/foo.mjs", "A\ttest/foo.test.mjs"]),
    baseContents: {},
    headContents: {},
    prBody: "",
  });
  assert.equal(r.outcome, "pass");
  assert.equal(r.satisfiedBy, null);
  assert.deepEqual(r.triggers, []);
});

test("non-contract docs and the .claude mirror pass without ADR", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns([
      "M\tskills/docs/decision-record-contract.md.bak",
      "M\tskills/docs/required-rules.json",
      "M\t.claude/skills/docs/decision-record-contract.md",
      "A\tdocs/phases/phase-x.md",
    ]),
    baseContents: {},
    headContents: {},
    prBody: "",
  });
  assert.equal(r.outcome, "pass");
  assert.deepEqual(r.triggers, []);
});

test("rule modality unchanged between base and head — no reversal trigger", () => {
  const DOC = "skills/docs/planning.md";
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + DOC]),
    baseContents: { [DOC]: BASE_CONTRACT },
    headContents: { [DOC]: BASE_CONTRACT.replace("advisory-first", "advisory-first (still)") },
    prBody: "",
  });
  assert.equal(r.outcome, "pass");
  assert.deepEqual(r.triggers, []);
});

test("new rule with a modality is not a reversal (no prior base modality)", () => {
  const DOC = "skills/docs/planning.md";
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + DOC]),
    baseContents: { [DOC]: BASE_CONTRACT },
    headContents: { [DOC]: BASE_CONTRACT + "\n<!-- rule: ADR-NEW-RULE -->\nNew rule MUST apply.\n" },
    prBody: "",
  });
  assert.equal(r.outcome, "pass");
  assert.deepEqual(r.triggers, []);
});

test("rule-bearing non-contract doc whose rules were all removed trips unresolvable only when head unreadable; with readable head it passes", () => {
  const DOC = "skills/docs/planning.md";
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + DOC]),
    baseContents: { [DOC]: BASE_CONTRACT },
    headContents: { [DOC]: "Rules removed entirely.\n" },
    prBody: "",
  });
  assert.equal(r.outcome, "pass");
  assert.deepEqual(r.triggers, []);
});

test("parseNameStatus: rename rows", () => {
  const files = parseNameStatus(ns(["R087\told-contract.md\tskills/docs/new-contract.md"]));
  assert.deepEqual(files, [
    { status: "R087", path: "skills/docs/new-contract.md", origPath: "old-contract.md" },
  ]);
});

test("parseNameStatus: C-quoted tab path is unquoted, not truncated", () => {
  const files = parseNameStatus('M\t"skills/docs/we\\tird-contract.md"\n');
  assert.deepEqual(files, [{ status: "M", path: "skills/docs/we\tird-contract.md", origPath: null }]);
});

test("unquoteGitPath: plain paths pass through, octal and quote escapes decode", () => {
  assert.equal(unquoteGitPath("skills/docs/plain-contract.md"), "skills/docs/plain-contract.md");
  assert.equal(unquoteGitPath(String.raw`"skills/docs/\303\251-contract.md"`), "skills/docs/\u00e9-contract.md");
  assert.equal(unquoteGitPath('"skills/docs/a\\"b-contract.md"'), 'skills/docs/a"b-contract.md');
});

test("rename OUT of the contract surface triggers via origPath (gate-review finding M2)", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["R100\tskills/docs/old-contract.md\tskills/docs/old.md"]),
    baseContents: { "skills/docs/old-contract.md": BASE_CONTRACT },
    headContents: { "skills/docs/old.md": "Renamed away from contract shape.\n" },
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.ok(r.triggers.some((t) => t.type === "contract-doc" && t.path === "skills/docs/old-contract.md"));
});

test("extractRuleModalities: adjacent markers without blank line do not cross-inherit modality (gate-review finding L2)", () => {
  const content = "<!-- rule: R-ONE -->\n<!-- rule: R-TWO -->\nYou MUST wait.\n";
  const m = extractRuleModalities(content);
  assert.equal(m.get("R-ONE"), null);
  assert.equal(m.get("R-TWO"), "must");
});

test("one-side-unreadable rule-bearing doc fails closed (base readable, head absent)", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\tskills/docs/planning.md"]),
    baseContents: { "skills/docs/planning.md": BASE_CONTRACT },
    headContents: {},
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.ok(r.triggers.some((t) => t.type === "unresolvable-rule-scan"));
});

// ---------------------------------------------------------------------------
// Existing ADR-shape validator surface untouched (issue AC 4) — smoke only;
// the validator itself is not modified by this change (checked by diff).
// ---------------------------------------------------------------------------

test("renamed contract doc triggers via its new path", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["R100\told-name.md\tskills/docs/renamed-contract.md"]),
    baseContents: { "old-name.md": BASE_CONTRACT },
    headContents: { "skills/docs/renamed-contract.md": HEAD_CONTRACT_PROSE_ONLY },
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.ok(r.triggers.some((t) => t.type === "contract-doc" && t.path === "skills/docs/renamed-contract.md"));
});

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

test("parseCheckAdrTripwireCliArgs: requires --base, accepts --head/--pr-body-file", () => {
  const opts = parseCheckAdrTripwireCliArgs(["--base", "origin/main", "--head", "abc123", "--pr-body-file", "/tmp/body.md"]);
  assert.equal(opts.base, "origin/main");
  assert.equal(opts.head, "abc123");
  assert.equal(opts.prBodyFile, "/tmp/body.md");
  assert.throws(() => parseCheckAdrTripwireCliArgs([]));
});

// ---------------------------------------------------------------------------
// runCli: a block exits non-zero (gate-review finding M1) — fail-closed at
// the tool's own CLI surface, not just the programmatic API.
// ---------------------------------------------------------------------------

test("runCli: block outcome exits 1 and reports ok:false", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "adr-cli-block-"));
  try {
    const fixture = path.join(tmp, "repo");
    await mkdir(path.join(fixture, "skills/docs"), { recursive: true });
    execSync("git init -q -b main && git config user.email t@t && git config user.name t && echo base > base.md && git add . && git commit -qm base && git branch base", { cwd: fixture, stdio: "ignore" });
    await writeFile(path.join(fixture, "skills/docs/new-contract.md"), "# New contract\n\nSome prose.\n");
    execSync("git add . && git commit -qm head", { cwd: fixture, stdio: "ignore" });
    const chunks = [];
    const stdout = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
    const stderr = new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } });
    await runCli(["--base", "base", "--head", "HEAD"], { stdout, stderr, repoRoot: fixture });
    const exitCode = process.exitCode;
    process.exitCode = undefined;
    assert.equal(exitCode, 1);
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(payload.ok, false);
    assert.equal(payload.outcome, "block");
    assert.equal(payload.error, "adr_tripwire_block");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
