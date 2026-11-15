/**
 * Thin adapter over `sh-syntax/sync` (Bash variant, ADR 0276). The module loads on the first parse, so importing a
 * classifier that never parses (the Pi extension, the CLI, the other predicates) loads no wasm.
 * The hook bundle generator rewrites the specifier below to the vendored copy (`scripts/claude/generate-claude-assets.mjs`).
 */
import { createRequire } from "node:module";

let shSyntax;
const load = () => (shSyntax ??= createRequire(import.meta.url)("sh-syntax/sync"));

/**
 * Parse TEXT as Bash. A `ParseError` returns `{ error }`; any other error is a defect and propagates.
 * @param {string} text
 * @returns {{ file: object } | { error: Error }}
 */
export function parseShell(text) {
  const mod = load();
  try {
    return { file: mod.parse(text, { variant: mod.LangVariant.LangBash }) };
  } catch (error) {
    if (error instanceof mod.ParseError) return { error };
    throw error;
  }
}

/** Depth-first walk (`sh-syntax` `walk`): a function visitor is `enter`; `{ enter, exit }` is also accepted. */
export const walkShell = (tree, visitor) => load().walk(tree, visitor);

/** The `RedirOperator` and `BinCmdOperator` enums of the loaded `sh-syntax`. */
export const shellOperators = () => ({ redir: load().RedirOperator, binCmd: load().BinCmdOperator });
