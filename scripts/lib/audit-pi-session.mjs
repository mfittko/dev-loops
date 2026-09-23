import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

function toNonNegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isUsageBearing(turn) {
  const { usage } = turn;
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens]
    .some((value) => typeof value === "number" && value > 0);
}

function findRepositoryRoot(startPath) {
  let current = path.resolve(startPath);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(startPath);
    current = parent;
  }
}

function canonicalRepositoryRoot(repositoryCwd) {
  const repositoryRoot = findRepositoryRoot(repositoryCwd);
  const worktreeMarker = `${path.sep}tmp${path.sep}worktrees${path.sep}`;
  const markerIndex = repositoryRoot.indexOf(worktreeMarker);
  return markerIndex === -1 ? repositoryRoot : repositoryRoot.slice(0, markerIndex);
}

function piSessionDirectoryPrefix(repositoryRoot) {
  return `--${repositoryRoot.replace(/^[/\\]+/, "").split(path.sep).join("-")}--`;
}

/**
 * Find the latest session directory or session file for this repository,
 * including sessions launched from one of its tmp/worktrees entries.
 * @param {string} [sessionsBaseDir]
 * @param {string} [repositoryCwd]
 * @returns {string | null}
 */
export function findLatestPiSession(
  sessionsBaseDir = path.join(os.homedir(), ".pi", "agent", "sessions"),
  repositoryCwd = process.cwd(),
) {
  if (!fs.existsSync(sessionsBaseDir)) return null;

  const repositoryPrefix = piSessionDirectoryPrefix(canonicalRepositoryRoot(repositoryCwd));
  const worktreePrefix = `${repositoryPrefix.slice(0, -2)}-tmp-worktrees-`;
  const entries = fs.readdirSync(sessionsBaseDir, { withFileTypes: true });
  const matchingDirs = entries
    .filter((entry) => entry.isDirectory() && (
      entry.name === repositoryPrefix ||
      (entry.name.startsWith(worktreePrefix) && entry.name.endsWith("--"))
    ))
    .map((entry) => path.join(sessionsBaseDir, entry.name));

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
 * @returns {{ files: string[] }}
 */
function collectTranscriptFilesWithMetadata(targetPath) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`Path does not exist: ${targetPath}`);
  }

  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return { files: [targetPath] };
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

  // If there are true session.jsonl files, deduplicate mirrored subagent artifacts.
  const hasRealSessions = rawList.some((f) => path.basename(f) === "session.jsonl");
  const withoutArtifacts = hasRealSessions
    ? rawList.filter((f) => !f.includes(`${path.sep}subagent-artifacts${path.sep}`))
    : rawList;

  // Fork snapshots remain in the audit. parseTranscriptFile removes their inherited
  // replay prefix while retaining the fork's own continuation.
  return { files: withoutArtifacts.sort() };
}

/**
 * @param {string} targetPath
 * @returns {string[]}
 */
export function collectTranscriptFiles(targetPath) {
  return collectTranscriptFilesWithMetadata(targetPath).files;
}

/**
 * Parse assistant usage entries from a single jsonl file.
 * @param {string} filePath
 * @returns {Promise<{ turns: any[], sessionInfo: any, agent: string | null, isForkSnapshot: boolean, inheritedTurnCount: number, malformedLineCount: number }>}
 */
