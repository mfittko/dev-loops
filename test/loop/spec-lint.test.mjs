import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "bun:test";

import { runCli } from "../../cli/index.mjs";
import { indexDecisionRecords, lintSpec, main } from "../../scripts/loop/spec-lint.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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
  const result = await lintSpec({ body, repoRoot: root });
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
  const { findings } = await lintSpec({ body, repoRoot: root });
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
  const { findings } = await lintSpec({ body: "Follows ADR 0010 and ADR 0011.", repoRoot: root });
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
  const { findings } = await lintSpec({ body: "Follows ADR 0001.", repoRoot: root });
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
  const { findings } = await lintSpec({ body: "Follows ADR 0999 and docs/decisions/1000-mid.md.", repoRoot: root });
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
  const rules = await lintSpec({
    body: "Cites GATE-EXEC-VALIDATION-ARTIFACT, COORDINATOR-VERIFY-DELEGATION and VALIDATE-TARGETED-FIRST.",
    repoRoot,
  });
  assert.deepEqual(rules.findings.map(({ kind, id }) => `${kind}:${id}`), [
    "unknown_rule_id:GATE-EXEC-VALIDATION-ARTIFACT",
    "unknown_rule_id:COORDINATOR-VERIFY-DELEGATION",
  ]);
  const adrs = await lintSpec({ body: "The ADR 0070 entry cap applies.", repoRoot });
  const amended = adrs.findings.find((f) => f.kind === "adr_amended" && f.id === "0070");
  assert.ok(amended.detail.amenders.some((a) => a.id === "0086" && a.amenderCited === false));
});

test("a missing registry or decisions directory skips that check", async () => {
  const noRules = await lintSpec({ body: "ADR 0001 and SOME-RULE-ID", repoRoot: await fixtureRepo({ rules: null }) });
  assert.equal(noRules.checks.rules.status, "skipped");
  assert.match(noRules.checks.rules.reason, /required-rules\.json/);
  assert.deepEqual(noRules.checks.adrs, { status: "ran" });
  const noAdrs = await lintSpec({ body: "ADR 0001", repoRoot: await fixtureRepo({ decisions: null }) });
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
