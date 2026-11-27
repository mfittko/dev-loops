---
title: External integrations and adapters
status: snapshot
snapshot_date: 2026-11-23
source_commit: f6619004d3edc2caccc98edd96914a5706c5d59b
---
<a id="06-integrations"></a>

## External integrations and adapters

dev-loops reaches the outside world through a small set of seams. GitHub is reached through the `gh` CLI, as REST calls (`gh api`, `gh pr`, `gh issue`) and GraphQL calls (`gh api graphql`), and most of those calls go through one child-process primitive, `runChild`. Copilot is a GitHub reviewer that the loop requests, probes and withdraws through the same `gh` seam. Three agent harnesses run the loop: Pi (the native extension host), Claude Code (agents, skills, commands and hooks in a plugin generated from the Pi sources) and Codex (detected, configured and evidenced, with no launcher of its own in core). Two frozen adapter interfaces in `packages/core/src/harness` keep call sites harness-agnostic, and a tracker adapter in `packages/core/src/tracker` keeps issue access provider-agnostic.

<a id="d72"></a>

### Integration landscape

Type: `flowchart`

The diagram shows each external system and the module family that reaches it. The insight is that GitHub and Copilot share one exit point, the `gh` binary, and most callers spawn it through `runChild` in `packages/core/src/cli/primitives.mjs`, so auth, rate limits and test doubles are handled at one seam. `grep -l runChild scripts/github/*.mjs | wc -l` gives 48 scripts and `grep -lE 'github/gh(\.mjs)?"' scripts/github/*.mjs | wc -l` gives 15 scripts that import the `gh.mjs` helpers. Derived from `packages/core/src/cli/primitives.mjs`, `packages/core/src/github/gh.mjs`, `packages/core/src/github/issue-ops.mjs`, `packages/core/src/tracker/github-adapter.mjs`, `scripts/github/request-copilot-review.mjs`, `scripts/claude/headless-dev-loop.mjs`, `extension/pi-extension-adapter.ts` and `packages/core/src/loop/codex-execution-evidence.mjs`.

```mermaid
flowchart LR
  subgraph core["@dev-loops/core"]
    RC["cli/primitives runChild"]
    GH["github/gh.mjs"]
    IO["github/issue-ops"]
    TR["tracker adapter"]
    HA["harness adapters"]
    CX["codex-execution-evidence"]
    CL["claude/headless-entry"]
  end
  SC["scripts/github/*.mjs"]
  EXT["extension/ (Pi)"]
  HD["scripts/claude/headless-dev-loop"]
  HOOKS[".claude/hooks"]
  SC --> GH
  SC --> RC
  TR --> IO
  IO --> RC
  GH --> RC
  RC -->|"spawn gh"| GHCLI(("gh CLI"))
  GHCLI -->|"REST"| GHAPI["GitHub API"]
  GHCLI -->|"GraphQL"| GHAPI
  GHAPI --> COP["Copilot reviewer"]
  EXT --> HA
  HA -->|"pi.exec bash -lc"| PI["Pi harness"]
  HD --> CL
  HD -->|"claude -p"| CC["Claude Code"]
  CC --> HOOKS
  CX -->|"read journal"| CODEX["Codex session store"]
```

<a id="d73"></a>

### Harness adapter interfaces

Type: `classDiagram`

The diagram shows the two harness seams and their concrete factories. `HarnessAdapter` answers "where am I running"; `ExtensionHarnessAdapter` answers "how do I talk to the harness". Both factories check a `REQUIRED_METHODS` list and return a frozen object. The only `ExtensionHarnessAdapter` implementation is the Pi one: `git grep -l createExtensionHarnessAdapter` finds no other caller. A Claude implementation is named only in code comments, so it is marked spec-only. Derived from `packages/core/src/harness/adapter.mjs`, `packages/core/src/harness/extension-adapter.mjs`, `packages/core/src/harness/pi-adapter.mjs`, `packages/core/src/harness/noop-adapter.mjs`, `packages/core/src/harness/index.mjs` and `extension/pi-extension-adapter.ts`.

