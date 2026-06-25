import {
  assertMatchesAll,
  readRepo,
  test,
} from "../imported-assets-helpers.mjs";

test("local-implementation skill keeps narrow failure-triage ordering", async () => {
  const content = await readRepo("skills/local-implementation/SKILL.md");

  assertMatchesAll(content, [
    /## Narrow failure-triage fast path/i,
    /run startup once from the relevant worktree/i,
    /inspect current state[\s\S]{0,120}`git status`[\s\S]{0,120}changed files/i,
    /reproduce[^\n]*failing command/i,
    /exact-pattern search in changed files/i,
    /patch the minimum call sites/i,
    /focused smoke checks/i,
    /default verification/i,
    /general tooling-internals and duplicate-broad-search prohibition/i,
  ], "skills/local-implementation/SKILL.md");
});

test("anti-patterns doc owns the general tooling-internals guidance", async () => {
  const content = await readRepo("skills/docs/anti-patterns.md");

  assertMatchesAll(content, [
    /Spelunking tooling internals instead of using the public surface/i,
    /Do not read installed package internals/i,
    /scan tooling source/i,
    /run ad-hoc scripts to understand a tool's behavior/i,
    /Use the CLI[\s\S]{0,120}`--help` subcommands[\s\S]{0,120}`skills\/docs\/?`/i,
    /concrete failure path is inside it and no public CLI\/docs path exists/i,
    /search changed files for the exact pattern/i,
    /don't run duplicate broad searches/i,
  ], "skills/docs/anti-patterns.md");
});
