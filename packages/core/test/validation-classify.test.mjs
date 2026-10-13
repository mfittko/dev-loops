import test from "node:test";
import assert from "node:assert/strict";
import { classifyValidationCommand, resolveTargetedValidation } from "../src/loop/validation-classify.mjs";

test("package-manager options preserve validation reach and opaque validation fails closed", () => {
  for (const pm of ["npm", "bun", "pnpm", "yarn"]) {
    for (const options of ["-s", "--loglevel silent", "--loglevel=silent", "--workspace core", "-w core", "--prefix . --dir . --cwd .", "--cache /tmp/cache --registry https://registry.npmjs.org"]) {
      for (const command of [`${pm} ${options} run verify`, `${pm} run ${options} verify`, `${pm} ${options} test`]) assert.equal(classifyValidationCommand(command), "full-repository", command);
      for (const command of [`${pm} ${options} run test:core`, `${pm} run ${options} test:core`]) assert.equal(classifyValidationCommand(command), "targeted", command);
      assert.equal(classifyValidationCommand(`${pm} run ${options} test:all && ${pm} ${options} run test:docs && ${pm} run ${options} test:workflows`), "full-repository");
      assert.equal(classifyValidationCommand(`${pm} ${options} install`), "non-validation");
    }
  }
  for (const command of ["npm run --opaque value verify", "npm --opaque value run verify", "npm run --opaque value test:core"]) assert.equal(classifyValidationCommand(command), "full-repository", command);
  for (const command of ["npm run --opaque value lint", "npm install --opaque value", "npm run lint --opaque verify", "npm -s install verify", "npm --loglevel silent run lint verify"]) assert.equal(classifyValidationCommand(command), "non-validation", command);
});

test("opaque package options cannot hide test aliases or run-script validation", () => {
  for (const pm of ["npm", "pnpm"]) {
    for (const alias of ["t", "tst", "it", "install-test", "cit", "install-ci-test", "clean-install-test", "sit"]) {
      for (const options of ["--tag x", "--script-shell sh", "--node-options x"]) {
        for (const command of [`${pm} ${options} ${alias}`, `${pm} ${alias} ${options}`]) assert.equal(classifyValidationCommand(command), "full-repository", command);
      }
    }
    for (const run of ["run", "run-script", "rum", "urn"]) {
      for (const command of [`${pm} --tag x ${run} verify`, `${pm} ${run} --tag x verify`]) assert.equal(classifyValidationCommand(command), "full-repository", command);
      for (const command of [`${pm} --tag x ${run} lint`, `${pm} ${run} --tag x t`, `${pm} ${run} --tag x install-test`]) assert.equal(classifyValidationCommand(command), "non-validation", command);
    }
  }
  for (const command of ["npm --tag x install", "pnpm --script-shell sh install", "npm install --tag x t", "npm run lint --tag x tst", "bun --tag x t", "yarn --script-shell sh install-test"]) assert.equal(classifyValidationCommand(command), "non-validation", command);
});

test("package option values retain quoted and escaped whitespace as one shell word", () => {
  for (const pm of ["npm", "pnpm", "bun", "yarn"]) {
    for (const value of ['"my dir"', "'my dir'", "my\\ dir", 'my" dir"', '"my \\"dir\\""']) {
      for (const options of [`--prefix ${value}`, `--prefix=${value}`, `--tag ${value}`, `--tag=${value}`]) {
        for (const command of [`${pm} ${options} run verify`, `${pm} run ${options} verify`, `${pm} ${options} test`]) assert.equal(classifyValidationCommand(command), "full-repository", command);
        const reach = options.startsWith("--prefix") || options.includes("=") ? "targeted" : "full-repository";
        for (const command of [`${pm} ${options} run test:core`, `${pm} run ${options} test:core`]) assert.equal(classifyValidationCommand(command), reach, command);
        for (const command of [`${pm} ${options} install`, `${pm} ${options} run lint`, `${pm} run ${options} lint`, `${pm} run lint ${options} verify`]) assert.equal(classifyValidationCommand(command), "non-validation", command);
        if (pm === "npm" || pm === "pnpm") {
          for (const alias of ["t", "tst", "it", "install-test", "cit", "install-ci-test", "clean-install-test", "sit"]) assert.equal(classifyValidationCommand(`${pm} ${options} ${alias}`), "full-repository", `${pm} ${options} ${alias}`);
        }
      }
    }
  }
});

