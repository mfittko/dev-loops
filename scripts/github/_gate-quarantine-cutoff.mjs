/**
 * LEAF module: the quarantine cutoff shared by emit-fanout-dispatch.mjs and
 * resolve-angle-carry-forward.mjs (GATE-EXEC-FINDINGS-LOG-QUARANTINE). A findings
 * log written at or before the latest recorded quarantine of its PR+gate no longer
 * counts as a prior round, in either script.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Latest quarantinedAt (ms) recorded for this PR+gate under the tmp root, or null.
 * A rolled_back record means no quarantine happened, so it sets no cutoff; pending,
 * partial and complete count, because a crash mid-move must still hold.
 */
export async function latestQuarantineMs({ repo, pr, gate, tmpRoot }) {
  const qdir = path.join(tmpRoot ?? "tmp", "quarantined-gate-findings", String(repo).replace("/", "-"), `pr-${pr}`);
  let entries;
  try {
    entries = await readdir(qdir);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  let latest = null;
  for (const entry of entries) {
    if (!entry.startsWith(`${gate}-`)) continue;
    try {
      const record = JSON.parse(await readFile(path.join(qdir, entry, "quarantine.json"), "utf8"));
      if (record.status === "rolled_back") continue;
      const ms = Date.parse(record.quarantinedAt);
      if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
    } catch { /* unreadable record: ignore */ }
  }
  return latest;
}

/** When a log was written: its recorded loggedAt, else the file mtime (a log without loggedAt). */
export function logWrittenMs(log, mtimeMs) {
  const ms = Date.parse(log?.loggedAt);
  return Number.isFinite(ms) ? ms : mtimeMs;
}
