- **Docs: name the one-call gate-fan-out wave shape (issue #2350).** The
  gate-fan-out dispatch discipline in `skills/dev-loop/SKILL.md` and the
  per-harness delivery table in `skills/docs/gate-review-sub-loop-contract.md`
  now state that a wave is ONE `subagent` call returning a single
  `runs.all([...])` with a unique non-empty `key` per unit — never N separate
  blocking per-unit calls, which Pi's foreground guard rejects and which
  silently serializes a round. Prose-only; no behavior change.
