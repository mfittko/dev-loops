import assert from "node:assert/strict";
import { test } from "bun:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import {
  ADR_PATH_RE,
  CONTRACT_DOC_RE,
  DEVLOOPS_CONFIG_PATH,
  computeAdrTripwire,
  extractRuleModalities,
  evaluateAdrTripwire,
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

// ── devloops-proportionality (#1984) ──────────────────────────────────────

const BASE_DEVLOOPS = "version: 1\nlocalImplementation:\n  lightMode:\n    enabled: true\n    maxFiles: 2\n    maxLines: 20\n";
const HEAD_DEVLOOPS_LOOSENED = "version: 1\nlocalImplementation:\n  lightMode:\n    enabled: true\n    maxFiles: 10\n    maxLines: 500\n";
const HEAD_DEVLOOPS_UNCHANGED = BASE_DEVLOOPS;

test("a .devloops maxFiles/maxLines change without ADR or waiver blocks (add direction)", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["A\t" + DEVLOOPS_CONFIG_PATH]),
    baseContents: {},
    headContents: { [DEVLOOPS_CONFIG_PATH]: HEAD_DEVLOOPS_LOOSENED },
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.ok(r.triggers.some((t) => t.type === "devloops-proportionality" && t.path === DEVLOOPS_CONFIG_PATH));
});

test("a .devloops maxFiles/maxLines change without ADR or waiver blocks (modify direction)", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + DEVLOOPS_CONFIG_PATH]),
    baseContents: { [DEVLOOPS_CONFIG_PATH]: BASE_DEVLOOPS },
    headContents: { [DEVLOOPS_CONFIG_PATH]: HEAD_DEVLOOPS_LOOSENED },
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  const trigger = r.triggers.find((t) => t.type === "devloops-proportionality");
  assert.ok(trigger, JSON.stringify(r.triggers));
  assert.ok(trigger.fields.includes("localImplementation.lightMode.maxFiles"));
  assert.ok(trigger.fields.includes("localImplementation.lightMode.maxLines"));
});

test("a .devloops riskPaths addition without ADR or waiver blocks", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + DEVLOOPS_CONFIG_PATH]),
    baseContents: { [DEVLOOPS_CONFIG_PATH]: BASE_DEVLOOPS },
    headContents: { [DEVLOOPS_CONFIG_PATH]: "version: 1\nlocalImplementation:\n  lightMode:\n    enabled: true\n    maxFiles: 2\n    maxLines: 20\n    riskPaths: [\"my-app/**\"]\n" },
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  const trigger = r.triggers.find((t) => t.type === "devloops-proportionality");
  assert.deepEqual(trigger.fields, ["localImplementation.lightMode.riskPaths"]);
});

test("an ADR record satisfies a .devloops proportionality-field change", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + DEVLOOPS_CONFIG_PATH, "A\t" + ADR_FILE]),
    baseContents: { [DEVLOOPS_CONFIG_PATH]: BASE_DEVLOOPS },
    headContents: { [DEVLOOPS_CONFIG_PATH]: HEAD_DEVLOOPS_LOOSENED },
    prBody: "",
  });
  assert.equal(r.outcome, "pass");
  assert.equal(r.satisfiedBy, "adr");
});

test("a waiver marker with a reason satisfies a .devloops proportionality-field change", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + DEVLOOPS_CONFIG_PATH]),
    baseContents: { [DEVLOOPS_CONFIG_PATH]: BASE_DEVLOOPS },
    headContents: { [DEVLOOPS_CONFIG_PATH]: HEAD_DEVLOOPS_LOOSENED },
    prBody: "adr-tripwire:allow deliberately widening the micro-PR cap for this repo",
  });
  assert.equal(r.outcome, "pass");
  assert.equal(r.satisfiedBy, "waiver");
});

