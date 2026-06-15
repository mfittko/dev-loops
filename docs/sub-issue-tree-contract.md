# Sub-Issue Tree Contract

This document defines the deterministic pattern for epic/umbrella issue decomposition using
GitHub sub-issues in `dev-loops`.

## Purpose

When an umbrella issue (epic) is decomposed into bounded child slices, the **real GitHub
sub-issue tree** is the default durable output — not a body checklist, not a manual follow-up
linking step.

The `scripts/github/manage-sub-issues.mjs` helper owns the deterministic sub-issue tooling:
listing, attaching, ordering, and verifying the tree.

## When to use sub-issues vs plain related-issue references

| Situation | Use |
|---|---|
| Umbrella/epic issue has bounded child slices with an execution order | Real sub-issue tree via `manage-sub-issues.mjs` |
| Two issues are related but neither owns the other's execution | Plain cross-reference (`#N`) in issue body |
| One issue blocks another but is not a structural child | Plain "blocked by #N" in body |
| A PR implements an issue | PR body / `Closes #N` syntax (not sub-issue) |
| Background investigation or spike precedes a slice | Plain related reference; promote to sub-issue if it becomes a required step |

**Rule of thumb:** use the sub-issue tree when the parent issue's progress is structurally
defined by completing its children in some intended order. Use plain references for everything
else.

## Default decomposition flow

When refining an umbrella issue into executable slices:

1. **Refine umbrella framing** — confirm scope, acceptance criteria, and non-goals in the
   parent issue body.
2. **Define bounded child slices** — each slice must be independently closable and
   independently verifiable.
3. **Create child issues** with `gh issue create --assignee @me` (or reuse existing issues).
4. **Attach children as real sub-issues** using `manage-sub-issues.mjs add`.
5. **Set execution order** using `manage-sub-issues.mjs reorder` — first in the list is
   highest priority.
6. **Verify the resulting tree** using `manage-sub-issues.mjs verify` so attachment and order are
   confirmed deterministically before the parent body stops carrying sequence details.
7. **Keep the parent issue body lean** — sequencing and progress now live in the sub-issue tree.
   The parent body should carry scope/context/acceptance criteria but not duplicate the ordered
   child list.

## Lean parent issue bodies

Once a real sub-issue tree exists:

- Do **not** maintain an ordered checklist in the parent body that duplicates the tree.
- Do **not** update the parent body to reflect child completion status; GitHub renders that
  from the tree automatically.
- **Do** keep scope, framing, acceptance criteria, and non-goals in the parent body because
  those are not structurally represented by the tree.

## Deterministic helper: `manage-sub-issues.mjs`

```sh
node <resolved-skill-scripts>/github/manage-sub-issues.mjs <command> \
  --repo <owner/name> --issue <parent-number> [options]
```

In the `dev-loops` source repository the scripts directory is `scripts/` from the repo root.
In normalized installed skill copies it may be `scripts/` inside the installed skill directory.

### List sub-issues

```sh
node <resolved-skill-scripts>/github/manage-sub-issues.mjs list \
  --repo <owner/name> --issue <parent-number>
```

Returns:
```json
{
  "ok": true,
  "repo": "owner/name",
  "issue": 42,
  "command": "list",
  "subIssues": [
    { "number": 10, "title": "Slice A", "state": "open", "id": 1001 },
    { "number": 11, "title": "Slice B", "state": "open", "id": 1002 }
  ]
}
```

Sub-issues are returned in their current tree order (highest priority first).

### Add a child issue as a sub-issue

```sh
node <resolved-skill-scripts>/github/manage-sub-issues.mjs add \
  --repo <owner/name> --issue <parent-number> --child <child-number>
```

The helper resolves the child's internal GitHub id and attaches it to the parent.
Run this once per child issue.

### Set execution order

```sh
node <resolved-skill-scripts>/github/manage-sub-issues.mjs reorder \
  --repo <owner/name> --issue <parent-number> --order <n1,n2,...>
```

All issue numbers in `--order` must already be sub-issues of the parent. The helper sends
sequential priority-update calls so the tree reflects the specified order.
The first number in the list becomes the highest-priority (first) sub-issue.

### Verify the tree state

```sh
node <resolved-skill-scripts>/github/manage-sub-issues.mjs verify \
  --repo <owner/name> --issue <parent-number> --expected <n1,n2,...> [--ordered]
```

Returns `"verified": true` when the actual sub-issues match the expected set.
Add `--ordered` to also verify that the execution order matches exactly.
`verify` exits 0 for mismatch-only results and reports the discrepancy in JSON.
Argument/usage errors and `gh`/runtime failures still exit non-zero.

Verification output includes `"missing"` and `"unexpected"` arrays so discrepancies are
machine-readable.

## Compatibility with `dev-loop`

This pattern is used inside the routed `issue-intake` and local-implementation skills and is always accessed through the
`dev-loop` public entrypoint. The helper is a thin, deterministic tool; it does not replace
issue writing, refinement, or the normal PR-based execution loop.

The `dev-loop` skill invokes `manage-sub-issues.mjs` when epic decomposition work includes a
real sub-issue tree step. Agents must not implement sub-issue management ad hoc or bypass this
helper.
