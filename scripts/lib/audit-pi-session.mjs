import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

/**
 * Find the latest session directory or session file under ~/.pi/agent/sessions/--Users-*-dev-loops--/
 * @param {string} [sessionsBaseDir]
 * @returns {string | null}
 */
export function findLatestPiSession(sessionsBaseDir = path.join(os.homedir(), ".pi", "agent", "sessions")) {
  if (!fs.existsSync(sessionsBaseDir)) return null;

  // Find candidate directories matching --Users-*-dev-loops--
  const entries = fs.readdirSync(sessionsBaseDir, { withFileTypes: true });
  const matchingDirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("--Users-") && e.name.includes("dev-loops"))
    .map((e) => path.join(sessionsBaseDir, e.name));

  if (matchingDirs.length === 0) return null;

  // Among all matching dirs, find the most recently modified session file or subfolder
  let latestPath = null;
  let latestMtime = 0;

  for (const dir of matchingDirs) {
    const dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.name === "subagent-artifacts") continue;
      // We look for either .jsonl files directly under the dir, or session directories
      if (entry.name.endsWith(".jsonl") || entry.isDirectory()) {
        const fullPath = path.join(dir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs > latestMtime) {
            latestMtime = stat.mtimeMs;
            // If it's a .jsonl file, check if there's a matching directory without .jsonl
            if (entry.name.endsWith(".jsonl")) {
              const dirWithoutExt = fullPath.slice(0, -".jsonl".length);
              if (fs.existsSync(dirWithoutExt) && fs.statSync(dirWithoutExt).isDirectory()) {
                latestPath = dirWithoutExt;
              } else {
                latestPath = fullPath;
              }
            } else {
              latestPath = fullPath;
            }
          }
        } catch {
          // ignore stat errors
        }
      }
    }
  }

  return latestPath;
}

/**
 * Collect all canonical session.jsonl files under the target path,
 * preferring true session.jsonl over mirrored/duplicated subagent-artifacts.
 * @param {string} targetPath
 * @returns {string[]}
 */
