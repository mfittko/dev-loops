import { readFile } from "node:fs/promises";

import { isDirectCliRun } from "../_core-helpers.mjs";

const USAGE = `Usage: extract-changelog-section.mjs --version <v> [--changelog <path>]

Prints the CHANGELOG.md section for <version> (the block from "## <version>"
up to the next "## " heading). Exits 1 if no such section exists or the section
is empty, so a release is never created for an undocumented version. Exits 2 on
usage/argument errors (missing --version, missing flag value, unreadable file).`;

/**
 * Extract the changelog block for a single version.
 *
 * Matches a heading line of the form "## <version>" optionally followed by
 * " - <date>" (or any trailing text), and returns everything up to but not
 * including the next "## " heading. Returns null when no matching section
 * exists (fail closed — caller must not synthesize notes).
 *
 * @param {string} changelog - Full CHANGELOG.md contents.
 * @param {string} version - Version without a leading "v" (e.g. "0.5.0").
 * @returns {string|null} Trimmed section body (without the heading), or null.
 */
export function extractChangelogSection(changelog, version) {
  const lines = changelog.split("\n");
  // A heading is "## " followed by the exact version token, then either end of
  // line or a non-version-character (space / "-"). This avoids "0.5.0" matching
  // "0.5.0-rc1" or "0.5.01".
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRe = new RegExp(`^##\\s+v?${escaped}(?=\\s|$)`);

  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headingRe.test(lines[i])) {
      start = i;
      break;
    }
  }

  if (start === -1) {
    return null;
  }

  const body = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      break;
    }
    body.push(lines[i]);
  }

  return body.join("\n").trim();
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let version;
  let changelogPath = "CHANGELOG.md";
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--version" || argv[i] === "--changelog") {
      const flag = argv[i];
      const value = argv[i + 1];
      if (value === undefined) {
        process.stderr.write(`error: ${flag} requires a value\n\n${USAGE}\n`);
        return 2;
      }
      if (flag === "--version") {
        version = value;
      } else {
        changelogPath = value;
      }
      i += 1;
    }
  }

  if (!version) {
    process.stderr.write(`error: --version is required\n\n${USAGE}\n`);
    return 2;
  }

  const normalized = version.replace(/^v/, "");

  let changelog;
  try {
    changelog = await readFile(changelogPath, "utf8");
  } catch (error) {
    process.stderr.write(`error: cannot read ${changelogPath}: ${error.message}\n`);
    return 2;
  }

  const section = extractChangelogSection(changelog, normalized);
  if (section === null || section === "") {
    process.stderr.write(
      `error: no section found for version ${normalized} in ${changelogPath}. ` +
        `Refusing to create a release for an undocumented version.\n`,
    );
    return 1;
  }

  process.stdout.write(`${section}\n`);
  return 0;
}

if (isDirectCliRun(import.meta.url)) {
  const exitCode = await main();
  process.exitCode = exitCode;
}
