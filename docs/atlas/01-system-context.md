---
title: System context and architecture
status: snapshot
snapshot_date: 2026-11-19
---
<a id="01-system-context"></a>

## System context and architecture

dev-loops is a workflow toolchain that drives GitHub issues to reviewed, tested pull requests. The operator works through an agent harness (Claude Code, Pi or Codex). The harness loads skills and agent definitions, and every deterministic step runs as a Node script behind one CLI. The scripts depend on the shared package `@dev-loops/core`, and core never imports a script. GitHub is the system of record for issues, pull requests, review threads, CI and the queue board. The diagrams below are derived from the code in `cli/`, `lib/`, `scripts/`, `packages/core/src/`, `extension/`, `agents/`, `skills/` and `.claude/`. Every number names the shell command that produced it, run against the checkout on 2026-11-23.

<a id="d1"></a>

### System context

Type: `C4Context`

The operator, the agent roles, the three harnesses and the external systems around dev-loops. The insight: GitHub reads and writes go through the `gh` CLI that core wraps (`ghJson` in `gh.mjs`). The CLI reaches the npm registry only in the `doctor` stale-install check, and publishing runs in the `npm-publish.yml` workflow. Codex has no packaged plugin; core only detects it by environment. The agent box lists all 9 files in `agents/` (`ls agents`). Derived from `packages/core/src/loop/run-context.mjs` (`resolveRuntimeHarness`), `packages/core/src/github/gh.mjs`, `cli/index.mjs` (`fetchLatestPublishedVersion`, `buildStaleInstallChecks`), `.github/workflows/npm-publish.yml`, `agents/*.agent.md` and `package.json` (`pi` manifest).

```mermaid
C4Context
  title dev-loops system context
  Person(op, "Operator", "Starts loops, answers grills, approves merges")
  System_Boundary(h, "Agent harnesses") {
    System(cc, "Claude Code", "Plugin in .claude")
    System(pi, "Pi", "extension/index.ts")
    System(cx, "Codex", "Detected by CODEX_THREAD_ID")
  }
  System_Boundary(dl, "dev-loops") {
    System(agents, "Agent roles", "9 roles: dev-loop, developer, fixer, judge, review, gate-coordinator, refiner, docs, quality")
    System(tool, "CLI and scripts", "cli/index.mjs, scripts/")
    System(core, "@dev-loops/core", "Pure decisions and adapters")
  }
  System_Ext(gh, "GitHub", "Issues, PRs, threads, Actions, Projects board")
  System_Ext(cop, "Copilot reviewer", "Review bot on PRs")
  System_Ext(npm, "npm registry", "Package versions")
  Rel(op, cc, "Prompts, slash commands")
  Rel(op, pi, "Prompts, /dev-loops")
  Rel(cc, agents, "Loads")
  Rel(pi, agents, "Loads")
  Rel(cx, agents, "Loads")
  Rel(agents, tool, "Runs via Bash")
  Rel(tool, core, "Imports")
  Rel(core, gh, "gh CLI calls")
  Rel(cop, gh, "Posts reviews")
  Rel(tool, npm, "doctor stale-install check")
  Rel(gh, npm, "npm-publish workflow")
```

<a id="d2"></a>

### Deployment view

Type: `architecture-beta`

Where the code lives at run time. The insight: the Claude plugin ships without `scripts/`, `packages/core` or `node_modules`, so its launcher `dev-loops-run` must find a toolchain root (a live checkout or the auto-installed package) before any script runs. The Pi package instead loads `extension/`, `skills/` and `agents/` straight from the installed package. The hooks never call the launcher. They run on their own vendored copies of core modules. Derived from `.claude/bin/dev-loops-run`, `.claude/hooks/hooks.json`, `package.json` (`bin`, `pi`, `workspaces`) and `cli/index.mjs` (`isCoreResolvable`).

```mermaid
architecture-beta
  group plugin(cloud)[Claude plugin]
  group pkg(server)[Package or checkout]
  group cloudgh(internet)[GitHub]

  service hooks(server)[Hooks] in plugin
  service vend(disk)[Vendored core] in plugin
  service assets(server)[Skills and agents] in plugin
  service launcher(server)[dev loops run] in plugin
  service piext(server)[Pi extension] in pkg
  service cli(server)[CLI entry] in pkg
  service scripts(server)[Scripts] in pkg
  service core(database)[Core package] in pkg
  service repo(database)[Repo and PRs] in cloudgh
  service board(database)[Projects board] in cloudgh

  hooks:B --> T:vend
  assets:R --> L:launcher
  launcher:R --> L:cli
  piext:B --> T:cli
  cli:R --> L:scripts
  scripts:B --> T:core
  core:R --> L:repo
  core:B --> T:board
```

