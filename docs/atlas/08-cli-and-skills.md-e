---
title: CLI, skills and commands
status: snapshot
snapshot_date: 2026-11-23
source_commit: f6619004d3edc2caccc98edd96914a5706c5d59b
---
<a id="08-cli-and-skills"></a>

## CLI, skills and commands

dev-loops exposes one npm binary, `dev-loops`, whose entry `cli/index.mjs` is a thin router (`package.json` `bin`). A few top-level actions (`help`, `status`, `doctor`, `gates`, `hide`, and the `inspect` viewer lifecycle) run in-process through `executeDevLoopsCommand` in `lib/dev-loops-core.mjs`. Every other call is a `<namespace> <subcommand>` pair that the static table `SUBCOMMAND_ROUTES` maps to one script under `scripts/`, which then runs as a child `node` process. On top of the CLI sit 11 slash commands in `commands/` (`ls commands | wc -l`), 8 skills in `skills/` plus the shared `skills/docs` folder (`ls skills | wc -l` prints 9, and one entry is `docs`), and 9 agent definitions in `agents/` (`ls agents | wc -l`). `skills/docs` holds 48 files (`ls skills/docs | wc -l`): 47 Markdown contracts (`ls skills/docs/*.md | wc -l`) and `required-rules.json`. The source files call `node <dev-loops-package-root>/cli/index.mjs`. The generator `scripts/claude/generate-claude-assets.mjs` rewrites that call to the `dev-loops-run` launcher form for the Claude Code plugin copies under `.claude/`. The diagrams below follow a request from the operator's slash command down to the script that does the work, and then cover the local inspect-run viewer.

<a id="d100"></a>

### Command tree

Type: `flowchart`

The `dev-loops` command tree as `parseTopLevelCommand` resolves it. In-process actions sit on top. The routed namespaces follow, each with representative subcommands and the script each one runs. `project` is the `queue` table with `run` removed (derived in code with a rest destructure, no table of its own), and `pr create-draft` is the only deprecated alias. `--version` and `--help` are handled before any table lookup. Derived from `cli/index.mjs` (`TOP_LEVEL_COMMANDS`, `INSPECT_LIFECYCLE_DESCRIPTIONS`, `QUEUE_ROUTES`, `PROJECT_ROUTES`, `SUBCOMMAND_ROUTES`, `SUBCOMMAND_ALIASES`).

```mermaid
flowchart LR
  root["dev-loops"]
  root --> top["in-process actions"]
  top --> help & status & doctor & gates & hide
  top --> insp_l["inspect open | resume | status | stop | restart"]
  root --> gate
  root --> loop
  root --> pr
  root --> decision
  root --> issue
  root --> queue
  root --> project
  root --> inspect
  root --> refine
  gate --> g1["upsert-verdict"] --> s1["scripts/github/upsert-checkpoint-verdict.mjs"]
  gate --> g2["judge-pass"] --> s2["scripts/loop/judge-pass.mjs"]
  gate --> g3["resolve-role"] --> s3["scripts/loop/resolve-reviewer-role.mjs"]
  gate --> g4["wait-for-units"] --> s4["scripts/loop/wait-for-gate-units.mjs"]
  loop --> l1["startup"] --> s5["scripts/loop/resolve-dev-loop-startup.mjs"]
  loop --> l2["build-envelope"] --> s6["scripts/loop/build-handoff-envelope.mjs"]
  loop --> l3["info"] --> s7["scripts/loop/info.mjs"]
  loop --> l4["validation-record"] --> s8["scripts/loop/validation-record.mjs"]
  pr --> p1["create"] --> s9["scripts/github/create-pr.mjs"]
  pr --> p2["ready-for-review"] --> s10["scripts/github/ready-for-review.mjs"]
  pr -.->|"alias, deprecated"| p3["create-draft"] -.-> p1
  decision --> d1["record"] --> s17["scripts/github/record-operator-decision.mjs"]
  issue --> i1["create | edit"] --> s11["scripts/github/create-issue.mjs, edit-issue.mjs"]
  queue --> q1["run"] --> s12["scripts/loop/run-queue.mjs"]
  queue --> q2["add | list | move | reconcile ..."] --> s13["scripts/projects/*.mjs"]
  project -.->|"queue minus run"| q2
  inspect --> v1["run"] --> s14["scripts/loop/inspect-run.mjs"]
  inspect --> v2["viewer"] --> s15["scripts/loop/inspect-run-viewer.mjs"]
  refine --> r1["verify"] --> s16["scripts/refine/verify.mjs"]
```

