# 0291. Fixer focus items carry a reply disposition and note, and bind by thread id on a threads source

## Status

Accepted, 2026-11-18 ([issue 3206](https://github.com/mfittko/dev-loops/issues/3206)).

Extends [ADR 0205](./0205-operator-focus-work-order-field.md). Every decision of that record stays in force, and its body stays unedited.

## Context

The fixer reply verifier posted "Fixed in commit" on every review thread the fixer touched. A thread that the operator decided to defer, reject or fix only in part got the same reply. The operator focus carrier of ADR 0205 had no field for the reply, and a fixer item bound only by act-item fingerprint, so a fixer pass driven by a `--threads-file` source had no way to name a thread.

## Decision

- A fixer item carries two more optional fields. `replyDisposition` is one of `tackled`, `partially_fixed`, `deferred` and `rejected`. `partially_fixed` is a new value of `FIXER_DISPOSITION_KIND`.
- `replyNote` is sanitized and bounded by the reply writer's own rules. The verifier posts it in the thread reply.
- A `replyDisposition` other than `tackled` without a `replyNote` refuses. A `replyNote` without a `replyDisposition` refuses.
- An item binds by `fingerprint` on an `--act-list-file` source or by `threadId` on a `--threads-file` source. Exactly one of the two keys is present.
- A `threadId` item carries no `decision`. An unknown thread id refuses, and nothing is written.
- The work-order digest pins both fields, and `## Operator focus` renders them.
- The `replyDisposition` sets only the reply on the review thread. The judge and the act list keep ownership of the act/defer disposition.

Rejected alternative: a free-text reply override in the fixer prompt. It would bypass the digest-pinned work order that ADR 0205 made the only sanctioned carrier.

## Consequences

- A deferred, rejected or partly fixed thread gets a reply that states the operator's decision and note.
- A threads-source fixer pass can bind operator focus to a review thread.
- An absent `replyDisposition` keeps the existing "Fixed in commit" reply and the existing work-order bytes.
