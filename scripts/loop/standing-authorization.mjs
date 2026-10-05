/**
 * Standing human authorization reader (ADR-TRIPWIRE-STANDING-WAIVER).
 *
 * Reads `standingAuthorizations.adrTripwireWaiver` ONLY from the `.devloops`
 * family at `origin/<defaultBranch>` (`git show`): never the worktree, a PR
 * head, a PR body, an environment variable or a CLI argument. A missing,
 * malformed, over-long or expired record means no authorization is in force.
 * The scope is fixed in the writer; the record has no scope field.
 */
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

import { isValidGithubLogin } from "@dev-loops/core/loop/merge-approval";
import { strictIsoDay } from "./adr-waiver-markers.mjs";
import { DEVLOOPS_CONFIG_PATHS } from "./check-adr-tripwire.mjs";

export const MAX_STANDING_AUTHORIZATION_DAYS = 90;
const RECORD_FIELDS = Object.freeze(["grantedBy", "grantedAt", "expires", "reason"]);
const DAY_MS = 86_400_000;

function defaultGit(args, { repoRoot }) {
  return execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 }).toString();
}

function isoDay(value) {
  // YAML parses an unquoted date to a Date; a string must be exactly YYYY-MM-DD.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return strictIsoDay(value);
}

const dayNumber = (day) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

/**
 * Validate a parsed record against `now` (compared as a UTC date; the record
 * is valid through the whole `expires` day).
 * @returns {{ inForce: true, record: object } | { inForce: false, state: "missing"|"malformed"|"over_long"|"expired", detail: string }}
 */
export function evaluateStandingAuthorizationRecord(record, now = new Date()) {
  if (record === undefined || record === null) return { inForce: false, state: "missing", detail: "no standingAuthorizations.adrTripwireWaiver record" };
  const malformed = (detail) => ({ inForce: false, state: "malformed", detail });
  if (typeof record !== "object" || Array.isArray(record)) return malformed("record is not a mapping");
  const keys = Object.keys(record);
  const missing = RECORD_FIELDS.filter((f) => !keys.includes(f));
  const extra = keys.filter((k) => !RECORD_FIELDS.includes(k));
  if (missing.length > 0) return malformed(`missing field(s): ${missing.join(", ")}`);
  if (extra.length > 0) return malformed(`unexpected field(s): ${extra.join(", ")} (the record has no scope field)`);
  if (!isValidGithubLogin(record.grantedBy)) return malformed("grantedBy is not a GitHub login");
  if (typeof record.reason !== "string" || record.reason.trim().length === 0) return malformed("reason is empty");
  const grantedAt = isoDay(record.grantedAt);
  const expires = isoDay(record.expires);
  if (grantedAt === null) return malformed("grantedAt is not an ISO date");
  if (expires === null) return malformed("expires is not an ISO date");
  const span = dayNumber(expires) - dayNumber(grantedAt);
  if (span < 0) return malformed("expires is before grantedAt");
  if (span > MAX_STANDING_AUTHORIZATION_DAYS) {
    return { inForce: false, state: "over_long", detail: `expires is ${span} days after grantedAt (maximum ${MAX_STANDING_AUTHORIZATION_DAYS})` };
  }
  const today = now.toISOString().slice(0, 10);
  if (today < grantedAt) return malformed(`grantedAt ${grantedAt} is after today ${today} UTC (not yet valid)`);
  if (today > expires) return { inForce: false, state: "expired", detail: `expired ${expires} (today ${today} UTC)` };
  return { inForce: true, record: { grantedBy: record.grantedBy, grantedAt, expires, reason: record.reason.trim() } };
}

/** Default branch name from `refs/remotes/origin/HEAD`, else null (never a guessed name). */
export function resolveDefaultBranch({ repoRoot = process.cwd(), git = defaultGit } = {}) {
  try {
    const ref = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { repoRoot }).trim();
    return ref.startsWith("origin/") && ref.length > "origin/".length ? ref.slice("origin/".length) : null;
  } catch {
    return null;
  }
}

/** Fetch `origin/<branch>` so the read sees the current default branch, not a stale local ref. */
export function defaultFetchOrigin(branch, { repoRoot }, exec = execFileSync) {
  exec("git", ["fetch", "origin", "--", branch], {
    cwd: repoRoot,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 30000,
    killSignal: "SIGKILL",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/**
 * Read and evaluate the standing authorization from `origin/<defaultBranch>`.
 * Fetches the branch first and refuses (`fetch_failed`) when the fetch fails.
 * Probes the `.devloops` family in loader order and stops at the first file
 * that exists on the branch; an existing file that cannot be read or parsed
 * counts as malformed (no authorization), never as "try the next name".
 */
export function readStandingAuthorization({ repoRoot = process.cwd(), defaultBranch, now = new Date(), git = defaultGit, fetchOrigin = defaultFetchOrigin } = {}) {
  const branch = defaultBranch ?? resolveDefaultBranch({ repoRoot, git });
  const refuse = (state, detail) => ({ inForce: false, state, detail, defaultBranch: branch });
  if (!branch) return refuse("default_branch_unresolved", "refs/remotes/origin/HEAD is unset; refusing to guess the default branch");
  try {
    fetchOrigin(branch, { repoRoot });
  } catch {
    return refuse("fetch_failed", `git fetch origin ${branch} failed; cannot trust the local origin/${branch} ref`);
  }
  try {
    git(["rev-parse", "--verify", "--quiet", `origin/${branch}^{commit}`], { repoRoot });
  } catch {
    return refuse("missing", `no .devloops on origin/${branch} (ref absent)`);
  }
  let source = null;
  for (const name of DEVLOOPS_CONFIG_PATHS) {
    let listed;
    try {
      listed = git(["ls-tree", "--name-only", `origin/${branch}`, "--", name], { repoRoot });
    } catch {
      return refuse("malformed", `cannot list ${name} on origin/${branch}`);
    }
    if (listed.trim() === "") continue; // git reports the path absent: try the next name
    try {
      source = git(["show", `origin/${branch}:${name}`], { repoRoot });
    } catch {
      return refuse("malformed", `${name} exists on origin/${branch} but cannot be read`);
    }
    break;
  }
  if (source === null) return refuse("missing", `no .devloops on origin/${branch}`);
  let parsed;
  try {
    parsed = parseYaml(source) ?? {};
  } catch {
    return refuse("malformed", `.devloops on origin/${branch} does not parse`);
  }
  return { ...evaluateStandingAuthorizationRecord(parsed?.standingAuthorizations?.adrTripwireWaiver, now), defaultBranch: branch };
}
