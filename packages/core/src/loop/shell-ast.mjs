/**
 * Thin adapter over `sh-syntax/sync` (Bash variant, ADR 0276). The module loads on the first parse, so importing a
 * classifier that never parses (the Pi extension, the CLI, the other predicates) loads no wasm.
 * The hook bundle generator rewrites the specifier below to the vendored copy (`scripts/claude/generate-claude-assets.mjs`).
 */
import { createRequire } from "node:module";

let shSyntax;
const load = () => (shSyntax ??= createRequire(import.meta.url)("sh-syntax/sync"));

/**
 * Parse TEXT as Bash. Every failure returns `{ error }` so the gate's blanket deny on a parse failure applies (ADR 0276):
 * a syntax-class error (`ShSyntaxError`: a `ParseError` or a zsh-only construct such as `${${x}}`) as thrown,
 * a module or wasm load failure and any other runtime failure wrapped with a message that names the parser.
 * @param {string} text
 * @returns {{ file: object } | { error: Error }}
 */
export function parseShell(text) {
  let mod;
  try {
    mod = load();
  } catch (error) {
    return { error: new Error(`the inline-interpreter parser failed to load: ${error?.message ?? error}`, { cause: error }) };
  }
  try {
    return { file: mod.parse(text, { variant: mod.LangVariant.LangBash }) };
  } catch (error) {
    if (error instanceof mod.ShSyntaxError) return { error };
    return { error: new Error(`the inline-interpreter parser failed: ${error?.message ?? error}`, { cause: error }) };
  }
}

/** Depth-first walk (`sh-syntax` `walk`): a function visitor is `enter`; `{ enter, exit }` is also accepted. */
export const walkShell = (tree, visitor) => load().walk(tree, visitor);

/** The `RedirOperator` and `BinCmdOperator` enums of the loaded `sh-syntax`. */
export const shellOperators = () => ({ redir: load().RedirOperator, binCmd: load().BinCmdOperator });
