# Structural quality

Canonical owner for structural quality standards across all workflow families.

## Core principles

- **KISS**: Keep implementations simple; prefer thin glue over thick abstraction
- **SRP**: Single Responsibility Principle — one reason to change per module
- **YAGNI**: Don't add speculative features, compatibility shims, or unused abstractions
- **Strict TypeScript**: No `any`, no implicit coercion, explicit return types

## Deep review standards

Apply these during implementation (not just review):

1. **Cohesion**: Related functionality lives together; unrelated functionality is separated
2. **Coupling**: Minimize dependencies between modules; prefer explicit injection over globals
3. **Error handling**: All error paths are explicit and tested; no silent failures
4. **Testability**: Every public function is independently testable; no hidden state
5. **Naming**: Names describe what, not how; consistent vocabulary across codebase

## Implementation self-check rules

Apply these during implementation (not just at review time):

- **Prefer deletion over addition**: Question every new file, export, layer, and moving part. If it does not earn its keep, remove it.
- **File size ceiling**: Files over ~1k lines need extraction or an explicit justification kept in a code comment or doc reference.
- **Logic placement**: Do not bolt conditionals onto unrelated paths; push logic into its own dedicated boundary.
- **Avoid thin abstractions**: No thin wrappers, re-export-only files, or identity abstractions that add indirection without clarity.
- **No leaky abstractions**: Do not leak feature-specific logic into shared or general-purpose modules.

## Code-comment convention

Code comments describe behavior and never cite PR or issue numbers (those are ephemeral tracker references that rot).

A rule ID (e.g. `WORKTREE-DEFAULT-BRANCH-GUARD`, `GATE-EXEC-PRIME`) is a **different kind of thing**: a stable contract identifier, not an ephemeral tracker reference. Where a script refuses an operation because a rule forbids it, name the rule ID in the **enforcement error message** (asserted by a test, so it cannot rot) rather than only in a comment; the rule-registry validator (`validate-rule-ownership.mjs`) counts a `runtime`-classified rule as enforced only when that ID appears in a **refusal/error string** in runtime source — not mere presence. A rule ID that appears only in a comment, docstring, usage text, or data/log string is not an enforcement site and does not count as enforced. See `required-rules.json` `enforcement` classification.

## Anti-patterns to avoid

- Over-engineering: adding abstraction layers "just in case"
- Copy-paste duplication: extracting shared logic too late
- Magic values: undocumented constants or configuration
- God modules: single file doing too many unrelated things

## Cross-references

- [Anti-patterns](anti-patterns.md)
- [Validation policy](validation-policy.md)
