import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "bun:test";

import { runCli } from "../../cli/index.mjs";
import { indexDecisionRecords, lintSimplestDesign, lintSizeForecast, lintSpec, main } from "../../scripts/loop/spec-lint.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// A valid forecast line, so the citation tests see only their own findings.
const FORECAST = "\n\n## Simplest design\n\nMinimal.\n\n## Size forecast\n\n- forecast: slice=1 wloc=200 files=a.mjs\n";
const lint = ({ body, repoRoot }) => lintSpec({ body: `${body}${FORECAST}`, repoRoot });

function record(status) {
  return `# Title\n\n## Status\n\n${status}\n\n## Context\n\nText.\n`;
}

async function fixtureRepo({ rules = { requiredRules: [{ id: "KNOWN-RULE-ID" }], optOutRules: [] }, decisions = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "spec-lint-"));
  tempDirs.push(root);
  if (rules !== null) {
    await mkdir(path.join(root, "skills", "docs"), { recursive: true });
    await writeFile(path.join(root, "skills", "docs", "required-rules.json"), typeof rules === "string" ? rules : JSON.stringify(rules));
  }
  if (decisions !== null) {
    await mkdir(path.join(root, "docs", "decisions"), { recursive: true });
    for (const [name, status] of Object.entries(decisions)) {
      await writeFile(path.join(root, "docs", "decisions", name), record(status));
    }
  }
  return root;
}

function buffer() {
  let text = "";
  return { stream: new Writable({ write(chunk, _enc, cb) { text += chunk; cb(); } }), read: () => text };
}

test("only an unregistered rule ID gets unknown_rule_id", async () => {
  const root = await fixtureRepo({ rules: { requiredRules: [{ id: "KNOWN-RULE-ID" }], optOutRules: [{ id: "OPTOUT-RULE-ID" }] } });
  const body = [
    "Cites `KNOWN-RULE-ID`, OPTOUT-RULE-ID, a FAIL-CLOSED path and ADR-0012.",
    "Also cites MISSING-RULE-ID.",
    "```",
    "FENCED-RULE-ID",
    "```",
    "~~~~",
    "```",
    "IN-FENCE-RULE",
    "~~~~",
    "AFTER-FENCE-RULE",
  ].join("\n");
  const result = await lint({ body, repoRoot: root });
  assert.deepEqual(result.findings.map(({ kind, id }) => ({ kind, id })), [
    { kind: "unknown_rule_id", id: "MISSING-RULE-ID" },
    { kind: "unknown_rule_id", id: "AFTER-FENCE-RULE" },
    { kind: "unknown_adr", id: "0012" },
  ]);
  assert.deepEqual(result.checks.rules, { status: "ran" });
});

test("ADR existence and status findings carry their detail", async () => {
  const root = await fixtureRepo({
    decisions: {
      "0001-accepted.md": "Accepted — 2026-01-01",
      "0002-proposed.md": "Proposed",
      "0003-old.md": "Superseded by [0004](0004-new.md) — 2026-02-01 ([PR 12](https://example.com/pull/12))",
      "0004-new.md": "Accepted — 2026-02-01",
    },
  });
  const body = "See ADR 0001, ADR 0002, [the old record](docs/decisions/0003-old.md) and ADR 0009.";
  const { findings } = await lint({ body, repoRoot: root });
  assert.deepEqual(findings.map(({ kind, id }) => `${kind}:${id}`).sort(), ["adr_not_accepted:0002", "adr_superseded:0003", "unknown_adr:0009"]);
  assert.equal(findings.find((f) => f.kind === "adr_superseded").detail.supersededBy, "0004");
  assert.match(findings.find((f) => f.kind === "adr_not_accepted").detail.status, /^Proposed/);
  assert.match(findings.find((f) => f.kind === "unknown_adr").detail.reason, /0009/);
});

test("adr_amended names each amender and whether the body cites it", async () => {
  const root = await fixtureRepo({
    decisions: {
      "0010-base.md": "Accepted — 2026-01-01",
      "0011-first.md": "Accepted — 2026-01-02\n\nAmends [0010](./0010-base.md): narrows it.",
      "0012-second.md": "Accepted — 2026-01-03\n\nIt partially amends ADR 0010.",
      "0013-draft.md": "Proposed\n\nAmends ADR 0010.",
    },
  });
  const { findings } = await lint({ body: "Follows ADR 0010 and ADR 0011.", repoRoot: root });
  assert.deepEqual(findings, [{
    kind: "adr_amended",
    id: "0010",
    detail: { amenders: [
      { id: "0011", file: "0011-first.md", amenderCited: true },
      { id: "0012", file: "0012-second.md", amenderCited: false },
    ] },
  }]);
});

