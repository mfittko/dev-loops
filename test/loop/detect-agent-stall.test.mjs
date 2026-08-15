import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { describe, it } from "node:test";
import { runNode, runIdFreeEnv } from "../_helpers.mjs";

const scriptPath = path.resolve("scripts/loop/detect-agent-stall.mjs");
const REPO = "mfittko/dev-loops";

async function runProbe(args, { cwd, env } = {}) {
  const envAll = env ? { ...process.env, ...env } : process.env;
  const result = await runNode(scriptPath, args, { cwd, env: envAll });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  return { ...result, parsed };
}

describe("detect-agent-stall CLI probe (#1669)", () => {
  it("reports stalled when status.json lastActivityAt is older than threshold", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stall-"));
    try {
      const stale = Date.now() - 6 * 60 * 1000;
      await mkdir(path.join(dir, "run"));
      await writeFile(
        path.join(dir, "run", "status.json"),
        JSON.stringify({ runId: "run-1", state: "running", lastActivityAt: stale }),
        "utf8",
      );
      const { code, parsed } = await runProbe([
        "--repo", REPO, "--status", path.join(dir, "run", "status.json"), "--run-id", "run-1",
      ], { cwd: dir });
      assert.equal(code, 0);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.status, "stalled");
      assert.equal(parsed.stalled, true);
      assert.match(parsed.recoveryBrief, /Recovery dispatch/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports not_stalled when status.json lastActivityAt is fresh", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stall-"));
    try {
      await mkdir(path.join(dir, "run"));
      await writeFile(
        path.join(dir, "run", "status.json"),
        JSON.stringify({ runId: "run-2", state: "running", lastActivityAt: Date.now() - 1000 }),
        "utf8",
      );
      const { code, parsed } = await runProbe([
        "--repo", REPO, "--status", path.join(dir, "run", "status.json"),
      ], { cwd: dir });
      assert.equal(code, 0);
      assert.equal(parsed.status, "not_stalled");
      assert.equal(parsed.stalled, false);
      assert.equal(parsed.reason, "active_turns");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports not_stalled when a pending request is present (AC1 no false bail)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stall-"));
    try {
      const stale = Date.now() - 10 * 60 * 1000;
      await mkdir(path.join(dir, "run"));
      await writeFile(
        path.join(dir, "run", "status.json"),
        JSON.stringify({ runId: "run-3", state: "running", lastActivityAt: stale }),
        "utf8",
      );
      const { code, parsed } = await runProbe([
        "--repo", REPO, "--status", path.join(dir, "run", "status.json"), "--pending-request",
      ], { cwd: dir });
      assert.equal(code, 0);
      assert.equal(parsed.status, "not_stalled");
      assert.equal(parsed.reason, "pending_request");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pending-marker file also marks a pending request", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stall-"));
    try {
      const stale = Date.now() - 10 * 60 * 1000;
      const marker = path.join(dir, "pending.marker");
      await writeFile(marker, "yes", "utf8");
      const { parsed } = await runProbe([
        "--repo", REPO, "--status", "nonexistent.json",
        "--pending-marker", marker, "--session", "nonexistent.jsonl",
      ], { cwd: dir });
      assert.equal(parsed.status, "not_stalled");
      assert.equal(parsed.reason, "pending_request");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns no_evidence when no signals are available", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stall-"));
    try {
      const { code, parsed } = await runProbe([
        "--repo", REPO, "--status", "missing.json", "--session", "missing.jsonl",
      ], { cwd: dir });
      assert.equal(code, 0);
      assert.equal(parsed.status, "no_evidence");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sanctioned-watch heartbeat from runner coordination exempts a stale run (AC2)", async () => {
    // Real git checkout so the probe resolves the coordination root via git
    // common-dir (falls back to canonicalized cwd when git is unavailable).
    const dir = await mkdtemp(path.join(os.tmpdir(), "stall-coord-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: dir });
      spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
      spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
      const coord = path.join(dir, ".pi", "runner-coordination", "mfittko", "dev-loops", "pr-42.json");
      await mkdir(path.dirname(coord), { recursive: true });
      // stale turn signal, but a FRESH runner heartbeat => sanctioned watch
      await writeFile(
        coord,
        JSON.stringify({
          schemaVersion: 2,
          target: { repo: "mfittko/dev-loops", pr: 42 },
          activeRun: { runId: "run-4", claimedAt: new Date().toISOString(), updatedAt: new Date(Date.now() - 1000).toISOString() },
          previousRun: null,
          history: [],
          exitSignals: [],
        }),
        "utf8",
      );
      const stale = Date.now() - 6 * 60 * 1000;
      const statusPath = path.join(dir, "status.json");
      await writeFile(statusPath, JSON.stringify({ runId: "run-4", state: "running", lastActivityAt: stale }), "utf8");
      const { code, parsed } = await runProbe([
        "--repo", REPO, "--pr", "42", "--status", statusPath,
      ], { cwd: dir });
      assert.equal(code, 0);
      assert.equal(parsed.status, "not_stalled");
      assert.equal(parsed.reason, "sanctioned_watch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honors an explicit threshold override", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stall-"));
    try {
      const stale = Date.now() - 3 * 60 * 1000;
      await mkdir(path.join(dir, "run"));
      await writeFile(
        path.join(dir, "run", "status.json"),
        JSON.stringify({ runId: "run-5", state: "running", lastActivityAt: stale }),
        "utf8",
      );
      // default 5m would NOT stall; 1m threshold DOES stall
      const { parsed } = await runProbe([
        "--repo", REPO, "--status", path.join(dir, "run", "status.json"), "--threshold-min", "1",
      ], { cwd: dir });
      assert.equal(parsed.status, "stalled");
      assert.equal(parsed.thresholdMinutes, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires a repo slug", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "stall-"));
    try {
      const { code, parsed } = await runProbe([], { cwd: dir });
      assert.equal(code, 1);
      assert.equal(parsed.ok, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