export async function parseTranscriptFile(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    return {
      turns: [],
      sessionInfo: null,
      agent: null,
      isForkSnapshot: false,
      inheritedTurnCount: 0,
      malformedLineCount: 0,
    };
  }

  let turns = [];
  let sessionInfo = null;
  let sessionInfoCount = 0;
  let currentAgent = null;
  let segmentId = 0;
  let isForkSnapshot = false;
  let sessionHeaderSeen = false;
  let forkBoundarySeen = false;
  let inheritedTurnCount = 0;
  let malformedLineCount = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const data = JSON.parse(trimmed);

      // Pi marks a genuine fork on this transcript's own session header. A plain
      // run-0 transcript may contain many session_info records and is not a fork.
      if (data.type === "session" && !sessionHeaderSeen) {
        sessionHeaderSeen = true;
        isForkSnapshot = data.parentSession !== null && data.parentSession !== undefined;
      }

      if (data.type === "session_info" && data.name) {
        sessionInfoCount += 1;
        segmentId += 1;
        if (isForkSnapshot && !forkBoundarySeen && sessionInfoCount > 1) {
          inheritedTurnCount = turns.filter(isUsageBearing).length;
          turns = [];
          forkBoundarySeen = true;
        }
        sessionInfo = data;
        currentAgent = data.name;
      }

      const isAssistant =
        (data.type === "message" && data.message?.role === "assistant") ||
        data.role === "assistant";

      if (isAssistant) {
        const msg = data.message || data;
        const usage = msg.usage || data.usage;
        if (usage) {
          const input = toNonNegativeFiniteNumber(usage.input);
          const output = toNonNegativeFiniteNumber(usage.output);
          const cacheRead = toNonNegativeFiniteNumber(usage.cacheRead);
          const cacheWrite = toNonNegativeFiniteNumber(usage.cacheWrite);
          const explicitTotal = toNonNegativeFiniteNumber(usage.totalTokens);
          const componentTotal = [input, output, cacheRead, cacheWrite].every((value) => value !== null)
            ? input + output + cacheRead + cacheWrite
            : null;
          turns.push({
            timestamp: data.timestamp || msg.timestamp || null,
            model: msg.model || data.model || "unknown",
            agent: data.agent || currentAgent || null,
            segmentId,
            usage: {
              input,
              output,
              cacheRead,
              cacheWrite,
              reasoning: toNonNegativeFiniteNumber(usage.reasoning),
              totalTokens: componentTotal ?? explicitTotal,
              cost: toNonNegativeFiniteNumber(usage.cost?.total ?? usage.cost),
            },
          });
        }
      }
    } catch {
      malformedLineCount += 1;
    }
  }

  return {
    turns,
    sessionInfo,
    agent: currentAgent,
    isForkSnapshot,
    inheritedTurnCount,
    malformedLineCount,
  };
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
  return "coordinator";
}

const AGGREGATE_DIMENSIONS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"];

function createUsageAggregate() {
  return {
    turns: 0,
    values: Object.fromEntries(AGGREGATE_DIMENSIONS.map((dimension) => [dimension, 0])),
    available: Object.fromEntries(AGGREGATE_DIMENSIONS.map((dimension) => [dimension, true])),
  };
}

function addUsageToAggregate(aggregate, usage) {
  aggregate.turns += 1;
  for (const dimension of AGGREGATE_DIMENSIONS) {
    const value = usage[dimension];
    if (value === null) {
      aggregate.available[dimension] = false;
    } else {
      aggregate.values[dimension] += value;
    }
  }
}

function aggregateValue(aggregate, dimension) {
  return aggregate.available[dimension] ? aggregate.values[dimension] : null;
}

function aggregateCacheHitRatio(aggregate) {
  const input = aggregateValue(aggregate, "input");
  const cacheRead = aggregateValue(aggregate, "cacheRead");
  if (input === null || cacheRead === null || input + cacheRead < 1) return null;
  return Number((cacheRead / (input + cacheRead)).toFixed(4));
}

function roundCost(value) {
  return value === null ? null : Number(value.toFixed(4));
}

function splitTurnsByAgentSegment(turns) {
  const groups = [];
  for (const turn of turns) {
    const previous = groups.at(-1);
    if (!previous || previous.segmentId !== turn.segmentId || previous.agent !== turn.agent) {
      groups.push({ segmentId: turn.segmentId, agent: turn.agent, turns: [turn] });
    } else {
      previous.turns.push(turn);
    }
  }
  return groups;
}

/**
 * Audit an entire Pi session directory or file.
 * @param {string} targetPath
 * @returns {Promise<object>}
 */
