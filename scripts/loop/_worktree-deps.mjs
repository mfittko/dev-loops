// Dependency refresh for a worktree. Imports only node builtins so resolve-pr-conflicts works when node_modules is stale.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Fail-soft `bun install --frozen-lockfile` in a worktree without its own node_modules so it never
// resolves packages from the main checkout's stale node_modules.
export function defaultInstallDeps(cwd) {
  const r = spawnSync(process.env.BUN_BIN || "bun", ["install", "--frozen-lockfile"], { cwd, timeout: 300000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) return { ok: false, reason: r.error.message };
  if (r.status === null && r.signal) return { ok: false, reason: `bun install terminated by ${r.signal}` };
  return r.status === 0 ? { ok: true } : { ok: false, exitCode: r.status, reason: (r.stderr ?? "").trim().split("\n").slice(-3).join(" | ") };
}

// Fingerprint of everything that decides node_modules: the lockfile and each workspace package.json.
export function depsFingerprint(worktreePath) {
  const files = [path.join(worktreePath, "bun.lock"), path.join(worktreePath, "package.json")];
  const packagesDir = path.join(worktreePath, "packages");
  if (existsSync(packagesDir)) {
    for (const name of readdirSync(packagesDir).sort()) files.push(path.join(packagesDir, name, "package.json"));
  }
  const hash = createHash("sha256");
  for (const file of files) if (existsSync(file)) hash.update(`${path.relative(worktreePath, file)}\0`).update(readFileSync(file)).update("\0");
  return hash.digest("hex");
}

export const DEPS_STAMP = path.join("node_modules", ".dev-loops-deps-stamp");

function warn(message) {
  process.stderr.write(`[worktree-deps] WARN ${message}\n`);
}

// Runs the install only when the lockfile or a workspace package.json differs from the stamp written by the last
// successful install here. A missing or unreadable stamp counts as changed, so a worktree that predates the stamp installs once.
export function refreshDepsIfChanged(worktreePath, installDeps = defaultInstallDeps) {
  if (!existsSync(path.join(worktreePath, "bun.lock"))) return { ok: true, ran: false, reason: "no bun.lock" };
  try {
    if (readFileSync(path.join(worktreePath, DEPS_STAMP), "utf8") === depsFingerprint(worktreePath)) return { ok: true, ran: false, reason: "deps unchanged" };
  } catch {
    // unreadable stamp or fingerprint: fall through to ensureDeps, which reports a fingerprint failure
  }
  return ensureDeps(worktreePath, installDeps);
}

// Never throws: a filesystem error becomes a stderr WARN and `stampWritten: false`.
export function ensureDeps(worktreePath, installDeps = defaultInstallDeps) {
  try {
    if (!existsSync(path.join(worktreePath, "bun.lock"))) return { ok: true, ran: false, reason: "no bun.lock" };
    let fingerprint;
    try {
      fingerprint = depsFingerprint(worktreePath);
    } catch (err) {
      warn(`deps fingerprint failed (continuing): ${err?.message ?? err}`);
    }
    try {
      rmSync(path.join(worktreePath, DEPS_STAMP), { force: true }); // only a completed install may leave a stamp
    } catch (err) {
      warn(`stale deps stamp not removed (continuing): ${err?.message ?? err}`); // the stamp write below then fails and reports stampWritten false
    }
    let result;
    try {
      result = installDeps(worktreePath) ?? { ok: false, reason: "installDeps returned nothing" };
    } catch (err) {
      result = { ok: false, reason: err?.message ?? String(err) };
    }
    if (!result.ok) {
      warn(`bun install --frozen-lockfile failed (continuing): ${result.reason ?? ""}`);
      return { ran: true, ...result };
    }
    if (fingerprint === undefined) return { ran: true, ...result, stampWritten: false };
    try {
      mkdirSync(path.join(worktreePath, "node_modules"), { recursive: true });
      writeFileSync(path.join(worktreePath, DEPS_STAMP), fingerprint);
    } catch (err) {
      warn(`deps stamp not written (continuing): ${err?.message ?? err}`);
      return { ran: true, ...result, stampWritten: false };
    }
    return { ran: true, ...result };
  } catch (err) {
    warn(`deps refresh failed (continuing): ${err?.message ?? err}`);
    return { ran: false, ok: false, reason: err?.message ?? String(err), stampWritten: false };
  }
}
