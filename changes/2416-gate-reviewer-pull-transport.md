### Changed

- Gate reviewers receive a compact `dispatchPrompt` reference and pull their work order with the new read-only `pull-work-order.mjs` instead of relayed work-order bytes (#2416)
- `pull-work-order.mjs` refuses mismatched, tampered or retired-round references and writes a pull receipt under the main checkout gate evidence root (#2416)
- `consolidate-fanin.mjs` fails closed when a freshly dispatched unit has no matching pull receipt; a receipt without a result artifact is an interrupted reviewer (#2416)
- The transcript audit reports coordinator output bytes per subagent dispatch (#2416)
- ADR 0106 amends ADR 0086: workers pull deterministic work orders (#2416)
