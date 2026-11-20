// OPERATOR-DECISION-RECORDER: the shipped settings put the recorder under `permissions.ask`, which Claude
// Code applies before `allow` in every mode. Pinned against https://code.claude.com/docs/en/permissions.md:
// a `*` may sit anywhere in a Bash rule and matches any text, spaces included.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

import { RECORDER_ASK_RULES } from "../../lib/dev-loops-core.mjs";

const settings = JSON.parse(fs.readFileSync(path.resolve(fileURLToPath(new URL("../../", import.meta.url)), ".claude/settings.json"), "utf8"));
const [PLAIN, REPO_ROOT] = RECORDER_ASK_RULES;

// The documented semantics: the rule body between `Bash(` and `)` with `*` as "any text".
const matches = (rule, command) => {
  const body = /^Bash\((.*)\)$/s.exec(rule)[1];
  return new RegExp(`^${body.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s").test(command);
};

test("both recorder patterns are in the shipped permissions.ask", () => {
  assert.deepEqual(RECORDER_ASK_RULES, ["Bash(dev-loops-run cli/index.mjs decision record *)", "Bash(dev-loops-run --repo-root * cli/index.mjs decision record *)"]);
  for (const rule of RECORDER_ASK_RULES) assert.ok(settings.permissions.ask.includes(rule), rule);
});

test("no recorder pattern is under permissions.allow", () => {
  assert.equal(settings.permissions.allow.filter((rule) => /decision/.test(rule)).length, 0);
});

// README.md records a live observation that a mid-pattern wildcard did not match, which conflicts with the
// official doc. The plain form is a pure prefix match and the --repo-root form stays hook-denied until a live
// session verifies the mid-pattern match (ADR 0295); both ask patterns still ship.
test("the plain ask pattern is a pure prefix match with no mid-pattern wildcard", () => {
  assert.equal(PLAIN.indexOf("*"), PLAIN.length - 2);
  assert.ok(REPO_ROOT.indexOf("*") < REPO_ROOT.length - 2);
});

test("the ask patterns match the canonical spellings under the documented semantics (a pin, not a live check)", () => {
  const tail = "decision record --repo o/n --target pr 5 --kind accept --head x --operator-answer-file a.json --body-file b.md";
  assert.ok(matches(PLAIN, `dev-loops-run cli/index.mjs ${tail}`));
  assert.ok(!matches(PLAIN, `node cli/index.mjs ${tail}`));
});