export function collectTranscriptFiles(targetPath) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Path does not exist: ${targetPath}`);
  }

  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return [targetPath];
  }

  const files = [];

  // Check if targetPath has a sibling or matching .jsonl (e.g. coordinator session alongside session subfolder)
  const matchingJsonl = `${targetPath}.jsonl`;
  if (fs.existsSync(matchingJsonl) && fs.statSync(matchingJsonl).isFile()) {
    files.push(matchingJsonl);
  }

  function walk(current) {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }

  walk(targetPath);

  const rawList = Array.from(new Set(files));

  // If there are true session.jsonl files, deduplicate out identical subagent-artifacts transcripts
  const hasRealSessions = rawList.some((f) => f.endsWith("session.jsonl"));
  const filtered = hasRealSessions
    ? rawList.filter((f) => !f.includes("/subagent-artifacts/") && !f.includes("\\subagent-artifacts\\"))
    : rawList;

  return filtered.sort();
}

/**
 * Parse assistant usage entries from a single jsonl file.
 * @param {string} filePath
 * @returns {Promise<{ turns: any[], sessionInfo: any, agent: string | null, empty: boolean }>}
 */
export async function parseTranscriptFile(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    return { turns: [], sessionInfo: null, agent: null, empty: true };
  }

  const turns = [];
  let sessionInfo = null;
  let fileAgent = null;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const data = JSON.parse(trimmed);

      if (data.type === "session_info" && data.name) {
        sessionInfo = data;
      }
      if (data.agent && !fileAgent) {
        fileAgent = data.agent;
      }

      // Check for assistant message
      const isAssistant =
        (data.type === "message" && data.message?.role === "assistant") ||
        data.role === "assistant";

      if (isAssistant) {
        const msg = data.message || data;
        const usage = msg.usage || data.usage;
        if (usage) {
          const model = msg.model || data.model || "unknown";
          const agent = data.agent || fileAgent || null;
          turns.push({
            timestamp: data.timestamp || msg.timestamp || null,
            model,
            agent,
            usage: {
              input: usage.input || 0,
              output: usage.output || 0,
              cacheRead: usage.cacheRead || 0,
              cacheWrite: usage.cacheWrite || 0,
              reasoning: usage.reasoning || 0,
              totalTokens: usage.totalTokens || ((usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0)),
              cost: usage.cost?.total ?? (typeof usage.cost === "number" ? usage.cost : 0),
            },
          });
        }
      }
    } catch {
      // ignore JSON parse error on malformed lines
    }
  }

  return { turns, sessionInfo, agent: fileAgent, empty: false };
}

/**
 * Derive session role / category from file path, sessionInfo, and turns
 * @param {string} filePath
 * @param {object} parsed
 * @returns {string}
 */
export function deriveSessionRole(filePath, parsed) {
  if (parsed.sessionInfo?.name) {
    const name = parsed.sessionInfo.name;
    const match = name.match(/subagent-([a-zA-Z0-9_-]+)-[0-9a-f]{8}-/);
    if (match && match[1]) {
      return match[1];
    }
    // Check known roles
    for (const r of ["dev-loop", "review", "fixer", "judge", "developer", "quality", "docs", "refiner"]) {
      if (name.includes(r)) return r;
    }
    return name;
  }
  if (parsed.agent) return parsed.agent;
  const basename = path.basename(filePath);
  if (basename.includes("_review_") || basename.includes("review")) return "review";
  if (basename.includes("_fixer_") || basename.includes("fixer")) return "fixer";
  if (basename.includes("_judge_") || basename.includes("judge")) return "judge";
  if (basename.includes("_developer_") || basename.includes("developer")) return "developer";
  if (basename.includes("_quality_") || basename.includes("quality")) return "quality";
  if (basename.includes("_docs_") || basename.includes("docs")) return "docs";
  if (basename.includes("_refiner_") || basename.includes("refiner")) return "refiner";
  if (filePath.endsWith(".jsonl") && !filePath.includes("/")) return "main-session";
  const norm = filePath.replace(/\\/g, "/");
  if (norm.split("/").length <= 2 && !norm.includes("/run-")) return "main-session";
  return "coordinator";
}

/**
 * Audit an entire Pi session directory or file.
 * @param {string} targetPath
 * @returns {Promise<object>}
 */
export async function auditPiSession(targetPath) {
  const files = collectTranscriptFiles(targetPath);
  if (files.length === 0) {
    throw new Error(`No .jsonl transcripts found in ${targetPath}`);
  }

  const sessions = [];
  const modelAggregation = {};

  let overallTotalInput = 0;
  let overallTotalOutput = 0;
  let overallTotalCacheRead = 0;
  let overallTotalCacheWrite = 0;
  let overallTotalCost = 0;
  let overallTurns = 0;

  for (const file of files) {
    const parsed = await parseTranscriptFile(file);
    if (parsed.turns.length === 0) continue;

    const role = deriveSessionRole(file, parsed);
    let sessionInput = 0;
    let sessionOutput = 0;
    let sessionCacheRead = 0;
    let sessionCacheWrite = 0;
    let sessionCost = 0;

    const modelsInSession = new Set();

    for (const turn of parsed.turns) {
      const u = turn.usage;
      sessionInput += u.input;
      sessionOutput += u.output;
      sessionCacheRead += u.cacheRead;
      sessionCacheWrite += u.cacheWrite;
      sessionCost += u.cost;
      modelsInSession.add(turn.model);

      if (!modelAggregation[turn.model]) {
        modelAggregation[turn.model] = {
          turns: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: 0,
        };
      }
      const m = modelAggregation[turn.model];
      m.turns++;
      m.input += u.input;
      m.output += u.output;
      m.cacheRead += u.cacheRead;
      m.cacheWrite += u.cacheWrite;
      m.totalTokens += (u.input + u.output + u.cacheRead + u.cacheWrite);
      m.cost += u.cost;
    }

    const firstTurn = parsed.turns[0];
    const lastTurn = parsed.turns[parsed.turns.length - 1];

    const initialPromptTokens = firstTurn.usage.input + firstTurn.usage.cacheRead;
    const finalPromptTokens = lastTurn.usage.input + lastTurn.usage.cacheRead;
    const promptGrowthFactor = initialPromptTokens >= 1
      ? Number((finalPromptTokens / initialPromptTokens).toFixed(2))
      : 1;

    const totalPromptTokens = sessionInput + sessionCacheRead;
    const cacheHitRatio = totalPromptTokens >= 1
      ? Number((sessionCacheRead / totalPromptTokens).toFixed(4))
      : 0;

    sessions.push({
      file: path.relative(process.cwd(), file),
      role,
      sessionName: parsed.sessionInfo?.name || null,
      models: Array.from(modelsInSession),
      turnCount: parsed.turns.length,
      inputTokens: sessionInput,
      outputTokens: sessionOutput,
      cacheReadTokens: sessionCacheRead,
      cacheWriteTokens: sessionCacheWrite,
      totalTokens: sessionInput + sessionOutput + sessionCacheRead + sessionCacheWrite,
      cost: Number(sessionCost.toFixed(4)),
      snowball: {
        initialPromptTokens,
        finalPromptTokens,
        promptGrowthFactor,
        cacheHitRatio,
      },
    });

    overallTotalInput += sessionInput;
    overallTotalOutput += sessionOutput;
    overallTotalCacheRead += sessionCacheRead;
    overallTotalCacheWrite += sessionCacheWrite;
    overallTotalCost += sessionCost;
    overallTurns += parsed.turns.length;
  }

  if (sessions.length === 0) {
    throw new Error(`No assistant turns with token usage found in ${targetPath}`);
  }

  const overallTotalTokens = overallTotalInput + overallTotalOutput + overallTotalCacheRead + overallTotalCacheWrite;
  const overallPromptTokens = overallTotalInput + overallTotalCacheRead;
  const overallCacheHitRatio = overallPromptTokens >= 1
    ? Number((overallTotalCacheRead / overallPromptTokens).toFixed(4))
    : 0;

  // Calculate overall model cache ratios
  for (const m of Object.values(modelAggregation)) {
    const prompt = m.input + m.cacheRead;
    m.cacheHitRatio = prompt >= 1 ? Number((m.cacheRead / prompt).toFixed(4)) : 0;
    m.cost = Number(m.cost.toFixed(4));
  }

  return {
    ok: true,
    targetPath,
    totalFilesExamined: files.length,
    activeSessionsCount: sessions.length,
    summary: {
      totalTurns: overallTurns,
      inputTokens: overallTotalInput,
      outputTokens: overallTotalOutput,
      cacheReadTokens: overallTotalCacheRead,
      cacheWriteTokens: overallTotalCacheWrite,
      totalTokens: overallTotalTokens,
      cacheHitRatio: overallCacheHitRatio,
      estimatedCost: Number(overallTotalCost.toFixed(4)),
    },
    byModel: modelAggregation,
    sessions,
  };
}

/**
 * Format audit result as a Markdown summary table.
 * @param {object} auditResult
 * @returns {string}
 */
export function formatMarkdownSummary(auditResult) {
  const { summary, byModel, sessions } = auditResult;

  const lines = [];
  lines.push("## Pi Session Token Audit");
  lines.push("");
  lines.push(`- **Total Turns**: ${summary.totalTurns}`);
  lines.push(`- **Total Tokens**: ${summary.totalTokens.toLocaleString()} (${(summary.totalTokens / 1_000_000).toFixed(2)}M)`);
  lines.push(`- **Uncached Input**: ${summary.inputTokens.toLocaleString()}`);
  lines.push(`- **Cached Read**: ${summary.cacheReadTokens.toLocaleString()}`);
  lines.push(`- **Output**: ${summary.outputTokens.toLocaleString()}`);
  lines.push(`- **Cache Hit Ratio**: ${(summary.cacheHitRatio * 100).toFixed(1)}%`);
  lines.push(`- **Estimated Cost**: $${summary.estimatedCost.toFixed(4)}`);
  lines.push("");

  lines.push("### Usage by Model");
  lines.push("");
  lines.push("| Model | Turns | Input | Cached Read | Output | Cache Ratio | Total Tokens | Cost |");
  lines.push("| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |");
  for (const [model, data] of Object.entries(byModel)) {
    lines.push(
      `| \`${model}\` | ${data.turns} | ${data.input.toLocaleString()} | ${data.cacheRead.toLocaleString()} | ${data.output.toLocaleString()} | ${(data.cacheHitRatio * 100).toFixed(1)}% | ${data.totalTokens.toLocaleString()} | $${data.cost.toFixed(4)} |`
    );
  }
  lines.push("");

  lines.push("### Session Breakdown & Context Snowballing");
  lines.push("");
  lines.push("| Role | Turns | Models | Total Tokens | Cache Ratio | Init Prompt | Final Prompt | Growth |");
  lines.push("| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |");
  for (const s of sessions) {
    const modelsStr = s.models.map((m) => `\`${m}\``).join(", ");
    lines.push(
      `| **${s.role}** | ${s.turnCount} | ${modelsStr} | ${s.totalTokens.toLocaleString()} | ${(s.snowball.cacheHitRatio * 100).toFixed(1)}% | ${s.snowball.initialPromptTokens.toLocaleString()} | ${s.snowball.finalPromptTokens.toLocaleString()} | ${s.snowball.promptGrowthFactor}x |`
    );
  }
  lines.push("");

  // Context Snowball Warnings
  const warnings = [];
  for (const s of sessions) {
    if (s.turnCount > 100) {
      warnings.push(`- ⚠️ **High turn count**: Session \`${s.role}\` ran for ${s.turnCount} turns. Monolithic coordinators risk severe context snowballing.`);
    }
    if (s.snowball.promptGrowthFactor > 15) {
      warnings.push(`- ⚠️ **Severe context growth**: Session \`${s.role}\` grew by ${s.snowball.promptGrowthFactor}x from initial prompt (${s.snowball.initialPromptTokens.toLocaleString()} to ${s.snowball.finalPromptTokens.toLocaleString()} tokens).`);
    }
    if (s.snowball.cacheHitRatio < 0.70 && s.totalTokens >= 500_000) {
      warnings.push(`- ⚠️ **Low cache hit ratio**: Session \`${s.role}\` has ${(s.snowball.cacheHitRatio * 100).toFixed(1)}% cache hit ratio with >500k tokens.`);
    }
  }

  if (warnings.length > 0) {
    lines.push("### Snowball & Efficiency Warnings");
    lines.push("");
    lines.push(...warnings);
    lines.push("");
  }

  return lines.join("\n");
}
