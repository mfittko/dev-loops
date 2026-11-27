// Durable, deterministic record of Copilot review requests that GitHub accepted
// but never made observable (no requested reviewer, no timeline event, no review).
// `request-copilot-review.mjs` counts each such request and
// `probe-copilot-review.mjs` counts each probe that timed out after one. The
// loop readers report Copilot as unavailable (`request_not_observable`) once both
// counts reach the threshold on the same head. A push changes the head, so the
// record applies to another head only across a base-only merge.
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseJsonText } from "../_core-helpers.mjs";
import { fixerEmitCarryAccepts } from "../github/_carried-verdict.mjs";
import { buildDefaultCheckpointDir } from "./_checkpoint-paths.mjs";
import { resolveMainWorktreeRoot } from "./_repo-root-resolver.mjs";

export const REQUEST_NOT_OBSERVABLE_THRESHOLD = 2;
const FILENAME = "unobservable-review-requests.json";

// Anchored at the main checkout so a record written from a PR worktree is the one merge-pr reads.
export function recordPath(repo, pr, { checkpointDir } = {}) {
  const dir = checkpointDir ?? path.join(resolveMainWorktreeRoot(process.cwd()), buildDefaultCheckpointDir(repo, pr));
  return path.join(dir, FILENAME);
}

async function readRaw(file) {
  try {
    const parsed = parseJsonText(await readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function write(file, record) {
  await mkdir(path.dirname(file), { recursive: true });
  const tempPath = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, file);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
const isHead = (value) => typeof value === "string" && value.length > 0;

// shortcut: this and recordTimedOutProbe do an unlocked read-modify-write, so two concurrent writers for one PR can lose an increment; the loss undercounts and delays copilot_unavailable. add a lock if that matters.
// Counts one accepted-but-unobservable request on `headSha`; a different head restarts the count.
export async function recordUnobservableRequest({ repo, pr, headSha }, opts = {}) {
  if (!isHead(headSha)) return null;
  const file = recordPath(repo, pr, opts);
  const prior = await readRaw(file);
  const same = prior?.headSha === headSha;
  const record = {
    repo,
    pr,
    headSha,
    unobservableRequests: (same ? count(prior.unobservableRequests) : 0) + 1,
    timedOutProbes: same ? count(prior.timedOutProbes) : 0,
    probesSinceLastRequest: 0,
  };
  await write(file, record);
  return record;
}

// Counts one timed-out probe of `headSha`. Without a prior unobservable request
// on that same head there is nothing to count.
export async function recordTimedOutProbe({ repo, pr, headSha }, opts = {}) {
  const file = recordPath(repo, pr, opts);
  const prior = await readRaw(file);
  if (!prior || !isHead(headSha) || prior.headSha !== headSha) return null;
  const record = { ...prior, timedOutProbes: count(prior.timedOutProbes) + 1, probesSinceLastRequest: count(prior.probesSinceLastRequest) + 1 };
  await write(file, record);
  return record;
}

// True when the record for the current head reaches the threshold on both counts.
// A record at another head carries over when the current head only integrates `baseRef`
// into it (Copilot availability does not depend on the merged base content).
export async function readRequestNotObservable({ repo, pr, headSha, baseRef, repoRoot }, { baseOnlyMerge = fixerEmitCarryAccepts, ...opts } = {}) {
  const record = await readRaw(recordPath(repo, pr, opts));
  const reached = (n) => Number.isInteger(n) && n >= REQUEST_NOT_OBSERVABLE_THRESHOLD;
  if (!record || !isHead(headSha)
    || !reached(record.unobservableRequests)
    || !reached(record.timedOutProbes)
    || count(record.probesSinceLastRequest) < 1) return false;
  if (record.headSha === headSha) return true;
  if (!isHead(record.headSha) || !baseRef) return false;
  try {
    return (await baseOnlyMerge({ originHead: record.headSha, headSha, baseRef, repoRoot })) === true;
  } catch {
    return false;
  }
}
