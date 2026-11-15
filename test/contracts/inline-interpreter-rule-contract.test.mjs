// Issue 2442: the OPS-NO-INLINE-INTERPRETER rule text, its citations, and the guard-classifier rule (DESIGN-GUARD-CLASSIFIER-STRUCTURAL).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

import { collectContractMarkdownFiles, extractRuleDefinitions, findEmbeddedRuleBodies } from "../../scripts/docs/validate-rule-ownership.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");
const ruleBody = (file, id) => extractRuleDefinitions(read(file), file).find((def) => def.id === id)?.body ?? assert.fail(`${id} not defined in ${file}`);
const RULE = "OPS-NO-INLINE-INTERPRETER";

test("OPS-NO-INLINE-INTERPRETER lists the closed forms, the file-write rule and the ceiling", () => {
  const body = ruleBody("skills/docs/copilot-loop-operations.md", RULE);
  // the four classes and the temp-path definition
  assert.match(body, /\(1\) inline code or a stdin heredoc to `node`, `bun`, `python`\/`python3`, `perl` or `ruby`/);
  assert.match(body, /\(2\) an in-place edit \(`sed`\/`gsed` `-i` or `--in-place`, `awk`\/`gawk` `-i inplace`/);
  assert.match(body, /\(3\) a `cat` or `tee` heredoc write outside a temp path \(a path with a `tmp\/` segment whose last `tmp\/` is not followed by `worktrees`, with no `\.\.` and no variable\)/);
  assert.match(body, /\(4\) running a file in the same command that a heredoc wrote/);
  assert.doesNotMatch(body, /or equivalent/);
  // perl and ruby are covered, deno is not
  assert.match(body, /`perl` and `ruby` are covered; `deno` stays uncovered/);
  // the editor-tool file-write sentence
  assert.match(body, /the editor tools \(Write\/Edit under Claude Code, write\/edit under Pi\)[\s\S]*?never a Bash heredoc \(`cat > file <<EOF`\) and never `echo`\/`printf` redirection of multi-line content/);
  // the ceiling and its report
  assert.match(body, /Ceiling: the gate allows a form it does not read[^.]*string payload[^.]*quoted-delimiter heredoc body[^.]*pipe into an interpreter/);
  assert.match(body, /`check-retro-tooling` reports each ceiling case after the fact; the hook adds no warning/);
});

test("every agent definition with edit or write tools cites OPS-NO-INLINE-INTERPRETER by ID and copies no rule body", async () => {
  const sources = (await collectContractMarkdownFiles(repoRoot)).map((file) => ({ file, content: fs.readFileSync(file, "utf8") }));
  const checked = [];
  for (const dir of ["agents", ".claude/agents"]) {
    for (const name of fs.readdirSync(path.join(repoRoot, dir)).filter((n) => n.endsWith(".md"))) {
      const file = `${dir}/${name}`;
      const content = read(file);
      const tools = /^tools: (.*)$/m.exec(content)?.[1] ?? "";
      if (!/\b(?:edit|write)\b/i.test(tools)) continue;
      checked.push(file);
      assert.ok(content.includes(`\`${RULE}\``), `${file} cites ${RULE}`);
      // a rule an agent file owns itself (the refiner's REFINER-* rules) is not a copy
      assert.deepEqual(findEmbeddedRuleBodies(content, sources).filter((def) => !/[\\/]agents[\\/]/.test(def.file)).map((def) => def.id), [], `${file} embeds no rule body`);
    }
  }
  assert.ok(checked.length >= 16, `expected the editing agents of both trees, got ${checked.length}`);
});

test("both main-agent-contract passages cite OPS-NO-INLINE-INTERPRETER for sed -i and cat/tee heredoc writes", () => {
  const text = read("skills/docs/main-agent-contract.md").replace(/\s+/g, " ");
  const passages = [...text.matchAll(/`OPS-NO-INLINE-INTERPRETER` in \[Loop operations\]\(copilot-loop-operations\.md\) denies `sed -i` and a `cat`\/`tee` heredoc write outside a temp path on the Bash gate/g)];
  assert.equal(passages.length, 2);
  assert.doesNotMatch(text, /`sed -i`, `> file`\) stay convention-enforced/);
  assert.doesNotMatch(text, /`sed -i`, `> file` \/ `tee`\) are convention-enforced/);
});

test("the retrospective contract names the inline-interpreter tool and the shared parser", () => {
  const text = read("skills/docs/retrospective-checkpoint-contract.md");
  assert.match(text, /`inline-interpreter` `rawCallViolations` entries/);
  assert.match(text, /`inlineInterpreterVerdict` in `@dev-loops\/core\/loop\/bash-command-classify`/);
  assert.match(text, /`sh-syntax` parse \(ADR 0276\)/);
});

test("DESIGN-GUARD-CLASSIFIER-STRUCTURAL states the three things and is registered", () => {
  const body = ruleBody("skills/docs/structural-quality.md", "DESIGN-GUARD-CLASSIFIER-STRUCTURAL");
  assert.match(body, /decide an allow or an inertness case by structure \(token and segment shape, from a parser\), never by a list of command or word names/);
  assert.ok(body.includes("No case main denied is allowed, except the ambiguous-input ceiling cases listed in the shared fixture table."));
  assert.match(body, /A PR that relaxes a classifier names the structural rule in its body\./);
  const rules = JSON.parse(read("skills/docs/required-rules.json")).requiredRules;
  assert.equal(rules.filter((rule) => rule.id === "DESIGN-GUARD-CLASSIFIER-STRUCTURAL").length, 1);
});
