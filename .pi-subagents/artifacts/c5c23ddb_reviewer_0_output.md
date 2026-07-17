## Review

- Correct:
  - Architecture already favors shared core + thin surfaces. Evidence: `README.md:5`, `PLAN.md:57-72`, `extension/index.ts:52-55`, `lib/dev-loops-core.mjs:12-23`.
  - Runtime validation is strong without TS everywhere: Zod strict schemas in `packages/core/src/config/config.mjs:15-55`, `220-238`; tests reject unknown config keys in `packages/core/test/config.test.mjs:84-127`.
  - Test surface is broad: `package.json:23-38`, `packages/core/package.json:76-78`; core has 71 tracked test files.

- Fixed:
  - None. Read-only audit; no files changed.

- Blocker:
  - High: `npm run test:core` fails under Pi subagent env. `packages/core/test/run-context.test.mjs:58-62` expects `resolveRunId(undefined) === null`, but `packages/core/src/loop/run-context.mjs:64-71` defaults `undefined` to `process.env`, where `PI_SUBAGENT_RUN_ID=c5c23ddb` exists. Same test passes with `env -u PI_SUBAGENT_RUN_ID`. This is test hermeticity debt, not a TS problem.

- Note:
  - Medium: Do **not** big-bang migrate to TypeScript now. Repo is mostly ESM JS: 480 tracked `.mjs` vs 7 `.ts`; no `tsconfig*.json`; `npm ls typescript --depth=0` is empty. Root tests run Node directly; only extension tests use `tsx` (`package.json:27`, `59-65`). Full migration would add build/declaration/source-loaded complexity.
  - Medium: Align stated TypeScript policy. `skills/docs/structural-quality.md:10` requires “Strict TypeScript,” but core/scripts are `.mjs`. Either narrow that rule to TS files/extensions, or add a small TS check for `extension/*.ts`; avoid repo-wide rewrite.
  - Medium: Apply DRY/SOLID as principles, not ceremony. Existing docs already say KISS/SRP/YAGNI/DRY carefully (`agents/developer.agent.md:24-31`) and review angles expose DRY/KISS/YAGNI/SRP/SoC (`README.md:125-129`, `extension/README.md:153-163`). Avoid OOP-style factories/interfaces unless a real second implementation exists.
  - Medium: Two core modules exceed own ~1k-line ceiling (`skills/docs/structural-quality.md:26-29`): `packages/core/src/loop/public-dev-loop-routing.mjs` 1746 lines, `packages/core/src/config/config.mjs` 1421 lines. Split opportunistically when touching them: schema/defaults/loader/resolvers; routing normalizers/gates/status bundle.

Recommendation: keep JS/MJS core. Use runtime schemas + tests. Add TypeScript only at stable boundaries or new TS-owned surfaces. Spend refactor effort on test hermeticity and smaller core modules first.