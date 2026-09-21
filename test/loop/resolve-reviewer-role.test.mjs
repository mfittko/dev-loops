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

test("overrideModel carries a NON-NULL bare per-angle model, and the primary model resolves it over the tier", () => {
  // The complement of the test above: here the angle entry sets an explicit
  // per-angle `model`, so `overrideModel` (the bare resolveReviewerRole().model)
  // is NON-NULL — the case the tier-only test never exercises. A distinct `tier`
  // is present only to prove the primary `model` (resolveRoleModel, kind:"angle")
  // honors the explicit per-angle model with precedence, NOT the tier mapping.
  //
  // Note: with the shipped data model an explicit per-angle `model` is the ONLY
  // source of a non-null overrideModel (all BUILTIN_PERSONAS have defaultModel
  // null), and resolveRoleModel(kind:"angle") returns that same per-angle model
  // first — so a non-null overrideModel necessarily equals the primary model. A
  // fixture where the two are non-null AND differ is unrealizable without
  // changing resolveReviewerRole/resolveRoleModel, which is out of scope. The
  // assertions below still discriminate the two fields: they fail if overrideModel
  // were dropped (would be null) or if the primary model leaked the tier value.
  const config = {
    gates: { draft: { angles: [{ name: "correctness", persona: "paranoid", model: "explicit-angle-model", tier: "audit" }] } },
    models: { tiers: { audit: { claude: "audit-claude", pi: "audit-pi" } } },
  };
  const payload = resolveRolePayload(config, { angle: "correctness", harness: "claude" });
  assert.equal(payload.overrideModel, "explicit-angle-model", "overrideModel must surface the bare per-angle model override, non-null");
  assert.notEqual(payload.overrideModel, null, "overrideModel must not be dropped when the entry sets an explicit model");
  assert.equal(payload.model, "explicit-angle-model", "primary model must honor the explicit per-angle model with precedence");
  assert.notEqual(payload.model, "audit-claude", "primary model must NOT leak the tier value when an explicit per-angle model is set");
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

// Capture process.stdout so the --fields render (written straight to stdout by
// emitResult) can be asserted without spawning a subprocess.
async function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = (chunk) => {
    out += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return out;
}

test("CLI resolves a built-in angle against a repo with no .devloops override", async () => {
  await withTempRepo(null, async (repoRoot) => {
    const result = await runCli(["--angle", "correctness", "--harness", "claude"], { repoRoot, env: {} });
    assert.equal(result.ok, true);
    assert.equal(result.persona, "review");
    assert.equal(result.model, "opus");
    // The shipped extension-defaults supply a real focus prompt for the built-in
    // `correctness` angle; the merged config must surface it (not null/empty).
    assert.ok(
      typeof result.prompt === "string" && result.prompt.length > 0,
      "a built-in angle must resolve a non-empty focus prompt from the merged config",
    );
  });
});

// H1: a `.devloops` that fails per-layer schema validation (here: missing
// `version: 1`) is DROPPED by the loader, so the CLI would otherwise return the
// shipped default with ok:true — the exact wrong-role bug this CLI prevents.
// Fail closed: config errors force ok:false and a nonzero exit.
test("CLI fails closed (ok:false, nonzero exit) when .devloops has config-layer errors", async () => {
  const brokenDevloops = ["gates:", "  draft:", "    angles: []", ""].join("\n"); // no `version: 1`
  await withTempRepo(brokenDevloops, async (repoRoot) => {
    process.exitCode = 0;
    const result = await runCli(["--angle", "correctness", "--harness", "claude"], { repoRoot, env: {} });
    assert.equal(result.ok, false, "config-layer errors must force ok:false");
    assert.ok(result.configErrorCount > 0, "the dropped-layer errors must be surfaced in configErrorCount");
    assert.notEqual(process.exitCode, 0, "config-layer errors must produce a nonzero exit");
    process.exitCode = 0;
  });
});

// M1: an unknown/typo angle resolves only to the generic fallback persona;
// silently returning ok:true would let a mis-typed angle pass with the wrong
// persona. Fail closed: a fallback role sets ok:false.
test("CLI fails closed (ok:false) for an unknown angle that resolves only to the fallback persona", async () => {
  await withTempRepo(null, async (repoRoot) => {
    process.exitCode = 0;
    const result = await runCli(["--angle", "not-a-real-angle-xyz", "--harness", "claude"], { repoRoot, env: {} });
    assert.equal(result.fallback, true, "an unknown angle must resolve to the fallback persona");
    assert.equal(result.ok, false, "a fallback (unresolved) angle must fail closed");
    assert.notEqual(process.exitCode, 0, "an unresolved angle must produce a nonzero exit");
    process.exitCode = 0;
  });
});

// M2: --fields must be forwarded to emitResult (it was parsed but dropped).
test("--fields narrows the CLI output to the named top-level scalar fields, tab-separated", async () => {
  await withTempRepo(null, async (repoRoot) => {
    const out = await captureStdout(() =>
      runCli(["--angle", "correctness", "--harness", "claude", "--fields", "persona,model"], { repoRoot, env: {} }),
    );
    assert.equal(out.trim(), "review\topus", "--fields persona,model must print exactly those two scalars, tab-separated");
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
