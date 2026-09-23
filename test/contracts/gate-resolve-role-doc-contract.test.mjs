// Doc contract for issue #2336 (operation-scoped reviewer role resolution):
// the reviewer-facing surface consumes ONLY the `gate resolve-role` CLI's
// exit code plus its optional prompt — never an inline `resolveReviewerRole`
// interpreter call, never a raw `extension-defaults.yaml` read, and never a
// reviewer decision table branching on the CLI's DIAGNOSTIC `status` field.
import assert from "node:assert/strict";
import { test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectGeneratedAssets } from "../../scripts/claude/generate-claude-assets.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");

// The five reviewer-facing surfaces the AC/DoD matrix names.
const REVIEWER_SURFACES = [
  "agents/review.agent.md",
  "skills/copilot-pr-followup/SKILL.md",
  "skills/docs/gate-review-sub-loop-contract.md",
  "skills/docs/gate-review-comment-contract.md",
  "scripts/github/emit-fanout-dispatch.mjs",
];

// Sources this issue edited to name the CLI as the sanctioned role source;
// each has a generated Claude mirror.
const EDITED_SURFACE_MIRRORS = {
  "agents/review.agent.md": ".claude/agents/review.md",
  "skills/copilot-pr-followup/SKILL.md": ".claude/skills/copilot-pr-followup/SKILL.md",
  "skills/docs/gate-review-sub-loop-contract.md": ".claude/skills/docs/gate-review-sub-loop-contract.md",
  "skills/docs/gate-review-comment-contract.md": ".claude/skills/docs/gate-review-comment-contract.md",
};

test("every edited reviewer surface names `gate resolve-role` as the role source", () => {
  for (const rel of Object.keys(EDITED_SURFACE_MIRRORS)) {
    const content = read(rel);
    assert.match(content, /gate resolve-role/, `${rel} must name the sanctioned \`gate resolve-role\` CLI`);
  }
});

// Regression guard for the defect issue #2336 exists to remove: reviewer
// prose instructing an inline `resolveReviewerRole(config, angle)`
// interpreter call. scripts/github/emit-fanout-dispatch.mjs is exempt — it is
// the emitter's own dispatch-time source, not reviewer-facing instruction
// prose — and the explicit "never calls resolveReviewerRole ... inline"
// prohibition sentence names the function without invoking it, so it does
// not match this call-shaped pattern.
const INLINE_CALL_RE = /resolveReviewerRole\(\s*config\b/;

test("no reviewer surface instructs an inline resolveReviewerRole(config, ...) call", () => {
  for (const rel of REVIEWER_SURFACES) {
    if (rel === "scripts/github/emit-fanout-dispatch.mjs") continue;
    const content = read(rel);
    assert.doesNotMatch(
      content,
      INLINE_CALL_RE,
      `${rel} must not instruct an inline resolveReviewerRole(config, ...) call (OPS-NO-INLINE-INTERPRETER)`,
    );
  }
});

test("generated Claude mirrors are in sync with the edited reviewer surfaces", () => {
  const assets = collectGeneratedAssets({ repoRoot });
  const byTarget = new Map(assets.map((a) => [a.target, a.content]));
  for (const [source, target] of Object.entries(EDITED_SURFACE_MIRRORS)) {
    const generated = byTarget.get(target);
    assert.ok(generated, `expected a generated asset for ${target}`);
    const onDisk = read(target);
    assert.equal(onDisk, generated, `${target} is stale — regenerate via scripts/claude/generate-claude-assets.mjs (source: ${source})`);
    assert.match(onDisk, /gate resolve-role/, `${target} must still name \`gate resolve-role\` after generation`);
  }
});

// A reviewer decision branch on the CLI's diagnostic `status` field would
// reference one of these five literal values in code/quote formatting (the
// way a status enum is named in prose), e.g. `` `fallback` `` or
// `"prompt-missing"`. Plain English use of the bare words ("the resolved
// angle set", "an unresolved thread") is untouched — only the formatted
// literal is checked, keeping the false-positive rate low.
const STATUS_LITERAL_RE = /[`"](resolved|fallback|prompt-missing|unresolved|non-member|config-error)[`"]/;

// Scoped to paragraphs that actually name `resolve-role`: a bare status word
// elsewhere in a reviewer surface (e.g. prose describing an unrelated
// "unresolved" thread) is not a reviewer decision branch on the CLI's
// diagnostic field.
test("no reviewer surface branches a decision on the diagnostic `status` literal", () => {
  for (const rel of REVIEWER_SURFACES) {
    const content = read(rel);
    for (const paragraph of content.split(/\n\s*\n/)) {
      if (!paragraph.includes("resolve-role")) continue;
      const match = paragraph.match(STATUS_LITERAL_RE);
      assert.equal(match, null, `${rel} must not encode a reviewer decision branch on a \`status\` literal near a resolve-role mention (found ${match?.[0]})`);
    }
  }
});

// extension-defaults.yaml may be named only to warn a reviewer away from it
// (a prohibition), never as an instruction for how to resolve a role. A bare
// "not" (e.g. "does not", "cannot") is not itself a prohibition phrase.
const PROHIBITION_RE = /\b(never|must not|do not|instead of)\b/i;

test("extension-defaults.yaml is named only in a prohibition context on every reviewer surface", () => {
  for (const rel of REVIEWER_SURFACES) {
    const content = read(rel);
    for (const line of content.split("\n")) {
      if (!line.includes("extension-defaults.yaml")) continue;
      assert.match(line, PROHIBITION_RE, `${rel}: a line naming extension-defaults.yaml must be a prohibition — got: ${line.trim()}`);
    }
  }
});

// Import contract: the CLI and write-gate-context.mjs both route through the
// ONE shared operation-angle-pool authority, and the CLI carries no
// membership/union/additive/disabled/spike classifier of its own.
test("the CLI and write-gate-context.mjs both import the shared review-operation authority", () => {
  const cli = read("scripts/loop/resolve-reviewer-role.mjs");
  assert.match(cli, /@dev-loops\/core\/loop\/review-operation/);
  const writeGateContext = read("scripts/github/write-gate-context.mjs");
  assert.match(writeGateContext, /@dev-loops\/core\/loop\/review-operation/);
});

test("the CLI source carries no independent membership/union/additive classifier", () => {
  const cli = read("scripts/loop/resolve-reviewer-role.mjs");
  for (const banned of ["resolveGateAngleContract", "resolveGateAngles", "resolveAnglePool"]) {
    assert.equal(cli.includes(banned), false, `resolve-reviewer-role.mjs must not import/reference ${banned} directly`);
  }
});
