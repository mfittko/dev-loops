// Multica asset-sync contract (MFIT-367).
//
// The `multica` CLI is mocked with an in-memory "server" store, so the whole
// suite is offline and bounded (no live workspace, no network). Coverage:
//  - in-sync: dry-run reports every target `in-sync` and exits ok.
//  - drift: dry-run reports `drift` (not ok); a real run updates + verifies,
//    writes a timestamped backup of the pre-images, and exits ok.
//  - update-then-verify mismatch: a CLI that stores something other than what
//    was uploaded is caught by the post-update verify (status `mismatch`, not ok).
//  - missing CLI: bump-version's best-effort hook skips the sync with one
//    warning line and never fails the release.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { desiredBody, loadConfig, stripFrontmatter, syncMulti } from "../../scripts/release/sync-multica.mjs";
import { maybeSyncMulticaAssets } from "../../scripts/release/bump-version.mjs";

const sha256 = (t) => createHash("sha256").update(t, "utf8").digest("hex");

const AGENT_ID = "agent-1";
const SKILL_IDS = { dl: "skill-dl", copilot: "skill-copilot", final: "skill-final" };

const AGENT_SOURCE = `---
name: "dev-loop"
tools: Read
---
<!-- GENERATED -->

You are the dev-loop entrypoint. Pinned: npx dev-loops@1.0.4 loop startup.
`;

function skillSource(name) {
  return `---\nname: ${name}\n---\n# ${name}\n\nBody for ${name}, npx dev-loops@1.0.4.\n`;
}

// Build a fixture repo with the four generated assets and a matching config.
function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "sync-multica-fixture-"));
  mkdirSync(path.join(dir, ".claude/agents"), { recursive: true });
  for (const s of ["dev-loop", "copilot-pr-followup", "final-approval"]) {
    mkdirSync(path.join(dir, `.claude/skills/${s}`), { recursive: true });
  }
  writeFileSync(path.join(dir, ".claude/agents/dev-loop.md"), AGENT_SOURCE);
  writeFileSync(path.join(dir, ".claude/skills/dev-loop/SKILL.md"), skillSource("dev-loop"));
  writeFileSync(path.join(dir, ".claude/skills/copilot-pr-followup/SKILL.md"), skillSource("copilot-pr-followup"));
  writeFileSync(path.join(dir, ".claude/skills/final-approval/SKILL.md"), skillSource("final-approval"));
  writeFileSync(
    path.join(dir, "multica-sync.json"),
    JSON.stringify({
      targets: [
        { kind: "agent", id: AGENT_ID, label: "agent:dev-loop", source: ".claude/agents/dev-loop.md" },
        { kind: "skill", id: SKILL_IDS.dl, label: "skill:dev-loop", source: ".claude/skills/dev-loop/SKILL.md" },
        { kind: "skill", id: SKILL_IDS.copilot, label: "skill:copilot-pr-followup", source: ".claude/skills/copilot-pr-followup/SKILL.md" },
        { kind: "skill", id: SKILL_IDS.final, label: "skill:final-approval", source: ".claude/skills/final-approval/SKILL.md" },
      ],
    }),
  );
  return dir;
}