// loadDevLoopConfig also honors the .devloops.yaml/.yml/.json variants
// (config.mjs's own probe order) — a proportionality-field change authored in
// one of those must trip the SAME trigger as the bare `.devloops` filename,
// or a repo could bypass the ADR requirement just by picking a different
// extension.
for (const variant of [".devloops.yaml", ".devloops.yml", ".devloops.json"]) {
  test(`a ${variant} maxFiles/maxLines change without ADR or waiver blocks (config-source family)`, () => {
    const r = computeAdrTripwire({
      nameStatusOutput: ns(["M\t" + variant]),
      baseContents: { [variant]: BASE_DEVLOOPS },
      headContents: { [variant]: HEAD_DEVLOOPS_LOOSENED },
      prBody: "",
    });
    assert.equal(r.outcome, "block");
    const trigger = r.triggers.find((t) => t.type === "devloops-proportionality");
    assert.ok(trigger, JSON.stringify(r.triggers));
    assert.equal(trigger.path, variant);
  });
}

test("a .devloops touch with NO proportionality-field change does not trip the tripwire", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + DEVLOOPS_CONFIG_PATH]),
    baseContents: { [DEVLOOPS_CONFIG_PATH]: BASE_DEVLOOPS },
    headContents: { [DEVLOOPS_CONFIG_PATH]: HEAD_DEVLOOPS_UNCHANGED + "\nqueue:\n  maxParallel: 5\n" },
    prBody: "",
  });
  assert.equal(r.outcome, "pass");
  assert.deepEqual(r.triggers, []);
});

test("a .devloops deletion that drops a configured cap is a proportionality change (removal direction)", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["D\t" + DEVLOOPS_CONFIG_PATH]),
    baseContents: { [DEVLOOPS_CONFIG_PATH]: BASE_DEVLOOPS },
    headContents: {},
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.ok(r.triggers.some((t) => t.type === "devloops-proportionality"));
});

test("a changed .devloops with unparsable YAML fails closed (unresolvable-devloops-scan)", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + DEVLOOPS_CONFIG_PATH]),
    baseContents: { [DEVLOOPS_CONFIG_PATH]: BASE_DEVLOOPS },
    headContents: { [DEVLOOPS_CONFIG_PATH]: "version: 1\n  : this is not valid yaml: [" },
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.ok(r.triggers.some((t) => t.type === "unresolvable-devloops-scan"));
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

test("rules removed from a still-present rule-bearing doc is a modality reversal (round-2 medium fix)", () => {
  const DOC = "skills/docs/planning.md";
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + DOC]),
    baseContents: { [DOC]: BASE_CONTRACT },
    headContents: { [DOC]: "Rules removed entirely.\n" },
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.ok(r.triggers.some((t) => t.type === "rule-modality-reversal" && t.ruleId === "ADR-SOFT-HINT" && t.to === "none"));
});

test("keyword stripped from a rule (marker stays, modality gone) is a reversal (round-2 medium fix)", () => {
  const DOC = "skills/docs/planning.md";
  const head = BASE_CONTRACT.replace("| <!-- rule: ADR-SOFT-HINT --> `ADR-SOFT-HINT` | A routine choice SHOULD be recorded when convenient. |", "| <!-- rule: ADR-SOFT-HINT --> `ADR-SOFT-HINT` | A routine choice is recorded when convenient. |");
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + DOC]),
    baseContents: { [DOC]: BASE_CONTRACT },
    headContents: { [DOC]: head },
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.ok(r.triggers.some((t) => t.type === "rule-modality-reversal" && t.ruleId === "ADR-SOFT-HINT" && t.to === "none"));
});

test("a deleted ADR record row never satisfies the tripwire (round-2 medium fix)", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + CONTRACT_DOC, "D\tdocs/decisions/0051-net-reduction-disposition-policy.md"]),
    baseContents: { [CONTRACT_DOC]: BASE_CONTRACT },
    headContents: { [CONTRACT_DOC]: HEAD_CONTRACT_PROSE_ONLY },
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.deepEqual(r.adrFiles, []);
  assert.ok(r.reasons.length > 0);
});

test("waiver marker buried mid-sentence does not waive (round-2 medium fix — line-anchored)", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + CONTRACT_DOC]),
    baseContents: { [CONTRACT_DOC]: BASE_CONTRACT },
    headContents: { [CONTRACT_DOC]: HEAD_CONTRACT_PROSE_ONLY },
    prBody: "This PR does not need adr-tripwire:allow because the change is minor.",
  });
  assert.equal(r.outcome, "block");
  assert.equal(r.waiver.valid, false);
});

