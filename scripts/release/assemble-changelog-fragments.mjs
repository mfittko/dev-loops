import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Changeset-fragment CHANGELOG (LIFECYCLE-CHANGELOG-COMPLETENESS in
 * skills/docs/pr-lifecycle-contract.md).
 *
 * Each PR records its changelog note as a NEW, uniquely named fragment file
 * under `changes/` instead of editing the shared `CHANGELOG.md` Unreleased
 * section. Uniquely named fragments never collide, so concurrent PRs stop
 * conflicting on the changelog. At release, `assembleFragments` splices every
 * pending fragment into the `## Unreleased` section and the fragments are
 * removed; the existing bump stamp (`stampChangelog`) then promotes Unreleased
 * to the version heading unchanged.
 */

export const FRAGMENTS_DIR = "changes";

/**
 * Whether a fragment body would prematurely CLOSE the changelog section it is
 * spliced into. `stampChangelog`/`extractChangelogSection` treat the next line
 * matching `/^##\s/` (a level-2 heading) as the end of the `## Unreleased` /
 * `## <version>` section, so a `## Foo` line inside a fragment would drop every
 * following entry from the assembled release notes. A level-3+ heading
 * (`### Added`) is fine — only exactly `##` + whitespace closes a section. The
 * documented fragment format is Keep-a-Changelog bullet lines.
 *
 * @param {string} content
 * @returns {boolean}
 */
export function fragmentBodyClosesSection(content) {
  return /^##\s/m.test(String(content ?? ""));
}

