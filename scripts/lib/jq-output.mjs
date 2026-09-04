// Shared --jq / --silent output helper for the JSON-emitting dev-loops scripts
// (issue #981, subsumes #963). One helper applied uniformly so the loop never
// falls back to `gh api | python3` or inline `node -e` to read tool JSON.
// BASE-JQ-OUTPUT-GUARANTEE: emitResult is the single shared emit path every
// JSON-emitting command routes through (enforced by the jq-output-base-guarantee
// contract test).
//
// Convention (also documented in skills/dev-loop/SKILL.md):
//   prefer the dev-loops subcommand
//     -> `--silent`/`-s` for a yes/no status check (zero output, exit code only)
//     -> `--jq <filter>` to extract a field from the result
//     -> `gh --jq` on a raw gh call
//     -> NEVER `| python3` or `node -e`.
//
// jq subset (NOT full jq — fails closed clearly on anything outside this):
//   .                identity
//   .field           field access (also .a.b.c chains)
//   .field[]         iterate an array field
//   .[]              iterate an array / object values
//   .[N] / .field[N] index access
//   a | b            pipe
//   select(<pred>)   filter the current value(s) by a predicate
//   length           count of array/string/object
//   keys             sorted object keys (or array indices)
//   predicates inside select: .x == <lit>, !=, <, <=, >, >=, and a bare path
//                  (truthy test). <lit> is a JSON string/number/true/false/null.
// Anything else -> JqFilterError (fail closed).

export class JqFilterError extends Error {
  constructor(message) {
    super(message);
    this.name = "JqFilterError";
    this.isJqFilterError = true;
  }
}

// A jq "stream" is an array of values (jq filters are many-valued). We thread an
// array through each pipe stage. Identity is [value].

function parseLiteral(token) {
  const trimmed = token.trim();
  if (trimmed === "true") return { ok: true, value: true };
  if (trimmed === "false") return { ok: true, value: false };
  if (trimmed === "null") return { ok: true, value: null };
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return { ok: true, value: Number(trimmed) };
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return { ok: true, value: trimmed.slice(1, -1) };
  }
  return { ok: false };
}

// Parse a path expression like `.`, `.a.b`, `.a[0].b`, `.[2]` into a step
// list. Pure syntax: never touches data. Throws JqFilterError on malformed
// path syntax. This is the syntactic core both resolvePath (real evaluation)
// and assertJqFilterSyntax (parse-time pre-validation, no data) build on, so
// the two never drift apart.
function parsePathSteps(path) {
  const trimmed = path.trim();
  if (trimmed === "") {
    // An empty path is never valid jq (no empty filter). Fail closed so
    // malformed predicates like `select()` or `==5` don't pass as identity.
    throw new JqFilterError("Empty path expression");
  }
  if (trimmed === ".") return [];
  if (!trimmed.startsWith(".")) {
    throw new JqFilterError(`Unsupported path (must start with '.'): ${path}`);
  }
  // Tokenize into .field and [index] steps.
  const stepRe = /\.([A-Za-z_][A-Za-z0-9_]*)|\[(\d+)\]/g;
  // Root index access (`.[N]`) starts with a leading '.' that is not part of any
  // step token; consume it so the first `[N]` match aligns at the cursor.
  let lastIndex = trimmed.startsWith(".[") ? 1 : 0;
  stepRe.lastIndex = lastIndex;
  const steps = [];
  let match;
  let consumedAny = false;
  while ((match = stepRe.exec(trimmed)) !== null) {
    if (match.index !== lastIndex) {
      throw new JqFilterError(`Unsupported path syntax near: ${trimmed.slice(lastIndex)}`);
    }
    lastIndex = stepRe.lastIndex;
    consumedAny = true;
    if (match[1] !== undefined) {
      steps.push({ field: match[1] });
    } else {
      steps.push({ index: Number(match[2]) });
    }
  }
  if (!consumedAny || lastIndex !== trimmed.length) {
    throw new JqFilterError(`Unsupported path syntax: ${path}`);
  }
  return steps;
}

