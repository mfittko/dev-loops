### Fixed

- Every terminal dev-loops hook denial now ends with a `stop: <class>; <deny-id>; <reason>` marker naming one of two classes, escalate or process-change, and thirteen denials that needed no stop became recoverable through a `policy-hook:` marker (#3514)
