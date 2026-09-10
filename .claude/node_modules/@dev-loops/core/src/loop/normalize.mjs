/**
 * Shared string-normalization primitive used across the loop layer:
 * trim a value and return it, or null when it isn't a non-empty string.
 */
export function trimmedOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