```mermaid
classDiagram
  class HarnessAdapter {
    <<interface>>
    +getCwd() string
    +getEnv() Env
    +isInteractive() boolean
    +isInsidePi() boolean
    +getRepoRoot() string
  }
  class ExtensionHarnessAdapter {
    <<interface>>
    +exec(command, options) HarnessExecResult
    +on(event, handler) void
    +registerCommand(name, config) void
  }
  class HarnessLifecycleEvent {
    <<enumeration>>
    session_start
    session_shutdown
    tool_result
    user_bash
    agent_end
    tool_call
  }
  class HarnessContext {
    +cwd string
    +hasUI boolean
    +ui HarnessUi
    +sendUserMessage() optional
    +getSystemPrompt() optional
    +getSessionId() optional
  }
  class PiAdapter {
    +createPiAdapter(cwd, env)
  }
  class NoopAdapter {
    +createNoopAdapter(cwd, env)
  }
  class PiExtensionAdapter {
    +createPiExtensionAdapter(pi)
    +toHarnessContext(ctx)
  }
  class ClaudeExtensionAdapter {
    <<spec-only>>
  }
  HarnessAdapter <|.. PiAdapter
  HarnessAdapter <|.. NoopAdapter
  ExtensionHarnessAdapter <|.. PiExtensionAdapter
  ExtensionHarnessAdapter <|.. ClaudeExtensionAdapter
  ExtensionHarnessAdapter ..> HarnessLifecycleEvent : on()
  ExtensionHarnessAdapter ..> HarnessContext : passes to handlers
```

<a id="d74"></a>

### Pi command dispatch through the extension seam

Type: `sequenceDiagram`

The diagram shows how a Pi slash command reaches dev-loops code. `pi-extension-adapter.ts` is the only module allowed to import the Pi SDK. It converts each Pi `ExtensionContext` into a neutral `HarnessContext` at call time, so the rest of the extension never sees a Pi type. `exec` runs every command as `bash -lc` with the caller's cwd and timeout. Derived from `extension/pi-extension-adapter.ts`, `extension/harness-types.ts` and `packages/core/src/harness/extension-adapter.mjs`.

```mermaid
sequenceDiagram
  participant Ext as extension/index.ts
  participant Ad as PiExtensionAdapter
  participant Pi as Pi ExtensionAPI
  participant Op as Operator
  Ext->>Ad: registerCommand(name, config)
  Ad->>Pi: pi.registerCommand(name, wrapped handler)
  Op->>Pi: types slash command
  Pi->>Ad: handler(args, piCtx)
  Ad->>Ad: toHarnessContext(piCtx)
  Ad->>Ext: config.handler(args, HarnessContext)
  Ext->>Ad: exec(command, cwd, timeout)
  Ad->>Pi: pi.exec("bash", ["-lc", command])
  Pi-->>Ext: code, stdout, stderr, killed
```

<a id="d75"></a>

### Runtime harness detection

Type: `flowchart`

The diagram shows two independent decisions. `resolveRuntimeHarness` picks the CLI harness: Claude wins over Codex, and Pi is the fallback. `CODEX_THREAD_ID` alone is a lookup key; `validateNativeCodexMetadata` must accept the native session header before a Codex run id exists, otherwise `resolveRunId` returns null. Separately, the Pi context adapter decides interactivity from `PI_INTERACTIVE` and `CI`. Derived from `packages/core/src/loop/run-context.mjs` (`isClaudeHarness`, `resolveRuntimeHarness`, `validateNativeCodexMetadata`, `resolveRunId`) and `packages/core/src/harness/pi-adapter.mjs` (`isInteractive`).

```mermaid
flowchart TD
  subgraph harness["run-context.mjs"]
    A["resolveRuntimeHarness(env)"] --> B{"CLAUDECODE == 1?"}
    B -->|yes| C["claude"]
    B -->|no| D{"CODEX_THREAD_ID set?"}
    D -->|yes| E["codex"]
    D -->|no| F["pi"]
    E --> G["validateNativeCodexMetadata"]
    G -->|valid| H["run id codex-thread-ID"]
    G -->|rejected| I["run id null"]
  end
  subgraph interactive["pi-adapter.mjs isInteractive"]
    J{"PI_INTERACTIVE?"}
    J -->|"0"| K["batch"]
    J -->|"1"| L["interactive"]
    J -->|unset| M{"CI is true or 1?"}
    M -->|yes| K
    M -->|no| L
  end
```

<a id="d76"></a>

### GraphQL call with rate-limit wait

Type: `sequenceDiagram`

