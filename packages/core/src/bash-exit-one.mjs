import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

export const DEFAULT_OUTPUT_LIMIT = 4000;

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

export function truncateText(value, limit = DEFAULT_OUTPUT_LIMIT) {
  if (value === undefined || value === null) {
    return undefined;
  }

  const text = String(value);
  if (text.length <= limit) {
    return text;
  }

  const truncatedCount = text.length - limit;
  return `${text.slice(0, limit)}…[truncated ${truncatedCount} chars]`;
}

export function normalizeBashExitOneRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("record must be an object");
  }

  const exitCode = Number(record.exitCode);
  if (exitCode !== 1) {
    throw new Error(`exitCode must be 1, received ${record.exitCode}`);
  }

  const normalized = {
    timestamp:
      typeof record.timestamp === "string" && record.timestamp.trim().length > 0
        ? record.timestamp.trim()
        : new Date().toISOString(),
    phase: requireNonEmptyString(record.phase, "phase"),
    cwd: requireNonEmptyString(record.cwd, "cwd"),
    command: requireNonEmptyString(record.command, "command"),
    exitCode: 1,
    purpose: requireNonEmptyString(record.purpose, "purpose"),
    summary: requireNonEmptyString(record.summary, "summary"),
  };

  const stdout = truncateText(record.stdout);
  const stderr = truncateText(record.stderr);
  const artifactPath = truncateText(record.artifactPath, 2000);

  if (stdout !== undefined && stdout.length > 0) {
    normalized.stdout = stdout;
  }

  if (stderr !== undefined && stderr.length > 0) {
    normalized.stderr = stderr;
  }

  if (artifactPath !== undefined && artifactPath.length > 0) {
    normalized.artifactPath = artifactPath;
  }

  return normalized;
}

export function formatBashExitOneRecord(record) {
  return `${JSON.stringify(normalizeBashExitOneRecord(record))}\n`;
}

export async function appendBashExitOneRecord(logPath, record) {
  const normalized = normalizeBashExitOneRecord(record);
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(normalized)}\n`, "utf8");
  return normalized;
}

export function parseCliArgs(argv) {
  const { tokens } = parseArgs({
    args: [...argv],
    options: {
      log: { type: "string" },
      record: { type: "string" },
    },
    allowPositionals: false,
    strict: false,
    tokens: true,
  });

  let logPath;
  let recordJson;

  for (const token of tokens) {
    if (token.kind === "positional") {
      throw new Error(`Unknown argument: ${token.value}`);
    }

    if (token.kind !== "option") {
      continue;
    }

    if (token.name === "log") {
      logPath = token.value;
      continue;
    }

    if (token.name === "record") {
      recordJson = token.value;
      continue;
    }

    throw new Error(`Unknown argument: ${token.rawName}`);
  }

  if (!logPath) {
    throw new Error("Missing required --log <path> argument");
  }

  return { logPath, recordJson };
}

export async function readRecordFromStdin(stream = process.stdin) {
  let input = "";

  for await (const chunk of stream) {
    input += chunk;
  }

  if (input.trim().length === 0) {
    throw new Error("Expected a JSON record via --record or stdin");
  }

  return JSON.parse(input);
}

export async function runCli(argv = process.argv.slice(2), stream = process.stdin) {
  const { logPath, recordJson } = parseCliArgs(argv);
  const record = recordJson ? JSON.parse(recordJson) : await readRecordFromStdin(stream);
  const normalized = await appendBashExitOneRecord(logPath, record);

  process.stdout.write(
    `${JSON.stringify({ ok: true, logPath, record: normalized })}\n`,
  );
}
