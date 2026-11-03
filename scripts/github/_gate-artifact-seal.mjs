/**
 * LEAF module: a sha256 seal beside the keyed fan-in ledger and the durable
 * findings log. The sanctioned writers call writeSealed; every sanctioned
 * reader calls readSealed. A hand edit changes the bytes but not the seal, so
 * the next read fails with a typed integrity error naming the file.
 * A missing seal is refused with the typed code gate_artifact_unsealed (ADR
 * 0242). ponytail: a writer that also rewrites the seal is out of reach; issue
 * 2892 binds the artifact to its producing run.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

export const OUT_OF_BAND_WRITE = "gate_artifact_out_of_band_write";
export const UNSEALED = "gate_artifact_unsealed";
/** True for a seal failure a reader must surface instead of swallowing: an edited or an unsealed artifact. */
export const isSealRefusal = (error) => error?.code === OUT_OF_BAND_WRITE || error?.code === UNSEALED;
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

export async function writeSealed(file, text) {
  await withLock(file, async () => {
    // Delete the seal first and write it last: a crash between the writes leaves an unsealed pair, never a stale seal. A reader that sees the pair mid-write waits for this lock (readSealed).
    await rm(sealPath(file), { force: true });
    await writeFile(file, text, "utf8");
    await writeFile(sealPath(file), `${digest(text)}\n`, "utf8");
  });
}

/** Remedy a prior-head findings-log reader appends to the refusal: quarantine handles only those logs. */
export const QUARANTINE_REMEDY = "to discard a prior-head log: dev-loops-run scripts/github/quarantine-gate-findings-log.mjs --repo <owner/name> --pr <N> --gate <gate> --prev-head <sha>";

const lockHeld = (file) => stat(`${file}.lock`).then((s) => Date.now() - s.mtimeMs <= LOCK_STALE_MS, () => false);

/**
 * Read a sealed artifact. `remedy` is the caller's own next step, appended to an unsealed refusal after the generic re-run-the-writer step.
 * A missing seal under a held write lock is a sanctioned write in progress: wait for it, then re-read once.
 */
export async function readSealed(file, { remedy } = {}, waited = false) {
  const text = await readFile(file, "utf8");
  let seal;
  // A sanctioned write can land between the two reads, even when it has already released the lock: on the first inconsistent pair, wait for any held lock, then re-read once.
  const rereadAfterWriter = async () => {
    if (waited) return null;
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (Date.now() < deadline && await lockHeld(file)) await new Promise((resolve) => setTimeout(resolve, 10));
    return readSealed(file, { remedy }, true);
  };
  try { seal = (await readFile(sealPath(file), "utf8")).trim().toLowerCase(); } catch (error) {
    if (error?.code === "ENOENT") { const reread = await rereadAfterWriter(); if (reread !== null) return reread; }
    const cause = error?.code === "ENOENT" ? "has no seal" : `has an unreadable seal (${error?.code ?? "read error"})`;
    throw Object.assign(new Error(`${UNSEALED}: ${file} ${cause}; re-run the sanctioned writer at the artifact head${remedy ? `; ${remedy}` : ""}`), { code: UNSEALED, file });
  }
  if (seal !== digest(text)) {
    const reread = await rereadAfterWriter();
    if (reread !== null) return reread;
    throw Object.assign(new Error(`${OUT_OF_BAND_WRITE}: ${file} was modified outside its sanctioned writer (seal mismatch)`), { code: OUT_OF_BAND_WRITE, file });
  }
  return text;
}