// Resolve a single-value path expression against real data. Returns undefined
// for a missing path (jq yields null; we map missing->undefined then callers
// coerce). Throws JqFilterError on malformed path syntax (via parsePathSteps).
function resolvePath(value, path) {
  const steps = parsePathSteps(path);
  let cursor = value;
  for (const step of steps) {
    if (cursor === undefined || cursor === null) {
      cursor = undefined;
      continue;
    }
    if (step.field !== undefined) {
      cursor = typeof cursor === "object" && !Array.isArray(cursor) ? cursor[step.field] : undefined;
    } else {
      cursor = Array.isArray(cursor) ? cursor[step.index] : undefined;
    }
  }
  return cursor;
}

// Parse a select(...)/top-level predicate's syntax without touching data:
// a bare path (truthy test) or `<path> <op> <literal>`. Pure syntax; throws
// JqFilterError for malformed path/operand syntax. Data-dependent checks
// (order-comparing mismatched runtime types) happen later in evaluatePredicate,
// once real data is available.
function parsePredicateSyntax(predicate) {
  const cmpRe = /^(.*?)(==|!=|<=|>=|<|>)(.*)$/;
  const m = predicate.match(cmpRe);
  if (!m) {
    // Bare path => truthy test.
    parsePathSteps(predicate);
    return { kind: "bare", path: predicate };
  }
  const [, leftRaw, op, rightRaw] = m;
  parsePathSteps(leftRaw);
  const lit = parseLiteral(rightRaw);
  if (!lit.ok) {
    throw new JqFilterError(`Unsupported predicate operand: ${rightRaw.trim()}`);
  }
  return { kind: "compare", leftRaw, op, literal: lit.value };
}

function evaluatePredicate(value, predicate) {
  const parsed = parsePredicateSyntax(predicate);
  if (parsed.kind === "bare") {
    const resolved = resolvePath(value, parsed.path);
    return resolved !== undefined && resolved !== null && resolved !== false;
  }
  // jq maps a missing path to null; resolvePath yields undefined -> normalize.
  const resolvedLeft = resolvePath(value, parsed.leftRaw);
  const left = resolvedLeft === undefined ? null : resolvedLeft;
  const right = parsed.literal;
  switch (parsed.op) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case "<":
    case "<=":
    case ">":
    case ">=": {
      // jq never coerces across types (number < string always); JS would. Fail
      // closed when operand types differ so numeric-string fields don't misfire.
      if (typeof left !== typeof right) {
        throw new JqFilterError(`Cannot order-compare ${typeof left} and ${typeof right}`);
      }
      if (parsed.op === "<") return left < right;
      if (parsed.op === "<=") return left <= right;
      if (parsed.op === ">") return left > right;
      return left >= right;
    }
    default:
      throw new JqFilterError(`Unsupported operator: ${parsed.op}`);
  }
}

// Apply one pipe stage to a stream (array of values), returning a new stream.
function applyStage(stream, rawStage) {
  const stage = rawStage.trim();
  if (stage === "") {
    throw new JqFilterError("Empty filter stage");
  }
  if (stage === "length") {
    return stream.map((v) => {
      if (Array.isArray(v) || typeof v === "string") return v.length;
      if (v && typeof v === "object") return Object.keys(v).length;
      throw new JqFilterError("length: input must be array, string, or object");
    });
  }
  if (stage === "keys") {
    return stream.map((v) => {
      if (Array.isArray(v)) return v.map((_, i) => i);
      if (v && typeof v === "object") return Object.keys(v).sort();
      throw new JqFilterError("keys: input must be array or object");
    });
  }
  const selectMatch = stage.match(/^select\((.*)\)$/);
  if (selectMatch) {
    return stream.filter((v) => evaluatePredicate(v, selectMatch[1]));
  }
  // Top-level comparison expression yields a boolean per input (e.g. .x=="y").
  if (/(==|!=|<=|>=|<|>)/.test(stage)) {
    return stream.map((v) => evaluatePredicate(v, stage));
  }
  // Iteration: a path ending in [] (incl. bare .[]).
  if (stage === ".[]") {
    return stream.flatMap((v) => iterate(v));
  }
  if (stage.endsWith("[]")) {
    const base = stage.slice(0, -2);
    return stream.flatMap((v) => iterate(resolvePath(v, base)));
  }
  // Plain path access (single value per input).
  return stream.map((v) => resolvePath(v, stage));
}