test("gate-config rename-out trips via origPath (round-2 low fix)", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["R100\tpackages/core/src/config/extension-defaults.yaml\tpackages/core/src/config/gate-defaults.yaml"]),
    baseContents: {},
    headContents: {},
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.ok(r.triggers.some((t) => t.type === "gate-config"));
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

// ---------------------------------------------------------------------------
// evaluateAdrTripwire: real git fixture, end-to-end (#1984) — proves the
// git-side wrapper actually captures .devloops content at both refs, not
// just the pure computeAdrTripwire unit tests above.
// ---------------------------------------------------------------------------

test("evaluateAdrTripwire (#1984): a real .devloops cap change blocks without an ADR/waiver", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "adr-devloops-"));
  try {
    const fixture = path.join(tmp, "repo");
    await mkdir(fixture, { recursive: true });
    execSync("git init -q -b main && git config user.email t@t && git config user.name t", { cwd: fixture, stdio: "ignore" });
    await writeFile(path.join(fixture, DEVLOOPS_CONFIG_PATH), BASE_DEVLOOPS);
    execSync("git add . && git commit -qm base && git branch base", { cwd: fixture, stdio: "ignore" });
    await writeFile(path.join(fixture, DEVLOOPS_CONFIG_PATH), HEAD_DEVLOOPS_LOOSENED);
    execSync("git add . && git commit -qm head", { cwd: fixture, stdio: "ignore" });
    const r = await evaluateAdrTripwire({ base: "base", head: "HEAD", repoRoot: fixture });
    assert.equal(r.outcome, "block");
    assert.ok(r.triggers.some((t) => t.type === "devloops-proportionality"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("evaluateAdrTripwire (#1984): a real .devloops.yaml cap change blocks without an ADR/waiver (config-source family)", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "adr-devloops-yaml-"));
  try {
    const fixture = path.join(tmp, "repo");
    await mkdir(fixture, { recursive: true });
    execSync("git init -q -b main && git config user.email t@t && git config user.name t", { cwd: fixture, stdio: "ignore" });
    await writeFile(path.join(fixture, ".devloops.yaml"), BASE_DEVLOOPS);
    execSync("git add . && git commit -qm base && git branch base", { cwd: fixture, stdio: "ignore" });
    await writeFile(path.join(fixture, ".devloops.yaml"), HEAD_DEVLOOPS_LOOSENED);
    execSync("git add . && git commit -qm head", { cwd: fixture, stdio: "ignore" });
    const r = await evaluateAdrTripwire({ base: "base", head: "HEAD", repoRoot: fixture });
    assert.equal(r.outcome, "block");
    assert.ok(r.triggers.some((t) => t.type === "devloops-proportionality" && t.path === ".devloops.yaml"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// evaluateAdrTripwire: the env argument reaches git subprocesses (round-2
// low fix) — GIT_DIR/GIT_WORK_TREE dir overrides are stripped, so a poisoned
// inherited env cannot redirect the scan.
// ---------------------------------------------------------------------------

test("evaluateAdrTripwire honors env injection and strips GIT_DIR/GIT_WORK_TREE", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "adr-env-"));
  try {
    const fixture = path.join(tmp, "repo");
    await mkdir(path.join(fixture, "skills/docs"), { recursive: true });
    execSync("git init -q -b main && git config user.email t@t && git config user.name t && echo base > base.md && git add . && git commit -qm base && git branch base", { cwd: fixture, stdio: "ignore" });
    await writeFile(path.join(fixture, "skills/docs/plain.md"), "# Plain doc\n\nNo rules.\n");
    execSync("git add . && git commit -qm head", { cwd: fixture, stdio: "ignore" });
    const poisoned = { ...process.env, GIT_DIR: "/nonexistent", GIT_WORK_TREE: "/nonexistent" };
    const r = await evaluateAdrTripwire({ base: "base", head: "HEAD", repoRoot: fixture, env: poisoned });
    assert.equal(r.ok, true);
    assert.equal(r.outcome, "pass");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("round-3 fixes: rule-bearing doc renamed OUT of skills/docs still scans (origPath guard)", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["R100\tskills/docs/planning.md\tdocs/planning.md"]),
    baseContents: { "skills/docs/planning.md": BASE_CONTRACT },
    headContents: { "docs/planning.md": BASE_CONTRACT.replace("MUST be persisted", "SHOULD be persisted") },
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.ok(r.triggers.some((t) => t.type === "rule-modality-reversal" && t.ruleId === "ADR-WORTHY-PERSIST"));
});

test("round-3 low fix: the reserved 0000-template row never satisfies the tripwire", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + CONTRACT_DOC, "A\tdocs/decisions/0000-template.md"]),
    baseContents: { [CONTRACT_DOC]: BASE_CONTRACT },
    headContents: { [CONTRACT_DOC]: HEAD_CONTRACT_PROSE_ONLY },
    prBody: "",
  });
  assert.equal(r.outcome, "block");
  assert.deepEqual(r.adrFiles, []);
});

