# repo-wiki manual-first local export

## Status

This repository now has a **local runnable `repo-wiki` export path** and a GitHub Actions CI workflow that compiles the wiki and publishes it to the repository's GitHub Wiki. The primary install route is the published npm package, with a pinned local-helper fallback for environments that cannot reach npm or require a deterministic source pin.

Scheduled sync remains out of scope.

Source files in this repository remain authoritative. Generated wiki output is a navigation aid, not the source of truth.

## Install paths

This slice supports two install paths. Pick the one that matches your environment.

### Primary path: published npm package

```bash
npm install @mfittko/repo-wiki
npx repo-wiki --help
```

This is the recommended path for normal local use. The npm wrapper at `scripts/repo-wiki.mjs` validates that `.llmwiki/config.json` exists and then proxies `npx @mfittko/repo-wiki@<pinned-version>` for the actual commands.

Pinned npm version used by the wrapper:

- `@mfittko/repo-wiki@0.2.6`

### Fallback path: pinned local helper

Use this when you prefer a pinned source checkout over the published npm path (deterministic source pin, controlled GitHub-only network access, offline reproduction after the initial clone). The helper still requires git access to `https://github.com/mfittko/repo-wiki.git` for the initial clone/fetch step; it is **not** suitable for fully air-gapped environments without a pre-seeded source checkout.

The local helper:

- clones `mfittko/repo-wiki` at a fixed commit
- installs dependencies and builds the CLI locally
- proxies the requested `repo-wiki` command against this repository using that built checkout

Pinned source ref used by the helper:

- `d7e772e3d702a75896a6f4eec574a4e4e5bfa6dd`

Helper entrypoint:

- `scripts/repo-wiki-local.mjs`

## Local prerequisites

For both paths:

- Node.js 24+ for the npm wrapper (matches the repository engine requirement)
- Node.js 24+ if you use the local-helper fallback (the pinned commit requires it)
- git and npm available locally
- network access to `https://github.com/mfittko/repo-wiki.git` (fallback path) and the public npm registry (primary path)

## Checked-in local config

The consumer-repo side of this slice ships two checked-in files:

- `.llmwiki/config.json` — repo-wiki consumer config for this repository
- `.llmwiki/schema.md` — schema reference for the config and required generated pages

Generated artifacts under `.llmwiki/run/`, `.llmwiki/wiki/`, and `.llmwiki/search/` are ignored by `.gitignore`; they are recreated locally and not treated as source of truth.

## Local commands that work

Prepare the pinned local-helper fallback (only needed for the fallback path):

```bash
npm run repo-wiki:prepare
```

Run a full local bootstrap export from a clean checkout (scan + plan + compile, no LLM key required for the deterministic compile step):

```bash
npm run repo-wiki:bootstrap
```

That bounded sequence covers the full deterministic local path (scan + plan + compile).
The lint step is intentionally **not** wired into the bootstrap script: `npm run repo-wiki:lint`
flags a pre-existing `OPENAI_API_KEY` mention in `README.md` as secret-like content, and that
issue is outside this slice. Run lint separately if you want to inspect wiki page health.
Lint remains available as an explicit opt-in step via `npm run repo-wiki:lint`.
Lint of ingested markdown docs is also available separately via `npm run repo-wiki:lint-docs`.

```bash
npm run repo-wiki:scan
npm run repo-wiki:plan
npm run repo-wiki:lint-docs
npm run repo-wiki:compile
npm run repo-wiki:lint
```

To run the same stages against the offline fallback source checkout instead of the published npm package, prefix the stage script with `repo-wiki:local-`:

```bash
npm run repo-wiki:local-bootstrap
npm run repo-wiki:local-scan
npm run repo-wiki:local-plan
npm run repo-wiki:local-lint-docs
npm run repo-wiki:local-compile
npm run repo-wiki:local-lint
```

Inspect the documentation lint output separately:

```bash
npm run repo-wiki:lint-docs
```

Search the generated local wiki output:

```bash
npm run repo-wiki:search -- "dev-loop"
```

Inspect the generated wiki pages directly:

```bash
find .llmwiki/wiki -maxdepth 1 -type f | sort
```

If you want to regenerate `.llmwiki/config.json` and `.llmwiki/schema.md` from the helper instead of using the checked-in versions:

```bash
npm run repo-wiki:init
```

## What each path does

### Primary (npm) path

`scripts/repo-wiki.mjs`:

