// Shared --findings / --findings-file resolution for the gate findings-array
// consumers (write-gate-findings-log.mjs, post-gate-findings.mjs). The two
// tools previously carried a byte-identical 24-line resolveFindings() copy;
// only the flag-resolution plumbing (mutual exclusion, file read, JSON parse)
// is shared here — each tool keeps its own `validate(parsed, flagLabel)`
// callback since their per-element validation intentionally differs (e.g.
// disposition enforcement).
import { readFile } from "node:fs/promises";

/**
 * Resolve a findings array from either `--findings` (inline JSON) or
 * `--findings-file` (a path to a file containing the same JSON array) —
 * mutually exclusive, identical read/parse handling either way. The parsed
 * value is validated/normalized by the caller-supplied `validate` callback.
 *
 * @param {{ findings?: string, findingsFile?: string }} options
 * @param {{ parseError: (message: string) => Error, validate: (parsed: unknown, flagLabel: string) => unknown }} deps
 */
export async function resolveFindingsInput(options, { parseError, validate }) {
  if (options.findings !== undefined && options.findingsFile !== undefined) {
    throw parseError("--findings and --findings-file are mutually exclusive; pass only one");
  }
  if (options.findingsFile !== undefined) {
    let raw;
    try {
      raw = await readFile(options.findingsFile, "utf8");
    } catch (err) {
      throw parseError(`Cannot read --findings-file "${options.findingsFile}": ${err instanceof Error ? err.message : String(err)}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw parseError(`--findings-file "${options.findingsFile}" must contain valid JSON`);
    }
    return validate(parsed, "--findings-file");
  }
  if (options.findings === undefined) {
    throw parseError("Either --findings <json> or --findings-file <path> is required");
  }
  let parsed;
  try {
    parsed = JSON.parse(options.findings);
  } catch {
    throw parseError("--findings must be valid JSON");
  }
  return validate(parsed, "--findings");
}
