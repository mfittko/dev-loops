import { SEVERITY_ORDER, VALID_SEVERITIES, normalizeSeverity } from "@dev-loops/core/loop/gate-fanin";
const CARRIED_FROM_HEAD_RE = /^[0-9a-f]{7,64}$/i;

// Shared --carried-angles JSON-array CLI parse (issue 1782), used by both
// write-gate-context.mjs and consolidate-fanin.mjs's own --carried-angles
// flag so the two can never drift on accepted shape or error wording. Both
// CLIs name the flag identically, so its error text is hardcoded here rather
// than parameterized per caller.

// One definition of a valid carried angle — a non-empty-after-trim string —
// shared by the CLI parse below and write-gate-context.mjs's own programmatic
// seam (resolveFanoutDispatch's carriedAngles option). Each caller supplies
// its own error via makeError; the element predicate and the trim live only
// here. Assumes an array (each caller establishes iterability first).
export function normalizeCarriedAngleElements(elements, makeError) {
  if (elements.some((a) => typeof a !== "string" || a.trim().length === 0)) {
    throw makeError();
  }
  return elements.map((a) => a.trim());
}

// Parses a raw --carried-angles flag value (a JSON string): JSON.parse, an
// array-shape check, then non-empty-string element validation. Returns the
// trimmed angle-name array.
export function parseCarriedAnglesJsonArray(raw, parseError) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw parseError("--carried-angles must be a JSON array of angle-name strings");
  }
  if (!Array.isArray(parsed)) {
    throw parseError("--carried-angles must be a JSON array of non-empty angle-name strings");
  }
  return normalizeCarriedAngleElements(parsed, () => parseError("--carried-angles must be a JSON array of non-empty angle-name strings"));
}

// Validate + normalize (in place) a "carried" entries array's per-entry shape:
// a non-empty "angle" and a "carriedFromHead" that is a 7-64 char hex SHA.
// Shared by both the parse-time path (validateCarryForwardPlanShape, below)
// and consolidateGateFanin's own re-check of options.carryForwardPlan, so a
// programmatic caller that bypasses the parser still fails closed on a
// malformed entry (e.g. `[{ angle: "x" }]`, missing carriedFromHead) instead
// of minting an unmarked clean row indistinguishable from a fresh review.
export function validateCarryForwardPlanEntries(carried) {
  carried.forEach((entry, i) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
        || typeof entry.angle !== "string" || entry.angle.trim().length === 0
        || typeof entry.carriedFromHead !== "string") {
      throw new Error(`--carry-forward-plan carried[${i}] must be an object with non-empty string "angle" and "carriedFromHead" fields (resolve-angle-carry-forward.mjs's plan.carried shape)`);
    }
    const normalized = entry.carriedFromHead.trim().toLowerCase();
    if (!CARRIED_FROM_HEAD_RE.test(normalized)) {
      throw new Error(`--carry-forward-plan carried[${i}].carriedFromHead must be a 7-64 char hex SHA (write-gate-findings-log.mjs's own provenance bound), got ${JSON.stringify(entry.carriedFromHead)}`);
    }
    entry.carriedFromHead = normalized;
    // Optional: a carried entry may declare the PRIOR verdict it is carrying
    // ("clean" or "findings_present"). Absent entirely, the upsert below
    // defaults to clean/no findings for backward compatibility with an older
    // plan shape.
    if (entry.prevVerdict !== undefined) {
      if (entry.prevVerdict !== "clean" && entry.prevVerdict !== "findings_present") {
        throw new Error(`--carry-forward-plan carried[${i}].prevVerdict must be "clean" or "findings_present", got ${JSON.stringify(entry.prevVerdict)}`);
      }
      // Fail closed both directions here, at the one place every carried
      // entry passes through: a "findings_present" carry with no findings
      // would silently drop the real findings it claims to carry, and a
      // "clean" carry smuggling non-empty findings would hide them behind an
      // approval — reject both rather than let either surface downstream
      // where the cause is harder to trace.
      if (entry.prevVerdict === "findings_present") {
        if (!Array.isArray(entry.findings) || entry.findings.length === 0) {
          throw new Error(`--carry-forward-plan carried[${i}] declares prevVerdict "findings_present" but has no non-empty "findings" array to carry — refusing to mint a findings_present carried entry with no findings (fail-closed: this would drop the very findings carry-forward exists to preserve)`);
        }
        entry.findings.forEach((f, j) => {
          if (!f || typeof f !== "object" || Array.isArray(f)
              || typeof f.severity !== "string" || !VALID_SEVERITIES.has(normalizeSeverity(f.severity.trim()))
              || typeof f.summary !== "string" || f.summary.trim().length === 0) {
            throw new Error(`--carry-forward-plan carried[${i}].findings[${j}] must be an object with a valid "severity" (${SEVERITY_ORDER.join("|")}) and a non-empty "summary"`);
          }
        });
      } else if (Array.isArray(entry.findings) && entry.findings.length > 0) {
        throw new Error(`--carry-forward-plan carried[${i}] declares prevVerdict "clean" but carries a non-empty "findings" array — a clean carry must never smuggle findings through (fail-closed)`);
      }
    } else if (entry.findings !== undefined && entry.findings !== null
        && (!Array.isArray(entry.findings) || entry.findings.length > 0)) {
      // Symmetric fail-closed case: an entry with no prevVerdict at all must
      // not be a backdoor around the check above. This also covers a
      // malformed (non-array) findings payload, not just a non-empty array —
      // only an explicit prevVerdict: "findings_present" with a well-formed
      // non-empty findings array is eligible to carry findings through.
      throw new Error(`--carry-forward-plan carried[${i}] carries a "findings" payload (${Array.isArray(entry.findings) ? "non-empty array" : typeof entry.findings}) but no "prevVerdict": "findings_present" — refusing to upsert it as a clean carry (fail-closed)`);
    }
  });
  return carried;
}