test("an (Amended by M) annotation in the target Status creates the edge", async () => {
  const root = await fixtureRepo({
    decisions: {
      "0001-base.md": "Accepted (amended by ADR 0002)",
      "0002-amender.md": "Accepted — 2026-01-02",
    },
  });
  const { findings } = await lint({ body: "Follows ADR 0001.", repoRoot: root });
  assert.deepEqual(findings.map(({ kind, id }) => `${kind}:${id}`), ["adr_amended:0001"]);
});

test("records numbered 1000 or higher create amendment edges", async () => {
  const root = await fixtureRepo({
    decisions: {
      "0999-base.md": "Accepted — 2026-01-01",
      "1000-mid.md": "Accepted — 2026-01-02\n\nAmends ADR 0999.",
      "1001-late.md": "Accepted — 2026-01-03\n\nAmends [1000](./1000-mid.md).",
    },
  });
  const records = await indexDecisionRecords(path.join(root, "docs", "decisions"));
  assert.deepEqual([...records.get("1000").amends], ["0999"]);
  assert.deepEqual([...records.get("1000").amendedBy], ["1001"]);
  const { findings } = await lint({ body: "Follows ADR 0999 and docs/decisions/1000-mid.md.", repoRoot: root });
  assert.deepEqual(findings.map(({ kind, id, detail }) => `${kind}:${id}:${detail.amenders.map((a) => a.id).join(",")}`), [
    "adr_amended:0999:1000",
    "adr_amended:1000:1001",
  ]);
});

test("a year in a Status section creates no edge without a matching record", async () => {
  const root = await fixtureRepo({
    decisions: {
      "0001-base.md": "Accepted — 2026-01-01",
      "0002-other.md": "Accepted — 2026-01-02\n\nAmends 2026 guidance; amended by 2026 review.",
    },
  });
  const records = await indexDecisionRecords(path.join(root, "docs", "decisions"));
  assert.deepEqual([...records.values()].map((r) => [r.id, [...r.amends], [...r.amendedBy]]), [["0001", [], []], ["0002", [], []]]);
});

test("the amendment parser matches this repo's decision records", async () => {
  const records = await indexDecisionRecords(path.join(repoRoot, "docs", "decisions"));
  const amends = (id) => records.get(id).amends;
  for (const target of ["0021", "0070"]) assert.ok(amends("0086").has(target), `0086 amends ${target}`);
  for (const target of ["0086", "0048", "0056", "0083", "0047"]) assert.ok(amends("0095").has(target), `0095 amends ${target}`);
  assert.ok(!amends("0095").has("0039"));
  assert.ok(amends("0069").has("0056"));
  assert.ok(!amends("0069").has("0049"));
  assert.equal(amends("0100").size, 0);
  assert.ok(amends("0081").has("0074"));
  assert.ok(amends("0072").has("0048"), "0072 amends 0048");
});

test("a missing or non-directory --repo-root exits 1", async () => {
  const root = await fixtureRepo();
  const bodyFile = path.join(root, "body.md");
  await writeFile(bodyFile, "text");
  for (const badRoot of [path.join(root, "nope"), bodyFile]) {
    const stdout = buffer();
    const stderr = buffer();
    assert.equal(await main(["--body-file", bodyFile, "--repo-root", badRoot], { stdout: stdout.stream, stderr: stderr.stream }), 1);
    assert.match(stderr.read(), /not an existing directory/);
    assert.equal(stdout.read(), "");
  }
});

test("an unreadable decision record exits 2 and names the file", async () => {
  const root = await fixtureRepo({ decisions: { "0001-ok.md": "Accepted — 2026-01-01" } });
  await symlink(path.join(root, "gone.md"), path.join(root, "docs", "decisions", "0002-dangling.md"));
  const bodyFile = path.join(root, "body.md");
  await writeFile(bodyFile, "ADR 0001");
  const stderr = buffer();
  assert.equal(await main(["--body-file", bodyFile, "--repo-root", root], { stdout: buffer().stream, stderr: stderr.stream }), 2);
  assert.match(stderr.read(), /0002-dangling\.md/);
});