// A mock `multica` CLI backed by an in-memory store. `corruptUpdate` makes an
// update store a different body than uploaded — to drive the verify-mismatch case.
function makeMockCli(store, { corruptUpdate = false } = {}) {
  return (args, { input } = {}) => {
    const [domain, verb] = args;
    const id = args[2];
    if (domain === "agent" && verb === "get") {
      return { status: 0, stdout: JSON.stringify({ id, instructions: store.get(id) ?? "" }), stderr: "" };
    }
    if (domain === "skill" && verb === "get") {
      const body = store.get(id) ?? "";
      return { status: 0, stdout: JSON.stringify({ id, content: body, content_hash: sha256(body) }), stderr: "" };
    }
    if (domain === "agent" && verb === "update") {
      const i = args.indexOf("--instructions");
      const body = args[i + 1];
      store.set(id, corruptUpdate ? `${body} CORRUPTED` : body);
      return { status: 0, stdout: "{}", stderr: "" };
    }
    if (domain === "skill" && verb === "update") {
      const i = args.indexOf("--content-file");
      const body = readFileSync(args[i + 1], "utf8");
      store.set(id, corruptUpdate ? `${body} CORRUPTED` : body);
      return { status: 0, stdout: "{}", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected: ${args.join(" ")}` };
  };
}

// Seed the store so every target already holds its exact desired body.
function seedInSync(store, dir) {
  for (const t of loadConfig(dir, "multica-sync.json")) {
    store.set(t.id, desiredBody(t, dir));
  }
}

test("stripFrontmatter removes a leading YAML block and leaves the body", () => {
  assert.equal(stripFrontmatter(AGENT_SOURCE), "<!-- GENERATED -->\n\nYou are the dev-loop entrypoint. Pinned: npx dev-loops@1.0.4 loop startup.\n");
  assert.equal(stripFrontmatter("no frontmatter here\n"), "no frontmatter here\n");
});

test("dry-run reports in-sync for every matching target and exits ok", () => {
  const dir = makeFixture();
  try {
    const store = new Map();
    seedInSync(store, dir);
    const result = syncMulti({ repoRoot: dir, configPath: "multica-sync.json", dryRun: true, runCli: makeMockCli(store) });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.backupDir, null);
    assert.equal(result.targets.length, 4);
    assert.ok(result.targets.every((t) => t.status === "in-sync"), JSON.stringify(result.targets));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dry-run reports drift and exits non-ok when a stored body is stale", () => {
  const dir = makeFixture();
  try {
    const store = new Map();
    seedInSync(store, dir);
    store.set(SKILL_IDS.copilot, "stale body\n"); // one drifted target
    const result = syncMulti({ repoRoot: dir, configPath: "multica-sync.json", dryRun: true, runCli: makeMockCli(store) });
    assert.equal(result.ok, false);
    const drifted = result.targets.filter((t) => t.status === "drift").map((t) => t.label);
    assert.deepEqual(drifted, ["skill:copilot-pr-followup"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real run backs up pre-images, updates every target, verifies, and exits ok", () => {
  const dir = makeFixture();
  try {
    const store = new Map();
    // Start fully drifted: server holds stale bodies for all four.
    for (const t of loadConfig(dir, "multica-sync.json")) store.set(t.id, `stale ${t.id}\n`);
    const backupsRoot = path.join(dir, "backups");
    const result = syncMulti({
      repoRoot: dir,
      configPath: "multica-sync.json",
      runCli: makeMockCli(store),
      now: new Date("2026-09-25T10:00:00Z"),
      backupsRoot,
    });
    assert.equal(result.ok, true);
    assert.ok(result.targets.every((t) => t.status === "verified" && t.changed), JSON.stringify(result.targets));

    // Server now holds the exact desired bodies.
    for (const t of loadConfig(dir, "multica-sync.json")) {
      assert.equal(store.get(t.id), desiredBody(t, dir));
    }

    // Backup directory exists, is printed via result.backupDir, and holds the pre-images.
    assert.ok(result.backupDir.startsWith(backupsRoot));
    assert.ok(existsSync(result.backupDir));
    const files = readdirSync(result.backupDir).sort();
    assert.equal(files.length, 4);
    const agentBackup = files.find((f) => f.startsWith("agent-dev-loop"));
    assert.equal(readFileSync(path.join(result.backupDir, agentBackup), "utf8"), `stale ${AGENT_ID}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update-then-verify mismatch is caught and exits non-ok", () => {
  const dir = makeFixture();
  try {
    const store = new Map();
    seedInSync(store, dir);
    const result = syncMulti({
      repoRoot: dir,
      configPath: "multica-sync.json",
      runCli: makeMockCli(store, { corruptUpdate: true }),
      backupsRoot: path.join(dir, "backups"),
    });
    assert.equal(result.ok, false);
    assert.ok(result.targets.every((t) => t.status === "mismatch"), JSON.stringify(result.targets));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bump-version skips the sync with one warning when the multica CLI is absent", () => {
  let warnings = "";
  const outcome = maybeSyncMulticaAssets({
    repoRoot: "/nonexistent",
    probe: () => ({ error: Object.assign(new Error("spawn multica ENOENT"), { code: "ENOENT" }) }),
    runSync: () => {
      throw new Error("sync must not run when the CLI is missing");
    },
    stderr: { write: (s) => (warnings += s) },
  });
  assert.deepEqual(outcome, { ran: false, reason: "no-cli" });
  assert.match(warnings, /not on PATH/);
  assert.equal(warnings.trim().split("\n").length, 1); // exactly one warning line
});

test("bump-version skips the sync with one warning when the CLI is unauthenticated", () => {
  let warnings = "";
  const outcome = maybeSyncMulticaAssets({
    repoRoot: "/nonexistent",
    probe: () => ({ status: 1 }),
    runSync: () => {
      throw new Error("sync must not run when unauthenticated");
    },
    stderr: { write: (s) => (warnings += s) },
  });
  assert.deepEqual(outcome, { ran: false, reason: "unauthenticated" });
  assert.match(warnings, /not authenticated/);
});