test("round-3 medium fix: CLI usage error exits 2", () => {
  const { execFileSync } = require("node:child_process");
  let code = null;
  try {
    execFileSync((Bun.which("node") ?? "node"), [path.resolve("scripts/loop/check-adr-tripwire.mjs"), "--bogus"], { stdio: "ignore", env: { ...process.env } });
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 2);
});

test("round-4 low fix: a bare marker earlier in the body invalidates a later valid marker", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + CONTRACT_DOC]),
    baseContents: { [CONTRACT_DOC]: BASE_CONTRACT },
    headContents: { [CONTRACT_DOC]: HEAD_CONTRACT_PROSE_ONLY },
    prBody: "adr-tripwire:allow\nadr-tripwire:allow real reason here",
  });
  assert.equal(r.outcome, "block");
  assert.equal(r.waiver.requested, true);
  assert.equal(r.waiver.valid, false);
});

test("round-5 fix pinned: same-line following marker bounds the modality window", () => {
  // First rule lost its keyword; a same-line later marker carries MUST. The
  // window bound must stop R-ONE's scan at the next marker so R-ONE stays
  // null (no reversal) instead of inheriting R-TWO's must.
  const content = "| <!-- rule: R-ONE --> `R-ONE` | Obligation text removed entirely. | <!-- rule: R-TWO --> `R-TWO` | You MUST comply. |\n";
  const m = extractRuleModalities(content);
  assert.equal(m.get("R-ONE"), null);
  assert.equal(m.get("R-TWO"), "must");
});

// ── commit-msg-guard-loosening (#2605) ────────────────────────────────────

const GUARD_ON = "version: 1\nworktree:\n  commitMsgGuard:\n    requireClaudeSession: true\n";
const GUARD_OFF = "version: 1\nworktree:\n  commitMsgGuard:\n    requireClaudeSession: false\n";
const GUARD_ABSENT = "version: 1\n";

function guardDiff(status, base, head, extra = {}) {
  return computeAdrTripwire({
    nameStatusOutput: ns([`${status}\t` + DEVLOOPS_CONFIG_PATH]),
    baseContents: base == null ? {} : { [DEVLOOPS_CONFIG_PATH]: base },
    headContents: head == null ? {} : { [DEVLOOPS_CONFIG_PATH]: head },
    ...extra,
  });
}

test("loosening requireClaudeSession (set false, key removed, file removed) blocks", () => {
  for (const [status, head] of [["M", GUARD_OFF], ["M", GUARD_ABSENT], ["D", null]]) {
    const r = guardDiff(status, GUARD_ON, head);
    assert.equal(r.outcome, "block");
    assert.ok(r.triggers.some((t) => t.type === "commit-msg-guard-loosening"));
  }
});