test("validation commands have one shared classification", () => {
  const cases = [
    ["git status --short", "non-validation"],
    ["cat test/foo.test.mjs", "non-validation"],
    ["bun run lint", "non-validation"],
    ["bun run verify", "full-repository"],
    ["npm test", "full-repository"],
    ["npm run --silent verify", "full-repository"],
    ["npm run --silent test:all && npm run --silent test:docs && npm run --silent test:workflows", "full-repository"],
    ["npm run --silent --prefix . test:core", "targeted"],
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
    ["npm t", "full-repository"],
    ["npm tst", "full-repository"],
    ["pnpm t", "full-repository"],
    ["npm it", "full-repository"],
    ["npm install-test", "full-repository"],
    ["npm cit", "full-repository"],
    ["npm install-ci-test", "full-repository"],
    ["npm clean-install-test", "full-repository"],
    ["npm sit", "full-repository"],
    ["pnpm it", "full-repository"],
    ["pnpm install-test", "full-repository"],
    ["npm --prefix . it", "full-repository"],
    ["pnpm --dir . install-test", "full-repository"],
    ["npm run-script verify", "full-repository"],
    ["npm rum verify", "full-repository"],
    ["npm urn test", "full-repository"],
    ["npm run-script test:docs", "targeted"],
    ["npm run-script build:docs-site", "targeted"],
    ["npm ls", "non-validation"],
    ["npm install", "non-validation"],
    ["npm run lint", "non-validation"],
    ["bun test packages/core/test/validation-classify.test.mjs", "targeted"],
    ["bun run scripts/verify.mjs", "full-repository"],
    ["bun run ./scripts/verify.mjs", "full-repository"],
    ["node ./scripts/verify.mjs", "full-repository"],
    ["bun --bun run scripts/verify.mjs", "full-repository"],
    ["bun run --silent scripts/verify.mjs", "full-repository"],
    ["node --no-warnings scripts/verify.mjs", "full-repository"],
    ["bun run scripts/run-bun-test.mjs test/loop/run-bun-test.test.mjs", "targeted"],
    ["bun run scripts/docs/check-something.mjs", "non-validation"],
    ["bun scripts/github/view-pr.mjs", "non-validation"],
  ];
  for (const [command, expected] of cases) assert.equal(classifyValidationCommand(command), expected, command);
});

test("runtime launch options preserve direct-script reach and consume their values", () => {
  for (const launcher of ["bun --bun run --silent", "bun --cwd /work run --preload setup.mjs", "bun run --cwd /work --preload=setup.mjs", "bun --port 3000 run --config bunfig.toml", "node --no-warnings", "node --require setup.mjs --import=init.mjs", "node --env-file envfile --conditions development", "node --max-old-space-size 4096"]) {
    assert.equal(classifyValidationCommand(`${launcher} scripts/verify.mjs`), "full-repository", launcher);
    assert.equal(classifyValidationCommand(`${launcher} scripts/run-bun-test.mjs test/loop/a.test.mjs`), "targeted", launcher);
    assert.equal(classifyValidationCommand(`${launcher} scripts/run-bun-test.mjs --all && bun run test:docs && bun run test:workflows`), "full-repository", launcher);
    assert.equal(classifyValidationCommand(`${launcher} scripts/github/view-pr.mjs`), "non-validation", launcher);
  }
  for (const command of ["node --require scripts/verify.mjs scripts/github/view-pr.mjs", "bun --preload scripts/verify.mjs run scripts/github/view-pr.mjs", "node scripts/github/view-pr.mjs scripts/verify.mjs"]) {
    assert.equal(classifyValidationCommand(command), "non-validation", command);
  }
  for (const command of ["bun --preload setup.mjs run verify", "bun run --cwd /work --port 3000 verify", "bun --preload setup.mjs test", "node --no-warnings --test", "bun run --silent test test/loop/a.test.mjs"]) assert.equal(classifyValidationCommand(command), "full-repository", command);
  for (const command of ["bun --preload setup.mjs run test:core", "bun --cwd /work test test/loop/a.test.mjs", "node --no-warnings --test test/loop/a.test.mjs"]) assert.equal(classifyValidationCommand(command), "targeted", command);
});