<a id="d3"></a>

### Layered stack

Type: `block-beta`

The runtime layers from the harness surfaces down to external tools. The insight: the stack is mostly top-down, with three known skips. The Pi extension imports seven core subpaths (`config`, `harness` and five `loop/*` modules) and one script module (`scripts/loop/inspect-run-viewer/managed-instance.mjs`), counted with `grep -hoE "from ['\"][^'\"]+['\"]" extension/*.ts extension/*.mjs`. `lib/dev-loops-core.mjs` dynamically imports `scripts/loop/print-gates.mjs`. The Claude hooks skip the launcher and use vendored core copies. Derived from `cli/index.mjs`, `lib/dev-loops-core.mjs`, `extension/index.ts`, `.claude/hooks/hooks.json` and `packages/core/package.json` (dependencies `yaml`, `zod`, `@secretlint/core`).

```mermaid
block-beta
  columns 3
  A["Claude commands, skills, agents"] B["Claude hooks"] C["Pi extension"]
  D["dev-loops-run launcher"]:2 E["lib/dev-loops-core.mjs"]
  F["cli/index.mjs namespace router"]:3
  G["scripts: github, loop, projects, refine, docs, release"]:3
  H["@dev-loops/core: loop, github, config, tracker, harness"]:3
  I["gh CLI"] J["git"] K["yaml, zod, secretlint"]
```

<a id="d4"></a>

### Top-level module graph

Type: `flowchart`

Import and generation edges between the top-level directories. The insight: `.claude/` is a generated tree. `scripts/claude/generate-claude-assets.mjs` writes it from `agents/`, `skills/`, `commands/` and nine vendored core modules, and `--check` fails on drift. Core has zero imports from `scripts/` (`grep -rlE "from ['\"]\.\./(\.\./)?scripts" packages/core/src | wc -l` gives 0). Only 2 of the 6 non-test skill scripts import core, `log-bash-exit-1.mjs` and `phase-files.mjs` (`grep -lE "@dev-loops/core" skills/dev-loop/scripts/*.mjs`); `post-gate-verdict-fallback.mjs` stays zero-dependency on purpose. Derived from `cli/index.mjs`, `lib/dev-loops-core.mjs`, `extension/index.ts`, `scripts/claude/generate-claude-assets.mjs` and `test/core-runtime-boundary.test.mjs`.

```mermaid
flowchart LR
  agentsDir["agents/"]
  skillsDir["skills/"]
  cmdDir["commands/"]
  gen["generate-claude-assets"]
  claudeDir[".claude/ (generated)"]
  ext["extension/"]
  lib["lib/"]
  cli["cli/"]
  scripts["scripts/"]
  core["packages/core/src"]
  agentsDir --> gen
  skillsDir --> gen
  cmdDir --> gen
  core -. "9 hook modules vendored" .-> gen
  gen --> claudeDir
  claudeDir -->|"dev-loops-run"| cli
  ext --> lib
  ext --> core
  ext -->|"inspect viewer"| scripts
  cli --> lib
  cli -->|"spawn route"| scripts
  lib -->|"print-gates"| scripts
  scripts --> core
  skillsDir -->|"2 of 6 skill scripts"| core
```

<a id="d5"></a>

### Scripts to core import flow

Type: `sankey-beta`

How many script files in each `scripts/` subdirectory import each `@dev-loops/core` area. A file counts once per area. Only flows of 3 or more files are shown. The insight: `scripts/loop` and `scripts/github` carry almost all core use, and they cross over heavily: 44 github scripts use core loop logic and 48 loop scripts use core github helpers. Counts come from `for f in $(find scripts -name '*.mjs'); do grep -oE "@dev-loops/core/[a-z-]+" $f | sort -u; done` grouped by subdirectory. Derived from `scripts/**/*.mjs` and `packages/core/package.json` (`exports`).

```mermaid
sankey-beta
scripts loop,core loop,69
scripts loop,core github,48
scripts loop,core config,39
scripts loop,core cli,5
scripts loop,core analysis,4
scripts loop,core harness,3
scripts github,core github,54
scripts github,core loop,44
scripts github,core config,19
scripts github,core cli,4
scripts github,core analysis,3
scripts projects,core projects,8
scripts projects,core github,8
scripts projects,core loop,6
scripts refine,core loop,5
scripts root,core cli,3
```