The diagram shows the shared GraphQL path. `ghGraphql` spawns `gh api graphql` and maps failures to `GH_API_ERROR` (non-zero exit) or `GRAPHQL_ERROR` (an `errors` array). A secondary rate limit or a pre-send transport failure (dial or TLS handshake timeout) makes `ghGraphql` back off 30 seconds and retry once, and a second secondary limit throws `RATE_LIMITED` while a second transport failure surfaces as `GH_API_ERROR`. `withGraphqlRateLimitWait` acts only when the error message matches `isRateLimitError`; every other error is rethrown unchanged. It reads the GraphQL reset from `gh api rate_limit`, which spends no GraphQL points, sleeps once and retries once. It fails closed with `RATE_LIMITED` when budget remains (a REST or secondary limit) or when the reset is unknown, past, beyond `maxWaitMs` or more than 24 hours ahead. Derived from `packages/core/src/github/gh.mjs`.

```mermaid
sequenceDiagram
  participant C as caller
  participant W as withGraphqlRateLimitWait
  participant G as ghGraphql
  participant GH as gh CLI
  C->>W: operation, maxWaitMs, sleep
  W->>G: operation()
  G->>GH: gh api graphql --field query=...
  GH-->>G: non-zero exit
  G-->>W: throw GH_API_ERROR or RATE_LIMITED
  alt message is not a rate limit
    W-->>C: rethrow unchanged
  else rate limit exceeded
    W->>GH: gh api rate_limit
    GH-->>W: resources.graphql remaining, reset
    alt remaining is 0 and reset within cap and 24h
      W->>W: sleep(reset - now)
      W->>G: operation() retry once
      G-->>C: payload, or RATE_LIMITED with resetAt null
    else budget left or reset unusable
      W-->>C: throw RATE_LIMITED with resetAt
    end
  end
```

<a id="d77"></a>

### Copilot review request

Type: `sequenceDiagram`

The diagram shows one run of `request-copilot-review.mjs` after its suppression checks pass. The POST targets the REST `requested_reviewers` endpoint with the `[bot]` reviewer login. Only the verification read repeats, never the POST. One GraphQL cross-check runs before the delayed retries, and the retry loop stops as soon as a read observes the review. When the POST succeeded but no read observes the review, the script reports `requested` with an eventual-consistency detail below 2 unobservable requests on the head, and `copilot_unavailable` at 2. A 422 classified as unavailable re-reads state and reports `already-requested` or `unavailable`. Derived from `scripts/github/request-copilot-review.mjs`.

```mermaid
sequenceDiagram
  participant S as request-copilot-review
  participant GH as gh CLI
  participant API as GitHub
  S->>GH: read requested_reviewers and reviews
  GH->>API: REST GET
  API-->>S: before snapshot
  opt prior error review settled the request
    S->>GH: withdraw Copilot request
  end
  S->>GH: POST pulls/N/requested_reviewers
  GH->>API: reviewer copilot-pull-request-reviewer[bot]
  alt 422 unavailable
    API-->>S: re-read state
    S-->>S: already-requested or unavailable
  else accepted
    S->>GH: verification read
    S->>GH: GraphQL cross-check, once
    loop up to 3 delayed re-reads, until observed
      S->>GH: verification read
    end
    S-->>S: requested with eventual-consistency detail, or copilot_unavailable at 2 unobservable requests
  end
```

<a id="d78"></a>

### Copilot verification backoff

Type: `xychart-beta`

The chart shows the cumulative wait before each verification read after the review POST. The bounded window ends after 30 seconds, so the script never hangs on an unobservable request. Values come from the constant `VERIFICATION_RETRY_DELAYS_MS = [5000, 10000, 15000]`, found with `grep -n VERIFICATION_RETRY_DELAYS_MS scripts/github/request-copilot-review.mjs`. Derived from `scripts/github/request-copilot-review.mjs`.

```mermaid
xychart-beta
  title "Cumulative wait before each verification read"
  x-axis ["read 0", "read 1", "read 2", "read 3"]
  y-axis "seconds" 0 --> 35
  bar [0, 5, 15, 30]
```

<a id="d79"></a>

### Copilot request outcomes

Type: `mindmap`

The mindmap groups the eleven status values that `request-copilot-review.mjs` can return. Most statuses are suppressions that save a redundant Copilot round; only `requested` starts a new review. `blocked_by_copilot_comment` asks the operator to delete a non-Copilot comment that contains `@copilot` or `/copilot`. Derived from the `*_STATUS` constants and the usage text in `scripts/github/request-copilot-review.mjs`.

```mermaid
mindmap
  root((request status))
    New round
      requested
    Already live
      already-requested
    Skipped
      suppressed_same_head_clean
      no_changes_since_last_review
      suppressed_post_convergence
      suppressed_post_convergence_docs_only
      suppressed_draft
      round_cap_reached
      copilot_unavailable
    Blocked
      blocked_by_copilot_comment
      unavailable
```