test("a wrong-shape registry exits 2 as malformed", async () => {
  for (const rules of [{ requiredRules: {} }, { requiredRules: [], optOutRules: {} }]) {
    const root = await fixtureRepo({ rules });
    const bodyFile = path.join(root, "body.md");
    await writeFile(bodyFile, "text");
    const stderr = buffer();
    assert.equal(await main(["--body-file", bodyFile, "--repo-root", root], { stdout: buffer().stream, stderr: stderr.stream }), 2);
    assert.match(stderr.read(), /Malformed registry/);
  }
});

test("the #2438 and #2528 failures reproduce against this repo", async () => {
  const rules = await lint({
    body: "Cites GATE-EXEC-VALIDATION-ARTIFACT, COORDINATOR-VERIFY-DELEGATION and VALIDATE-TARGETED-FIRST.",
    repoRoot,
  });
  assert.deepEqual(rules.findings.map(({ kind, id }) => `${kind}:${id}`), [
    "unknown_rule_id:GATE-EXEC-VALIDATION-ARTIFACT",
    "unknown_rule_id:COORDINATOR-VERIFY-DELEGATION",
  ]);
  const adrs = await lint({ body: "The ADR 0070 entry cap applies.", repoRoot });
  const amended = adrs.findings.find((f) => f.kind === "adr_amended" && f.id === "0070");
  assert.ok(amended.detail.amenders.some((a) => a.id === "0086" && a.amenderCited === false));
});

test("a missing registry or decisions directory skips that check", async () => {
  const noRules = await lint({ body: "ADR 0001 and SOME-RULE-ID", repoRoot: await fixtureRepo({ rules: null }) });
  assert.equal(noRules.checks.rules.status, "skipped");
  assert.match(noRules.checks.rules.reason, /required-rules\.json/);
  assert.deepEqual(noRules.checks.adrs, { status: "ran" });
  const noAdrs = await lint({ body: "ADR 0001", repoRoot: await fixtureRepo({ decisions: null }) });
  assert.equal(noAdrs.checks.adrs.status, "skipped");
  assert.match(noAdrs.checks.adrs.reason, /docs\/decisions/);
  assert.deepEqual(noAdrs.findings, []);
});

test("a malformed registry exits 2", async () => {
  const root = await fixtureRepo({ rules: "{ not json" });
  const bodyFile = path.join(root, "body.md");
  await writeFile(bodyFile, "text");
  const stdout = buffer();
  const stderr = buffer();
  assert.equal(await main(["--body-file", bodyFile, "--repo-root", root], { stdout: stdout.stream, stderr: stderr.stream }), 2);
  assert.match(stderr.read(), /Malformed JSON/);
  assert.equal(stdout.read(), "");
});

test("main prints one JSON object and exits 0 with findings", async () => {
  const root = await fixtureRepo();
  const bodyFile = path.join(root, "body.md");
  await writeFile(bodyFile, "MISSING-RULE-ID");
  const stdout = buffer();
  assert.equal(await main(["--body-file", bodyFile, "--repo-root", root], { stdout: stdout.stream, stderr: buffer().stream }), 0);
  const parsed = JSON.parse(stdout.read());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.findings[0].kind, "unknown_rule_id");
});

test("the CLI route prints help and rejects bad input", async () => {
  const run = (argv) => runCli({ argv, stdout: buffer().stream, stderr: buffer().stream, cwd: repoRoot });
  assert.equal(await run(["loop", "spec-lint", "--help"]), 0);
  assert.equal(await run(["loop", "spec-lint", "--bogus"]), 1);
  assert.equal(await run(["loop", "spec-lint"]), 1);
});

const forecastLine = (slice, wloc) => `- forecast: slice=${slice} wloc=${wloc} files=a.mjs,b.mjs`;
const sizeKinds = (findings) => findings.filter((f) => f.kind.startsWith("size_forecast_")).map(({ kind, id }) => `${kind}:${id}`);

test("size forecast: no line gives size_forecast_missing", async () => {
  const root = await fixtureRepo();
  for (const body of ["no forecast here", "## Size forecast\n\nprose only", `${forecastLine(1, 100)}\n(outside the section)`, `## Size forecast\n\n~~~\n${forecastLine(1, 100)}\n~~~`]) {
    assert.deepEqual(sizeKinds((await lintSpec({ body, repoRoot: root })).findings), ["size_forecast_missing:size-forecast"]);
  }
});