<a id="d6"></a>

### Dependencies inside core

Type: `flowchart`

Cross-directory imports inside `packages/core/src`. Edge labels give the number of files in the source directory that import the target directory. The insight: `loop` is the hub, and it has two-way edges with `github`, `config`, `claude` and `projects`. Core is a layered package by name only; its directories form import cycles. Counts come from `grep -oE "from ['\"]\.\./[a-z]+/"` per file under `packages/core/src`, grouped by source and target directory.

```mermaid
flowchart LR
  loop((loop))
  github[github]
  config[config]
  claude[claude]
  projects[projects]
  tracker[tracker]
  analysis[analysis]
  cli[cli]
  debt[debt]
  loop -->|15| github
  github -->|3| loop
  loop -->|5| analysis
  loop -->|3| config
  config -->|1| loop
  config -->|1| analysis
  loop -->|2| projects
  projects -->|1| loop
  loop -->|1| claude
  claude -->|2| loop
  claude -->|2| config
  loop -->|1| cli
  github -->|4| cli
  cli -->|1| github
  debt -->|1| github
  projects -->|3| github
  projects -->|2| cli
  tracker -->|1| github
  tracker -->|1| loop
  tracker -->|1| projects
  classDef hub fill:#fde68a,stroke:#b45309
  class loop hub
```

<a id="d7"></a>

### Core size by directory

Type: `xychart-beta`

Module count per `packages/core/src` directory. The insight: `loop` holds 84 of 132 core modules, almost two thirds of the package, so most deterministic workflow policy lives in one directory. Counts come from `find packages/core/src/<dir> -name '*.mjs' | wc -l`; the total comes from `find packages/core/src -name '*.mjs' | wc -l`, which also counts `bash-exit-one.mjs` at the root. Derived from `packages/core/src/`.

```mermaid
xychart-beta
  title "Core modules per directory"
  x-axis [loop, github, debt, harness, tracker, projects, claude, analysis, cli, config, security]
  y-axis "Modules" 0 --> 90
  bar [84, 18, 6, 5, 4, 4, 3, 2, 2, 2, 1]
```

<a id="d8"></a>

### Scripts tree

Type: `treemap-beta`

Script modules per `scripts/` subdirectory. The insight: `scripts/loop` (127) and `scripts/github` (94) hold 221 of 286 script modules. Counts come from `find scripts/<dir> -name '*.mjs' | wc -l`; the root count comes from `find scripts -maxdepth 1 -name '*.mjs' | wc -l`; the total comes from `find scripts -name '*.mjs' | wc -l`. Derived from `scripts/`.

```mermaid
treemap-beta
"scripts"
    "loop": 127
    "github": 94
    "projects": 12
    "lib": 12
    "refine": 12
    "docs": 8
    "root": 8
    "release": 6
    "claude": 3
    "pages": 3
    "security": 1
```

<a id="d9"></a>

### CLI namespaces

Type: `mindmap`

The nine CLI namespaces and the number of subcommands each one routes to a script. The insight: `loop` (34) and `gate` (18) are the main control surfaces, and `project` is `queue` minus the `run` driver, derived in code and not duplicated. Counts come from a Node one-liner that imports `SUBCOMMAND_ROUTES` from `cli/index.mjs` and prints `Object.keys(routes).length` per namespace. Derived from `cli/index.mjs` (`SUBCOMMAND_ROUTES`, `QUEUE_ROUTES`, `TOP_LEVEL_COMMANDS`).

```mermaid
mindmap
  root((dev-loops CLI))
    loop 34
      startup
      coordinator-work-order
      validation-record
    gate 18
      judge-pass
      consolidate-fanin
      resolve-validation
    queue 12
      run
      add, move, reorder
    project 11
      alias of queue minus run
    pr 7
      create always draft
    decision 1
    issue 2
    inspect 2
    refine 1
    top level
      help, status, doctor, gates, hide
```

<a id="d10"></a>

### Namespace to script directory routing

Type: `flowchart`

Which `scripts/` subdirectory each CLI namespace routes into, with the route count on each edge. The insight: the `gate` namespace splits across `scripts/github` (9) and `scripts/loop` (9), so a gate step can live in either directory, and the directory name does not predict the namespace. Counts come from the same Node one-liner over `SUBCOMMAND_ROUTES`, grouped by the second path segment of each route. Derived from `cli/index.mjs`.

