### Changed

- Gate reviewers read the filtered diff once: the evidence file and the `changed-files` variant point at the hash-bound `diff` read instead of repeating its bytes (#2528)
- The `correctness` angle checks what moved or re-hosted code used to guarantee and flags each guarantee the new path drops (#2528)
- The `prior-dispositions` read carries the reject and defer dispositions of every closed prior round of the same gate, latest disposition per finding wins, with no caller flag (#2528)
- `write-gate-context.mjs --prev-head` is removed; `resolve-angle-carry-forward.mjs --prev-head` is unchanged (#2528)
- ADR 0109 amends ADR 0070: cumulative prior dispositions within one gate (#2528)
