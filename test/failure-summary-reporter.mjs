import { Transform } from "node:stream";
import { inspect } from "node:util";

function formatFailure(eventData = {}) {
  const file = typeof eventData.file === "string" ? eventData.file : "<unknown-file>";
  const name = typeof eventData.name === "string" ? eventData.name : "<unnamed-test>";
  const details = eventData.details && typeof eventData.details === "object"
    ? eventData.details
    : {};
  const error = details.error && typeof details.error === "object"
    ? details.error
    : null;
  const cause = error?.cause ?? error;
  const rendered = cause
    ? inspect(cause, { depth: 3, breakLength: 120 })
    : "Unknown test failure";

  return `✖ ${name}\n  at ${file}\n  ${rendered}\n`;
}

function formatSummary(summary = {}) {
  const counts = summary.counts && typeof summary.counts === "object" ? summary.counts : {};
  return [
    `ℹ tests ${counts.tests ?? 0}`,
    `ℹ suites ${counts.suites ?? 0}`,
    `ℹ pass ${counts.passed ?? 0}`,
    `ℹ fail ${counts.failed ?? 0}`,
    `ℹ cancelled ${counts.cancelled ?? 0}`,
    `ℹ skipped ${counts.skipped ?? 0}`,
    `ℹ todo ${counts.todo ?? 0}`,
    `ℹ duration_ms ${summary.duration_ms ?? 0}`,
    "",
  ].join("\n");
}

export default class FailureSummaryReporter extends Transform {
  constructor() {
    super({ writableObjectMode: true });
    this.failures = [];
  }

  _transform(event, _encoding, callback) {
    if (event?.type === "test:fail") {
      this.failures.push(event.data);
    }

    if (event?.type === "test:summary" && !event?.data?.file) {
      if (this.failures.length > 0) {
        this.push("✖ failing tests:\n\n");
        for (const failure of this.failures) {
          this.push(formatFailure(failure));
          this.push("\n");
        }
      }
      this.push(formatSummary(event.data));
    }

    callback();
  }
}
