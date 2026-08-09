// Shared --findings / --findings-file resolution for the gate findings-array
// consumers (write-gate-findings-log.mjs, post-gate-findings.mjs). The two
// tools previously carried a byte-identical 24-line resolveFindings() copy;
// only the flag-resolution plumbing (mutual exclusion, file read, JSON parse)
// is shared here — each tool keeps its own `validate(parsed, flagLabel)`
// callback since their per-element validation intentionally differs (e.g.
// disposition enforcement).
import { readFile } from "node:fs/promises";

// The consolidate-fanin CLI's `--ledger-out` writes a wrapper object
// `{ overallVerdict, findings }` (the consolidator's computed verdict carried
// alongside the flat findings it already wrote) rather than a bare array, so
// the consolidator's computed verdict flows downstream to the durable ledger
// (write-gate-findings-log.mjs) without an orchestrator hand-off — the same
// defect shape (#1616) a caller-passed `--verdict` reproduces. A bare array
// (the legacy shape, and any hand-authored `--findings` input) is still
// accepted: `overallVerdict` is simply absent, and the consumer keeps today's
// behavior. Returns `{ findings, overallVerdict }` — `findings` is the value
// the caller's `validate` callback receives (always the array, unwrapped);
// `overallVerdict` is passed through UNVALIDATED (the consumer that records it
// validates it; the consumer that ignores it drops it).
function unwrapFindingsPayload(parsed) {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.findings)) {
    return { findings: parsed.findings, overallVerdict: parsed.overallVerdict };
  }
  return { findings: parsed, overallVerdict: undefined };
}

/**
 * Resolve a findings array from either `--findings` (inline JSON) or
 * `--findings-file` (a path to the same JSON) — mutually exclusive, identical
 * read/parse handling either way. The parsed value is validated/normalized by
 * the caller-supplied `validate` callback. Returns `{ findings, overallVerdict }`
 * so a consolidator-produced wrapper object (`{ overallVerdict, findings }`,
 * written by consolidate-fanin.mjs's `--ledger-out`) threads its computed
 * verdict through to the consumer alongside the findings array; a bare array
 * input leaves `overallVerdict` undefined.
 *
 * @param {{ findings?: string, findingsFile?: string }} options
 * @param {{ parseError: (message: string) => Error, validate: (parsed: unknown, flagLabel: string) => unknown[] }} deps
 * @returns {Promise<{ findings: unknown[], overallVerdict?: unknown }>}
 */
export async function resolveFindingsInput(options, { parseError, validate }) {
  if (options.findings !== undefined && options.findingsFile !== undefined) {
    throw parseError("--findings and --findings-file are mutually exclusive; pass only one");
  }
  let parsed;
  let flagLabel;
  if (options.findingsFile !== undefined) {
    let raw;
    try {
      raw = await readFile(options.findingsFile, "utf8");
    } catch (err) {
      throw parseError(`Cannot read --findings-file "${options.findingsFile}": ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw parseError(`--findings-file "${options.findingsFile}" must contain valid JSON`);
    }
    flagLabel = "--findings-file";
  } else if (options.findings === undefined) {
    throw parseError("Either --findings <json> or --findings-file <path> is required");
  } else {
    try {
      parsed = JSON.parse(options.findings);
    } catch {
      throw parseError("--findings must be valid JSON");
    }
    flagLabel = "--findings";
  }
  const { findings: payload, overallVerdict } = unwrapFindingsPayload(parsed);
  return { findings: validate(payload, flagLabel), overallVerdict };
}
