# 0122. Per-tool guidance for extraTools comes from .devloops and renders only for a detected server

## Status

Proposed

## Context

Issue [2598](https://github.com/mfittko/dev-loops/issues/2598) delivers MCP tools to the Claude `developer`, `fixer` and `refiner` roles through `.devloops` `extraTools`. Its decision lives in the issue body and in no ADR, so this record amends no ADR.

In a run for issue 2612, a worker held a code-graph MCP tool and still searched with grep only. The coordinator added a usage line to the brief by hand. Brief text is not durable. The same worker queried a graph project for its worktree and got "project not found or not indexed", because only the main checkout was indexed. The freshness limit lived in docs that the worker prompt never sees.

## Decision

- Per-tool usage guidance comes from the optional `.devloops` key `extraToolsGuidance`: a map from an `extraTools` entry to a non-empty text of at most 2000 characters. A key that no role lists in `extraTools` fails config load and names the key.
- The guidance renders only into the session-scoped `--agents` override prompt, only for roles that list the key, and only when the server is detected for the session. Detection reads the user, local and project MCP config files and never spawns a process. Detection gates the guidance text only. Tool delivery stays as decided in issue 2598.
- Core holds a fixed frame that makes every line conditional on the server's tools being in the worker's tool list. Core holds no guidance text and names no server.
- No static surface names a third-party MCP server: agents, the committed `.claude` tree, skills, shared contracts, docs, this record, change fragments and Pi output stay generic. A server name appears only in `.devloops` and in tests.
- A worker indexes its own worktree once per session, with persistence off, and falls back to the main-checkout index when indexing fails. On fallback the worker confirms each answer with Read or Grep in the worktree before an edit. A worker that indexed its worktree deletes that graph project before its hand-back.
- Worktree provisioning does not index. The dev-loop coordinator has no MCP tools, so the worker does this through its own tools.

## Consequences

Guidance survives across runs and briefs and stays consumer-owned. A consumer that sets the key needs the dev-loops release that ships it, and an older CLI fails config load on the key. Servers from plugins, managed config, connectors or a `--mcp-config` argument are not detected and get no guidance. This is a false negative only. A listed server that fails to connect is a false positive that the conditional frame covers. A worker that ends abnormally leaves its worktree graph project in the store until removed by hand.