<a id="d80"></a>

### GitHub script surface

Type: `pie`

The chart shows how the GitHub wrapper scripts reach GraphQL. Most scripts use REST through `gh pr`, `gh issue` or `gh api`; GraphQL is reserved for review threads, project boards and cross-checks. Scripts can also reach GraphQL indirectly through imported core modules, which this count does not see. Counts come from `ls scripts/github/*.mjs | wc -l` (94), `grep -l '"graphql"' scripts/github/*.mjs | wc -l` (10) and `grep -lE '"graphql"|ghGraphql' scripts/github/*.mjs | wc -l` (12). Derived from `scripts/github/`.

```mermaid
pie showData
  title "scripts/github/*.mjs by direct GraphQL use"
  "literal graphql argument" : 10
  "ghGraphql helper only" : 2
  "neither" : 82
```

<a id="d81"></a>

### Tracker adapter

Type: `classDiagram`

The diagram shows the tracker seam over the core `gh issue` operations. The Issues capability is required; the Board capability is optional and copied through only when present. The built-in GitHub provider wires two board methods, `listQueueItems` and `setItemStatus`, through `packages/core/src/projects`. The other board operations exist as `scripts/projects/*.mjs` CLI tools (`ensure-queue-board`, `add-queue-item`, `reorder-queue-item`, `archive-done-items`). The noop adapter stubs every method for tests. An unknown `tracker.provider` fails closed in `resolveTrackerAdapter`. Derived from `packages/core/src/tracker/adapter.mjs`, `packages/core/src/tracker/github-adapter.mjs`, `packages/core/src/tracker/noop-adapter.mjs`, `packages/core/src/tracker/index.mjs` and `packages/core/src/github/issue-ops.mjs`.

```mermaid
classDiagram
  class TrackerAdapter {
    <<interface>>
    +parseRef(ref)
    +getIssue(ref)
    +createIssue(input)
    +editIssue(ref, patch)
    +commentIssue(ref, body)
    +listIssues(filter)
    +detectLinkedPr(ref)
  }
  class BoardCapability {
    <<optional>>
    +ensureBoard()
    +listQueueItems()
    +addQueueItem()
    +setItemStatus()
    +reorderItem()
    +archiveItems()
  }
  class GithubTrackerAdapter {
    +listQueueItems()
    +setItemStatus()
  }
  class NoopTrackerAdapter
  class IssueOps {
    +viewIssue()
    +createIssue()
    +editIssue()
    +commentIssue()
    +listIssues()
    +detectLinkedIssuePr()
  }
  class ProjectsCore {
    +move-queue-item main()
    +list-queue-items main()
  }
  TrackerAdapter <|.. GithubTrackerAdapter
  TrackerAdapter <|.. NoopTrackerAdapter
  BoardCapability <|.. GithubTrackerAdapter : partial
  BoardCapability <|.. NoopTrackerAdapter : stubs
  GithubTrackerAdapter --> IssueOps : gh issue
  GithubTrackerAdapter --> ProjectsCore : board
```

<a id="d82"></a>

### Claude Code hook pipeline

Type: `sequenceDiagram`

The diagram shows the eight hook registrations the plugin installs and when Claude Code fires them. PreToolUse hooks can deny a tool call. The approval guard runs first on Bash, Read, Edit, Write, NotebookEdit, Grep, Glob and MCP calls and denies a call that names the merge approval record. The answers guard denies an AskUserQuestion approval question that carries a pre-filled `answers` map, and the AskUserQuestion PostToolUse hook records the operator's yes answer. The PostToolUse merge hook fast-forwards the main checkout with `--ff-only` and always exits 0. The SubagentStop guard refuses a stop with exit 2 when a worktree under `tmp/worktrees/` is dirty. The bash gate denies raw `gh pr create`, raw `gh pr merge`, raw PR-body writes, raw comment writes and `git stash`. Counts come from `.claude/hooks/hooks.json` (8 registrations) and `ls .claude/hooks/*.mjs | wc -l` (19 files: 8 hooks and 11 helper modules). Derived from `.claude/hooks/hooks.json`, `.claude/hooks/pre-tool-use-approval-guard.mjs`, `.claude/hooks/pre-tool-use-ask-answers-guard.mjs`, `.claude/hooks/pre-tool-use-bash-gate.mjs`, `.claude/hooks/pre-tool-use-write-guard.mjs`, `.claude/hooks/pre-tool-use-agent-guard.mjs`, `.claude/hooks/post-tool-use-merge.mjs` and `.claude/hooks/subagent-stop-uncommitted-guard.mjs`.

