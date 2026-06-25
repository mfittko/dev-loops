import {
  assertMatchesAll,
  readRepo,
  test,
} from "../imported-assets-helpers.mjs";

test("local-implementation skill keeps narrow failure-triage guidance", async () => {
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
    /Do not read installed package internals unless the failing path is inside that installed package or no public CLI\/docs path exists/i,
    /Do not run duplicate broad searches/i,
  ], "skills/local-implementation/SKILL.md");
});
