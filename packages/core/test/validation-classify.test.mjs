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
    ["npm --prefix . test", "full-repository"],
    ["pnpm --dir . test", "full-repository"],
    ["bun --cwd . run verify", "full-repository"],
    ["bun --cwd . run test:core", "targeted"],
    ["yarn run test:all", "targeted"],
    ["env -u FOO CI=1 timeout 600 bun run verify", "full-repository"],
    ["command /usr/local/bin/bun scripts/verify.mjs", "full-repository"],
    ["bun ./scripts/verify.mjs", "full-repository"],
    ["bun scripts/../scripts/verify.mjs", "full-repository"],
    ["node scripts/x/../../scripts/verify.mjs", "full-repository"],
    ["./scripts/verify.mjs", "full-repository"],
    ["bun test", "full-repository"],
    ["bun scripts/run-bun-test.mjs --all", "targeted"],
    ["bun scripts/run-bun-test.mjs", "targeted"],
    ["bun scripts/run-bun-test.mjs --dots", "targeted"],
    ["bun run test:all && bun run test:docs && bun run test:workflows", "full-repository"],
    ["bun scripts/run-bun-test.mjs --all && bun run test:docs && bun run test:workflows", "full-repository"],
    ["bun scripts/run-bun-test.mjs && bun run test:docs && bun run test:workflows", "full-repository"],
    ["bun scripts/run-bun-test.mjs --dots && bun run test:docs && bun run test:workflows", "full-repository"],
    ["bun scripts/run-bun-test.mjs packages/core/test/foo.test.mjs && bun run test:docs && bun run test:workflows", "targeted"],
    ["bun run test:core", "targeted"],
    ["pnpm run test:playwright:viewer", "targeted"],
    ["nice -n 10 bun scripts/run-bun-test.mjs packages/core/test/foo.test.mjs", "targeted"],
    ["bun test packages/core/test/foo.test.mjs", "targeted"],
    ["bun test --coverage", "full-repository"],
    ["bun test --timeout 3000", "full-repository"],
    ["bun test --filter test/foo.test.mjs", "full-repository"],
    ["bun test test/foo.test.mjs --timeout 3000", "targeted"],
    ["node --test test/loop/foo.test.mjs", "targeted"],
    ["node --test --test-reporter spec", "full-repository"],
    ["node --test --test-name-pattern foo.test.js", "full-repository"],
    ["vitest run --coverage", "full-repository"],
    ["vitest run test/widget.spec.ts", "targeted"],
    ["bun run test:core && bun run test:scripts", "targeted"],
    ["bun run test:core && bun run test:scripts && bun run test:assets && bun run test:extension && bun run test:dev-loop && bun run test:pack && bun run test:docs && bun run test:workflows", "full-repository"],
    ["echo ready; bun run test:docs", "targeted"],
  ];
  for (const [command, expected] of cases) assert.equal(classifyValidationCommand(command), expected, command);
});

test("changed surfaces select existing checks and unknown or mixed changes fail closed", () => {
  const cases = [
    [["packages/core/src/loop/validation-classify.mjs"], ["bun run assets:check", "bun run test:core"], ["assets:check", "test:core"]],
    [["packages/core/src/loop/run-context.mjs"], ["bun run assets:check", "bun run test:core"], ["assets:check", "test:core"]],
    [["packages/core/package.json"], ["bun run test:core", "bun run test:pack"], ["test:core", "test:pack"]],
    [["packages/core/test/foo.test.mjs"], ["bun scripts/run-bun-test.mjs packages/core/test/foo.test.mjs"], ["test:core"]],
    [["scripts/loop/run-gate-validation.mjs"], ["bun run test:scripts"], ["test:scripts"]],
    [["scripts/claude/generate-claude-assets.mjs"], ["bun run assets:check", "bun run test:doc-guard"], ["assets:check", "test:doc-guard"]],
    [["test/loop/run-gate-validation.test.mjs"], ["bun scripts/run-bun-test.mjs test/loop/run-gate-validation.test.mjs"], ["test:scripts"]],
    [["skills/docs/validation-contract.md"], ["bun run test:doc-guard", "bun run test:docs"], ["test:doc-guard", "test:docs"]],
    [["skills/loop-grill/SKILL.md"], ["bun run test:doc-guard", "bun run test:docs"], ["test:doc-guard", "test:docs"]],
    [["skills/loop-grill/SKILL.md", "skills/docs/validation-contract.md"], ["bun run test:doc-guard", "bun run test:docs"], ["test:doc-guard", "test:docs"]],
    [[".github/workflows/ci.yml"], ["bun run test:workflows"], ["test:workflows"]],
    [["extension/index.ts"], ["bun run test:extension"], ["test:extension"]],
    [[".claude/agents/judge.md"], ["bun run assets:check", "bun run test:assets"], ["assets:check", "test:assets"]],
    [["scripts/loop/inspect-run-viewer/client.mjs"], ["bun run test:playwright:viewer"], ["test:playwright:viewer"]],
    [["scripts/loop/inspect-run-viewer.mjs"], ["bun run test:playwright:viewer"], ["test:playwright:viewer"]],
    [["docs/presentations/dev-loops-deep-dive.html"], ["bun run test:playwright:deep-dive"], ["test:playwright:deep-dive"]],
    [["docs/articles/introducing-dev-loops.html"], ["bun run test:playwright:intro-article"], ["test:playwright:intro-article"]],
    [["test/playwright/deep-dive-deck.spec.mjs"], ["bun run test:playwright:deep-dive"], ["test:playwright:deep-dive"]],
    [["test/playwright/how-decided-article.spec.mjs"], ["bun run test:playwright:how-decided-article"], ["test:playwright:how-decided-article"]],
  ];
  for (const [paths, commands, gateSuites] of cases) assert.deepEqual(resolveTargetedValidation(paths), { profile: "targeted", commands, gateSuites }, paths.join(","));
  for (const paths of [[], ["mystery.bin"], ["docs/articles/new-page.html"], ["test/playwright/ui-review-drive.spec.mjs"], ["skills/loop-grill/references/SKILL.md"], ["skills/loop-grill/notes.md"], ["packages/core/src/x.mjs", "extension/index.ts"], ["packages/core/test/a;touch pwn.test.mjs"], ["test/loop/a;touch pwn.test.mjs"]]) {
    assert.deepEqual(resolveTargetedValidation(paths), { profile: "full-repository", commands: [], gateSuites: [] });
  }
  const paths = ["packages/core/src/loop/validation-classify.mjs", "packages/core/test/foo.test.mjs"];
  const expected = { profile: "targeted", commands: ["bun run assets:check", "bun run test:core", "bun scripts/run-bun-test.mjs packages/core/test/foo.test.mjs"], gateSuites: ["assets:check", "test:core"] };
  assert.deepEqual(resolveTargetedValidation(paths), expected);
  assert.deepEqual(resolveTargetedValidation(paths.toReversed()), expected);
});
