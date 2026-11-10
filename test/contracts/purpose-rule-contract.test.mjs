// PURPOSE-HIGHEST-SAFE-AUTONOMY (#2937 AC19): one owning purpose rule, cited as parent by the #2937 rules.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const ID = "PURPOSE-HIGHEST-SAFE-AUTONOMY";
const STATEMENT =
  "dev-loops ships reviewed, tested PRs with the highest autonomy that is still safe. Deterministic gates and a judge decide; humans decide only what tooling cannot, or what the repo requires.";
const CITING = {
  "skills/docs/gate-review-sub-loop-contract.md": [
    "GATE-EXEC-JUDGE-PRIME-AUTHORITY",
    "GATE-EXEC-LOW-FIX-UNTIL-CAP",
    "GATE-EXEC-ROUND-CAP",
    "GATE-EXEC-FIXER-CYCLE-BOUND",
    "GATE-EXEC-OPERATOR-LINE-APPROVE-MERGE",
    "GATE-EXEC-OPERATOR-LINE-RELEASE-PUBLISH",
  ],
  "skills/docs/decision-record-contract.md": ["ADR-OVER-WAIVER"],
};

test("the purpose rule owns the statement and the three reasons, and is registered", () => {
  const guide = read("skills/docs/contract-style-guide.md");
  assert.equal(guide.split(`<!-- rule: ${ID} -->`).length, 2);
  const row = guide.split("\n").find((l) => l.startsWith("|") && l.includes(`<!-- rule: ${ID} -->`));
  assert.ok(row?.includes(STATEMENT));
  assert.match(row, /quality, safety, or a decision tooling cannot make/);
  assert.ok(read("skills/docs/required-rules.json").includes(`"id": "${ID}"`));
});

function assertReadmePurpose(text) {
  const paragraphs = text.trim().split(/\r?\n[ \t]*\r?\n/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const titleIndex = paragraphs.findIndex((paragraph) => /^# [^\r\n]+$/.test(paragraph));
  assert.ok(titleIndex >= 0, "README has an H1 title");
  assert.equal(paragraphs[titleIndex + 1]?.replace(/\r?\n/g, " "), STATEMENT);
}

test("the README hero paragraph and the package description carry the statement", () => {
  assertReadmePurpose(read("README.md"));
  assert.equal(JSON.parse(read("package.json")).description, STATEMENT);
});

test("the README purpose check tolerates layout changes but rejects changed or misplaced text", () => {
  for (const text of [
    `\n\n# dev-loops\n\n\n${STATEMENT}\n\n## More`,
    `# dev-loops\n\n${STATEMENT.replace(" Deterministic gates", "\nDeterministic gates")}\n\nMore prose.`,
    `# dev-loops\r\n\r\n${STATEMENT}\r\n\r\nMore prose.`,
  ]) {
    assertReadmePurpose(text);
  }
  for (const text of [
    `# dev-loops\n\n${STATEMENT.replace("safe", "fast")}`,
    `# dev-loops\n\nOther prose.\n\n${STATEMENT}`,
    `## dev-loops\n\n${STATEMENT}`,
    "# dev-loops\n\n",
    "",
  ]) {
    assert.throws(() => assertReadmePurpose(text), assert.AssertionError);
  }
});

test("each #2937 rule cites the purpose rule as its parent without restating it", () => {
  for (const [file, ids] of Object.entries(CITING)) {
    const text = read(file);
    for (const id of ids) {
      const line = text.split("\n").find((l) => l.startsWith(`\`${id}\``) || (l.startsWith("|") && l.includes(`<!-- rule: ${id} -->`)));
      assert.match(line ?? "", new RegExp(`[Pp]arent:? \`${ID}\``), `${id} cites ${ID}`);
      for (const fragment of ["highest autonomy", "humans decide only what tooling cannot"]) {
        assert.ok(!line.includes(fragment), `${id} does not restate the purpose`);
      }
    }
  }
});
