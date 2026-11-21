/**
 * Per-main-checkout pacing for `gh` calls. Every dev-loops process that resolves
 * the same main checkout (the parent of its cwd's git common dir) shares one
 * `next-slot` file (epoch ms of the next allowed call) under that checkout's
 * `tmp/gh-throttle/`, guarded by an exclusive-create lock file. Separate clones
 * do not share pacing. A caller reserves a slot under the lock, releases it, then
 * sleeps until its slot. The limiter never fails open: a lock that cannot be taken
 * in time, an unreadable state file, or a cwd outside a git checkout throws
 * `GH_THROTTLE_UNAVAILABLE`. Only a gh attested as a stub (`DEV_LOOPS_GH_STUB`)
 * is unpaced.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SECONDARY_RATE_LIMIT_BACKOFF_MS, isSecondaryRateLimitError, rateLimitedError } from "./gh.mjs";
import { GH_STUB_ATTESTATION_ENV } from "./test-mode-write-guard.mjs";

export const DEFAULT_GH_MIN_INTERVAL_MS = 500;
const LOCK_TIMEOUT_MS = 10_000;
// A stored slot further ahead than any legitimate queue (60 callers at the 10000 ms maximum interval) is stale.
const MAX_QUEUE_HORIZON_MS = 600_000;
const STALE_LOCK_MS = 5_000;
// A lock this old is stolen even when its holder pid looks alive (a reused pid or EPERM): the critical section lasts milliseconds.
const HARD_STALE_LOCK_MS = 6 * LOCK_TIMEOUT_MS;
const LOCK_POLL_MS = 20;
const GIT_TIMEOUT_MS = 10_000;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unavailable = (message, cause) =>
  Object.assign(new Error(`gh throttle unavailable: ${message}`), { code: "GH_THROTTLE_UNAVAILABLE", cause });

const cachedRoots = new Map();
let cachedIntervalMs;

/** The main checkout root (parent of the shared git dir) for the call cwd (default: the process cwd), cached per cwd. */
export function resolveMainRoot({ execFile = execFileSync, cwd } = {}) {
  const key = path.resolve(cwd ?? process.cwd());
  if (cachedRoots.has(key)) return cachedRoots.get(key);
  try {
    const gitDir = execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      cwd: key,
    }).trim();
    if (!gitDir) throw new Error("empty git common dir");
    const root = path.dirname(gitDir);
    cachedRoots.set(key, root);
    return root;
  } catch (error) {
    throw unavailable(`cannot resolve the main checkout root: ${error.message}`, error);
  }
}

/** The configured interval, read once per process; a config load failure uses the schema default. */
export async function resolveIntervalMs(root, { warn = (message) => process.stderr.write(message), loadConfig } = {}) {
  if (cachedIntervalMs !== undefined) return cachedIntervalMs;
  let value = DEFAULT_GH_MIN_INTERVAL_MS;
  try {
    const load = loadConfig ?? (await import("../config/config.mjs")).loadDevLoopConfig;
    const configured = (await load({ repoRoot: root })).config?.queue?.ghMinIntervalMs;
    if (Number.isInteger(configured) && configured >= 0) value = configured;
  } catch (error) {
    // explicit fallback: the schema default, one warning per process (the result is cached)
    warn(`gh throttle: config load failed, using the default ${DEFAULT_GH_MIN_INTERVAL_MS}ms interval: ${error.message}\n`);
  }
  cachedIntervalMs = value;
  return value;
}

