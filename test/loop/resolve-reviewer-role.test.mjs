import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import {
  parseResolveReviewerRoleCliArgs,
  resolveRolePayload,
  runCli,
} from "../../scripts/loop/resolve-reviewer-role.mjs";

// ---------------------------------------------------------------------------
// Arg parsing (parseArgs-backed — no hand-rolled scanning)
// ---------------------------------------------------------------------------

test("parse: --angle is required", () => {
  assert.throws(() => parseResolveReviewerRoleCliArgs([]), /requires --angle/);
});

test("parse: rejects an unknown --gate value", () => {
  assert.throws(
    () => parseResolveReviewerRoleCliArgs(["--angle", "correctness", "--gate", "bogus"]),
    /--gate must be one of/,
  );
});

test("parse: rejects an unknown --harness value", () => {
  assert.throws(
    () => parseResolveReviewerRoleCliArgs(["--angle", "correctness", "--harness", "gpt"]),
    /--harness must be one of/,
  );
});

test("parse: harness defaults to claude under Claude Code, else pi", () => {
  const claude = parseResolveReviewerRoleCliArgs(["--angle", "correctness"], { env: { CLAUDECODE: "1" } });
  assert.equal(claude.harness, "claude");
  const pi = parseResolveReviewerRoleCliArgs(["--angle", "correctness"], { env: {} });
  assert.equal(pi.harness, "pi");
});

// ---------------------------------------------------------------------------
// Payload resolution (pure — injected config)
// ---------------------------------------------------------------------------

test("built-in angle resolves persona + a model tier from the merged config", () => {
  // Empty config -> the built-in `correctness` persona (`review`) and the
  // built-in review tier, which maps high -> opus on Claude.
  const payload = resolveRolePayload({}, { angle: "correctness", harness: "claude" });
  assert.equal(payload.ok, true);
  assert.equal(payload.angle, "correctness");
  assert.equal(payload.persona, "review");
  assert.equal(payload.model, "opus");
  assert.equal(payload.fallback, false);
});

test("--gate adds the resolved angle surface scope", () => {
  const payload = resolveRolePayload({}, { angle: "correctness", harness: "pi", gate: "draft" });
  assert.equal(payload.gate, "draft");
  assert.equal(payload.scope, "full");
});

test("primary model is the merged tier, not the bare override; overrideModel is separate", () => {
  // An angle entry carrying only a `tier` (no `model`) resolves its model via
  // the merged tier mapping; overrideModel stays null because the entry set no
  // explicit `model`.
  const config = {
    gates: { draft: { angles: [{ name: "correctness", persona: "paranoid", tier: "audit" }] } },
    models: { tiers: { audit: { claude: "audit-claude", pi: "audit-pi" } } },
  };
  const payload = resolveRolePayload(config, { angle: "correctness", harness: "claude" });
  assert.equal(payload.persona, "paranoid");
  assert.equal(payload.model, "audit-claude");
  assert.equal(payload.overrideModel, null);
});

// ---------------------------------------------------------------------------
// CLI end-to-end against a temp repo (loads the merged config off disk)
// ---------------------------------------------------------------------------

async function withTempRepo(devloopsYaml, run) {
  const dir = await mkdtemp(path.join(tmpdir(), "resolve-role-"));
  try {
    if (devloopsYaml != null) await writeFile(path.join(dir, ".devloops.yaml"), devloopsYaml, "utf8");
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("CLI resolves a built-in angle against a repo with no .devloops override", async () => {
  await withTempRepo(null, async (repoRoot) => {
    const result = await runCli(["--angle", "correctness", "--harness", "claude"], { repoRoot, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.persona, "review");
    assert.equal(result.model, "opus");
  });
});

// AC #3: a repo that overrides an angle's persona/model tier resolves to the
// OVERRIDDEN role via the merged config (the .devloops merge-by-name), not the
// shipped default. A raw grep of extension-defaults.yaml would miss this.
test("CLI resolves the OVERRIDDEN role when .devloops overrides the angle", async () => {
  const devloops = [
    "version: 1",
    "gates:",
    "  draft:",
    "    angles:",
    "      - name: correctness",
    "        persona: paranoid-auditor",
    "        tier: audit-tier",
    "models:",
    "  tiers:",
    "    audit-tier:",
    "      claude: audit-claude-model",
    "      pi: audit-pi-model",
    "",
  ].join("\n");
  await withTempRepo(devloops, async (repoRoot) => {
    const claude = await runCli(["--angle", "correctness", "--harness", "claude"], { repoRoot, env: {} });
    assert.equal(claude.persona, "paranoid-auditor", "persona must come from the .devloops override");
    assert.equal(claude.model, "audit-claude-model", "model must be the merged overridden tier on Claude");
    const pi = await runCli(["--angle", "correctness", "--harness", "pi"], { repoRoot, env: {} });
    assert.equal(pi.model, "audit-pi-model", "model must resolve per-harness from the merged tier");
  });
});