test("size forecast: two lines under waiverLoc pass; a line at or above it gives size_forecast_split_required", async () => {
  const root = await fixtureRepo();
  const run = (...lines) => lintSpec({ body: `## Size forecast\n\n${lines.join("\n")}\n\nwLOC: note`, repoRoot: root });
  assert.deepEqual(sizeKinds((await run(forecastLine(1, 240), forecastLine(2, 235))).findings), []);
  assert.deepEqual(sizeKinds((await run(forecastLine(1, 1499))).findings), []);
  assert.deepEqual(sizeKinds((await run(forecastLine(1, 1500), forecastLine("b", 1501), forecastLine(3, 10))).findings), ["size_forecast_split_required:1", "size_forecast_split_required:b"]);
});

test("size forecast: a malformed forecast bullet next to a valid one is a size_forecast_malformed finding, not dropped", async () => {
  const root = await fixtureRepo();
  const valid = "- forecast: slice=1 wloc=200 files=a.mjs";
  const run = (...lines) => lintSpec({ body: `## Size forecast\n\n${lines.join("\n")}`, repoRoot: root });
  for (const line of [
    "- forecast: slice=2 wloc=1800 files=a.mjs, b.mjs",
    "- forecast: slice=2 wloc=1,600 files=a.mjs",
    "- forecast: slice=2 wloc=1600 files=a.mjs trailing note",
    "* forecast: slice=2 wloc=1600 files=a.mjs",
    "- forecast: slice=2 wloc=1600 files=",
    "- Forecast: slice=2 wloc=1800 files=b.mjs",
    "+ forecast: slice=2 wloc=1800 files=b.mjs",
    "1. forecast: slice=2 wloc=1800 files=b.mjs",
    "1) forecast: slice=2 wloc=1800 files=b.mjs",
    "* FORECAST: slice=2 wloc=1800 files=b.mjs",
    "- forecast slice=2 wloc=1800 files=b.mjs",
    "- forecast : slice=2 wloc=1800 files=b.mjs",
    "- Forecast slice=2 wloc=1800 files=b.mjs",
    "- slice=2 wloc=1800 files=b.mjs",
    "1. forecast slice=2 wloc=1800 files=b.mjs",
    "- wloc=1800 slice=2 files=b.mjs",
    "- slice = 2 wloc = 1800 files=b.mjs",
    "- wloc=1800 files=b.mjs",
    "- slice 2: wloc=1800 files=b.mjs",
    "- forecast (slice 2): wloc=1800 files=b.mjs",
    // Accepted fail-closed cost: a list-item prose line containing `wloc =` is claimed.
    "- note: wloc = 130 here",
  ]) {
    const { findings } = await run(valid, line);
    assert.deepEqual(sizeKinds(findings), ["size_forecast_malformed:size-forecast"], line);
    assert.deepEqual(findings.find((f) => f.kind === "size_forecast_malformed").detail, { line }, line);
  }
  // Accepted forms stay clean, including a comma-joined files list.
  assert.deepEqual(sizeKinds((await run(valid, "- forecast: slice=2 wloc=1800 files=a.mjs,b.mjs")).findings), ["size_forecast_split_required:2"]);
  assert.deepEqual(sizeKinds((await run(valid)).findings), []);
  // Non-list lines are never claimed, even when they look like a forecast.
  assert.deepEqual(sizeKinds((await run(valid, "wLOC = source + 0.25 × test: 130 + 440 and 85 + 600.", "Each slice = one PR.", "Forecast: two slices, both under budget.", "Forecast is below", "The forecast for slice 2 is below.", "forecast: slice=2 wloc=1800 files=b.mjs", "slice=2 wloc=1800 files=b.mjs")).findings), []);
  // A malformed bullet with no valid line still reports the missing forecast too.
  assert.deepEqual(sizeKinds((await run("- forecast: slice=2 wloc=1800 files=a.mjs, b.mjs")).findings), ["size_forecast_missing:size-forecast", "size_forecast_malformed:size-forecast"]);
});

test("simplest design: a Size forecast body without the section gives simplest_design_missing; the section, a fenced heading, or no forecast section behave as stated", () => {
  const forecast = "## Size forecast\n\n- forecast: slice=1 wloc=10 files=a.mjs";
  assert.deepEqual(lintSimplestDesign(forecast).map((f) => f.kind), ["simplest_design_missing"]);
  assert.deepEqual(lintSimplestDesign(`${forecast}\n\n## Simplest design\n\nMinimal approach.`), []);
  assert.deepEqual(lintSimplestDesign(`## Simplest design\n\nx\n\n${forecast}`), []);
  assert.deepEqual(lintSimplestDesign(`${forecast}\n\n\`\`\`\n## Simplest design\n\`\`\``).map((f) => f.kind), ["simplest_design_missing"]);
  assert.deepEqual(lintSimplestDesign("## Objective\n\nNo forecast here."), []);
  assert.deepEqual(lintSimplestDesign(`${forecast}\n\n## Simplest design\n\n`).map((f) => f.kind), ["simplest_design_missing"]);
});