/** Test seam: forget the per-process root and interval caches. */
export function resetThrottleCache() {
  cachedRoots.clear();
  cachedIntervalMs = undefined;
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/**
 * Steal a stale lock. Stale means an old mtime and a holder pid (the token prefix) that is gone, or an mtime past the hard bound whatever the pid.
 * The steal unlinks only when the token is unchanged, so a fresh holder's lock is never removed.
 * A lock replaced between the final read and the unlink is a residual race that costs only a pacing violation.
 */
async function stealStaleLock(lockPath, { now, staleLockMs }) {
  let token;
  let mtimeMs;
  try {
    token = await readFile(lockPath, "utf8");
    mtimeMs = (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw unavailable(`cannot inspect the lock: ${error.message}`, error);
  }
  if (now() - mtimeMs <= staleLockMs) return;
  const pid = Number.parseInt(token, 10);
  if (now() - mtimeMs <= HARD_STALE_LOCK_MS && Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return;
  if ((await readFile(lockPath, "utf8").catch(() => null)) !== token) return;
  await unlink(lockPath).catch(() => {});
}

async function withLock(lockPath, { now, sleep, lockTimeoutMs, staleLockMs }, fn) {
  const deadline = now() + lockTimeoutMs;
  const token = `${process.pid}:${randomUUID()}`;
  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw unavailable(`cannot create the lock: ${error.message}`, error);
      await stealStaleLock(lockPath, { now, staleLockMs });
      if (now() >= deadline) throw unavailable(`lock ${lockPath} not acquired within ${lockTimeoutMs}ms`);
      await sleep(LOCK_POLL_MS);
      continue;
    }
    try {
      await handle.writeFile(token);
    } finally {
      await handle.close();
    }
    try {
      return await fn();
    } finally {
      // Release only our own lock: a stolen-and-retaken lock holds another token.
      if ((await readFile(lockPath, "utf8").catch(() => null)) === token) await unlink(lockPath).catch(() => {});
    }
  }
}

/**
 * Reserve the next slot and sleep until it starts. `intervalMs` 0 skips pacing.
 */
export async function acquireSlot({
  root,
  intervalMs,
  now = Date.now,
  sleep = realSleep,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
  staleLockMs = STALE_LOCK_MS,
}) {
  if (intervalMs === 0) return;
  const dir = path.join(root, "tmp", "gh-throttle");
  const slotPath = path.join(dir, "next-slot");
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw unavailable(`cannot create ${dir}: ${error.message}`, error);
  }
  const start = await withLock(path.join(dir, "lock"), { now, sleep, lockTimeoutMs, staleLockMs }, async () => {
    let next = 0;
    try {
      const parsed = Number(String(await readFile(slotPath, "utf8")).trim());
      // A value beyond any legitimate queue (a backward clock step or a corrupt write) is no reservation.
      if (Number.isFinite(parsed) && parsed <= now() + MAX_QUEUE_HORIZON_MS) next = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw unavailable(`cannot read ${slotPath}: ${error.message}`, error);
    }
    const reserved = Math.max(now(), next);
    const tmpPath = `${slotPath}.${randomUUID()}.tmp`;
    try {
      // Temp file plus rename: a concurrent reader never sees a half-written (empty) slot file.
      await writeFile(tmpPath, String(reserved + intervalMs));
      await rename(tmpPath, slotPath);
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      throw unavailable(`cannot write ${slotPath}: ${error.message}`, error);
    }
    return reserved;
  });
  const wait = start - now();
  if (wait > 0) await sleep(wait);
}

/** No pacing for a gh attested as a stub (`GH_STUB_ATTESTATION_ENV`, set by the writeGhStub helper): a stub sends no traffic. Test mode alone is paced. */
export const isUnpaced = (env) => Boolean(env?.[GH_STUB_ATTESTATION_ENV] || process.env[GH_STUB_ATTESTATION_ENV]);

/** Default slot taker for the real `gh` path: resolves root and interval lazily. */
export async function takeGhSlot(opts = {}) {
  if (isUnpaced(opts.env)) return;
  const root = resolveMainRoot({ ...(opts.execFile && { execFile: opts.execFile }), cwd: opts.cwd });
  const intervalMs = opts.intervalMs ?? await resolveIntervalMs(root);
  await acquireSlot({ ...opts, root, intervalMs });
}

// The config schema caps queue.ghMinIntervalMs at 10000, so this covers several queued slots.
export const SYNC_SLOT_TIMEOUT_MS = 60_000;
const SLOT_SCRIPT = fileURLToPath(new URL("./gh-throttle-slot.mjs", import.meta.url));

/** Sync slot taker for `execFileSync` call sites: runs the slot child (in the gh call's env and cwd) and blocks until it exits. */
export function takeGhSlotSync({ execFile = execFileSync, env, cwd } = {}) {
  try {
    execFile(process.execPath, [SLOT_SCRIPT], { stdio: ["ignore", "ignore", "pipe"], timeout: SYNC_SLOT_TIMEOUT_MS, env, cwd });
  } catch (error) {
    throw unavailable(`sync slot failed: ${String(error.stderr ?? error.message).trim()}`, error);
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * `execFileSync` that takes a slot first when the command is `gh`. A secondary
 * rate limit backs off once and retries, and a second one throws `RATE_LIMITED`.
 * The last argument is a test seam.
 */
export function ghExecFileSync(command, args, options, { execFile = execFileSync, takeSlotSync = takeGhSlotSync, backoff = sleepSync } = {}) {
  const attempt = () => {
    if (command === "gh" && !isUnpaced(options?.env)) takeSlotSync({ env: options?.env, cwd: options?.cwd });
    return execFile(command, args, options);
  };
  if (command !== "gh") return attempt();
  try {
    return attempt();
  } catch (error) {
    // stderr only: error.message carries the whole argv, so argument text must not read as a limit.
    if (!isSecondaryRateLimitError(String(error.stderr ?? ""))) throw error;
  }
  backoff(SECONDARY_RATE_LIMIT_BACKOFF_MS);
  try {
    return attempt();
  } catch (error) {
    if (!isSecondaryRateLimitError(String(error.stderr ?? ""))) throw error;
    throw rateLimitedError("gh command failed", error.stderr || error.message, error);
  }
}