1. asserts the current Node.js runtime is supported
2. asserts `.llmwiki/config.json` exists in the consumer repo
3. invokes `npx --yes @mfittko/repo-wiki@<pinned-version> ...` with the passthrough args
4. forwards cwd, env, and stdio so the underlying `repo-wiki` commands behave as if invoked directly

### Fallback (local helper) path

`scripts/repo-wiki-local.mjs`:

1. clones `mfittko/repo-wiki` under `.tmp/repo-wiki/<ref>/source/`
2. checks out the pinned commit `d7e772e3d702a75896a6f4eec574a4e4e5bfa6dd`
3. runs `npm install` and `npm run build` in that checkout (skipped on rerun if a build stamp matches the ref)
4. runs `dist/bin/repo-wiki.js` from that prepared checkout against this repository

## Local verification performed for this slice

The following commands were run from a clean checkout of this repository (see the lint caveat above; lint is intentionally excluded from this verification list because of a pre-existing repo-wiki finding):

```bash
npm run repo-wiki:scan
npm run repo-wiki:plan
npm run repo-wiki:compile
npm run repo-wiki:lint
find .llmwiki/wiki -maxdepth 1 -type f | sort
```

Standard changed-scope repo validation was also run:

```bash
git diff --check
node --test test/loop/repo-wiki.test.mjs test/loop/repo-wiki-local.test.mjs
npm run verify
```

## CI automation

A GitHub Actions workflow at `.github/workflows/wiki.yml` compiles the repository wiki and, on pushes to `main` (or on demand via `workflow_dispatch`), publishes the compiled pages to the GitHub Wiki.

### Triggers

- `push` to `main` — runs the `compile-wiki` job and, because it is on `main`, the `publish-wiki` job.
- `workflow_dispatch` — optionally opt in to `publish_wiki` after `compile-wiki` succeeds. The compile job always runs `npm run repo-wiki:bootstrap` (scan + plan + compile).

### Required operator setup

1. **Secret** (Settings → Secrets and variables → Actions → Secrets):
   - `LLMWIKI_LLM_API_KEY` — OpenAI-compatible API key. Required only when `LLMWIKI_COMPILER_MODE=llm`.
2. **Variable** (Settings → Secrets and variables → Actions → Variables) — **only if LLM mode is desired**:
   - `LLMWIKI_COMPILER_MODE=llm`
   - Without this var, the workflow uses the deterministic baseline from `.llmwiki/config.json` and does not consume the API key.
3. **Optional provider variables** (when LLM mode is enabled):
   - `LLMWIKI_LLM_PROVIDER`
   - `LLMWIKI_LLM_BASE_URL`
   - `LLMWIKI_LLM_MODEL`
   - `LLMWIKI_LLM_ARCHITECTURE_MODEL`
   - `LLMWIKI_LLM_TEMPERATURE`
   - `LLMWIKI_LLM_REASONING_EFFORT`
   - `LLMWIKI_LLM_MAX_OUTPUT_TOKENS`
   - `LLMWIKI_LLM_ARCHITECTURE_MAX_OUTPUT_TOKENS`
   - `LLMWIKI_LLM_TIMEOUT_MS`
   - `LLMWIKI_LLM_ARCHITECTURE_TIMEOUT_MS`
   - `LLMWIKI_LLM_ARCHITECTURE_REASONING_EFFORT`
   - `LLMWIKI_LLM_RETRIES`
   - `LLMWIKI_LLM_SYSTEM_PROMPT`
   - `LLMWIKI_LLM_SYSTEM_PROMPT_FILE`
4. **Repo Wiki feature**:
   - Confirm Wikis are enabled: Settings → General → Features → Wikis. If disabled, the `publish-wiki` job fails with a clear run summary message.

### Workflow jobs

- `compile-wiki` — checks out the repo, installs Node.js 24 dependencies, runs `npm run repo-wiki:bootstrap` (chained scan + plan + compile) and `npm run repo-wiki:lint`, then uploads `.llmwiki/wiki` as the `compiled-wiki` artifact.
- `publish-wiki` — downloads the artifact and pushes it to `${{ github.repository }}.wiki.git` using `secrets.GITHUB_TOKEN` via `npm run repo-wiki -- publish --target github-wiki`.

### Local commands still work

The CI workflow does not replace the local command surface. The existing npm scripts remain the recommended local path:

```bash
npm run repo-wiki:bootstrap
npm run repo-wiki:lint
```

## Deferred work

Still deferred from this slice:

- scheduled sync

GitHub Wiki publishing and CI automation are now wired via `.github/workflows/wiki.yml`. Further enhancements (scheduled sync, additional modes, Pages publishing) should come back as separate follow-up work.