```mermaid
sequenceDiagram
  participant A as Claude agent
  participant CC as Claude Code
  participant AP as approval-guard
  participant BG as bash-gate
  participant WG as write-guard
  participant AG as agent-guard
  participant AQ as answers-guard
  participant AR as ask-record
  participant PM as post-merge
  participant SS as stop-guard
  A->>CC: Bash, Read, Edit, Write, NotebookEdit, Grep, Glob or MCP call
  CC->>AP: PreToolUse
  AP-->>CC: deny when the call names the approval record
  CC->>BG: PreToolUse Bash
  BG-->>CC: allow or deny with reason
  CC->>PM: PostToolUse Bash
  PM-->>CC: ff-only main, exit 0
  A->>CC: Edit or Write
  CC->>WG: PreToolUse Edit or Write
  WG-->>CC: allow or deny
  A->>CC: Agent or Task dispatch
  CC->>AG: PreToolUse Agent or Task
  AG-->>CC: allow or deny
  A->>CC: AskUserQuestion
  CC->>AQ: PreToolUse AskUserQuestion
  AQ-->>CC: deny pre-filled answers on an approval question
  CC->>AR: PostToolUse AskUserQuestion
  AR-->>CC: record a yes approval answer
  A->>CC: subagent stops
  CC->>SS: SubagentStop
  SS-->>CC: exit 2 when worktree dirty
```

<a id="d83"></a>

### Hook bundle vendoring

Type: `flowchart`

The diagram shows why the hooks import local `_*.mjs` files. The plugin ships without `node_modules`, so a hook cannot import `@dev-loops/core`. The generator copies pure core deciders into `.claude/hooks/` and rewrites their cross-module imports to sibling paths; a `--check` run keeps the copies in sync. Edges on the right show which helper each hook imports, from `grep -o 'from "./_[a-z-]*.mjs"' .claude/hooks/[a-z]*.mjs`. `_hook-io`, `_fixer-grants` and the other helpers without a core source are hand-written. Derived from `HOOK_BUNDLE` in `scripts/claude/generate-claude-assets.mjs` and the hook files under `.claude/hooks/`.

```mermaid
flowchart LR
  subgraph src["packages/core/src"]
    S1["loop/bash-command-classify"]
    S2["loop/bash-gate-decisions"]
    S3["loop/run-context"]
    S4["claude/hook-decisions"]
    S5["loop/worktree-guard"]
    S6["loop/main-checkout-ff"]
    S7["github/ask-merge-approval"]
  end
  subgraph vend[".claude/hooks vendored"]
    V1["_bash-command-classify"]
    V2["_bash-gate-decisions"]
    V3["_run-context"]
    V4["_hook-decisions"]
    V5["_worktree-guard"]
    V6["_main-checkout-ff"]
    V7["_ask-merge-approval"]
  end
  S1 --> V1
  S2 --> V2
  S3 --> V3
  S4 --> V4
  S5 --> V5
  S6 --> V6
  S7 --> V7
  BG["bash-gate"] --> V1
  BG --> V4
  WG["write-guard"] --> V4
  WG --> V5
  AG["agent-guard"] --> V4
  SS["stop-guard"] --> V4
  PM["post-merge"] --> V1
  PM --> V5
  PM --> V6
  AP["approval-guard"] --> V7
  AQ["answers-guard"] --> V7
  AR["ask-record"] --> V7
```

<a id="d84"></a>

### Claude asset generation

Type: `flowchart`

The diagram shows how the Claude Code plugin is built from the Pi sources. Agents, skills and commands are authored once for Pi; the generator maps tool names, strips `pi-only` blocks and rewrites CLI calls to the `dev-loops-run` launcher. It also copies `skills/docs`, the dev-loop templates and the hook bundle, and stamps the version into `plugin.json`. The marketplace manifest points its plugin source at `./.claude`. Agent counts come from `ls agents/*.agent.md | wc -l` (9) and `ls .claude/agents/*.md | wc -l` (9). Derived from `scripts/claude/generate-claude-assets.mjs`, `packages/core/src/claude/asset-generation.mjs` and `.claude-plugin/marketplace.json`.