test("loosening from an unparseable or non-boolean base value blocks", () => {
  const nonBoolean = GUARD_ON.replace("true", "\"true\"");
  const unparseable = "a: [unclosed\n";
  for (const base of [nonBoolean, unparseable]) {
    for (const [status, head] of [["M", GUARD_OFF], ["M", GUARD_ABSENT], ["D", null]]) {
      const r = guardDiff(status, base, head);
      assert.equal(r.outcome, "block");
      assert.ok(r.triggers.some((t) => t.type === "commit-msg-guard-loosening"));
    }
  }
});

test("opting in or leaving requireClaudeSession unchanged passes", () => {
  for (const [status, base, head] of [["M", GUARD_ABSENT, GUARD_ON], ["M", GUARD_OFF, GUARD_ON], ["A", null, GUARD_ON], ["M", GUARD_ON, GUARD_ON + "# c\n"]]) {
    const r = guardDiff(status, base, head);
    assert.equal(r.outcome, "pass");
    assert.deepEqual(r.triggers, []);
  }
});

test("a loosening is satisfied by a decision record or the waiver", () => {
  const adr = guardDiff("M", GUARD_ON, GUARD_OFF);
  assert.equal(adr.outcome, "block");
  const withAdr = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + DEVLOOPS_CONFIG_PATH, "A\t" + ADR_FILE]),
    baseContents: { [DEVLOOPS_CONFIG_PATH]: GUARD_ON },
    headContents: { [DEVLOOPS_CONFIG_PATH]: GUARD_OFF },
  });
  assert.equal(withAdr.satisfiedBy, "adr");
  const waived = guardDiff("M", GUARD_ON, GUARD_OFF, { prBody: "adr-tripwire:allow operator opted out" });
  assert.equal(waived.satisfiedBy, "waiver");
});

test("a new key-less .devloops shadowing an unchanged .devloops.yaml that sets the key blocks", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["A\t" + DEVLOOPS_CONFIG_PATH]),
    baseContents: { ".devloops.yaml": GUARD_ON },
    headContents: { [DEVLOOPS_CONFIG_PATH]: GUARD_ABSENT, ".devloops.yaml": GUARD_ON },
  });
  assert.equal(r.outcome, "block");
  assert.ok(r.triggers.some((t) => t.type === "commit-msg-guard-loosening"));
});

