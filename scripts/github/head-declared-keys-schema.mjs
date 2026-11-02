// Schema for the head-declared config key list (docs/decisions/0234).
// The list is attacker-controlled data: the 64 KiB byte bound rejects an oversized text,
// and each entry is checked on its own so one off-pattern entry never discards the valid ones.
export const HEAD_DECLARED_KEYS_MAX_BYTES = 64 * 1024;
const MAX_ENTRY_LENGTH = 100;
const KEY_PATTERN = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

/** Parse a declared-keys JSON text (array or {declaredKeys:[...]}); invalid input is an empty set, never an error. */
export function parseHeadDeclaredKeys(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > HEAD_DECLARED_KEYS_MAX_BYTES) return [];
  try {
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : parsed?.declaredKeys;
    if (!Array.isArray(list)) return [];
    const valid = list.filter((k) => typeof k === "string" && k.length >= 1 && k.length <= MAX_ENTRY_LENGTH && KEY_PATTERN.test(k));
    if (valid.length < list.length) process.stderr.write(`${JSON.stringify({ headDeclaredKeysDiscarded: list.length - valid.length, of: list.length })}\n`); // one JSON line, no evidenceState/currentHeadSha: the workflow's jq reads stderr as a JSON stream
    return valid;
  } catch {
    return [];
  }
}