test("unlisted runtime options cannot hide a full entrypoint behind their value", () => {
  for (const launcher of ["node --watch-path .", "node --report-dir out", "node --report-filename report.json", "node --heapsnapshot-signal SIGUSR2", "node --trace-event-categories node", "node --localstorage-file storage.json", "node --future-option value", "bun --future-option value run", "node --future-option value --another-option out", "node --future-option setup.mjs"]) {
    assert.equal(classifyValidationCommand(`${launcher} scripts/verify.mjs`), "full-repository", launcher);
    assert.equal(classifyValidationCommand(`${launcher} scripts/run-bun-test.mjs test/loop/a.test.mjs`), "targeted", launcher);
    assert.equal(classifyValidationCommand(`${launcher} scripts/github/view-pr.mjs`), "non-validation", launcher);
  }
  for (const command of ["node --future-option value --test", "bun --future-option value run verify", "bun run --future-option value verify"]) assert.equal(classifyValidationCommand(command), "full-repository", command);
  for (const command of ["node --no-warnings scripts/github/view-pr.mjs scripts/verify.mjs", "node --trace-warnings scripts/github/view-pr.mjs scripts/verify.mjs", "bun run --silent scripts/github/view-pr.mjs scripts/verify.mjs", "node --report-dir out scripts/github/view-pr.mjs scripts/verify.mjs", "node --future-option value scripts/github/view-pr.mjs scripts/verify.mjs", "node --require scripts/verify.mjs --future-option value scripts/github/view-pr.mjs"]) assert.equal(classifyValidationCommand(command), "non-validation", command);
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

test("readValidationPaths probes the .devloops family and parses .json as JSON", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readValidationPaths } = await import("../src/loop/validation-classify.mjs");
  const rule = { match: "spec/**", surface: "models", commands: ["bundle exec rspec {path}"] };
  for (const [name, body] of [[".devloops.yaml", "validation:\n  paths:\n    - match: spec/**\n      surface: models\n      commands: [\"bundle exec rspec {path}\"]\n"], [".devloops.json", JSON.stringify({ validation: { paths: [rule] } })]]) {
    const dir = mkdtempSync(join(tmpdir(), "vc-family-"));
    try {
      writeFileSync(join(dir, name), body);
      assert.deepEqual(readValidationPaths(dir), [rule], name);
      assert.deepEqual(resolveTargetedValidation(["spec/models/user_spec.rb"], readValidationPaths(dir)).commands, ["bundle exec rspec spec/models/user_spec.rb"], name);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("exact selectors cannot widen to directories or globs; wrappers keep validation reach", () => {
  for (const command of ["bun test test/foo.test.mjs test", "node --test test/foo.test.mjs test/*.test.mjs", "vitest run test/foo.spec.ts src", "bun scripts/run-bun-test.mjs test/foo.test.mjs test", "sh -c 'bun run verify'", 'bash -lc "npm test"', '"bun" run "verify"', "env -u DEVLOOPS_COORDINATOR_READONLY nice -n 10 timeout 30 command /usr/local/bin/bun test"]) {
    assert.equal(classifyValidationCommand(command), "full-repository", command);
  }
  for (const command of ["bun test --timeout 3000 test/foo.test.mjs test/bar.test.mjs", "node --test --test-reporter spec test/foo.test.mjs", "vitest run 'test/foo.spec.ts' --reporter verbose"]) {
    assert.equal(classifyValidationCommand(command), "targeted", command);
  }
});

test("normalized direct scripts retain full reach behind wrappers and absolute paths", () => {
  for (const command of ["env CI=1 ./scripts/../scripts/verify.mjs", "node /work/scripts/verify.mjs", "bun ./scripts/run-bun-test.mjs --all && bun run test:docs && bun run test:workflows"]) assert.equal(classifyValidationCommand(command), "full-repository", command);
});

test("literal shell wrappers preserve multiline full execution", () => {
  assert.equal(classifyValidationCommand("sh -c 'bun run verify\necho done'"), "full-repository");
});
