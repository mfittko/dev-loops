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
