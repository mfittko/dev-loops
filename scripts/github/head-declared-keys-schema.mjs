// Strict schema for the head-declared config key list (issue #2662, docs/decisions/0234).
// The list is attacker-controlled data; anything off-schema is the empty set.
export const HEAD_DECLARED_KEYS_MAX_BYTES = 64 * 1024;
const MAX_ENTRIES = 512;
const MAX_ENTRY_LENGTH = 100; // 512 entries x (100 + 3 JSON chars) fit in 64 KiB
const KEY_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/** Parse a declared-keys JSON text (array or {declaredKeys:[...]}); invalid input is an empty set, never an error. */
export function parseHeadDeclaredKeys(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > HEAD_DECLARED_KEYS_MAX_BYTES) return [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : parsed?.declaredKeys;
    if (!Array.isArray(list) || list.length > MAX_ENTRIES) return [];
    const valid = list.every((k) => typeof k === "string" && k.length >= 1 && k.length <= MAX_ENTRY_LENGTH && KEY_PATTERN.test(k));
    return valid ? list : [];
  } catch {
    return [];
  }
}
