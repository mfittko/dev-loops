// Strict schema for the head-declared config key list (issue #2662, docs/decisions/0234).
// The list is attacker-controlled data; anything off-schema is the empty set.
export const HEAD_DECLARED_KEYS_MAX_BYTES = 256 * 1024;
const MAX_ENTRIES = 512;
const KEY_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/** Parse a declared-keys JSON text (array or {declaredKeys:[...]}); invalid input is an empty set, never an error. */
export function parseHeadDeclaredKeys(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > HEAD_DECLARED_KEYS_MAX_BYTES) return [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : parsed?.declaredKeys;
    if (!Array.isArray(list) || list.length > MAX_ENTRIES) return [];
    const valid = list.every((k) => typeof k === "string" && k.length >= 1 && k.length <= 200 && KEY_PATTERN.test(k));
    return valid ? list : [];
  } catch {
    return [];
  }
}
