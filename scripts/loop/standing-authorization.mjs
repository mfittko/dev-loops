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
import { DEVLOOPS_CONFIG_PATHS } from "./check-adr-tripwire.mjs";

export const MAX_STANDING_AUTHORIZATION_DAYS = 90;
const RECORD_FIELDS = Object.freeze(["grantedBy", "grantedAt", "expires", "reason"]);
const ISO_DATE_RE = /^(\d{4}-\d{2}-\d{2})(?:T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/u;
const DAY_MS = 86_400_000;

function defaultGit(args, { repoRoot }) {
  return execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 }).toString();
}

function isoDay(value) {
  const text = value instanceof Date ? value.toISOString() : value;
  if (typeof text !== "string") return null;
  const m = ISO_DATE_RE.exec(text.trim());
  if (!m || Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`))) return null;
  return m[1];
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
  if (today > expires) return { inForce: false, state: "expired", detail: `expired ${expires} (today ${today} UTC)` };
  return { inForce: true, record: { grantedBy: record.grantedBy, grantedAt, expires, reason: record.reason.trim() } };
}

/** Default branch name from `refs/remotes/origin/HEAD`, else "main". */
export function resolveDefaultBranch({ repoRoot = process.cwd(), git = defaultGit } = {}) {
  try {
    const ref = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { repoRoot }).trim();
    return ref.startsWith("origin/") ? ref.slice("origin/".length) : "main";
  } catch {
    return "main";
  }
}

/**
 * Read and evaluate the standing authorization from `origin/<defaultBranch>`.
 * An unparsable `.devloops` counts as malformed (no authorization).
 */
export function readStandingAuthorization({ repoRoot = process.cwd(), defaultBranch, now = new Date(), git = defaultGit } = {}) {
  const branch = defaultBranch ?? resolveDefaultBranch({ repoRoot, git });
  let source = null;
  for (const name of DEVLOOPS_CONFIG_PATHS) {
    try {
      source = git(["show", `origin/${branch}:${name}`], { repoRoot });
      break;
    } catch {
      /* absent at this extension */
    }
  }
  if (source === null) return { inForce: false, state: "missing", detail: `no .devloops on origin/${branch}`, defaultBranch: branch };
  let parsed;
  try {
    parsed = parseYaml(source) ?? {};
  } catch {
    return { inForce: false, state: "malformed", detail: `.devloops on origin/${branch} does not parse`, defaultBranch: branch };
  }
  return { ...evaluateStandingAuthorizationRecord(parsed?.standingAuthorizations?.adrTripwireWaiver, now), defaultBranch: branch };
}