<a id="d101"></a>

### Subcommands per namespace

Type: `xychart-beta`

The number of routed subcommands in each namespace. `loop` (34) and `gate` (18) hold most of the surface, so the CLI is mainly a toolbox for the coordinator agents, with few commands meant for the operator. Counts come from an `awk` scan of each table in `cli/index.mjs` (`awk '/^ loop: \{/,/^ \},?/' cli/index.mjs | grep -c '\.mjs"'` and the same scan for `gate`, `pr`, `issue`, `inspect` and `refine`). `decision` (1) is a one-line table, so its count is read directly. The `queue` count (12) is the number of keys in `QUEUE_ROUTES`, and `project` (11) is that table minus `run`. `inspect` shows only its 2 routed subcommands; it also has 5 in-process lifecycle actions. Derived from `cli/index.mjs`.

```mermaid
xychart-beta
  title "Routed subcommands per namespace"
  x-axis [loop, gate, queue, project, pr, issue, inspect, refine, decision]
  y-axis "subcommands" 0 --> 35
  bar [34, 18, 12, 11, 7, 2, 2, 1, 1]
```

<a id="d102"></a>

### Routed scripts by directory

Type: `pie`

Where the 77 distinct routed scripts live. `scripts/loop` holds more than half of them, and `scripts/github` holds the GitHub wrappers that gate and PR commands call. The `project` namespace adds no scripts, because it reuses the `queue` entries. Counts come from `sed -n 248,359p cli/index.mjs | grep -oE '"scripts/[a-z]+/' | sort | uniq -c` (44, 21, 11, 1) and the distinct total from the same range piped through `grep -oE '"scripts/[^"]+"' | sort -u | wc -l` (77). Slash commands also call a few unrouted scripts directly, such as `scripts/github/view-issue.mjs` and `scripts/refine/scaffold-spike-file.mjs`; the chart leaves them out. Derived from `cli/index.mjs`.

```mermaid
pie showData
  title Routed scripts per scripts/ subfolder
  "scripts/loop" : 44
  "scripts/github" : 21
  "scripts/projects" : 11
  "scripts/refine" : 1
```

<a id="d103"></a>

### How runCli dispatches one call

Type: `flowchart`

The decision path inside `runCli`. First, it delegates `gate`, `loop` and `pr` calls to a different source checkout when the working directory sits inside one (`CLI-CHECKOUT-DELEGATION`); it prints a skew line only when the versions differ. Second, it parses the arguments. Third, it refuses with one plain error line when `@dev-loops/core` cannot be resolved, because the deps-less plugin checkout has no `node_modules`. That check runs for every routed subcommand and subcommand help, and for the `gates` and `inspect` actions; `help`, `status` and `doctor` stay core-free. Last, it spawns the routed script with piped stdio, except `claude-launch`, which inherits the terminal while the wrapper ignores SIGINT. Derived from `cli/index.mjs` (`delegateToCheckout`, `findSkewedCheckout`, `isCoreResolvable`, `parseTopLevelCommand`, `INHERIT_STDIO_SCRIPTS`, `SPAWN_MAX_BUFFER`).

```mermaid
flowchart TD
  A["argv"] --> B{"category in gate, loop, pr<br/>and not already delegated?"}
  B -- yes --> C{"cwd inside another<br/>dev-loops checkout?"}
  C -- yes --> D["spawn checkout cli/index.mjs<br/>with DEVLOOPS_CHECKOUT_DELEGATED=1"]
  C -- no --> E
  B -- no --> E["parseTopLevelCommand"]
  E --> K{"kind"}
  K -- "help / version / category_help" --> H["print, exit 0"]
  K -- "action" --> AC{"gates or inspect<br/>and core missing?"}
  AC -- yes --> RE
  AC -- no --> X["executeDevLoopsCommand<br/>in lib/dev-loops-core.mjs"]
  K -- "subcommand / subcommand_help" --> R{"core resolvable?"}
  R -- no --> RE["one-line error, exit 1"]
  R -- yes --> S{"script is claude-launch?"}
  S -- yes --> SI["spawn node, stdio inherit"]
  S -- no --> SP["spawn node, piped stdio<br/>64 MiB buffer"]
  SP --> O{"spawn error?"}
  O -- "ENOBUFS" --> OE["child_output_too_large, exit 1"]
  O -- "other" --> OF["subcommand_spawn_failed, exit 1"]
  O -- no --> OK["forward stdout, stderr, exit status"]
  K -- "malformed" --> M["message + help, exit 1"]
```