// Validate one pipe stage's syntax without touching data. Mirrors the
// branching in applyStage exactly (same order, same subset) so the two never
// drift apart; type/data-dependent failures (length on a non-collection,
// iterating a scalar, order-comparing mismatched runtime types) are NOT
// checked here — those can only be known once real data is present, so they
// still surface at evaluation/emit time.
function validateStageSyntax(stage) {
  const trimmed = stage.trim();
  if (trimmed === "") {
    throw new JqFilterError("Empty filter stage");
  }
  if (trimmed === "length" || trimmed === "keys") return;
  const selectMatch = trimmed.match(/^select\((.*)\)$/);
  if (selectMatch) {
    parsePredicateSyntax(selectMatch[1]);
    return;
  }
  if (/(==|!=|<=|>=|<|>)/.test(trimmed)) {
    parsePredicateSyntax(trimmed);
    return;
  }
  if (trimmed === ".[]") return;
  if (trimmed.endsWith("[]")) {
    parsePathSteps(trimmed.slice(0, -2));
    return;
  }
  parsePathSteps(trimmed);
}

function iterate(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return Object.values(v);
  throw new JqFilterError("Cannot iterate (.[]) over a non-array/object value");
}

// Split on top-level pipes, ignoring | inside quotes or parentheses.
function splitPipes(filter) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (const ch of filter) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "|" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

// Evaluate a jq-subset filter against a value. Returns the jq "stream" (array of
// result values). Throws JqFilterError on unsupported syntax.
export function evaluateJqFilter(value, filter) {
  if (typeof filter !== "string" || filter.trim() === "") {
    throw new JqFilterError("Empty --jq filter");
  }
  let stream = [value];
  for (const stage of splitPipes(filter)) {
    stream = applyStage(stream, stage);
  }
  return stream;
}

// Validate a --jq filter's SYNTAX only, independent of any data. Throws
// JqFilterError for anything outside the supported subset (same grammar
// evaluateJqFilter enforces, via the same parsePathSteps/parsePredicateSyntax
// helpers — one source of truth, so this can't silently drift from the real
// evaluator). Returns normally for a syntactically valid filter, even one
// that may still fail at evaluation time against a particular data shape
// (e.g. `length` applied to a scalar) — those are data-dependent and stay at
// emit time, never here.
export function assertJqFilterSyntax(filter) {
  if (typeof filter !== "string" || filter.trim() === "") {
    throw new JqFilterError("Empty --jq filter");
  }
  for (const stage of splitPipes(filter)) {
    validateStageSyntax(stage);
  }
}

// jq truthiness for --silent: matches `jq -e` exit semantics — the status is
// based on the LAST output value (empty output is falsy; a value is truthy
// unless it is null or false).
function streamIsTruthy(stream) {
  if (stream.length === 0) return false;
  const last = stream[stream.length - 1];
  return last !== null && last !== false && last !== undefined;
}

// Single source of truth for the invalid-filter stderr envelope, shared by
// emitResult's own (data-dependent-inclusive) error path and the parse-time
// preflightJqFilter check below, so the two byte-for-byte agree.
function formatJqFilterErrorEnvelope(error) {
  return JSON.stringify({ ok: false, error: `--jq (BASE-JQ-OUTPUT-GUARANTEE): ${error.message}` });
}

