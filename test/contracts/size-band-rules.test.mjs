import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");
const registry = JSON.parse(read("skills/docs/required-rules.json")).requiredRules;

const OWNERS = {
  "PLAN-SIZE-BAND": "skills/docs/local-planning.md",
  "PRE-PR-SIZE-CHECK": "skills/docs/pre-pr-review-contract.md",
  "LOCAL-DEV-SIZE-STOP": "skills/docs/pre-pr-review-contract.md",
  "RETRO-SIZE-WAIVER-COUNT": "skills/docs/retrospective-checkpoint-contract.md",
};

test("each size rule is registered once and defined once in its owner (and the Claude copy)", () => {
  for (const [id, owner] of Object.entries(OWNERS)) {
    assert.equal(registry.filter((r) => r.id === id).length, 1, id);
    for (const file of [owner, `.claude/${owner}`]) {
      assert.equal(read(file).split(`<!-- rule: ${id} -->`).length, 2, `${id} in ${file}`);
    }
  }
});

test("the grill skill, the refiner and the developer cite the size rules, in source and Claude assets", () => {
  const cites = {
    "skills/loop-grill/SKILL.md": ["PLAN-SIZE-BAND"],
    "agents/refiner.agent.md": ["PLAN-SIZE-BAND"],
    "agents/developer.agent.md": ["PRE-PR-SIZE-CHECK", "LOCAL-DEV-SIZE-STOP"],
  };
  for (const [file, ids] of Object.entries(cites)) {
    const claude = file.startsWith("agents/") ? `.claude/agents/${path.basename(file).replace(".agent", "")}` : `.claude/${file}`;
    for (const id of ids) {
      assert.match(read(file), new RegExp(id), `${id} in ${file}`);
      assert.match(read(claude), new RegExp(id), `${id} in ${claude}`);
    }
  }
});

test("the retrospective template carries the count line with the baseline", () => {
  const template = read("skills/dev-loop/templates/retrospective.md");
  assert.match(template, /size waivers and size merge approvals this milestone: \{\{count\}\}/u);
  assert.match(template, /v1\.0\.6 baseline 10 = 1 waiver \+ 9 size-class approvals/u);
  assert.match(read("skills/docs/retrospective-checkpoint-contract.md"), /v1\.0\.6 baseline is 10/u);
});

test("GRILL-SPEC-LINT forbids disposing the size forecast findings and ADR-TRIPWIRE-EARLY-SURFACE states the refusal exception", () => {
  assert.match(read("skills/loop-grill/SKILL.md"), /`size_forecast_missing` and `size_forecast_split_required`; the grill MUST NOT dispose either one/u);
  assert.match(read("skills/docs/decision-record-contract.md"), /refuses with `size_split_required_before_pr`/u);
});

test("local-planning no longer says splitting is never mandatory", () => {
  assert.doesNotMatch(read("skills/docs/local-planning.md"), /never mandatory/iu);
});
