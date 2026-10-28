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
  let latest = null;
  for (const record of await readQuarantineRecords({ repo, pr, gate, tmpRoot })) {
    const ms = Date.parse(record.quarantinedAt);
    if (Number.isFinite(ms) && (latest === null || ms > latest)) latest = ms;
  }
  return latest;
}

/** True when a non-rolled_back quarantine record names this exact prior head (its log moved, so a missing log there is audited). */
export async function isQuarantinedHead({ repo, pr, gate, tmpRoot, prevHead }) {
  return (await readQuarantineRecords({ repo, pr, gate, tmpRoot })).some((record) => record.prevHead === prevHead);
}

async function readQuarantineRecords({ repo, pr, gate, tmpRoot }) {
  const qdir = path.join(tmpRoot ?? "tmp", "quarantined-gate-findings", String(repo).replace("/", "-"), `pr-${pr}`);
  let entries;
  try {
    entries = await readdir(qdir);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.startsWith(`${gate}-`)) continue;
    try {
      const record = JSON.parse(await readFile(path.join(qdir, entry, "quarantine.json"), "utf8"));
      if (record.status !== "rolled_back") records.push(record);
    } catch { /* unreadable record: ignore */ }
  }
  return records;
}

/** When a log was written: its recorded loggedAt, else the file mtime (a log without loggedAt). */
export function logWrittenMs(log, mtimeMs) {
  const ms = Date.parse(log?.loggedAt);
  return Number.isFinite(ms) ? ms : mtimeMs;
}