// Fail-fast --jq syntax preflight for mutation wrappers: call this AFTER
// argument parsing but BEFORE the wrapper's mutation runs. A syntactically
// invalid filter writes the exact stderr envelope emitResult's own
// JqFilterError branch would produce and returns 2 — the caller should
// return that code immediately, skipping the mutation. `undefined` means
// `jq` is absent or syntactically valid; the wrapper proceeds normally (its
// own eventual emitResult call still handles data-dependent jq errors and
// the success/failure path, unchanged).
export function preflightJqFilter(jq, { stderr = process.stderr } = {}) {
  if (jq === undefined) return undefined;
  try {
    assertJqFilterSyntax(jq);
    return undefined;
  } catch (error) {
    if (!(error instanceof JqFilterError)) throw error;
    stderr.write(`${formatJqFilterErrorEnvelope(error)}\n`);
    return 2;
  }
}

function renderJqStream(stream) {
  // jq prints each value on its own line; single value => just that value.
  return stream
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v ?? null)))
    .join("\n");
}

// Standard option block to merge into a parseArgs `options` map so every script
// exposes the same flags.
export const JQ_OUTPUT_PARSE_OPTIONS = {
  jq: { type: "string" },
  silent: { type: "boolean", short: "s" },
};

// Shared USAGE fragment so every script documents the flags identically.
export const JQ_OUTPUT_USAGE = `Output filtering:
  --jq <filter>             Apply a jq-subset filter to the result and print it
                            (field access, .[]/.[N], pipes, select(...), ==,!=,<,<=,>,>=, length, keys).
                            Invalid filter fails closed (stderr + exit 2).
  --silent, -s              Suppress stdout; map result to exit code only
                            (0 = pass/truthy, 1 = fail/falsy). Composes with --jq as a predicate.`;

// Shared token-matcher for scripts that hand-roll a `parseArgs({ tokens: true })`
// loop (rather than reading `values.jq`/`values.silent` off a strict parse).
// Call once per `option` token: `if (matchJqOutputToken(token, options)) continue;`.
// `requireValue` extracts the `--jq <value>` argument; pass the script's own
// value-extraction function (e.g. `(t) => requireTokenValue(t, parseError)`) to
// preserve its existing error semantics. Defaults to the raw token value.
export function matchJqOutputToken(token, options, requireValue = (t) => t.value) {
  if (token.name === "jq") {
    options.jq = requireValue(token);
    return true;
  }
  if (token.name === "silent") {
    options.silent = true;
    return true;
  }
  return false;
}

// Apply --jq / --silent to a result object and emit. Returns the exit code the
// CLI should use (0 success / truthy, 1 falsy or non-ok, 2 invalid filter).
// Without jq/silent the result is printed verbatim as JSON (unchanged shape).
//
//   ok: success of the underlying result (defaults to result.ok !== false).
export function emitResult(
  result,
  {
    jq = undefined,
    silent = false,
    stdout = process.stdout,
    stderr = process.stderr,
    ok = result?.ok !== false,
  } = {},
) {
  if (jq !== undefined) {
    let stream;
    try {
      stream = evaluateJqFilter(result, jq);
    } catch (error) {
      if (error instanceof JqFilterError) {
        // Fail closed, distinct from a clean "predicate false". Exit 2.
        stderr.write(`${formatJqFilterErrorEnvelope(error)}\n`);
        return 2;
      }
      throw error;
    }
    if (silent) {
      return streamIsTruthy(stream) ? 0 : 1;
    }
    stdout.write(`${renderJqStream(stream)}\n`);
    return ok ? 0 : 1;
  }
  if (silent) {
    return ok ? 0 : 1;
  }
  stdout.write(`${JSON.stringify(result)}\n`);
  return ok ? 0 : 1;
}