```mermaid
flowchart LR
  A["agents/*.agent.md"] --> G["generate-claude-assets"]
  S["skills/NAME/SKILL.md"] --> G
  C["commands/*.command.md"] --> G
  P["package.json version"] --> G
  G --> T["stripPiOnlyBlocks, rewrite to dev-loops-run"]
  T --> T1["mapTools: read to Read, search to Grep+Glob"]
  T1 --> O1[".claude/agents"]
  T1 --> O2[".claude/skills"]
  T --> O4[".claude/commands"]
  G --> O5[".claude/hooks/_*.mjs bundle"]
  G --> O3["plugin.json version"]
  O1 --> M["marketplace.json source ./.claude"]
  O2 --> M
  O4 --> M
  O5 --> M
  O3 --> M
```

<a id="d85"></a>

### Headless Claude launch

Type: `sequenceDiagram`

The diagram shows the headless entry that runs the dev-loop under Claude Code without a terminal. The script mints a run id and puts it in the child environment as `DEVLOOPS_RUN_ID`, which is how the write guard recognizes the session as the dev-loop context. MCP servers are detected from config files only; no process is spawned for detection. After `claude` exits, the script releases every coordination claim the run still owns. Derived from `scripts/claude/headless-dev-loop.mjs` and `packages/core/src/claude/headless-entry.mjs`.

```mermaid
sequenceDiagram
  participant Op as Operator
  participant H as headless-dev-loop
  participant E as headless-entry
  participant C as claude CLI
  participant Hk as plugin hooks
  Op->>H: --issue N or --pr N
  H->>H: ensureRunId mints run id
  H->>E: buildDevLoopPrompt(issue, pr)
  H->>E: buildHeadlessClaudeInvocation(prompt, runId)
  E->>E: detectSessionMcpServers from config files
  E-->>H: command, args -p, env with DEVLOOPS_RUN_ID
  H->>C: spawnSync claude -p prompt
  C->>Hk: every tool call passes the hooks
  Hk-->>C: guard reads run id from env
  C-->>H: exit
  H->>H: releaseRunClaimsOnExit(runId)
```

<a id="d86"></a>

### Harness capability defaults

Type: `block-beta`

The grid shows the default cache and telemetry posture per harness used by review dispatch planning. Claude is the only harness with automatic breakpoints, a fixed cache TTL and usage telemetry; Pi and Codex default to opaque and unavailable, so the planner does not over-claim. Derived from `HARNESS_DEFAULT_CAPABILITIES` in `packages/core/src/loop/review-dispatch-plan.mjs`.

```mermaid
block-beta
  columns 5
  h0["harness"] h1["breakpoint"] h2["barrier"] h3["cache TTL"] h4["telemetry"]
  c0["claude"] c1["automatic"] c2["completion_only"] c3["fixed"] c4["available"]
  p0["pi"] p1["opaque"] p2["completion_only"] p3["opaque"] p4["unavailable"]
  x0["codex"] x1["opaque"] x2["completion_only"] x3["opaque"] x4["unavailable"]
```

<a id="d87"></a>

### Codex execution evidence

Type: `stateDiagram-v2`

The diagram shows how `reconcileCodexExecution` decides whether a stopped Codex worker finished, from its native session journal. The adapter is read-only: it never probes or signals a process. Only one terminal `CommandExecution` record bound to the owner thread, execution id, repo root and cwd yields `completed`; that status covers a recorded `failed` exit as well. Every gap or drift yields `unknown`, and a runtime without a session store yields `unsupported`. The module is exported from `@dev-loops/core`; `git grep -l reconcileCodexExecution` finds no caller outside its own test. Derived from `packages/core/src/loop/codex-execution-evidence.mjs`.

```mermaid
stateDiagram-v2
  [*] --> Validate
  Validate --> Unknown: invalid_request
  Validate --> Locate
  Locate --> Unsupported: no native session store
  Locate --> Unknown: not found, ambiguous, unreadable
  Locate --> ReadJournal
  ReadJournal --> Unknown: not a file, over 32 MiB, tail in flight
  ReadJournal --> ParseRecords
  ParseRecords --> Unknown: malformed or no terminal record
  ParseRecords --> CheckHeader
  CheckHeader --> Unknown: schema drift or owner mismatch
  CheckHeader --> BindExecution
  BindExecution --> Unknown: conflict or execution id mismatch
  BindExecution --> VerifyRecord
  VerifyRecord --> Unknown: drift, repo root or cwd mismatch
  VerifyRecord --> Completed: terminal_evidence_verified
  Completed --> [*]
  Unknown --> [*]
  Unsupported --> [*]
```