// Validate --carry-forward-plan's shape at parse time: an object carrying a
// "carried" array (resolve-angle-carry-forward.mjs's own result object
// satisfies this directly), or a bare JSON array of carried entries — so the
// sanctioned invocation can pass that CLI's stdout, or just its "carried"
// field, straight through. Every entry must carry a non-empty "angle" and a
// "carriedFromHead" that is a 7-64 char hex SHA; malformed/missing evidence
// fails closed here rather than silently treating an unmatched name as "not
// carried" later, or a garbage provenance marker reaching --out.
// Returns the validated "carried" array (not the whole plan object) — the
// only part consolidateGateFanin actually consumes.
export function validateCarryForwardPlanShape(raw) {
  const plan = Array.isArray(raw) ? { carried: raw } : raw;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error('--carry-forward-plan must be a JSON object with a "carried" array, or a bare JSON array of carried entries (resolve-angle-carry-forward.mjs\'s own result, or just its "carried" field)');
  }
  if (!Array.isArray(plan.carried)) {
    throw new Error('--carry-forward-plan must have a "carried" array (resolve-angle-carry-forward.mjs\'s plan.carried)');
  }
  return validateCarryForwardPlanEntries(plan.carried);
}

// Zero-emission rounds have no fresh reviewers to establish coverage. Bind
// the complete resolver proof to the emitter's resolved angles instead.
export function validateZeroUnitCarryProof(raw, angles) {
  const entries = validateCarryForwardPlanShape(structuredClone(raw));
  const names = entries.map((entry) => entry.angle);
  if (names.length === 0 || new Set(names).size !== names.length
      || names.length !== angles.length || new Set(angles).size !== angles.length
      || angles.some((angle) => !names.includes(angle))) {
    throw new Error("zero-unit carry proof must cover exactly every resolved angle, without duplicates");
  }
  return entries;
}

export function verifyZeroUnitCarryProvenance(proof, rows) {
  const entries = validateZeroUnitCarryProof(proof, rows.map((row) => row.angle));
  for (const entry of entries) {
    const row = rows.find((candidate) => candidate.angle === entry.angle);
    for (const key of ["carriedFromHead", "reviewer", "model", "dispatchId"]) {
      if (row[key] !== entry[key]) throw new Error(`zero-unit carry proof differs from provenance for ${entry.angle}.${key}`);
    }
    if (row.carriedVerdict !== (entry.prevVerdict ?? "clean")) {
      throw new Error(`zero-unit carry proof differs from provenance for ${entry.angle}.carriedVerdict`);
    }
  }
}