test("evaluateAdrTripwire (#2605): a real key-less .devloops shadowing an unchanged .devloops.yaml that sets the key blocks", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "adr-guard-shadow-"));
  try {
    const fixture = path.join(tmp, "repo");
    await mkdir(fixture, { recursive: true });
    execSync("git init -q -b main && git config user.email t@t && git config user.name t", { cwd: fixture, stdio: "ignore" });
    await writeFile(path.join(fixture, ".devloops.yaml"), GUARD_ON);
    execSync("git add . && git commit -qm base && git branch base", { cwd: fixture, stdio: "ignore" });
    await writeFile(path.join(fixture, DEVLOOPS_CONFIG_PATH), GUARD_ABSENT);
    execSync("git add . && git commit -qm head", { cwd: fixture, stdio: "ignore" });
    const r = await evaluateAdrTripwire({ base: "base", head: "HEAD", repoRoot: fixture });
    assert.equal(r.outcome, "block");
    assert.ok(r.triggers.some((t) => t.type === "commit-msg-guard-loosening"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ADR-TRIPWIRE-STANDING-WAIVER: head-pinned standing lines and the
// standingAuthorizations policy trigger
// ---------------------------------------------------------------------------

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const standingLine = (head) => `adr-tripwire:allow standing-authorization head=${head} issue=7 granted-by=operator expires=2026-12-01 paths=${CONTRACT_DOC}`;
const contractTouch = (prBody, headSha, now = new Date("2026-10-04T12:00:00Z")) => computeAdrTripwire({
  nameStatusOutput: ns(["M\t" + CONTRACT_DOC]),
  baseContents: { [CONTRACT_DOC]: BASE_CONTRACT },
  headContents: { [CONTRACT_DOC]: HEAD_CONTRACT_PROSE_ONLY },
  prBody,
  headSha,
  now,
});

test("a standing-authorization line is valid through its expires day (UTC) and stale after", () => {
  assert.equal(contractTouch(`${standingLine(HEAD_A)}\n`, HEAD_A, new Date("2026-12-01T23:59:59Z")).outcome, "pass");
  const stale = contractTouch(`${standingLine(HEAD_A)}\n`, HEAD_A, new Date("2026-12-02T00:00:00Z"));
  assert.equal(stale.outcome, "block");
  assert.equal(stale.waiver.stale, true);
});

test("a standing-authorization line with a missing or invalid expires blocks as stale", () => {
  for (const expires of ["", "expires=soon", "expires=2026-02-30", "expires=2026-12-01T00:00:00Z", "expires=12/01/2026"]) {
    const line = `adr-tripwire:allow standing-authorization head=${HEAD_A} issue=7 granted-by=operator ${expires} paths=${CONTRACT_DOC}`;
    const r = contractTouch(`${line}\n`, HEAD_A);
    assert.equal(r.outcome, "block", expires);
    assert.equal(r.waiver.stale, true, expires);
  }
});

test("a standing-authorization waiver passes at the head it names", () => {
  const r = contractTouch(`Body\n\n${standingLine(HEAD_A)}\n`, HEAD_A);
  assert.equal(r.outcome, "pass");
  assert.equal(r.satisfiedBy, "waiver");
  assert.equal(r.waiver.standing, true);
});

test("a standing-authorization waiver blocks at a different head (a later push makes it stale)", () => {
  const r = contractTouch(`Body\n\n${standingLine(HEAD_A)}\n`, HEAD_B);
  assert.equal(r.outcome, "block");
  assert.equal(r.waiver.stale, true);
  assert.ok(r.reasons.some((x) => /waive-adr-tripwire/.test(x)));
});

test("a standing-authorization line at the right head blocks when a current trigger is unlisted or not a contract-doc", () => {
  const other = "skills/docs/other-contract.md";
  const run = (extra, contents = {}) => computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + CONTRACT_DOC, ...extra]),
    baseContents: { [CONTRACT_DOC]: BASE_CONTRACT, ...contents },
    headContents: { [CONTRACT_DOC]: HEAD_CONTRACT_PROSE_ONLY, ...contents },
    prBody: `${standingLine(HEAD_A)}\n`,
    headSha: HEAD_A,
    now: new Date("2026-10-04T12:00:00Z"),
  });
  for (const extra of [["M\t" + other], ["M\tpackages/core/src/config/extension-defaults.yaml"]]) {
    const r = run(extra, { [other]: BASE_CONTRACT });
    assert.equal(r.outcome, "block", extra[0]);
    assert.equal(r.waiver.stale, true, extra[0]);
  }
});

test("a standing-authorization line with no well-formed head, or no evaluated head, blocks (fail closed)", () => {
  assert.equal(contractTouch("adr-tripwire:allow standing-authorization issue=7\n", HEAD_A).outcome, "block");
  assert.equal(contractTouch(`${standingLine(HEAD_A)}\n`, null).outcome, "block");
  assert.equal(contractTouch(`${standingLine(HEAD_A)}\n`, undefined).outcome, "block");
});

test("a hand-written adr-tripwire:allow <reason> line keeps today's semantics at any head", () => {
  const r = contractTouch("adr-tripwire:allow operator reviewed this contract edit\n", HEAD_B);
  assert.equal(r.outcome, "pass");
  assert.equal(r.satisfiedBy, "waiver");
  assert.deepEqual(r.waiver, { requested: true, valid: true, reason: "operator reviewed this contract edit" });
});

const POLICY_HEAD = "version: 1\nstandingAuthorizations:\n  adrTripwireWaiver:\n    grantedBy: operator\n    grantedAt: '2026-10-01'\n    expires: '2026-12-01'\n    reason: contract edits\n";
const policyChange = (prBody, adr) => computeAdrTripwire({
  nameStatusOutput: ns(["M\t" + DEVLOOPS_CONFIG_PATH, ...(adr ? ["A\t" + ADR_FILE] : [])]),
  baseContents: { [DEVLOOPS_CONFIG_PATH]: "version: 1\n" },
  headContents: { [DEVLOOPS_CONFIG_PATH]: POLICY_HEAD },
  prBody,
  headSha: HEAD_A,
});

