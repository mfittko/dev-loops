/**
 * Machine-wide pacing for `gh` calls. Every dev-loops process on this machine
 * shares one `next-slot` file (epoch ms of the next allowed call) under the main
 * checkout's `tmp/gh-throttle/`, guarded by an exclusive-create lock file. A
 * caller reserves a slot under the lock, releases it, then sleeps until its slot.
 * The limiter never fails open: a lock that cannot be taken in time throws
 * `GH_THROTTLE_UNAVAILABLE`, and an unreadable state file is an error.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_GH_MIN_INTERVAL_MS = 500;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 5_000;
const LOCK_POLL_MS = 20;
const GIT_TIMEOUT_MS = 10_000;

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unavailable = (message, cause) =>
  Object.assign(new Error(`gh throttle unavailable: ${message}`), { code: "GH_THROTTLE_UNAVAILABLE", cause });

let cachedRoot;
let cachedIntervalMs;

/** The main checkout root (parent of the shared git dir), cached per process. */
export function resolveMainRoot({ execFile = execFileSync } = {}) {
  if (cachedRoot) return cachedRoot;
  try {
    const gitDir = execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    if (!gitDir) throw new Error("empty git common dir");
    cachedRoot = path.dirname(gitDir);
    return cachedRoot;
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
  cachedRoot = undefined;
  cachedIntervalMs = undefined;
}

/** Steal a stale lock: atomic rename to a unique name so only one stealer wins, then re-verify. */
async function stealStaleLock(lockPath, { now, staleLockMs }) {
  const aside = `${lockPath}.stale.${randomUUID()}`;
  try {
    await rename(lockPath, aside);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw unavailable(`cannot steal the stale lock: ${error.message}`, error);
  }
  // The file moved aside may be a fresh holder's lock that replaced the stale one; restore it.
  if (now() - (await stat(aside)).mtimeMs <= staleLockMs) await link(aside, lockPath).catch(() => {});
  await unlink(aside).catch(() => {});
}

async function withLock(lockPath, { now, sleep, lockTimeoutMs, staleLockMs, lockPollMs }, fn) {
  const deadline = now() + lockTimeoutMs;
  const token = randomUUID();
  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw unavailable(`cannot create the lock: ${error.message}`, error);
      try {
        if (now() - (await stat(lockPath)).mtimeMs > staleLockMs) await stealStaleLock(lockPath, { now, staleLockMs });
      } catch (statError) {
        if (statError.code !== "ENOENT") throw unavailable(`cannot inspect the lock: ${statError.message}`, statError);
      }
      if (now() >= deadline) throw unavailable(`lock ${lockPath} not acquired within ${lockTimeoutMs}ms`);
      await sleep(lockPollMs);
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
  lockPollMs = LOCK_POLL_MS,
}) {
  if (intervalMs === 0) return;
  const dir = path.join(root, "tmp", "gh-throttle");
  const slotPath = path.join(dir, "next-slot");
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    throw unavailable(`cannot create ${dir}: ${error.message}`, error);
  }
  const start = await withLock(path.join(dir, "lock"), { now, sleep, lockTimeoutMs, staleLockMs, lockPollMs }, async () => {
    let next = 0;
    try {
      const parsed = Number(String(await readFile(slotPath, "utf8")).trim());
      if (Number.isFinite(parsed)) next = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw unavailable(`cannot read ${slotPath}: ${error.message}`, error);
    }
    const reserved = Math.max(now(), next);
    try {
      await writeFile(slotPath, String(reserved + intervalMs));
    } catch (error) {
      throw unavailable(`cannot write ${slotPath}: ${error.message}`, error);
    }
    return reserved;
  });
  const wait = start - now();
  if (wait > 0) await sleep(wait);
}

/** Default slot taker for the real `gh` path: resolves root and interval lazily. */
export async function takeGhSlot(opts = {}) {
  const root = opts.root ?? resolveMainRoot(opts.execFile ? { execFile: opts.execFile } : undefined);
  const intervalMs = opts.intervalMs ?? await resolveIntervalMs(root, { warn: opts.warn });
  await acquireSlot({ ...opts, root, intervalMs });
}
