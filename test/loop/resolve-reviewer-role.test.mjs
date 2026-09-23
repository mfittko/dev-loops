// CLI e2e coverage for `dev-loops gate resolve-role` (issue #2336). Real
// subprocess invocations so the assertions bind to the ACTUAL process exit
// code, not an in-process mock of it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(REPO_ROOT, "cli/index.mjs");
const LAUNCHER = path.join(REPO_ROOT, ".claude/bin/dev-loops-run");

async function makeFixtureRepo({ defaultsYaml = null, devloops = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dev-loops-2336-resolve-role-"));
  // `.devloops` (bare, no extension) marks a synthetic repo root for
  // resolveRepoRoot even before any content is written for it.
  if (devloops !== null) {
    await writeFile(path.join(dir, ".devloops"), devloops);
  } else {
    // Every fixture needs SOME repo-root marker; an empty .devloops layer is
    // rejected (EMPTY_FILE), so default to a minimal valid layer instead.
    await writeFile(path.join(dir, ".devloops"), "version: 1\n");
  }
  if (defaultsYaml !== null) {
    await mkdir(path.join(dir, ".pi/dev-loop"), { recursive: true });
    await writeFile(path.join(dir, ".pi/dev-loop/defaults.yaml"), defaultsYaml);
  }
  return dir;
}

function runCli(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, "gate", "resolve-role", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function parseJson(stdout) {
  return JSON.parse(stdout.trim().split("\n").pop());
}

// ---------------------------------------------------------------------------
// Argument errors: exit 2, shared parse-error/usage shape.
// ---------------------------------------------------------------------------

test("missing --gate: exit 2, shared usage-error shape", async () => {
  const dir = await makeFixtureRepo();
  try {
    const r = runCli(["--angle", "correctness"], { cwd: dir });
    assert.equal(r.status, 2);
    const payload = JSON.parse(r.stderr.trim());
    assert.equal(payload.ok, false);
    assert.match(payload.error, /--gate/);
    assert.equal(payload.hint, "run with --help for usage");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing --angle: exit 2, shared usage-error shape", async () => {
  const dir = await makeFixtureRepo();
  try {
    const r = runCli(["--gate", "draft_gate"], { cwd: dir });
    assert.equal(r.status, 2);
    const payload = JSON.parse(r.stderr.trim());
    assert.equal(payload.ok, false);
    assert.match(payload.error, /--angle/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unknown --gate value: exit 2", async () => {
  const dir = await makeFixtureRepo();
  try {
    const r = runCli(["--gate", "not_a_real_gate", "--angle", "correctness"], { cwd: dir });
    assert.equal(r.status, 2);
    const payload = JSON.parse(r.stderr.trim());
    assert.match(payload.error, /--gate must be one of/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("whitespace-only --harness: exit 2 (never a silent env fallback)", async () => {
  const dir = await makeFixtureRepo();
  try {
    const r = runCli(["--gate", "draft_gate", "--angle", "correctness", "--harness", " "], { cwd: dir });
    assert.equal(r.status, 2);
    const payload = JSON.parse(r.stderr.trim());
    assert.match(payload.error, /--harness must be one of/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const alias of ["draft", "preApproval"]) {
  test(`config-key alias --gate ${alias} is rejected: exit 2 (never inferred/aliased)`, async () => {
    const dir = await makeFixtureRepo();
    try {
      const r = runCli(["--gate", alias, "--angle", "correctness"], { cwd: dir });
      assert.equal(r.status, 2);
      const payload = JSON.parse(r.stderr.trim());
      assert.match(payload.error, /--gate must be one of/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// ---------------------------------------------------------------------------
// Representative rows across equivalence classes: real process exit codes.
// ---------------------------------------------------------------------------

test("member angle, no config errors: exit 0, ok:true, status resolved", async () => {
  const dir = await makeFixtureRepo({
    devloops: "version: 1\ngates:\n  draft:\n    angles:\n      - name: test-angle\n        persona: test-persona\n        prompt: \"Focus on the thing.\"\n",
  });
  try {
    const r = runCli(["--gate", "draft_gate", "--angle", "test-angle"], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const payload = parseJson(r.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "resolved");
    assert.equal(payload.persona, "test-persona");
    assert.equal(payload.prompt, "Focus on the thing.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-member angle: exit 1, ok:false, status non-member", async () => {
  const dir = await makeFixtureRepo({
    devloops: "version: 1\ngates:\n  draft:\n    angles:\n      - correctness\n",
  });
  try {
    const r = runCli(["--gate", "draft_gate", "--angle", "totally-unconfigured-angle"], { cwd: dir });
    assert.equal(r.status, 1, r.stderr);
    const payload = parseJson(r.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "non-member");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("non-member with --jq .persona --silent still exits 1 (result.ok, not jq truthiness, decides exit)", async () => {
  const dir = await makeFixtureRepo({
    devloops: "version: 1\ngates:\n  draft:\n    angles:\n      - correctness\n",
  });
  try {
    const r = runCli(["--gate", "draft_gate", "--angle", "totally-unconfigured-angle", "--jq", ".persona", "--silent"], { cwd: dir });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stdout, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("angle valid for a different operation is rejected: exit 1", async () => {
  const dir = await makeFixtureRepo({
    devloops: "version: 1\ngates:\n  preApproval:\n    angles:\n      - security\n",
  });
  try {
    const r = runCli(["--gate", "draft_gate", "--angle", "security"], { cwd: dir });
    assert.equal(r.status, 1, r.stderr);
    const payload = parseJson(r.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "non-member");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("configured member with no dedicated persona/prompt entry: exit 0, status fallback", async () => {
  const dir = await makeFixtureRepo({
    devloops: "version: 1\ngates:\n  draft:\n    angles:\n      - test-angle\n",
  });
  try {
    const r = runCli(["--gate", "draft_gate", "--angle", "test-angle"], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const payload = parseJson(r.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "fallback");
    assert.equal(payload.fallback, true);
    assert.equal(payload.prompt, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concrete member with persona but no prompt: exit 0, status prompt-missing", async () => {
  const dir = await makeFixtureRepo({
    devloops: "version: 1\ngates:\n  draft:\n    angles:\n      - name: test-angle\n        persona: test-persona\n",
  });
  try {
    const r = runCli(["--gate", "draft_gate", "--angle", "test-angle"], { cwd: dir });
    assert.equal(r.status, 0, r.stderr);
    const payload = parseJson(r.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.status, "prompt-missing");
    assert.equal(payload.fallback, false);
    assert.equal(payload.prompt, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("standalone review operation authorizes the static draft+preApproval union", async () => {
  const dir = await makeFixtureRepo({
    devloops:
      "version: 1\ngates:\n  draft:\n    angles:\n      - correctness\n  preApproval:\n    angles:\n      - name: security\n        persona: security\n        prompt: \"Check for auth/permission regressions.\"\n",
  });
  try {
    const r1 = runCli(["--gate", "review", "--angle", "correctness"], { cwd: dir });
    assert.equal(r1.status, 0, r1.stderr);
    const r2 = runCli(["--gate", "review", "--angle", "security"], { cwd: dir });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(parseJson(r2.stdout).persona, "security");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("spike operation resolves only the gates.spike pool", async () => {
  const dir = await makeFixtureRepo({
    devloops: "version: 1\ngates:\n  spike:\n    angles:\n      - spike-only-lens\n",
  });
  try {
    const member = runCli(["--gate", "spike", "--angle", "spike-only-lens"], { cwd: dir });
    assert.equal(member.status, 0, member.stderr);
    const nonMember = runCli(["--gate", "draft_gate", "--angle", "spike-only-lens"], { cwd: dir });
    assert.equal(nonMember.status, 1, nonMember.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Layered config: extension defaults < .pi/dev-loop/defaults.yaml < .devloops
// (repository overrides win for persona/prompt/model), on both harnesses.
// ---------------------------------------------------------------------------

for (const harness of ["claude", "pi"]) {
  test(`layered config: .devloops overrides persona/prompt/model over .pi/dev-loop/defaults (harness=${harness})`, async () => {
    const dir = await makeFixtureRepo({
      defaultsYaml:
        "version: 1\ngates:\n  draft:\n    angles:\n      - name: test-angle\n        persona: base-persona\n        prompt: \"Base prompt.\"\n        model: base-model\n",
      devloops:
        "version: 1\ngates:\n  draft:\n    angles:\n      - name: test-angle\n        persona: override-persona\n        prompt: \"Override prompt.\"\n        model: override-model\n",
    });
    try {
      const r = runCli(["--gate", "draft_gate", "--angle", "test-angle", "--harness", harness], { cwd: dir });
      assert.equal(r.status, 0, r.stderr);
      const payload = parseJson(r.stdout);
      assert.equal(payload.persona, "override-persona");
      assert.equal(payload.prompt, "Override prompt.");
      assert.equal(payload.model, "override-model");
      assert.equal(payload.harness, harness);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

// The layered-config loop above pins a literal angle `model:`, which
// resolveRoleModel(kind: "angle") returns before it ever reads `harness`
// (config.mjs), so it cannot prove --harness actually threads through. This
// fixture instead leaves the angle's `model` unset, sets a `tier:` alias, and
// configures `models.tiers.<alias>` with DISTINCT claude/pi ids — the only
// shape that can observe a harness mixup.
test("--harness selects the harness-specific tier model (no per-angle literal model)", async () => {
  const dir = await makeFixtureRepo({
    devloops:
      "version: 1\nmodels:\n  tiers:\n    resolve-role-2336-tier:\n      claude: claude-tier-model\n      pi: pi-tier-model\ngates:\n  draft:\n    angles:\n      - name: tiered-angle\n        persona: tiered-persona\n        prompt: \"Tiered prompt.\"\n        tier: resolve-role-2336-tier\n",
  });
  try {
    const claude = runCli(["--gate", "draft_gate", "--angle", "tiered-angle", "--harness", "claude"], { cwd: dir });
    assert.equal(claude.status, 0, claude.stderr);
    const claudePayload = parseJson(claude.stdout);
    assert.equal(claudePayload.model, "claude-tier-model");

    const pi = runCli(["--gate", "draft_gate", "--angle", "tiered-angle", "--harness", "pi"], { cwd: dir });
    assert.equal(pi.status, 0, pi.stderr);
    const piPayload = parseJson(pi.stdout);
    assert.equal(piPayload.model, "pi-tier-model");

    // Eligibility/exit code are harness-independent; only the model differs.
    assert.equal(claudePayload.ok, piPayload.ok);
    assert.notEqual(claudePayload.model, piPayload.model);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--harness defaults to claude under a Claude-harness env, pi otherwise", async () => {
  const dir = await makeFixtureRepo({
    devloops: "version: 1\ngates:\n  draft:\n    angles:\n      - correctness\n",
  });
  try {
    const claudeDefault = runCli(["--gate", "draft_gate", "--angle", "correctness"], {
      cwd: dir,
      env: { CLAUDECODE: "1" },
    });
    assert.equal(parseJson(claudeDefault.stdout).harness, "claude");
    const piDefault = runCli(["--gate", "draft_gate", "--angle", "correctness"], {
      cwd: dir,
      env: { CLAUDECODE: "" },
    });
    assert.equal(parseJson(piDefault.stdout).harness, "pi");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Config-layer failures: fail closed, never a trusted shipped default.
// ---------------------------------------------------------------------------

test("a broken repository layer (malformed YAML) fails closed: exit 1", async () => {
  const dir = await makeFixtureRepo({ devloops: "gates: [not, valid, :::" });
  try {
    const r = runCli(["--gate", "draft_gate", "--angle", "correctness"], { cwd: dir });
    assert.equal(r.status, 1, r.stderr);
    const payload = parseJson(r.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "config-error");
    assert.ok(payload.configErrors.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Each individual config layer validates on its OWN — schema-valid at both
// `.pi/dev-loop/defaults.yaml` and `.devloops` in isolation — but the later
// layer's `models.tiers` wholesale-replaces the earlier layer's, leaving the
// earlier layer's `models.roleTiers` entry pointing at a tier alias that no
// longer exists once merged. Only the FINAL merged-schema check (layer
// "merged") catches this; per-layer validation cannot.
test("a merged-validation error (no single broken layer) fails closed: exit 1", async () => {
  const dir = await makeFixtureRepo({
    defaultsYaml: "version: 1\nmodels:\n  tiers:\n    mytier:\n      claude: model-a\n  roleTiers:\n    test-angle: mytier\n",
    devloops: "version: 1\nmodels:\n  tiers:\n    othertier:\n      claude: model-b\n",
  });
  try {
    const r = runCli(["--gate", "draft_gate", "--angle", "test-angle"], { cwd: dir });
    assert.equal(r.status, 1, r.stderr);
    const payload = parseJson(r.stdout);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "config-error");
    assert.ok(payload.configErrors.some((e) => e.layer === "merged"), JSON.stringify(payload.configErrors));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Cross-harness: package-root Pi form and the generated Claude launcher form
// both run against the reviewed worktree/repo and agree on ok/exit.
// ---------------------------------------------------------------------------

test("package-root `node cli/index.mjs` and `.claude/bin/dev-loops-run` agree on ok/exit", async () => {
  const dir = await makeFixtureRepo({
    devloops: "version: 1\ngates:\n  draft:\n    angles:\n      - name: test-angle\n        persona: test-persona\n        prompt: \"Focus.\"\n",
  });
  try {
    const piForm = spawnSync(process.execPath, [CLI, "gate", "resolve-role", "--gate", "draft_gate", "--angle", "test-angle"], {
      cwd: dir,
      encoding: "utf8",
    });
    const claudeForm = spawnSync(process.execPath, [LAUNCHER, "cli/index.mjs", "gate", "resolve-role", "--gate", "draft_gate", "--angle", "test-angle"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(piForm.status, 0, piForm.stderr);
    assert.equal(claudeForm.status, piForm.status);
    const piPayload = parseJson(piForm.stdout);
    const claudePayload = parseJson(claudeForm.stdout);
    assert.equal(claudePayload.ok, piPayload.ok);
    assert.equal(claudePayload.status, piPayload.status);
    assert.equal(claudePayload.persona, piPayload.persona);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cross-harness non-member also agrees on ok/exit (nonzero)", async () => {
  const dir = await makeFixtureRepo({
    devloops: "version: 1\ngates:\n  draft:\n    angles:\n      - correctness\n",
  });
  try {
    const piForm = spawnSync(process.execPath, [CLI, "gate", "resolve-role", "--gate", "draft_gate", "--angle", "unconfigured-angle"], {
      cwd: dir,
      encoding: "utf8",
    });
    const claudeForm = spawnSync(process.execPath, [LAUNCHER, "cli/index.mjs", "gate", "resolve-role", "--gate", "draft_gate", "--angle", "unconfigured-angle"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(piForm.status, 1, piForm.stderr);
    assert.equal(claudeForm.status, 1, claudeForm.stderr);
    assert.equal(parseJson(claudeForm.stdout).ok, parseJson(piForm.stdout).ok);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