test("a standingAuthorizations change is a trigger only a decision record satisfies", () => {
  const blocked = policyChange("adr-tripwire:allow operator waiver\n", false);
  assert.equal(blocked.outcome, "block");
  assert.ok(blocked.triggers.some((t) => t.type === "standing-authorizations-change"));
  assert.equal(policyChange(`${standingLine(HEAD_A)}\n`, false).outcome, "block");
  const satisfied = policyChange("", true);
  assert.equal(satisfied.outcome, "pass");
  assert.equal(satisfied.satisfiedBy, "adr");
});

test("a .devloops change that leaves the standingAuthorizations block untouched does not trigger the policy gate", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["M\t" + DEVLOOPS_CONFIG_PATH]),
    baseContents: { [DEVLOOPS_CONFIG_PATH]: POLICY_HEAD },
    headContents: { [DEVLOOPS_CONFIG_PATH]: POLICY_HEAD + "autonomy:\n  humanMergeOnly: true\n" },
    prBody: "",
  });
  assert.equal(r.outcome, "pass");
  assert.deepEqual(r.triggers, []);
});

test("evaluateAdrTripwire resolves the head ref to its full SHA for the standing-line pin", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "adr-standing-"));
  try {
    const fixture = path.join(tmp, "repo");
    await mkdir(path.join(fixture, "skills/docs"), { recursive: true });
    execSync("git init -q -b main && git config user.email t@t && git config user.name t && echo base > base.md && git add . && git commit -qm base && git branch base", { cwd: fixture, stdio: "ignore" });
    await writeFile(path.join(fixture, "skills/docs/new-contract.md"), "# New contract\n\nProse.\n");
    execSync("git add . && git commit -qm head", { cwd: fixture, stdio: "ignore" });
    const sha = execSync("git rev-parse HEAD", { cwd: fixture }).toString().trim();
    const atHead = await evaluateAdrTripwire({ base: "base", head: "HEAD", repoRoot: fixture, prBody: `${standingLine(sha)}`.replace(CONTRACT_DOC, "skills/docs/new-contract.md") + "\n", now: new Date("2026-10-04T12:00:00Z") });
    assert.equal(atHead.outcome, "pass");
    const stale = await evaluateAdrTripwire({ base: "base", head: "HEAD", repoRoot: fixture, prBody: `${standingLine(HEAD_B)}\n`, now: new Date("2026-10-04T12:00:00Z") });
    assert.equal(stale.outcome, "block");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("deleting a shadowing .devloops that exposes a shadowed standingAuthorizations record is a policy trigger", () => {
  const r = computeAdrTripwire({
    nameStatusOutput: ns(["D\t" + DEVLOOPS_CONFIG_PATH]),
    baseContents: { [DEVLOOPS_CONFIG_PATH]: "version: 1\n", ".devloops.yaml": POLICY_HEAD },
    headContents: { ".devloops.yaml": POLICY_HEAD },
    prBody: "",
    headSha: HEAD_A,
  });
  assert.equal(r.outcome, "block");
  assert.ok(r.triggers.some((t) => t.type === "standing-authorizations-change"));
});

test("evaluateAdrTripwire: base contents are read at the merge base, not the base tip", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "adr-mergebase-"));
  try {
    const run = (c) => execSync(c, { cwd: tmp, stdio: "ignore" });
    run("git init -q -b main && git config user.email t@t && git config user.name t");
    await writeFile(path.join(tmp, DEVLOOPS_CONFIG_PATH), "version: 1\n");
    run("git add . && git commit -qm base && git checkout -qb feature");
    await writeFile(path.join(tmp, DEVLOOPS_CONFIG_PATH), "version: 1\nautonomy: x\n");
    run("git add . && git commit -qm head && git checkout -q main");
    await writeFile(path.join(tmp, DEVLOOPS_CONFIG_PATH), POLICY_HEAD);
    run("git add . && git commit -qm grant && git checkout -q feature");
    const r = await evaluateAdrTripwire({ base: "main", head: "feature", repoRoot: tmp });
    assert.ok(!r.triggers.some((t) => t.type === "standing-authorizations-change"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
