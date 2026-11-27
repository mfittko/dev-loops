/**
 * LEAF module: a sha256 seal beside the keyed fan-in ledger and the durable
 * findings log. The sanctioned writers call writeSealed; every sanctioned
 * reader calls readSealed. A hand edit changes the bytes but not the seal, so
 * the next read fails with a typed integrity error naming the file.
 * ponytail: a missing seal reads as a legacy artifact and is accepted; a
 * writer that also rewrites the seal is out of reach. Refuse a missing seal
 * once all writers have shipped.
 */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const OUT_OF_BAND_WRITE = "gate_artifact_out_of_band_write";
const sealPath = (file) => `${file}.seal`;
const digest = (text) => createHash("sha256").update(text).digest("hex");

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 60_000;

// Serialize publication per artifact across processes: an exclusive mkdir lock beside the file.
// ponytail: a lock older than LOCK_STALE_MS (crashed writer) is stolen; use a pid-liveness check if writers ever run that long.
async function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { await mkdir(lock); break; } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(lock).then((s) => s.mtimeMs, () => Date.now()));
      if (age > LOCK_STALE_MS) { await rm(lock, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the write lock ${lock}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try { return await fn(); } finally { await rm(lock, { recursive: true, force: true }); }
}

// `expectedLive`, when given, is the exact text the caller read: the write refuses with `live_ledger_changed` when the file differs inside the lock.
export async function writeSealed(file, text, { expectedLive } = {}) {
  await withLock(file, async () => {
    if (expectedLive !== undefined && (await readFile(file, "utf8").catch(() => undefined)) !== expectedLive) {
      throw Object.assign(new Error(`live_ledger_changed: ${file} changed after it was read; rerun the write`), { code: "live_ledger_changed", file });
    }
    // Delete the seal first and write it last: a crash between the writes leaves an unsealed (legacy) pair, never a stale seal.
    await rm(sealPath(file), { force: true });
    await writeFile(file, text, "utf8");
    await writeFile(sealPath(file), `${digest(text)}\n`, "utf8");
  });
}

export async function readSealed(file) {
  const text = await readFile(file, "utf8");
  let seal;
  try { seal = (await readFile(sealPath(file), "utf8")).trim().toLowerCase(); } catch (error) {
    if (error?.code === "ENOENT") return text;
    throw error;
  }
  if (seal !== digest(text)) {
    throw Object.assign(new Error(`${OUT_OF_BAND_WRITE}: ${file} was modified outside its sanctioned writer (seal mismatch)`), { code: OUT_OF_BAND_WRITE, file });
  }
  return text;
}

// Moves the live ledger and its seal to `retained` without ever replacing an existing file: COPYFILE_EXCL fails with EEXIST on a taken name.
// The copies are separate inodes, so a later rewrite of the live path never writes through to the retained round.
// The seal is copied first (a crash leaves a waiting seal that matches the bytes a retry copies there; EEXIST on the seal is that waiting seal).
export async function claimRetainedRound(fullPath, retained) {
  let copiedSeal = true;
  await copyFile(`${fullPath}.seal`, `${retained}.seal`, fsConstants.COPYFILE_EXCL).catch((err) => { copiedSeal = false; if (err?.code !== "ENOENT" && err?.code !== "EEXIST") throw err; });
  // A refused claim drops only the seal this call copied; a pre-existing seal of the taken round stays.
  try { await copyFile(fullPath, retained, fsConstants.COPYFILE_EXCL); } catch (err) {
    if (copiedSeal) await unlink(`${retained}.seal`).catch(() => {});
    throw err;
  }
  await unlink(fullPath);
  await unlink(`${fullPath}.seal`).catch((err) => { if (err?.code !== "ENOENT") throw err; });
}

/** The next free `<stem>.round-<n>.json` beside a live ledger: the one naming rule of every retained-round writer. */
export async function nextRetainedPath(fullPath) {
  const dir = path.dirname(fullPath);
  const stem = path.basename(fullPath, ".json");
  const taken = (await readdir(dir)).map((n) => Number((n.startsWith(`${stem}.round-`) ? /\.round-(\d+)\.json$/.exec(n)?.[1] : undefined) ?? 0));
  return path.join(dir, `${stem}.round-${Math.max(0, ...taken.filter(Number.isSafeInteger)) + 1}.json`);
}
