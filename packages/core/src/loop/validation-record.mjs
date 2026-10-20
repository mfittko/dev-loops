/**
 * Head-pinned validation record (issue 2866). One JSON file per pushed head at
 * `<tmpRoot>/validation-records/<owner>/<repo>/<headSha>.json`. The record has
 * no PR number: the first push happens before the PR exists.
 */
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROFILES = ["targeted", "full-repository"];

function parseRepo(repo) {
  const parts = typeof repo === "string" ? repo.split("/") : [];
  if (parts.length !== 2 || !parts.every((part) => SEGMENT_RE.test(part) && !part.includes(".."))) {
    throw new Error(`repo must be owner/name with safe segments, got: ${JSON.stringify(repo)}`);
  }
  return parts;
}

function assertHeadSha(headSha) {
  if (typeof headSha !== "string" || !SHA_RE.test(headSha)) throw new Error("headSha must be a full 40- or 64-character lowercase hex SHA");
}

export function validationRecordPath({ repo, headSha, tmpRoot = "tmp" }) {
  const [owner, name] = parseRepo(repo);
  assertHeadSha(headSha);
  if (typeof tmpRoot !== "string" || tmpRoot.trim() === "") throw new Error("tmpRoot must be a non-empty string");
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
  if (!isString(value.generatedAt) || Number.isNaN(Date.parse(value.generatedAt))) return refuse("generatedAt must be an ISO timestamp");
  if (typeof value.allPassed !== "boolean") return refuse("allPassed must be a boolean");
  if (!Array.isArray(value.suites) || value.suites.length === 0) return refuse("suites must be a non-empty array");
  for (const suite of value.suites) {
    if (suite === null || typeof suite !== "object" || !isString(suite.name) || !isString(suite.command) || !Number.isInteger(suite.exitCode) || !isString(suite.outputPath)) {
      return refuse("each suite needs name, command, outputPath and an integer exitCode");
    }
  }
  if (value.allPassed !== value.suites.every((suite) => suite.exitCode === 0)) return refuse("allPassed disagrees with the suite exit codes");
  if (value.depState !== undefined && (value.depState === null || typeof value.depState !== "object" || Array.isArray(value.depState))) return refuse("depState must be an object");
  return { ok: true, record: value };
}
