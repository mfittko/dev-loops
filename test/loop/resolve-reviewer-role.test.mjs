import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "bun:test";

import { runNode } from "../_helpers.mjs";
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

test("parse: accepts the canonical gate id and normalizes it to its config key", () => {
  // GATE_CONFIG_KEY is the single source of the marker-name -> config-key
  // mapping; both spellings must be accepted so the briefing's own gate id
  // (`pre_approval_gate`) does not error out. `--gate` never changes persona/
  // prompt/model, only the reported surface scope.
  assert.equal(
    parseResolveReviewerRoleCliArgs(["--angle", "correctness", "--gate", "pre_approval_gate"]).gate,
    "preApproval",
  );
  assert.equal(
    parseResolveReviewerRoleCliArgs(["--angle", "correctness", "--gate", "draft_gate"]).gate,
    "draft",
  );
  assert.equal(
    parseResolveReviewerRoleCliArgs(["--angle", "correctness", "--gate", "preApproval"]).gate,
    "preApproval",
  );
  assert.equal(
    parseResolveReviewerRoleCliArgs(["--angle", "correctness", "--gate", "spike"]).gate,
    "spike",
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
  assert.equal(payload.status, "prompt-missing");
});

// A configured gate angle that ships only a fallback persona is NOT a typo: it
// must be reported distinctly (ok:true, status:fallback) so a reviewer for a
// real gate angle is not pushed to a false blocked or the forbidden defaults
// grep. Only an angle ABSENT from the merged gate config stays ok:false.
test("a configured gate angle with only a fallback persona reports ok:true + status:fallback", () => {
  const config = { gates: { preApproval: { angles: ["contradiction-lens"] } } };
  const payload = resolveRolePayload(config, { angle: "contradiction-lens", harness: "claude" });
  assert.equal(payload.fallback, true, "contradiction-lens has no dedicated persona entry");
  assert.equal(payload.ok, true, "a configured angle must not fail closed like an unknown angle");
  assert.equal(payload.status, "fallback");
  assert.ok(payload.warnings.some((w) => /configured in the merged gate config/.test(w)));
});

test("an angle absent from the merged gate config stays ok:false + status:unresolved", () => {
  const config = { gates: { preApproval: { angles: ["contradiction-lens"] } } };
  const payload = resolveRolePayload(config, { angle: "not-a-real-angle-xyz", harness: "claude" });
  assert.equal(payload.fallback, true);
  assert.equal(payload.ok, false, "an unknown angle must fail closed");
  assert.equal(payload.status, "unresolved");
});

test("a non-fallback built-in angle absent from every declared gate stays unresolved", () => {
  const config = { gates: { preApproval: { angles: ["contradiction-lens"] } } };
  const payload = resolveRolePayload(config, { angle: "correctness", harness: "claude" });
  assert.equal(payload.fallback, false);
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "unresolved");
});

test("a non-fallback angle outside the gate named by --gate stays unresolved", () => {
  const config = { gates: { draft: { angles: ["correctness"] }, preApproval: { angles: ["security"] } } };
  const payload = resolveRolePayload(config, { angle: "correctness", harness: "claude", gate: "preApproval" });
  assert.equal(payload.fallback, false);
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "unresolved");
});

// #2336 follow-up: `dynamic.additive` can dispatch an angle that is NOT in the
// static gate list (it lives only in the additive pool). The fallback
// classifier must use the SAME additive-aware pool dynamic dispatch uses, or a
// legitimately dispatched angle is misreported as a typo (ok:false).
test("a fallback angle reachable only via the additive pool is classified configured, not unresolved", () => {
  const config = {
    gates: {
      anglePool: ["contradiction-lens"],
      preApproval: { dynamic: { additive: true }, angles: ["acceptance-criteria"] },
    },
  };
  const payload = resolveRolePayload(config, { angle: "contradiction-lens", harness: "claude" });
  assert.equal(payload.fallback, true, "contradiction-lens has no dedicated persona entry");
  assert.equal(payload.ok, true, "an additive-pool angle is legitimately dispatchable, not a typo");
  assert.equal(payload.status, "fallback");
});

// Complement: additive mode must NOT turn a genuinely unknown angle into a
// false "configured" — an angle in neither the static list nor the additive
// pool stays unresolved.
test("an angle in neither the static list nor the additive pool stays unresolved even with additive on", () => {
  const config = {
    gates: {
      anglePool: ["contradiction-lens"],
      preApproval: { dynamic: { additive: true }, angles: ["acceptance-criteria"] },
    },
  };
  const payload = resolveRolePayload(config, { angle: "not-a-real-angle-xyz", harness: "claude" });
  assert.equal(payload.ok, false);
  assert.equal(payload.status, "unresolved");
});

// #2336 follow-up: loadDevLoopConfig errors can originate from ANY layer
// (extensionDefaults, repo defaults, .devloops, or the final merged
// validation), not only .devloops — the warning must name the affected layer(s)
// instead of always blaming .devloops.
test("the config-error warning names the affected layer(s)", () => {
  const payload = resolveRolePayload({}, {
    angle: "correctness",
    harness: "claude",
    configErrors: [
      { path: "ext.yaml", message: "x", layer: "extensionDefaults" },
      { path: "<merged>", message: "y", layer: "merged" },
      { path: "ext.yaml", message: "z", layer: "extensionDefaults" },
    ],
  });
  assert.equal(payload.status, "config-error");
  assert.equal(payload.ok, false);
  assert.ok(
    payload.warnings.some((w) => /in layer\(s\) extensionDefaults, merged/.test(w)),
    "the warning must name the affected layer(s), deduped",
  );
});