<a id="d104"></a>

### dev-loops-run toolchain resolution

Type: `flowchart`

How the Claude Code plugin launcher picks the toolchain root. The plugin ships without `scripts/`, `packages/core` or `node_modules`, so every generated command, skill and agent calls through this launcher. A checkout is a directory whose `package.json` names `dev-loops` and that has a `scripts/` folder. The launcher never compares versions: a live source checkout always wins, so the operator's local edits run without a reinstall. `--repo-root` acts like `cd <checkout> &&` (ADR 0117). The launcher also refuses a script path that is absolute or contains `..`. Derived from `.claude/bin/dev-loops-run`.

```mermaid
flowchart TD
  A["dev-loops-run [--repo-root dir] path args"] --> V{"--repo-root given<br/>and not a directory?"}
  V -- yes --> E2["exit 2"]
  V -- no --> B{"checkout found walking<br/>up from cwd or --repo-root?"}
  B -- yes --> P
  B -- no --> C{"checkout found walking up<br/>from the launcher's real path?"}
  C -- yes --> P
  C -- no --> D{"pluginRoot/node_modules/dev-loops<br/>exists?"}
  D -- yes --> P
  D -- no --> STOP["hard stop, exit 3"]
  P{"path escapes the root?"} -- yes --> E2
  P -- no --> RUN["spawn node path, stdio inherit,<br/>forward exit status"]
```

<a id="d105"></a>

### Slash command to skill and CLI

Type: `flowchart`

Where each of the 11 slash commands lands. Five commands hand a public intent to the `dev-loop` skill. Only `/loop-start`, `/loop-auto` and `/loop-continue` first run `gate resolve-role --role dev-loop --harness claude` in the main session to choose the coordinator model. `/loop-continue` without an argument first picks the target with `resolve-active-board-item.mjs`. `/loop-start-spike` scaffolds a findings file and runs the startup resolver with `--spike`. The other commands go straight to a narrower skill, a CLI subcommand, or a `scripts/` wrapper, and `/loop-status` runs only shell checks. Derived from `commands/*.command.md` (generated as `.claude/commands/*.md`).

```mermaid
flowchart LR
  subgraph cmds["commands/"]
    ls1["/loop-start"]
    la["/loop-auto"]
    lc["/loop-continue"]
    lru["/loop-review-ui"]
    lsp["/loop-start-spike"]
    lr["/loop-review"]
    lg["/loop-grill"]
    li["/loop-info"]
    lq["/loop-queue-status"]
    le["/loop-enqueue"]
    lst["/loop-status"]
  end
  RR["gate resolve-role"]
  DL["skill dev-loop"]
  ls1 & la --> RR
  lc -->|"no argument"| RAB["resolve-active-board-item.mjs"] --> RR
  lc -->|"issue or PR"| RR
  RR --> DL
  lru --> DL
  lsp --> SC["scaffold-spike-file.mjs"] -->|"startup --spike"| DL
  lr --> RV["skill review"]
  lg --> GR["skill loop-grill"] --> IE["issue edit + comment-issue.mjs"]
  li --> INFO["loop info"]
  lq --> LQ["list-queue-items.mjs --summary"]
  le --> AQ["add-queue-item.mjs"]
  le -->|"freeform text"| CI["create-issue.mjs"] --> GR
  lst --> SH["gh, git and subagent checks"]
```

<a id="d106"></a>

### Skill map

Type: `mindmap`

The skills tree. `dev-loop` is the only public entry. It loads a route pack only after the startup resolver has chosen `selectedStrategy`. The route table lists 8 strategies. The code enum `INTERNAL_DEV_LOOP_STRATEGY` also has `ui_review`, which the route table does not list; the `ui-review` pack is reached through the `/loop-review-ui` intent. `final-approval` is a stub, because its procedure now lives in `copilot-pr-followup`. `review`, `loop-grill` and `pi-session-audit` are standalone and run outside the gate lifecycle. `pi-session-audit` is not copied to `.claude/skills`. Derived from `skills/*/SKILL.md` (frontmatter and the route table in `skills/dev-loop/SKILL.md`), `packages/core/src/loop/public-dev-loop-routing-contract.mjs`, `ls skills/dev-loop` and `ls .claude/skills`.