```mermaid
flowchart LR
  gate[gate] -->|9| sg["scripts/github"]
  gate -->|9| sl["scripts/loop"]
  loopNs[loop] -->|32| sl
  loopNs -->|2| sg
  pr[pr] -->|7| sg
  decision[decision] -->|1| sg
  issue[issue] -->|2| sg
  queue[queue] -->|11| sp["scripts/projects"]
  queue -->|1| sl
  project[project] -->|11| sp
  inspect[inspect] -->|2| sl
  refine[refine] -->|1| sr["scripts/refine"]
```

<a id="d11"></a>

### One CLI call under Claude Code

Type: `sequenceDiagram`

The path of one routed command from an agent Bash call to GitHub. The insight: the harness asks the PreToolUse hooks first (the approval guard and the Bash gate), and each returns allow or deny before any script runs. The hooks do not start the launcher; the harness runs the command after an allow. The hooks work using core logic vendored into `.claude/hooks/`, because the hook cannot resolve `@dev-loops/core` from the plugin cache. Derived from `.claude/hooks/hooks.json`, `.claude/hooks/pre-tool-use-bash-gate.mjs`, `.claude/bin/dev-loops-run`, `cli/index.mjs` and `packages/core/src/github/gh.mjs`.

```mermaid
sequenceDiagram
  autonumber
  participant A as Agent
  participant X as Claude Code
  participant H as Approval guard and Bash gate hooks
  participant L as dev-loops-run
  participant C as cli/index.mjs
  participant S as scripts/loop script
  participant K as @dev-loops/core
  participant G as GitHub
  A->>X: Bash dev-loops-run ... loop startup
  X->>H: PreToolUse event
  H->>H: classify command, check deny rules
  alt denied
    H-->>X: deny with reason
    X-->>A: tool call refused
  else allowed
    H-->>X: allow
    X->>L: run the Bash command
    L->>L: resolve toolchain root
    L->>C: node cli/index.mjs loop startup
    C->>C: isCoreResolvable()
    C->>S: spawn routed script
    S->>K: import decisions and gh wrapper
    K->>G: gh api / gh pr view
    G-->>K: JSON
    K-->>S: typed state
    S-->>X: JSON on stdout
    X-->>A: tool result
  end
```

<a id="d12"></a>

### Toolchain root and harness resolution

Type: `flowchart`

Two deterministic resolvers. The launcher picks the toolchain root in a fixed order with no version comparison. `resolveRuntimeHarness` picks the harness from environment markers, and Pi is the fallback. The insight: a live checkout always wins over an installed package, so the operator's local edits run without a release. Derived from `.claude/bin/dev-loops-run` and `packages/core/src/loop/run-context.mjs`.

```mermaid
flowchart TD
  subgraph launcher["dev-loops-run"]
    s1{"checkout above cwd?"} -->|yes| useCwd["use that checkout"]
    s1 -->|no| s2{"checkout above own real path?"}
    s2 -->|yes| useBin["use that checkout"]
    s2 -->|no| s3{"plugin node_modules/dev-loops?"}
    s3 -->|yes| usePkg["use installed package"]
    s3 -->|no| stop["exit 3, hard stop"]
  end
  subgraph harness["resolveRuntimeHarness"]
    h1{"Claude marker env = 1?"} -->|yes| hc["claude"]
    h1 -->|no| h2{"CODEX_THREAD_ID set?"}
    h2 -->|yes| hx["codex"]
    h2 -->|no| hp["pi"]
  end
```

<a id="d13"></a>

### Adapter contracts

Type: `classDiagram`

The two adapter seams in core. `createHarnessAdapter` and `createTrackerAdapter` validate the required methods and freeze the object. The insight: the tracker contract splits a required Issues group from an optional Board group, so a tracker without a board stays valid. GitHub is the only registered tracker provider (`BUILTIN_PROVIDERS` in `tracker/index.mjs`). Other providers, such as Jira, are spec-only: Jira appears only in a doc comment. The class names stand for factory functions (`createPiAdapter`, `createExtensionHarnessAdapter`, `createNoopAdapter`, `createGithubTrackerAdapter`, `createNoopTrackerAdapter`); core defines no classes for them. Derived from `packages/core/src/harness/adapter.mjs`, `packages/core/src/harness/index.mjs`, `packages/core/src/tracker/adapter.mjs` and `packages/core/src/tracker/index.mjs`.

