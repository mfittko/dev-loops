import { assert, readRepo, test } from "../imported-assets-helpers.mjs";

const setupPath = "skills/docs/copilot-loop-operations.md";
const setupLink = "../skills/docs/copilot-loop-operations.md#codex-runtime-setup";

test("Codex runtime setup has one owner and reaches generic roles before scoped work", async () => {
  const operations = await readRepo(setupPath);
  const setup = operations.slice(operations.indexOf("## Codex runtime setup"));
  assert.match(setup, /<!-- rule: OPS-CODEX-RUNTIME-SETUP -->/);
  for (const required of [
    /OPS-NO-INLINE-INTERPRETER/,
    /temporary artifacts.*absolute paths/,
    /git rev-parse --path-format=absolute --git-dir/,
    /git rev-parse --path-format=absolute --git-common-dir/,
    /git rev-parse --show-toplevel/,
    /git branch --show-current/,
    /sandbox_permissions: "require_escalated"/,
    /justification.*up front/,
    /subject to.*approval review/,
    /staging, staged secret scan and commit as three separate tool invocations/,
    /failed stage permits no scan or commit/,
    /scanner hit or error stops/,
    /ordinary command-input error or executed failing test is not automatically a permission\/classifier denial/i,
    /no subsequent read, verification or alternate-command attempt/,
    /actual collaboration parent\/child task identities.*CODEX_THREAD_ID/,
    /no native Claude role or Claude hook grant/,
    /never broadens.*branch, paths or phase/,
  ]) assert.match(setup, required);
  const registry = JSON.parse(await readRepo("skills/docs/required-rules.json"));
  assert.ok(registry.requiredRules.some(({ id, enforcement }) => id === "OPS-CODEX-RUNTIME-SETUP" && enforcement === "doc"));
  for (const role of ["developer", "refiner", "dev-loop", "fixer"]) {
    const body = await readRepo(`agents/${role}.agent.md`);
    assert.ok(body.includes(setupLink), `${role} receives the canonical setup`);
    if (role !== "fixer") assert.doesNotMatch(body, /sandbox_permissions: "require_escalated"/, `${role} links rather than duplicates setup`);
  }
  const dispatch = await readRepo("skills/docs/main-agent-contract.md");
  const generic = dispatch.slice(dispatch.indexOf("## Generic Codex dispatch"), dispatch.indexOf("## Codex fixer dispatch"));
  assert.match(generic, /does not automatically load.*role/);
  assert.match(generic, /verified absolute.*role.*setup/);
  assert.match(generic, /artifact-only refiners/);
  assert.match(generic, /initial startup\/envelope.*pull-first/);
  assert.match(generic, /before.*artifact.*Git write/);
});
