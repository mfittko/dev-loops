// Durable, deterministic record of Copilot review requests that GitHub accepted
// but never made observable (no requested reviewer, no timeline event, no review).
// `request-copilot-review.mjs` counts each such request and
// `probe-copilot-review.mjs` counts each probe that timed out after one. The
// loop readers report Copilot as unavailable (`request_not_observable`) once both
// counts reach the threshold on the same head. A push changes the head, so the
// record never outlives the head it was counted on.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseJsonText } from "../_core-helpers.mjs";
import { buildDefaultCheckpointDir } from "./_checkpoint-paths.mjs";
import { resolveRepoRoot } from "./_repo-root-resolver.mjs";

export const REQUEST_NOT_OBSERVABLE_THRESHOLD = 2;
const FILENAME = "unobservable-review-requests.json";

function recordPath(repo, pr, { checkpointDir } = {}) {
  const dir = checkpointDir ?? path.join(resolveRepoRoot(process.cwd()), buildDefaultCheckpointDir(repo, pr));
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
  const tempPath = `${file}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(tempPath, file);
}

const isHead = (value) => typeof value === "string" && value.length > 0;

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
    unobservableRequests: (same ? Number(prior.unobservableRequests) || 0 : 0) + 1,
    timedOutProbes: same ? Number(prior.timedOutProbes) || 0 : 0,
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
  const record = { ...prior, timedOutProbes: (Number(prior.timedOutProbes) || 0) + 1 };
  await write(file, record);
  return record;
}

// True when the record for the current head reaches the threshold on both counts.
export async function readRequestNotObservable({ repo, pr, headSha }, opts = {}) {
  const record = await readRaw(recordPath(repo, pr, opts));
  const reached = (n) => Number.isInteger(n) && n >= REQUEST_NOT_OBSERVABLE_THRESHOLD;
  return Boolean(record)
    && isHead(headSha)
    && record.headSha === headSha
    && reached(record.unobservableRequests)
    && reached(record.timedOutProbes);
}
