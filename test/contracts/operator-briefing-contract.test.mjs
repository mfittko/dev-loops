import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "bun:test";

import { resolverTestEnv } from "../_helpers.mjs";
import { OPERATOR_BRIEFING } from "../../scripts/loop/resolve-dev-loop-startup.mjs";
import { SANCTIONED_COMMANDS } from "../../scripts/loop/sanctioned-commands.mjs";

// Issue 2351: the orchestrator is briefed on the sanctioned tooling surface
// through (1) a shared `## Sanctioned tooling` section in the main-agent
// contract and (2) a static `operatorBriefing` pointer in every ok:true
// startup result. Per-mode presence is asserted in test/loop/resolve-dev-loop-startup*.test.mjs.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = path.join(repoRoot, "scripts", "loop", "resolve-dev-loop-startup.mjs");
const INDEX_PATH = "scripts/loop/sanctioned-commands.mjs";
const CONTRACT_ANCHOR = "skills/docs/main-agent-contract.md#sanctioned-tooling";

const read = (rel) => readFileSync(path.join(repoRoot, rel), "utf8");

// Body of a `## <heading>` section, up to the next `## ` heading or pi-only marker.
function section(doc, heading) {
  const start = doc.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `missing section: ## ${heading}`);
  const rest = doc.slice(start + heading.length + 5);
  const end = rest.search(/\n## |\n<!-- \/?pi-only -->/);
  return end < 0 ? rest : rest.slice(0, end);
}

for (const rel of ["skills/docs/main-agent-contract.md", ".claude/skills/docs/main-agent-contract.md"]) {
  test(`${rel} has a shared Sanctioned tooling section naming the index and orchestrator-owned operations`, () => {
    const doc = read(rel);
    const body = section(doc, "Sanctioned tooling");
    for (const needle of [INDEX_PATH, "merge-pr.mjs", "sync-item-status.mjs", "create-issue.mjs"]) {
      assert.ok(body.includes(needle), `section must name ${needle}`);
    }
  });
}

test("Sanctioned tooling section sits outside the pi-only block", () => {
  const doc = read("skills/docs/main-agent-contract.md");
  const outside = doc.replace(/<!-- pi-only -->[\s\S]*?<!-- \/pi-only -->/g, "");
  assert.ok(outside.includes("\n## Sanctioned tooling\n"));
});

test("main-agent contract Pi-only lines do not contradict the index", () => {
  const doc = read("skills/docs/main-agent-contract.md");
  const allowed = section(doc, "Main agent owns (allowed)");
  for (const raw of SANCTIONED_COMMANDS.forbidden) {
    assert.equal(allowed.includes(raw), false, `allowed list must not name forbidden ${raw}`);
  }
  assert.doesNotMatch(allowed, /gh issue (view \/ )?create/);

  const examples = section(doc, "Boundary examples");
  for (const row of examples.split("\n").filter((l) => l.startsWith("|"))) {
    assert.equal(/gh issue create/.test(row) && /Allowed/.test(row), false, `row allows raw issue creation: ${row}`);
  }

  const lifecycle = section(doc, "Dev-loop agent (async) owns")
    .split("\n")
    .find((l) => l.startsWith("- ALL PR lifecycle"));
  assert.ok(lifecycle, "PR-lifecycle bullet must exist");
  const owned = lifecycle.match(/^- ALL PR lifecycle \(([^)]*)\)/);
  assert.ok(owned, "PR-lifecycle bullet must list its owned steps in parentheses");
  assert.doesNotMatch(owned[1], /merge/i);
  assert.match(lifecycle, /Merge is orchestrator-owned/);
});

test("operatorBriefing names the index and contract anchor without restating the command list", () => {
  assert.equal(typeof OPERATOR_BRIEFING, "string");
  assert.ok(OPERATOR_BRIEFING.includes(INDEX_PATH));
  assert.ok(OPERATOR_BRIEFING.includes(CONTRACT_ANCHOR));
  // Derived from the live map, so a new entry is checked with no test edit.
  const banned = [];
  for (const group of Object.values(SANCTIONED_COMMANDS)) {
    if (Array.isArray(group)) banned.push(...group);
    else banned.push(...Object.keys(group), ...Object.values(group));
  }
  assert.ok(banned.length > 0);
  for (const needle of banned) {
    assert.equal(OPERATOR_BRIEFING.includes(needle), false, `briefing restates ${needle}`);
  }
});

test("operatorBriefing points at a module exporting SANCTIONED_COMMANDS", async () => {
  const mod = await import(pathToFileURL(path.join(repoRoot, INDEX_PATH)).href);
  assert.equal(mod.SANCTIONED_COMMANDS, SANCTIONED_COMMANDS);
  // Static pointer: the resolver source declares it as a string literal, not derived from the map.
  assert.match(read("scripts/loop/resolve-dev-loop-startup.mjs"), /export const OPERATOR_BRIEFING =\s*\n?\s*"/);
});

test("operatorBriefing is rendered in startup stdout and via --jq; requiredReads unchanged", async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "operator-briefing-"));
  try {
    const inputPath = path.join(tmpDir, "startup-input.json");
    await writeFile(inputPath, JSON.stringify({
      currentState: {
        target: { kind: "issue", issue: 429 },
        ownership: "copilot",
        nextActor: "user",
        status: "active",
        authorization: "authorized",
      },
      artifactState: "not_applicable",
      issueLinkageResolution: "resolved_no_open_pr",
      issueReadiness: "ready",
      issueAssignmentState: "unassigned",
      loopState: "active",
    }));
    const run = (extra) => spawnSync((Bun.which("node") ?? "node"), [cliPath, "--input", inputPath, ...extra], {
      cwd: tmpDir,
      encoding: "utf8",
      env: { ...process.env, ...resolverTestEnv() },
    });

    const plain = run([]);
    assert.equal(plain.status, 0, plain.stderr);
    const parsed = JSON.parse(plain.stdout);
    assert.equal(parsed.operatorBriefing, OPERATOR_BRIEFING);
    assert.deepEqual(parsed.requiredReads, [
      "skills/docs/public-dev-loop-contract.md",
      "skills/docs/retrospective-checkpoint-contract.md",
      "skills/copilot-pr-followup/SKILL.md",
      "skills/docs/copilot-loop-operations.md",
      "skills/docs/issue-intake-procedure.md",
      "skills/docs/pre-pr-review-contract.md",
    ]);

    const jq = run(["--jq", ".operatorBriefing"]);
    assert.equal(jq.status, 0, jq.stderr);
    assert.equal(jq.stdout.trim(), OPERATOR_BRIEFING);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});
