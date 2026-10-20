/**
 * Head-pinned validation record (issue 2866). One JSON file per pushed head at
 * `<tmpRoot>/validation-records/<owner>/<repo>/<headSha>.json`. The record has
 * no PR number: the first push happens before the PR exists.
 */
import { parseRepoSlugParts } from "../github/repo-slug.mjs";

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PROFILES = ["targeted", "full-repository"];

function assertHeadSha(headSha) {
  if (typeof headSha !== "string" || !SHA_RE.test(headSha)) throw new Error("headSha must be a full 40- or 64-character lowercase hex SHA");
}

export function validationRecordPath({ repo, headSha, tmpRoot = "tmp" }) {
  const { owner, name } = parseRepoSlugParts(repo, { errorMessage: `repo must be owner/name with safe segments, got: ${JSON.stringify(repo)}` });
  assertHeadSha(headSha);
  if (typeof tmpRoot !== "string" || tmpRoot.trim() === "") throw new Error("tmpRoot must be a non-empty string");
  if (tmpRoot.startsWith("/") || /^[A-Za-z]:/.test(tmpRoot) || tmpRoot.split(/[\\/]/).includes("..")) throw new Error("tmpRoot must be a relative path without '..' segments");
  return `${tmpRoot.replace(/\/+$/, "")}/validation-records/${owner}/${name}/${headSha}.json`;
}

const isString = (value) => typeof value === "string" && value !== "";

export function parseValidationRecord(value, { repo, headSha }) {
  const refuse = (reason) => ({ ok: false, reason });
  if (value === null || typeof value !== "object" || Array.isArray(value)) return refuse("record is not an object");
  if (value.repo !== repo) return refuse("record repo differs from the expected repo");
  if (value.headSha !== headSha) return refuse("record head differs from the expected head");
  if (value.producer !== "local") return refuse("producer must be local");
  if (!PROFILES.includes(value.profile)) return refuse("profile must be targeted or full-repository");
  for (const field of ["toolchain", "prTitle"]) if (!isString(value[field])) return refuse(`${field} must be a non-empty string`);
  if (!Array.isArray(value.requestedSuites) || value.requestedSuites.length === 0 || !value.requestedSuites.every(isString)) return refuse("requestedSuites must be a non-empty string array");
  if ((value.profile === "full-repository") !== (value.requestedSuites.length === 1 && value.requestedSuites[0] === "verify")) return refuse("profile full-repository requires requestedSuites to be exactly [verify]");
  if (!isString(value.generatedAt) || Number.isNaN(Date.parse(value.generatedAt)) || new Date(value.generatedAt).toISOString() !== value.generatedAt) return refuse("generatedAt must be an ISO timestamp");
  if (typeof value.allPassed !== "boolean") return refuse("allPassed must be a boolean");
  if (!Array.isArray(value.suites) || value.suites.length === 0) return refuse("suites must be a non-empty array");
  for (const suite of value.suites) {
    if (suite === null || typeof suite !== "object" || !isString(suite.name) || !isString(suite.command) || !Number.isInteger(suite.exitCode) || !isString(suite.outputPath)) {
      return refuse("each suite needs name, command, outputPath and an integer exitCode");
    }
  }
  const requested = new Set(value.requestedSuites);
  const named = new Set(value.suites.map((suite) => suite.name));
  if (requested.size !== value.requestedSuites.length || named.size !== value.suites.length || named.size !== requested.size || !value.suites.every((suite) => requested.has(suite.name))) return refuse("suites must match requestedSuites");
  if (value.allPassed !== value.suites.every((suite) => suite.exitCode === 0)) return refuse("allPassed disagrees with the suite exit codes");
  return { ok: true, record: value };
}