test("the config-error warning degrades gracefully when no layer is present", () => {
  const payload = resolveRolePayload({}, {
    angle: "correctness",
    harness: "claude",
    configErrors: [{ path: "x", message: "y" }],
  });
  assert.equal(payload.status, "config-error");
  assert.ok(payload.warnings.some((w) => /config-layer error\(s\);/.test(w)));
});

// A non-fallback angle whose prompt is null/empty (a repo `.devloops` override
// that sets only `persona`) must be signalled, not silently returned as a
// usable focus instruction.
test("a non-fallback angle with a null/empty prompt is signalled as prompt-missing", () => {
  const config = { gates: { draft: { angles: [{ name: "acceptance-criteria", persona: "overridden-persona" }] } } };
  const payload = resolveRolePayload(config, { angle: "acceptance-criteria", harness: "claude" });
  assert.equal(payload.fallback, false);
  assert.equal(payload.prompt, null);
  assert.equal(payload.ok, true, "a persona-only override is a legitimate config, not a hard failure");
  assert.equal(payload.status, "prompt-missing");
  assert.ok(payload.warnings.some((w) => /prompt is null\/empty/.test(w)));
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
    assert.equal(result.status, "unresolved");
    assert.notEqual(process.exitCode, 0, "an unresolved angle must produce a nonzero exit");
    process.exitCode = 0;
  });
});

// A CONFIGURED gate angle that ships only a fallback persona must NOT fail
// closed like a typo: the CLI reports it distinctly (ok:true, status:fallback)
// and exits 0, so a reviewer for a real gate angle is not pushed to a false
// blocked or the forbidden defaults grep.
test("CLI reports a configured fallback angle distinctly (ok:true, status:fallback, exit 0)", async () => {
  await withTempRepo(null, async (repoRoot) => {
    process.exitCode = 0;
    const result = await runCli(["--angle", "contradiction-lens", "--harness", "claude"], { repoRoot, env: {} });
    assert.equal(result.fallback, true, "contradiction-lens ships without a dedicated persona");
    assert.equal(result.ok, true, "a configured angle must not fail closed like an unknown angle");
    assert.equal(result.status, "fallback");
    assert.equal(process.exitCode, 0, "a configured fallback angle must exit 0");
  });
});

test("CLI accepts the canonical gate id (--gate pre_approval_gate) and normalizes it", async () => {
  await withTempRepo(null, async (repoRoot) => {
    const result = await runCli(
      ["--angle", "dry", "--gate", "pre_approval_gate", "--harness", "claude"],
      { repoRoot, env: {} },
    );
    assert.equal(result.gate, "preApproval", "--gate pre_approval_gate must normalize to the config key");
    assert.equal(result.ok, true);
  });
});

// A repo `.devloops` entry that overrides only `persona` (no prompt anywhere for
// that angle) resolves a non-fallback role with prompt:null. The CLI must
// surface that rather than returning an unusable focus instruction silently.
test("CLI surfaces a persona-only override's missing prompt (status:prompt-missing, exit 0)", async () => {
  const devloops = [
    "version: 1",
    "gates:",
    "  preApproval:",
    "    angles:",
    "      - name: acceptance-criteria",
    "        persona: overridden-persona",
    "",
  ].join("\n");
  await withTempRepo(devloops, async (repoRoot) => {
    process.exitCode = 0;
    const result = await runCli(["--angle", "acceptance-criteria", "--harness", "claude"], { repoRoot, env: {} });
    assert.equal(result.persona, "overridden-persona");
    assert.equal(result.prompt, null);
    assert.equal(result.ok, true, "a persona-only override is legitimate, not a hard failure");
    assert.equal(result.status, "prompt-missing");
    assert.ok(result.warnings.some((w) => /prompt is null\/empty/.test(w)), "the lost prompt must be surfaced");
    assert.equal(process.exitCode, 0, "a persona-only override must not be a hard failure");
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
    assert.equal(claude.status, "resolved", "the merged override keeps the shipped focus prompt, so it resolves cleanly");
    assert.ok(
      typeof claude.prompt === "string" && claude.prompt.length > 0,
      "the override must not silently drop the shipped focus prompt",
    );
    const pi = await runCli(["--angle", "correctness", "--harness", "pi"], { repoRoot, env: {} });
    assert.equal(pi.model, "audit-pi-model", "model must resolve per-harness from the merged tier");
  });
});

// The CLI defaults its repoRoot to the git toplevel (resolveRepoRoot), so a
// reviewer whose shell starts in a subdirectory still gets the repo's
// `.devloops` layer instead of silently falling back to the shipped default.
test("CLI run from a subdirectory resolves the repo's .devloops from the git toplevel", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "resolve-role-subdir-"));
  try {
    await writeFile(
      path.join(dir, ".devloops.yaml"),
      [
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
      ].join("\n"),
      "utf8",
    );
    const subdir = path.join(dir, "nested", "deeper");
    await mkdir(subdir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
    const { code, stdout, stderr } = await runNode(
      path.resolve("scripts/loop/resolve-reviewer-role.mjs"),
      ["--angle", "correctness", "--harness", "claude"],
      { cwd: subdir },
    );
    assert.equal(code, 0, `expected exit 0, got stderr: ${stderr}`);
    const result = JSON.parse(stdout.trim());
    assert.equal(
      result.persona,
      "paranoid-auditor",
      "must read the .devloops at the git toplevel, not the subdirectory cwd",
    );
    assert.equal(result.model, "audit-claude-model");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