test("only cli/index.mjs wires the spec-lint lint surface; other files may reuse its pure helpers", () => {
  const files = execFileSync("git", ["ls-files", "scripts", "packages", "cli"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n").filter((f) => /\.mjs$/u.test(f) && !f.includes("node_modules") && !/\.test\.mjs$/u.test(f) && f !== "cli/index.mjs" && f !== "scripts/loop/spec-lint.mjs");
  // The guard forbids a SECOND LINT ENTRY POINT (authority drift), not helper reuse:
  // `lintSpec` and the `loop spec-lint` argv are the lint surface, while e.g.
  // scripts/loop/implementation-brief.mjs imports only pure parsers (citedAdrNumbers,
  // indexDecisionRecords, loadKnownRuleIds, stripFencedCode), which is not an entry point.
  // Match the entry symbol, a quoted spec-lint argv/module-path token (runCli / execFile /
  // spawn / import), and a `[dev-loops] loop spec-lint` shell invocation (including the
  // `cli/index.mjs loop spec-lint` forms) — a prose mention of the subcommand is not
  // wiring. If spec-lint's entry export is ever renamed, update the `lintSpec` token here
  // together with the export.
  const consumer = /lintSpec\b|["'`](?:[^"'`\s]*\/)?spec-lint(?:\.mjs)?["'`]|\b(?:dev-loops\s+)?loop\s+spec-lint\b|cli\/index\.mjs\s+loop\s+spec-lint\b/u;
  // The one declared pure-helper consumer: it may import only these parsers, never the
  // entry points `lintSpec` or `main`, and its comments may name the subcommand.
  const HELPER_CONSUMER = "scripts/loop/implementation-brief.mjs";
  const PURE_HELPERS = new Set(["citedAdrNumbers", "indexDecisionRecords", "inForceAmenders", "loadKnownRuleIds", "stripFencedCode"]);
  const IMPORT_RE = /import\s*\{([^}]*)\}\s*from\s*"\.\/spec-lint\.mjs";/u;
  const wired = (f, source) => {
    if (f !== HELPER_CONSUMER) return consumer.test(source);
    const imported = (IMPORT_RE.exec(source)?.[1] ?? "").split(",").map((n) => n.trim()).filter(Boolean);
    if (imported.some((n) => !PURE_HELPERS.has(n))) return true;
    const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "").replace(IMPORT_RE, "");
    return consumer.test(code);
  };
  const offenders = files.filter((f) => wired(f, readFileSync(path.join(repoRoot, f), "utf8")));
  assert.deepEqual(offenders, []);
  for (const form of ['import { lintSpec } from "../loop/spec-lint.mjs";', 'import { main } from "../loop/spec-lint.mjs";', "lintSpec(x)", 'runCli(["loop", "spec-lint", "--body-file", p])', "execFile('dev-loops', ['loop', 'spec-lint'])", "execSync(`dev-loops loop spec-lint --body-file ${p}`)", "execSync(`dev-loops-run cli/index.mjs loop spec-lint --body-file ${p}`)", "execSync(`node <dev-loops-package-root>/cli/index.mjs loop spec-lint ${p}`)", 'execFileSync("node", ["scripts/loop/spec-lint.mjs", "--body-file", p])']) {
    assert.match(form, consumer, form);
  }
  // The helper-consumer carve-out stays narrow: an entry-point import or an invocation is flagged.
  assert.ok(wired(HELPER_CONSUMER, 'import { main } from "./spec-lint.mjs";'));
  assert.ok(wired(HELPER_CONSUMER, 'import { stripFencedCode } from "./spec-lint.mjs";\nspawn("node", ["scripts/loop/spec-lint.mjs"]);'));
  assert.ok(!wired(HELPER_CONSUMER, '// runs `loop spec-lint`\nimport { stripFencedCode } from "./spec-lint.mjs";'));
  assert.doesNotMatch("// the grill (refine-plan-file, spec-lint) reads it", consumer);
});

test("lintSpec reports simplest_design_missing for a Size forecast body without the section, and none with it", async () => {
  const root = await fixtureRepo();
  const forecast = "## Size forecast\n\n- forecast: slice=1 wloc=10 files=a.mjs";
  const kinds = async (body) => (await lintSpec({ body, repoRoot: root })).findings.map((f) => f.kind);
  assert.deepEqual(await kinds(forecast), ["simplest_design_missing"]);
  assert.deepEqual(await kinds(`${forecast}\n\n## Simplest design\n\nMinimal approach.`), []);
});

test("DESIGN-SIMPLEST-FIRST is registered, owned by structural-quality, and cited by the grill, refiner and four agents", async () => {
  const read = (rel) => readFile(path.join(repoRoot, rel), "utf8");
  assert.match(await read("skills/docs/structural-quality.md"), /<!-- rule: DESIGN-SIMPLEST-FIRST -->\n`DESIGN-SIMPLEST-FIRST`: before any code[\s\S]{0,400}rejects[\s\S]{0,200}cost/);
  assert.ok(JSON.parse(await read("skills/docs/required-rules.json")).requiredRules.some((r) => r.id === "DESIGN-SIMPLEST-FIRST"));
  for (const file of ["skills/loop-grill/SKILL.md", "agents/refiner.agent.md"]) {
    assert.match(await read(file), /`## Simplest design` section[\s\S]{0,300}minimal approach[\s\S]{0,100}rejected[\s\S]{0,200}cost comparison/, file);
  }
  assert.match(await read("agents/refiner.agent.md"), /`## Simplest design` section per issue and per slice/);
  assert.match(await read("skills/loop-grill/SKILL.md"), /The synthesized body and every slice also carry a `## Simplest design` section/);
  assert.match(await read("skills/loop-grill/SKILL.md"), /`simplest_design_missing`[\s\S]{0,120}grill or a re-grill[\s\S]{0,200}`size_forecast_\*` findings only/);
  assert.match(await read("skills/loop-grill/SKILL.md"), /`simplest_design_missing` is also not disposable[\s\S]{0,80}only by writing/);
  assert.match(await read("skills/loop-grill/SKILL.md"), /`size_forecast_malformed` or `simplest_design_missing` finding blocks `grill-clean`/);
  for (const file of ["developer", "fixer", "review", "judge"]) {
    assert.match(await read(`agents/${file}.agent.md`), /DESIGN-SIMPLEST-FIRST/, file);
  }
  for (const file of ["review", "judge"]) {
    assert.match(await read(`agents/${file}.agent.md`), /no AC row[\s\S]{0,40}at least `medium`/, file);
  }
});

test("size forecast: a null waiverLoc never reports size_forecast_split_required", () => {
  assert.deepEqual(lintSizeForecast("## Size forecast\n\n- forecast: slice=1 wloc=10 files=a.mjs", { waiverLoc: null }), []);
  assert.deepEqual(lintSizeForecast("## Size forecast\n\n- forecast: slice=1 wloc=1800 files=a.mjs", { waiverLoc: 1500 }).map((f) => f.kind), ["size_forecast_split_required"]);
});

test("size forecast: the split bound moves with a .devloops waiverLoc override", async () => {
  const root = await fixtureRepo();
  const body = `## Size forecast\n\n${forecastLine(1, 600)}`;
  assert.deepEqual(sizeKinds((await lintSpec({ body, repoRoot: root })).findings), []);
  await writeFile(path.join(root, ".devloops"), "version: 1\ngates:\n  size:\n    tiers:\n      default:\n        softLoc: 400\n        waiverLoc: 600\n");
  const { findings } = await lintSpec({ body, repoRoot: root });
  assert.deepEqual(sizeKinds(findings), ["size_forecast_split_required:1"]);
  assert.deepEqual(findings.find((f) => f.kind === "size_forecast_split_required").detail, { wloc: 600, waiverLoc: 600 });
});

test("a broken .devloops exits 2 instead of falling back to the default bounds", async () => {
  const root = await fixtureRepo();
  await writeFile(path.join(root, ".devloops"), "gates:\n  size:\n    tiers:\n      default:\n        waiverLoc: 100\n");
  const bodyFile = path.join(root, "body.md");
  await writeFile(bodyFile, `## Size forecast\n\n${forecastLine(1, 500)}`);
  const stdout = buffer();
  assert.equal(await main(["--body-file", bodyFile, "--repo-root", root], { stdout: stdout.stream, stderr: buffer().stream }), 2);
  assert.equal(stdout.read(), "");
});
