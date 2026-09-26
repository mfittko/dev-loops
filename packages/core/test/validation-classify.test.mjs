import test from "node:test";
import assert from "node:assert/strict";
import { classifyValidationCommand, resolveTargetedValidation } from "../src/loop/validation-classify.mjs";

test("validation commands have one shared classification", () => {
  const cases = [
    ["git status --short", "non-validation"],
    ["cat test/foo.test.mjs", "non-validation"],
    ["bun run lint", "non-validation"],
    ["bun run verify", "full-repository"],
    ["npm test", "full-repository"],
    ["yarn run test:all", "targeted"],
    ["env -u FOO CI=1 timeout 600 bun run verify", "full-repository"],
    ["command /usr/local/bin/bun scripts/verify.mjs", "full-repository"],
    ["bun test", "full-repository"],
    ["bun scripts/run-bun-test.mjs --all", "targeted"],
    ["bun run test:all && bun run test:docs && bun run test:workflows", "full-repository"],
    ["bun scripts/run-bun-test.mjs --all && bun run test:docs && bun run test:workflows", "full-repository"],
    ["bun run test:core", "targeted"],
    ["pnpm run test:playwright:viewer", "targeted"],
    ["nice -n 10 bun scripts/run-bun-test.mjs packages/core/test/foo.test.mjs", "targeted"],
    ["bun test packages/core/test/foo.test.mjs", "targeted"],
    ["bun test --coverage", "full-repository"],
    ["node --test test/loop/foo.test.mjs", "targeted"],
    ["bun run test:core && bun run test:scripts", "targeted"],
    ["bun run test:core && bun run test:scripts && bun run test:assets && bun run test:extension && bun run test:dev-loop && bun run test:pack && bun run test:docs && bun run test:workflows", "full-repository"],
    ["echo ready; bun run test:docs", "targeted"],
  ];
  for (const [command, expected] of cases) assert.equal(classifyValidationCommand(command), expected, command);
});

test("changed surfaces select existing checks and unknown or mixed changes fail closed", () => {
  const cases = [
    [["packages/core/src/loop/validation-classify.mjs"], ["bun run test:core"]],
    [["packages/core/test/foo.test.mjs"], ["bun scripts/run-bun-test.mjs packages/core/test/foo.test.mjs"]],
    [["scripts/loop/run-gate-validation.mjs"], ["bun run test:scripts"]],
    [["test/loop/run-gate-validation.test.mjs"], ["bun scripts/run-bun-test.mjs test/loop/run-gate-validation.test.mjs"]],
    [["skills/docs/validation-contract.md"], ["bun run test:docs", "bun run test:doc-guard"]],
    [[".github/workflows/ci.yml"], ["bun run test:workflows"]],
    [["extension/index.ts"], ["bun run test:extension"]],
    [[".claude/agents/judge.md"], ["bun run assets:check", "bun run test:assets"]],
    [["scripts/loop/inspect-run-viewer/client.mjs"], ["bun run test:playwright:viewer"]],
  ];
  for (const [paths, commands] of cases) assert.deepEqual(resolveTargetedValidation(paths), { profile: "targeted", commands }, paths.join(","));
  for (const paths of [[], ["mystery.bin"], ["packages/core/src/x.mjs", "extension/index.ts"]]) {
    assert.deepEqual(resolveTargetedValidation(paths), { profile: "full-repository", commands: [] });
  }
});
