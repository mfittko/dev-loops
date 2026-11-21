import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Children spawned by tests inherit this env, so no test writes the shared <main checkout>/tmp/gh-calls.jsonl.
process.env.DEVLOOPS_GH_CALL_LOG ??= path.join(mkdtempSync(path.join(tmpdir(), "devloops-gh-call-log-")), "gh-calls.jsonl");
