Read-only audit done. No files changed.

## Finding

Do **not** migrate whole repo to TS now.

Repo is mostly `.mjs`:

- tracked code: `480 .mjs`, `7 .ts`, `1 .js`
- JS/TS LOC: ~163k excluding vendored Mermaid
- no `tsconfig`, `jsconfig`, ESLint, Biome, Prettier config
- no `typescript` or `@types/node` devDependency
- `tsx` exists only to execute extension tests
- CI canonical path is `npm run verify`; no typecheck step

Current TS use is narrow:

- `extension/*.ts`
- package points Pi extension at `./extension/index.ts`
- extension tests run with `node --import tsx`
- TS files import many `.mjs` modules, so real `tsc` would need JS declarations/JSDoc or shims.

## Cost / risk

### Full TS migration now

Cost: high.  
Risk: high.

Why:

- would touch CLI, scripts, tests, package exports, bin entries, CI, publish packing
- Node/ESM extension specifiers need care: `.mjs` imports, package export paths, direct `node scripts/*.mjs`
- publish package currently ships `.mjs` and `.ts`; migration needs either build output or runtime TS strategy
- 400+ files lack `@ts-check`; only ~71 have JSDoc type tags
- no type toolchain baseline, so first `tsc` run likely noisy
- tests are large and JS-heavy; converting tests adds little value first

Best estimate: multi-week cleanup if done correctly.

### JSDoc + targeted `checkJs`

Cost: low to medium.  
Risk: low.

Best path:

1. Add `typescript` devDependency.
2. Add `typecheck` script with narrow `tsconfig`.
3. Start with:
   - `extension/**/*.ts`
   - `lib/dev-loops-core.mjs`
   - `packages/core/src/harness/*.mjs`
   - public package exports used by extension/scripts
4. Expand include list by seam, not whole repo.
5. Prefer JSDoc typedefs where JS stays JS.

Why better:

- keeps runtime/package behavior unchanged
- catches shape drift on public seams
- avoids mass rename/build churn
- aligns with existing style: explicit runtime validation + JSDoc typedefs already present in core.

## Recommended next step

Add targeted typecheck, not full TS migration.

Lazy version: `tsc --noEmit` over existing `.ts` extension plus a small JS allowlist with JSDoc. Expand only when files become public seams or bugs show type drift.

## Validation notes

`npm run test:extension` passes.

`npm run test:core` failed under current Pi subagent env because `PI_SUBAGENT_RUN_ID` leaks into `resolveRunId(undefined)` test. Same command passes with `PI_SUBAGENT_RUN_ID` unset. This is tooling/hermeticity issue, not TS-specific, but worth fixing before adding stricter CI gates.