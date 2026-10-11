// Prose guards for issue 2442: OPS-NO-INLINE-INTERPRETER lists the denied classes and the editor-tool
// file-write rule, the main-agent contract cites it, and agents cite the ID without copying the rule body.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectContractMarkdownFiles, extractRuleDefinitions, findEmbeddedRuleBodies } from "../../scripts/docs/validate-rule-ownership.mjs";
import { assert, fromRepoRoot, readRepo, test } from "../imported-assets-helpers.mjs";

const RULE_ID = "OPS-NO-INLINE-INTERPRETER";
const OPS_DOC = "skills/docs/copilot-loop-operations.md";

async function ruleBody() {
  const [def] = extractRuleDefinitions(await readRepo(OPS_DOC), "copilot-loop-operations.md").filter((d) => d.id === RULE_ID);
  assert.ok(def, `expected ${RULE_ID} definition`);
  return def.body.replace(/\s+/g, " ");
}

test("OPS-NO-INLINE-INTERPRETER lists the four classes and the temp-path definition", async () => {
  const body = await ruleBody();
  assert.doesNotMatch(body, /or equivalent/);
  for (const needle of [
    "closed list, in four classes",
    "inline code or a stdin heredoc",
    "in-place editors",
    "`cat`/`tee` heredoc write whose target is not a temp path",
    "running, in the same command, a file that a `cat`/`tee` heredoc wrote",
    "A temp path starts with `tmp/` or `./tmp/` when relative",
    "is not `worktrees`",
  ]) {
    assert.ok(body.includes(needle), `rule must contain: ${needle}`);
  }
});

test("OPS-NO-INLINE-INTERPRETER states the editor-tool file-write rule", async () => {
  const body = await ruleBody();
  assert.ok(body.includes("agents write and edit files with the editor tools (Write/Edit under Claude Code, write/edit under Pi)"));
  assert.ok(body.includes("never a Bash heredoc (`cat > file <<EOF`)"));
  assert.ok(body.includes("never `echo`/`printf` redirection of multi-line content"));
});

test("both main-agent-contract passages cite the rule for sed -i and cat/tee heredoc writes", async () => {
  const doc = (await readRepo("skills/docs/main-agent-contract.md")).replace(/\s+/g, " ");
  const passages = doc.split(RULE_ID).length - 1;
  assert.ok(passages >= 2, `expected the contract to cite ${RULE_ID} in both passages`);
  assert.equal(doc.split(`\`${RULE_ID}\` denies \`sed -i\` and a cat/tee heredoc write outside a temp path`).length - 1, 2);
});

function agentFiles(dir, toolsPattern) {
  const root = fromRepoRoot(dir);
  return fs.readdirSync(root)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ name, content: fs.readFileSync(path.join(fileURLToPath(root), name), "utf8") }))
    .filter(({ content }) => toolsPattern.test(content.match(/^tools:.*$/m)?.[0] ?? ""));
}

test("every editing agent cites the rule ID and copies no rule body", async () => {
  const sources = (await collectContractMarkdownFiles()).map((file) => ({ file, content: fs.readFileSync(file, "utf8") }));
  for (const [dir, pattern] of [["agents", /\b(edit|write)\b/], [".claude/agents", /\b(Edit|Write)\b/]]) {
    const files = agentFiles(dir, pattern);
    assert.ok(files.length >= 8, `expected editing agents under ${dir}`);
    for (const { name, content } of files) {
      assert.ok(content.includes(RULE_ID), `${dir}/${name} must cite ${RULE_ID}`);
      // Scoped to this rule: refiner embeds two unrelated REFINER-* bodies that predate this issue.
      const embedded = findEmbeddedRuleBodies(content, sources).map((def) => def.id);
      assert.ok(!embedded.includes(RULE_ID), `${dir}/${name} embeds the ${RULE_ID} body`);
    }
  }
});

test("no surface says every dispatched prompt repeats the rule", async () => {
  for (const file of ["skills/dev-loop/SKILL.md", "agents/dev-loop.agent.md", OPS_DOC, "skills/docs/main-agent-contract.md"]) {
    assert.doesNotMatch((await readRepo(file)).replace(/\s+/g, " "), /every (?:dispatched )?(?:dispatch )?prompt (?:repeats|carries|restates) (?:the rule|`?OPS-NO-INLINE-INTERPRETER)/i, file);
  }
});