```mermaid
mindmap
  root((skills))
    dev-loop
      public entry
      route table
        local_implementation
        issue_intake
        copilot_pr_followup
        external_pr_followup
        reviewer_fixer
        wait_watch
        final_approval
        review
      enum only
        ui_review
      templates and scripts folders
    Routed packs
      local-implementation
      copilot-pr-followup
      final-approval stub
      ui-review
    Standalone
      review
      loop-grill
      pi-session-audit
    docs
      48 files
      main-agent-contract
      workflow-handoff-contract
      contract-style-guide
```

<a id="d107"></a>

### From /loop-start to a route pack

Type: `sequenceDiagram`

One `/loop-start` call under Claude Code. The main session only picks the model and dispatches. It does not run the startup resolver, gate, fixer or reviewer steps. The `dev-loop` coordinator calls every CLI step through `dev-loops-run`. It loads only the files the handoff envelope lists in `requiredReads`, and no route pack before the resolver selects one. Derived from `.claude/commands/loop-start.md`, `skills/dev-loop/SKILL.md`, `agents/dev-loop.agent.md`, `.claude/bin/dev-loops-run`, and the `loop` and `gate` tables in `cli/index.mjs`.

```mermaid
sequenceDiagram
  actor Op as Operator
  participant Main as Main session
  participant Agent as dev-loop agent
  participant Run as dev-loops-run
  participant CLI as cli/index.mjs
  participant Script as scripts/loop
  Op->>Main: /loop-start 123
  Main->>Run: cli/index.mjs gate resolve-role --role dev-loop --harness claude
  Run->>CLI: resolved toolchain root
  CLI->>Script: resolve-reviewer-role.mjs
  Script-->>Main: model for dispatch
  Main->>Agent: dispatch with intent
  Agent->>Run: cli/index.mjs loop startup --issue 123
  Run->>CLI: resolved toolchain root
  CLI->>Script: resolve-dev-loop-startup.mjs
  Script-->>Agent: selectedStrategy and state bundle
  Agent->>Run: cli/index.mjs loop build-envelope --input file
  Run->>CLI: route
  CLI->>Script: build-handoff-envelope.mjs
  Script-->>Agent: requiredReads, nextAction, stopRules
  Agent->>Agent: load only the selected route pack
  Agent-->>Main: hand-back
  Main-->>Op: status and needed decision
```

<a id="d108"></a>

### Operator journey

Type: `journey`

What the operator does in the CLI and slash-command layer, from setup to merge approval. The scores are synthetic and only illustrate friction. No command produced them. Low scores mark the steps where the code says the operator still acts by hand: diagnosing a stale install and approving the merge. Derived from `cli/index.mjs` (`status`, `doctor`, `buildStaleInstallChecks`), `commands/loop-enqueue.command.md`, `commands/loop-queue-status.command.md`, `commands/loop-info.command.md`, `commands/loop-auto.command.md` and `INSPECT_LIFECYCLE_DESCRIPTIONS`.

```mermaid
journey
  title Operator using dev-loops
  section Setup
    Run dev-loops status: 4: Operator
    Run dev-loops doctor for stale install: 2: Operator
  section Queue work
    loop-enqueue an issue: 4: Operator
    loop-queue-status board view: 5: Operator
  section Run
    loop-auto on the issue: 4: Operator
    loop-info to check state: 4: Operator
    dev-loops inspect open viewer: 3: Operator
  section Finish
    Approve merge at checkpoint: 2: Operator
```

<a id="d109"></a>

### Coordinator agent journey

Type: `journey`

The same layer from the `dev-loop` coordinator agent's side. The scores are synthetic and illustrate the effort per step. No command produced them. The agent spends most of its effort on CLI calls through `dev-loops-run`, and its reading is limited to what the envelope lists. Every step name is a real route in the `loop`, `gate` or `pr` table. Derived from `skills/dev-loop/SKILL.md`, `agents/dev-loop.agent.md`, and the `loop`, `gate` and `pr` tables in `cli/index.mjs`.

```mermaid
journey
  title dev-loop coordinator agent
  section Startup
    loop startup resolves state: 5: Coordinator
    loop build-envelope: 5: Coordinator
    Read only requiredReads: 4: Coordinator
  section Work
    loop ensure-worktree: 4: Coordinator
    Dispatch developer or fixer: 3: Coordinator
    loop validation-record: 3: Coordinator
  section Gate
    pr create as draft: 4: Coordinator
    gate wait-for-units: 3: Coordinator
    gate judge-pass: 4: Coordinator
    pr ready-for-review: 5: Coordinator
```

