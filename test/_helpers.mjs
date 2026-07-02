import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function runNode(scriptPath, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(options.execPath ?? process.execPath, [scriptPath, ...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });

    child.stdin.end(options.stdinText ?? options.stdin ?? "");
  });
}

export async function writeJson(filePath, data) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function buildGhStubScript() {
  return [
    "#!/usr/bin/env node",
    'const { appendFileSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");',
    'const path = require("node:path");',
    'const sequencePath = process.env.GH_SEQUENCE_PATH;',
    'const counterPath = process.env.GH_COUNTER_PATH;',
    'const claimsDir = process.env.GH_CLAIMS_DIR;',
    'const ghLogPath = process.env.GH_LOG_PATH;',
    'const mode = process.env.GH_STUB_MODE || "sequential";',
    'const repeatLast = process.env.GH_REPEAT_LAST_ON_OVERFLOW === "1";',
    'const defaultStdout = process.env.GH_DEFAULT_STDOUT ?? "{}\\n";',
    'const entries = JSON.parse(readFileSync(sequencePath, "utf8"));',
    'const actual = process.argv.slice(2);',
    'const fail = (code, message) => { process.stderr.write(`${message}\\n`); process.exit(code); };',
    'let entry = null;',
    'if (mode === "claims") {',
    '  for (let index = 0; index < entries.length; index += 1) {',
    '    const candidate = entries[index] ?? { stdout: defaultStdout };',
    '    const expectedArgs = Array.isArray(candidate.assertArgs) ? candidate.assertArgs : [];',
    '    if (!expectedArgs.every((expected) => actual.includes(expected))) continue;',
    '    try {',
    '      mkdirSync(path.join(claimsDir, String(index)));',
    '      entry = candidate;',
    '      break;',
    '    } catch {',
    '      continue;',
    '    }',
    '  }',
    '  if (entry == null) {',
    '    fail(97, `unexpected gh args: ${actual.join(" ")}`);',
    '  }',
    '} else {',
    '  const current = Number(readFileSync(counterPath, "utf8").trim() || "0");',
    '  if (current >= entries.length && !repeatLast) {',
    '    fail(97, `unexpected extra gh call #${current + 1}: ${actual.join(" ")}`);',
    '  }',
    '  const index = entries.length === 0 ? -1 : Math.min(current, entries.length - 1);',
    '  entry = index >= 0 ? (entries[index] ?? { stdout: defaultStdout }) : { stdout: defaultStdout };',
    '  writeFileSync(counterPath, String(current + 1));',
    '}',
    'if (ghLogPath) {',
    '  appendFileSync(ghLogPath, `${JSON.stringify(actual)}\\n`);',
    '}',
    'let stdin = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => { stdin += chunk; });',
    'process.stdin.on("end", () => {',
    '  if (entry.assertArgs) {',
    '    for (const expected of entry.assertArgs) {',
    '      if (!actual.includes(expected)) {',
    '        fail(98, `missing expected gh arg: ${expected}${actual.length > 0 ? `\\nactual: ${actual.join(" ")}` : ""}`);',
    '      }',
    '    }',
    '  }',
    '  if (entry.assertStdinIncludes) {',
    '    for (const expected of entry.assertStdinIncludes) {',
    '      if (!stdin.includes(expected)) {',
    '        fail(96, `missing expected stdin text: ${expected}`);',
    '      }',
    '    }',
    '  }',
    '  if (entry.assertArgContains) {',
    '    for (const expected of entry.assertArgContains) {',
    '      if (!actual.some((a) => a.includes(expected))) {',
    '        fail(94, `missing expected arg substring: ${expected}\\nactual: ${actual.join(" ")}`);',
    '      }',
    '    }',
    '  }',
    '  if (entry.assertArgNotContains) {',
    '    for (const forbidden of entry.assertArgNotContains) {',
    '      if (actual.some((a) => a.includes(forbidden))) {',
    '        fail(93, `unexpected arg substring: ${forbidden}`);',
    '      }',
    '    }',
    '  }',
    '  if (entry.stderr) process.stderr.write(entry.stderr);',
    '  if (entry.stdout) process.stdout.write(entry.stdout);',
    '  process.exit(entry.exitCode ?? 0);',
    '});',
    "",
  ].join("\n");
}

export async function writeGhStub(tempDir, entries = [], {
  commandName = "gh",
  matchMode = "sequential",
  repeatLastOnOverflow = false,
  defaultStdout = "{}\n",
  logCalls = false,
} = {}) {
  const sequencePath = path.join(tempDir, `${commandName}-sequence.json`);
  const ghPath = path.join(tempDir, commandName);
  const counterPath = matchMode === "claims" ? null : path.join(tempDir, `${commandName}-counter.txt`);
  const claimsDir = matchMode === "claims" ? path.join(tempDir, `${commandName}-claims`) : null;
  const ghLogPath = logCalls ? path.join(tempDir, `${commandName}-log.jsonl`) : null;

  await writeFile(sequencePath, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  if (counterPath) {
    await writeFile(counterPath, "0\n", "utf8");
  }
  if (claimsDir) {
    await mkdir(claimsDir, { recursive: true });
  }
  if (ghLogPath) {
    await writeFile(ghLogPath, "", "utf8");
  }
  await writeFile(ghPath, buildGhStubScript(), "utf8");
  await chmod(ghPath, 0o755);

  const env = {
    ...process.env,
    PATH: [tempDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    GH_SEQUENCE_PATH: sequencePath,
    GH_STUB_MODE: matchMode,
    GH_REPEAT_LAST_ON_OVERFLOW: repeatLastOnOverflow ? "1" : "0",
    GH_DEFAULT_STDOUT: defaultStdout,
  };

  if (counterPath) {
    env.GH_COUNTER_PATH = counterPath;
  }
  if (claimsDir) {
    env.GH_CLAIMS_DIR = claimsDir;
  }
  if (ghLogPath) {
    env.GH_LOG_PATH = ghLogPath;
  }

  return {
    env,
    ghPath,
    ghLogPath,
    sequencePath,
    counterPath,
    claimsDir,
  };
}
