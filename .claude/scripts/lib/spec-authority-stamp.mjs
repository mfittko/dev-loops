// Shared --spec-authority stamping seam (issue 2008 / ADR 0061 AC1): every
// gate/fixer/carry-forward record writer that optionally accepts a
// `--spec-authority <path>` JSON identity ({specDigest, headSha, contentDigest,
// checkedCriteria}) threads it through ONE shared helper
// (@dev-loops/core/loop/spec-authority's stampSpecAuthorityIdentity) so the
// writers can never independently recompute/drift the stamp. Absent input is a
// pure no-op — the record writes byte-identically to before.
import { readFile } from "node:fs/promises";
import { stampSpecAuthorityIdentity } from "@dev-loops/core/loop/spec-authority";

/**
 * Read + parse an optional `--spec-authority <path>` JSON identity artifact.
 * Returns `undefined` when `specAuthorityPath` is undefined (flag absent —
 * caller stays a no-op). Fail-closed on malformed JSON.
 * @param {string|undefined} specAuthorityPath
 * @param {(message: string) => Error} parseErr — the caller's own parseError
 * @returns {Promise<object|undefined>}
 */
export async function readSpecAuthorityIdentity(specAuthorityPath, parseErr) {
  if (specAuthorityPath === undefined) return undefined;
  let raw;
  try {
    raw = await readFile(specAuthorityPath, "utf8");
  } catch (error) {
    throw parseErr(`Cannot read --spec-authority "${specAuthorityPath}": ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw parseErr(`--spec-authority "${specAuthorityPath}" must contain valid JSON`);
  }
}

/**
 * Stamp a record with the optional spec-authority identity. A pure no-op
 * (returns `record` unchanged) when `identity` is `undefined`. Fail-closed via
 * {@link stampSpecAuthorityIdentity} on a malformed identity.
 * @param {object} record
 * @param {object|undefined} identity
 * @returns {object}
 */
export function stampOptionalSpecAuthority(record, identity) {
  if (identity === undefined) return record;
  return stampSpecAuthorityIdentity(record, identity);
}
