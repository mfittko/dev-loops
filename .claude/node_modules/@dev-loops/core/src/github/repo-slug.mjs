import { execFileSync } from "node:child_process";

export function isSafeRepoSegment(segment) {
  return typeof segment === "string"
    && segment.length > 0
    && segment !== "."
    && segment !== ".."
    && !/[\\/]/.test(segment)
    && !/\s/.test(segment);
}

export function parseRepoSlug(
  repo,
  { errorMessage = "--repo must match <owner/name>", lowercase = false } = {},
) {
  return parseRepoSlugParts(repo, { errorMessage, lowercase });
}

export function parseRepoSlugParts(
  repo,
  { errorMessage = "repo must match <owner/name>", lowercase = false } = {},
) {
  if (typeof repo !== "string") {
    throw new Error(errorMessage);
  }

  const trimmed = repo.trim();
  const [rawOwner, rawName, ...rest] = trimmed.split("/");

  if (rest.length > 0 || !isSafeRepoSegment(rawOwner) || !isSafeRepoSegment(rawName)) {
    throw new Error(errorMessage);
  }

  const owner = lowercase ? rawOwner.toLowerCase() : rawOwner;
  const name = lowercase ? rawName.toLowerCase() : rawName;
  return { owner, name };
}

export function normalizeRepoSlug(
  repo,
  { errorMessage = "repo must match <owner/name>" } = {},
) {
  const { owner, name } = parseRepoSlugParts(repo, { errorMessage, lowercase: true });
  return `${owner}/${name}`;
}

/**
 * Lenient variant: trims and lowercases a slug string. Returns null for
 * non-strings, empty strings, or strings that cannot be trimmed to a
 * non-empty value. Does NOT validate owner/name structure.
 */
export function tryNormalizeRepoSlug(slug) {
  if (typeof slug !== "string") {
    return null;
  }
  const trimmed = slug.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

export function repoSlugEquals(left, right) {
  const normalizedLeft = tryNormalizeRepoSlug(left);
  const normalizedRight = tryNormalizeRepoSlug(right);
  if (normalizedLeft === null || normalizedRight === null) {
    return left === right;
  }
  return normalizedLeft === normalizedRight;
}

export function dedupeRepoSlugOptions(options) {
  const uniqueOptions = [];
  const seen = new Set();
  for (const option of options) {
    if (typeof option !== "string") {
      continue;
    }
    const trimmed = option.trim();
    const normalized = tryNormalizeRepoSlug(trimmed);
    if (normalized === null || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    uniqueOptions.push(trimmed);
  }
  return uniqueOptions;
}
/**
 * Auto-detect <owner/name> from `git remote get-url origin`.
 * Returns the slug string on success, or null when detection fails
 * (no origin remote, not a git repo, or unparseable URL).
 * Does NOT throw — callers should add their own context-specific error messages.
 */
export function detectRepoSlug(cwd) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const match = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) return null;
    return `${match[1]}/${match[2]}`;
  } catch {
    return null;
  }
}