/** Section headings a fragment may declare, in release order. */
export const FRAGMENT_SECTIONS = ["Added", "Changed", "Fixed"];
const DEFAULT_SECTION = "Changed";
const SECTION_LINE_RE = /^###\s+(Added|Changed|Fixed)\s*$/;
const HEADING_RE = /^#{1,6}\s/;
export const MAX_ENTRY_CHARS = 200;
const ENTRY_LINK_RE = /\(#\d+(?:,\s*#\d+)*\)/;

/**
 * Split a fragment into its section and its non-blank body lines. The section
 * comes from a `### Added|Changed|Fixed` first line; it defaults to `Changed`.
 *
 * @param {string} content
 * @returns {{ section: string, lines: string[] }}
 */
export function parseFragment(content) {
  const lines = String(content ?? "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
  const match = lines.length > 0 ? SECTION_LINE_RE.exec(lines[0]) : null;
  return match
    ? { section: match[1], lines: lines.slice(1) }
    : { section: DEFAULT_SECTION, lines };
}

/**
 * Format violations of a fragment body. Each entry is one `- <effect> (#NNN)`
 * line of at most MAX_ENTRY_CHARS characters with no bold lead, under at most
 * one leading `### Added|Changed|Fixed` section line. Each message names its rule.
 *
 * @param {string} content
 * @returns {string[]}
 */
export function fragmentFormatErrors(content) {
  const errors = [];
  const all = String(content ?? "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const headings = all.filter((l) => HEADING_RE.test(l));
  const { lines } = parseFragment(content);
  if (headings.length > 1) {
    errors.push("section-heading rule: more than one section heading; use one ### Added, ### Changed or ### Fixed line at the top");
  } else if (headings.length === 1 && lines.length === all.length) {
    errors.push("section-heading rule: the only allowed heading is a first-line ### Added, ### Changed or ### Fixed");
  }
  if (lines.length === 0) errors.push("one-line rule: the fragment has no entries");
  for (const line of lines) {
    if (HEADING_RE.test(line)) continue; // reported by the section-heading rule
    const excerpt = line.slice(0, 60);
    if (!line.startsWith("- ")) {
      errors.push(`one-line rule: continuation or non-entry line (each entry is one "- " line): ${excerpt}`);
      continue;
    }
    if (line.length > MAX_ENTRY_CHARS) {
      errors.push(`200-character rule: entry is ${line.length} characters: ${excerpt}`);
    }
    if (line.startsWith("- **")) errors.push(`no-bold-lead rule: entry opens with bold text: ${excerpt}`);
    if (!ENTRY_LINK_RE.test(line)) errors.push(`link rule: entry has no (#NNN) issue or PR link: ${excerpt}`);
  }
  return errors;
}

/**
 * Whether a path is a changeset fragment: `changes/<slug>.md`, excluding the
 * convention `changes/README.md` (which documents the directory, not a change).
 *
 * @param {string} file - A Git-reported repository-relative path (always
 *   `/`-separated; backslashes are NOT normalized and never match).
 * @returns {boolean}
 */
export function isChangelogFragmentPath(file) {
  // Match Git's canonical path shape verbatim: Git always reports `/`-separated
  // paths on every OS. Do NOT normalize `\` to `/` — a POSIX file literally
  // named `changes\foo.md` (backslash in the basename) is a root-level file,
  // NOT `changes/foo.md`, so normalizing would let the gate accept a path the
  // assembler (which enumerates `<repoRoot>/changes/`) never sees.
  const match = /^changes\/([^/]+)\.md$/.exec(String(file ?? ""));
  if (!match) return false;
  return match[1].toLowerCase() !== "readme";
}

/**
 * Read every pending fragment under `<repoRoot>/changes/`, filename-sorted for a
 * deterministic assembly order. README and non-`.md` files are skipped. A
 * genuinely absent directory (`ENOENT`) yields an empty list (fail soft: no
 * fragments to assemble). Any OTHER read failure — `changes/` unreadable or not
 * a directory (`ENOTDIR`) — is rethrown, so the release never SILENTLY omits
 * pending notes it could not read.
 *
 * @param {string} repoRoot
 * @returns {{ name: string, content: string }[]}
 */
export function readFragments(repoRoot) {
  const dir = path.join(repoRoot, FRAGMENTS_DIR);
  // The `changes/` directory itself must be a REAL directory, checked with lstat
  // (which does NOT follow a final symlink) before enumeration. A commit could
  // replace `changes/` with a symlink to an external directory; following it
  // would read external `*.md` files into CHANGELOG.md and later rmSync-delete
  // those host paths at release. Reject a symlinked/non-directory `changes/`.
  let dirStat;
  try {
    dirStat = lstatSync(dir);
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  if (!dirStat.isDirectory()) {
    throw new Error(
      `${FRAGMENTS_DIR}/ must be a real directory, not a ${dirStat.isSymbolicLink() ? "symlink" : "non-directory"}; refusing to enumerate it`,
    );
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries
    .filter(
      (e) =>
        // REGULAR files only. A symlink is deliberately excluded (not followed):
        // an untrusted PR could add `changes/x.md` symlinked to an arbitrary host
        // file, and following it would copy that file's contents into CHANGELOG.md
        // (data disclosure). The gate applies the same regular-file-only policy,
        // so a symlinked fragment is rejected by both — never accepted-then-dropped.
        e.isFile() &&
        isChangelogFragmentPath(`${FRAGMENTS_DIR}/${e.name}`),
    )
    .map((e) => {
      const content = readFileSync(path.join(dir, e.name), "utf8");
      // Fail closed on a malformed body that would truncate the release section
      // (a `## ` heading). The PR gate rejects this too, so at release it should
      // never occur — but a silent drop of consumed notes must never happen.
      if (fragmentBodyClosesSection(content)) {
        throw new Error(
          `changeset fragment ${FRAGMENTS_DIR}/${e.name} contains a level-2 "## " heading, which would truncate the assembled release section; fragments must be bullet lines (level-3 "### " is allowed)`,
        );
      }
      return { name: e.name.replace(/\.md$/, ""), content };
    })
    // Byte-wise name sort (not localeCompare): a locale-independent order so the
    // assembled bullet order is reproducible across environments.
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Splice pending fragment bodies into the `## Unreleased` section, preserving
 * any existing Unreleased entries and the rest of the file. Fragments with
 * empty content are ignored (an empty fragment documents nothing). When no
 * `## Unreleased` section exists it is created above the first version heading.
 *
 * Pure: no I/O. Deterministic filename order (caller sorts, e.g. readFragments).
 *
 * @param {{ changelog: string, fragments: { name: string, content: string }[] }} input
 * @returns {{ changelog: string, consumed: string[] }} New changelog text and
 *   the names of the fragments that were assembled (empty when none applied).
 */
export function assembleFragments({ changelog, fragments }) {
  const frags = (Array.isArray(fragments) ? fragments : [])
    .filter((f) => f && typeof f.content === "string" && f.content.trim() !== "");
  if (frags.length === 0) return { changelog: String(changelog ?? ""), consumed: [] };

  // One heading per section, in FRAGMENT_SECTIONS order; empty sections omitted.
  const bySection = new Map(FRAGMENT_SECTIONS.map((name) => [name, []]));
  for (const f of frags) {
    const { section, lines: body } = parseFragment(f.content);
    bySection.get(section).push(...body);
  }
  const block = FRAGMENT_SECTIONS
    .filter((name) => bySection.get(name).length > 0)
    .map((name) => `### ${name}\n\n${bySection.get(name).join("\n")}`)
    .join("\n\n");
  const consumed = frags.map((f) => f.name);
  const lines = String(changelog ?? "").split("\n");

  const headingIdx = lines.findIndex((l) => /^##\s+Unreleased\b/i.test(l));
  if (headingIdx === -1) {
    // No Unreleased section: create one above the first version heading (or at
    // EOF when the file has no `## ` heading yet).
    const firstSection = lines.findIndex((l) => /^##\s/.test(l));
    const insertAt = firstSection === -1 ? lines.length : firstSection;
    lines.splice(insertAt, 0, "## Unreleased", "", block, "");
    return { changelog: lines.join("\n"), consumed };
  }

  // Append the fragment block at the tail of the Unreleased section, just before
  // the next `## ` heading (or EOF), after any existing entries.
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let tail = end;
  while (tail > headingIdx + 1 && lines[tail - 1].trim() === "") tail -= 1;
  lines.splice(tail, 0, "", block);
  return { changelog: lines.join("\n"), consumed };
}