<a id="d110"></a>

### Packaging surfaces

Type: `block-beta`

The three ways the same toolchain reaches a user. The npm package ships the `dev-loops` binary with all of `scripts/`. The Claude Code plugin ships generated commands, skills, agents, hooks and the launcher, and resolves `scripts/` through `dev-loops-run`. The Pi extension registers one `dev-loops` command through its adapter. The in-process actions of the CLI and the Pi command both call the shared executor in `lib/dev-loops-core.mjs`; routed subcommands bypass it and spawn their script. Derived from `package.json` (`bin`), the `.claude/` directory listing, `.claude/hooks/hooks.json`, `cli/index.mjs` and `extension/index.ts`.

```mermaid
block-beta
  columns 3
  npm["npm bin dev-loops"] claude["Claude Code plugin"] pi["Pi extension"]
  cli["cli/index.mjs"] cc["commands, skills, agents"] ext["registerCommand dev-loops"]
  scripts["scripts/ routed"] hooks["hooks: PreToolUse, PostToolUse, SubagentStop"] adapter["pi-extension-adapter.ts"]
  space launcher["bin/dev-loops-run"] space
  core["lib/dev-loops-core.mjs shared executor"]:3
```

<a id="d111"></a>

### Inspect viewer lifecycle

Type: `stateDiagram-v2`

The states the managed viewer record can report, and the in-process `inspect` actions that move between them. `open` reuses a running viewer only when it can serve the requested repo; otherwise it stops that viewer and starts a fresh one. Before a fresh start, the manager checks the port and never signals a listener there, because only the managed record PID proves ownership. It reports `conflict_unmanaged_listener` when any other listener holds the port. A managed process that ignores SIGTERM leaves the record in `stale_record`. An unreadable record also counts as `stale_record`. `restart` reuses the recorded repo arguments. Derived from `scripts/loop/inspect-run-viewer/managed-instance.mjs` (`inspectRecord`, `startFresh`, `createInspectRunViewerLifecycleManager`) and `INSPECT_LIFECYCLE_DESCRIPTIONS` in `cli/index.mjs`.

```mermaid
stateDiagram-v2
  [*] --> stopped
  stopped --> running: open or restart, port free
  stopped --> conflict_unmanaged_listener: other listener on the port
  conflict_unmanaged_listener --> running: open after listener exits
  running --> running: open or resume, same repo
  running --> running: open other repo, stop then start
  running --> running: restart
  running --> stopped: stop
  running --> stale_record: process gone or healthz fails
  running --> stale_record: stop, SIGTERM ignored
  stale_record --> stopped: stop clears record
  stale_record --> running: open or restart starts fresh
```

<a id="d112"></a>

### Inspect viewer HTTP surface

Type: `sequenceDiagram`

The routes the local viewer server answers. `/healthz` answers from memory and never calls `gh`; the managed launcher polls it. The page and the JSON and fragment routes take the target from their own `?repo=&pr=` query. The envelope routes run the startup resolver with `--no-reconcile`, so the viewer stays read-only. Any other path gets 404, and a non-GET method gets 405. The viewer binds to `127.0.0.1` by default, refuses a non-loopback `--host` unless `--allow-non-localhost` is set, and rejects a `--pr` flag. Derived from `scripts/loop/inspect-run-viewer/server.mjs`, `scripts/loop/inspect-run-viewer/cli.mjs` and `scripts/loop/inspect-run-viewer/constants.mjs`. The repo and PR values are synthetic.

```mermaid
sequenceDiagram
  participant B as Browser
  participant S as Viewer server
  participant C as Inspection adapter
  participant R as Startup resolver
  B->>S: GET /healthz
  S-->>B: 200 ok
  B->>S: GET /?repo=o/r&pr=7
  S->>C: snapshot and assigned PR inbox
  C-->>S: data
  S-->>B: HTML page
  B->>S: GET /assets/inspect-graph.mjs
  S-->>B: graph module
  B->>S: GET /snapshot.json?repo=o/r&pr=7
  S->>C: compose run inspection snapshot
  C-->>S: snapshot
  S-->>B: JSON
  B->>S: GET /handoff-envelope.json or .html
  S->>R: resolve-dev-loop-startup --pr 7 --no-reconcile
  R-->>S: bundle
  S-->>B: envelope JSON or fragment
  B->>S: GET /round-metrics.html
  S-->>B: metrics fragment
  B->>S: POST / or GET /other
  S-->>B: 405 or 404
```