export async function auditPiSession(targetPath) {
  const { files } = collectTranscriptFilesWithMetadata(targetPath);
  if (files.length === 0) {
    throw new Error(`No .jsonl transcripts found in ${targetPath}`);
  }

  const sessions = [];
  const modelAggregates = Object.create(null);
  const overallAggregate = createUsageAggregate();

  let forkSnapshotsProcessed = 0;
  let retainedForkTurns = 0;
  let skippedInheritedForkTurns = 0;
  let malformedLines = 0;

  for (const file of files) {
    const parsed = await parseTranscriptFile(file);
    const usageTurns = parsed.turns.filter(isUsageBearing);
    malformedLines += parsed.malformedLineCount;
    if (parsed.isForkSnapshot) {
      forkSnapshotsProcessed += 1;
      retainedForkTurns += usageTurns.length;
      skippedInheritedForkTurns += parsed.inheritedTurnCount;
    }
    if (usageTurns.length === 0) continue;

    for (const group of splitTurnsByAgentSegment(usageTurns)) {
      const sessionAggregate = createUsageAggregate();
      const modelsInSession = new Set();

      for (const turn of group.turns) {
        addUsageToAggregate(sessionAggregate, turn.usage);
        addUsageToAggregate(overallAggregate, turn.usage);
        modelsInSession.add(turn.model);

        if (!modelAggregates[turn.model]) {
          modelAggregates[turn.model] = createUsageAggregate();
        }
        addUsageToAggregate(modelAggregates[turn.model], turn.usage);
      }

      const promptTurns = group.turns.filter((turn) => (
        turn.usage.input !== null &&
        turn.usage.cacheRead !== null &&
        turn.usage.input + turn.usage.cacheRead > 0
      ));
      const firstTurn = promptTurns[0] ?? null;
      const lastTurn = promptTurns.at(-1) ?? null;
      const initialPromptTokens = firstTurn
        ? firstTurn.usage.input + firstTurn.usage.cacheRead
        : null;
      const finalPromptTokens = lastTurn
        ? lastTurn.usage.input + lastTurn.usage.cacheRead
        : null;
      const promptGrowthFactor = initialPromptTokens !== null && initialPromptTokens >= 1
        ? Number((finalPromptTokens / initialPromptTokens).toFixed(2))
        : null;

      const role = deriveSessionRole(file, {
        sessionInfo: group.agent ? { name: group.agent } : null,
        agent: group.agent,
      });
      sessions.push({
        file: path.relative(process.cwd(), file),
        role,
        sessionName: group.agent,
        models: Array.from(modelsInSession),
        turnCount: group.turns.length,
        inputTokens: aggregateValue(sessionAggregate, "input"),
        outputTokens: aggregateValue(sessionAggregate, "output"),
        cacheReadTokens: aggregateValue(sessionAggregate, "cacheRead"),
        cacheWriteTokens: aggregateValue(sessionAggregate, "cacheWrite"),
        totalTokens: aggregateValue(sessionAggregate, "totalTokens"),
        cost: roundCost(aggregateValue(sessionAggregate, "cost")),
        snowball: {
          initialPromptTokens,
          finalPromptTokens,
          promptGrowthFactor,
          cacheHitRatio: aggregateCacheHitRatio(sessionAggregate),
        },
      });
    }
  }

  if (sessions.length === 0) {
    throw new Error(`No assistant turns with token usage found in ${targetPath}`);
  }

  const modelAggregation = Object.create(null);
  for (const [model, aggregate] of Object.entries(modelAggregates)) {
    modelAggregation[model] = {
      turns: aggregate.turns,
      input: aggregateValue(aggregate, "input"),
      output: aggregateValue(aggregate, "output"),
      cacheRead: aggregateValue(aggregate, "cacheRead"),
      cacheWrite: aggregateValue(aggregate, "cacheWrite"),
      totalTokens: aggregateValue(aggregate, "totalTokens"),
      cost: roundCost(aggregateValue(aggregate, "cost")),
      cacheHitRatio: aggregateCacheHitRatio(aggregate),
    };
  }

  return {
    ok: true,
    targetPath,
    totalFilesExamined: files.length,
    forkSnapshotsProcessed,
    retainedForkTurns,
    skippedInheritedForkTurns,
    malformedLines,
    activeSessionsCount: sessions.length,
    summary: {
      totalTurns: overallAggregate.turns,
      inputTokens: aggregateValue(overallAggregate, "input"),
      outputTokens: aggregateValue(overallAggregate, "output"),
      cacheReadTokens: aggregateValue(overallAggregate, "cacheRead"),
      cacheWriteTokens: aggregateValue(overallAggregate, "cacheWrite"),
      totalTokens: aggregateValue(overallAggregate, "totalTokens"),
      cacheHitRatio: aggregateCacheHitRatio(overallAggregate),
      estimatedCost: roundCost(aggregateValue(overallAggregate, "cost")),
      malformedLines,
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
function formatTokenCount(value) {
  return value === null || value === undefined
    ? "n/a"
    : String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatRatio(value) {
  return value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function formatCost(value) {
  return value === null || value === undefined ? "n/a" : `$${value.toFixed(4)}`;
}

function escapeMarkdown(value) {
  return String(value)
    .replace(/\\/g, "&#92;")
    .replace(/`/g, "&#96;")
    .replace(/\|/g, "\\|")
    .replace(/\r\n?|\n/g, "<br>");
}

export function formatMarkdownSummary(auditResult) {
  const {
    summary,
    byModel,
    sessions,
    targetPath,
    forkSnapshotsProcessed = 0,
    retainedForkTurns = 0,
    skippedInheritedForkTurns = 0,
    malformedLines = summary.malformedLines ?? 0,
  } = auditResult;

  const lines = [];
  lines.push("## Pi Session Token Audit");
  lines.push("");
  lines.push(`- **Resolved Target**: \`${escapeMarkdown(targetPath ?? "unknown")}\``);
  lines.push(`- **Total Turns**: ${summary.totalTurns}`);
  const totalMillions = summary.totalTokens === null || summary.totalTokens === undefined
    ? "n/a"
    : `${(summary.totalTokens / 1_000_000).toFixed(2)}M`;
  lines.push(`- **Total Tokens**: ${formatTokenCount(summary.totalTokens)} (${totalMillions})`);
  lines.push(`- **Uncached Input**: ${formatTokenCount(summary.inputTokens)}`);
  lines.push(`- **Cached Read**: ${formatTokenCount(summary.cacheReadTokens)}`);
  lines.push(`- **Output**: ${formatTokenCount(summary.outputTokens)}`);
  lines.push(`- **Cache Hit Ratio**: ${formatRatio(summary.cacheHitRatio)}`);
  lines.push(`- **Estimated Cost**: ${formatCost(summary.estimatedCost)}`);
  lines.push(`- **Fork Snapshots**: ${forkSnapshotsProcessed} processed; ${retainedForkTurns} fork-own turns retained; ${skippedInheritedForkTurns} inherited turns excluded`);
  if (malformedLines > 0) {
    lines.push(`- **Malformed Lines**: ${malformedLines} skipped while parsing; totals may be incomplete`);
  }
  lines.push("");

  lines.push("### Usage by Model");
  lines.push("");
  lines.push("| Model | Turns | Input | Cached Read | Output | Cache Ratio | Total Tokens | Cost |");
  lines.push("| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |");
  for (const [model, data] of Object.entries(byModel)) {
    lines.push(
      `| \`${escapeMarkdown(model)}\` | ${data.turns} | ${formatTokenCount(data.input)} | ${formatTokenCount(data.cacheRead)} | ${formatTokenCount(data.output)} | ${formatRatio(data.cacheHitRatio)} | ${formatTokenCount(data.totalTokens)} | ${formatCost(data.cost)} |`
    );
  }
  lines.push("");

  lines.push("### Session Breakdown & Context Snowballing");
  lines.push("");
  lines.push("| Role | Turns | Models | Total Tokens | Cache Ratio | Init Prompt | Final Prompt | Growth |");
  lines.push("| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |");
  for (const s of sessions) {
    const modelsStr = s.models.map((model) => `\`${escapeMarkdown(model)}\``).join(", ");
    const growth = s.snowball.promptGrowthFactor === null ? "n/a" : `${s.snowball.promptGrowthFactor}x`;
    lines.push(
      `| **${escapeMarkdown(s.role)}** | ${s.turnCount} | ${modelsStr} | ${formatTokenCount(s.totalTokens)} | ${formatRatio(s.snowball.cacheHitRatio)} | ${formatTokenCount(s.snowball.initialPromptTokens)} | ${formatTokenCount(s.snowball.finalPromptTokens)} | ${growth} |`
    );
  }
  lines.push("");

  const warnings = [];
  for (const s of sessions) {
    const role = escapeMarkdown(s.role);
    if (s.turnCount > 100) {
      warnings.push(`- ⚠️ **High turn count**: Session \`${role}\` ran for ${s.turnCount} turns. Monolithic coordinators risk severe context snowballing.`);
    }
    if (s.snowball.promptGrowthFactor !== null && s.snowball.promptGrowthFactor > 15) {
      warnings.push(`- ⚠️ **Severe context growth**: Session \`${role}\` grew by ${s.snowball.promptGrowthFactor}x from initial prompt (${formatTokenCount(s.snowball.initialPromptTokens)} to ${formatTokenCount(s.snowball.finalPromptTokens)} tokens).`);
    }
    if (s.snowball.cacheHitRatio !== null && s.totalTokens !== null && s.snowball.cacheHitRatio < 0.70 && s.totalTokens >= 500_000) {
      warnings.push(`- ⚠️ **Low cache hit ratio**: Session \`${role}\` has ${formatRatio(s.snowball.cacheHitRatio)} cache hit ratio with >500k tokens.`);
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
