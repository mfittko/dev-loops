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

## Anti-patterns to avoid

- Over-engineering: adding abstraction layers "just in case"
- Copy-paste duplication: extracting shared logic too late
- Magic values: undocumented constants or configuration
- God modules: single file doing too many unrelated things

## Cross-references

- [Anti-patterns](anti-patterns.md)
- [Validation policy](validation-policy.md)