```mermaid
classDiagram
  class HarnessAdapter {
    <<interface>>
    +getCwd()
    +getEnv()
    +isInteractive()
    +isInsidePi()
    +getRepoRoot()
  }
  class TrackerIssues {
    <<interface>>
    +parseRef()
    +getIssue()
    +createIssue()
    +editIssue()
    +commentIssue()
    +listIssues()
    +detectLinkedPr()
  }
  class TrackerBoard {
    <<optional>>
    +ensureBoard()
    +listQueueItems()
    +addQueueItem()
    +setItemStatus()
    +reorderItem()
    +archiveItems()
  }
  class PiAdapter
  class ExtensionHarnessAdapter
  class NoopAdapter
  class GithubTrackerAdapter
  class NoopTrackerAdapter
  class JiraAdapter {
    spec-only
  }
  HarnessAdapter <|.. PiAdapter
  HarnessAdapter <|.. ExtensionHarnessAdapter
  HarnessAdapter <|.. NoopAdapter
  TrackerIssues <|.. GithubTrackerAdapter
  TrackerBoard <|.. GithubTrackerAdapter
  TrackerIssues <|.. NoopTrackerAdapter
  TrackerBoard <|.. NoopTrackerAdapter
  TrackerIssues <|.. JiraAdapter
```

<a id="d14"></a>

### Claude hook bundle

Type: `flowchart`

The eight Claude Code hook entry files, the event that triggers each one, and the local modules each imports. The insight: every hook entry reaches core policy only through `_`-prefixed sibling files, and 9 of those are generated copies of core modules (the `HOOK_BUNDLE` list). `_hook-io.mjs` and `_fixer-grants.mjs` are hand-authored. The count 9 comes from reading the `HOOK_BUNDLE` array in `generate-claude-assets.mjs` (9 `source` entries). The edges come from `grep -oE "from \"\./_[a-z-]+\.mjs\""` per hook file. Derived from `.claude/hooks/hooks.json`, `.claude/hooks/*.mjs` and `scripts/claude/generate-claude-assets.mjs`.

```mermaid
flowchart LR
  subgraph events["hooks.json events"]
    eTools["PreToolUse Bash, Read, Edit, Write, Grep, Glob, MCP"]
    eAsk["PreToolUse AskUserQuestion"]
    eBash["PreToolUse Bash"]
    eWrite["PreToolUse Edit or Write"]
    eAgent["PreToolUse Agent or Task"]
    ePostAsk["PostToolUse AskUserQuestion"]
    ePost["PostToolUse Bash"]
    eStop["SubagentStop"]
  end
  subgraph entries["hook entry files"]
    approvalGuard["approval-guard"]
    askAnswers["ask-answers-guard"]
    bashGate["bash-gate"]
    writeGuard["write-guard"]
    agentGuard["agent-guard"]
    askApproval["post-tool-use-ask-approval"]
    merge["post-tool-use-merge"]
    stopGuard["uncommitted-guard"]
  end
  subgraph hand["hand-authored"]
    io["_hook-io"]
    grants["_fixer-grants"]
  end
  subgraph vendored["vendored from core"]
    decisions["_hook-decisions"]
    classify["_bash-command-classify"]
    gateDec["_bash-gate-decisions"]
    runCtx["_run-context"]
    wtGuard["_worktree-guard"]
    ff["_main-checkout-ff"]
    digest["_work-order-digest"]
    retire["_gate-round-retirement"]
    askMerge["_ask-merge-approval"]
  end
  eTools --> approvalGuard
  eAsk --> askAnswers
  eBash --> bashGate
  eWrite --> writeGuard
  eAgent --> agentGuard
  ePostAsk --> askApproval
  ePost --> merge
  eStop --> stopGuard
  entries -->|"all 8"| io
  approvalGuard --> askMerge
  askAnswers --> askMerge
  askApproval --> askMerge
  bashGate --> decisions
  bashGate --> classify
  bashGate --> grants
  writeGuard --> decisions
  writeGuard --> grants
  writeGuard --> wtGuard
  agentGuard --> decisions
  agentGuard --> grants
  merge --> classify
  merge --> ff
  merge --> wtGuard
  stopGuard --> decisions
  decisions --> gateDec
  decisions --> runCtx
  decisions --> digest
  decisions --> wtGuard
  gateDec --> classify
  grants --> decisions
  grants --> digest
  grants --> retire
  grants --> wtGuard
```

