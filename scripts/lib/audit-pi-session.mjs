import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";

function toNonNegativeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isUsageBearing(turn) {
  const { usage } = turn;
  return [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens, usage.cost]
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

function latestTranscriptMtime(directoryPath) {
  let latestMtime = null;

  function walk(currentPath) {
    let entries;
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === "subagent-artifacts") continue;
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const mtime = fs.statSync(fullPath).mtimeMs;
          latestMtime = latestMtime === null ? mtime : Math.max(latestMtime, mtime);
        } catch {
          // ignore stat errors
        }
      }
    }
  }

  walk(directoryPath);
  return latestMtime;
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

  // Among all matching dirs, find the session whose transcript was most recently modified.
  let latestPath = null;
  let latestMtime = -Infinity;

  for (const dir of matchingDirs) {
    const dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.name === "subagent-artifacts") continue;
      const fullPath = path.join(dir, entry.name);
      let candidatePath = null;
      let candidateMtime = null;

      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          candidateMtime = fs.statSync(fullPath).mtimeMs;
          const dirWithoutExt = fullPath.slice(0, -".jsonl".length);
          if (fs.existsSync(dirWithoutExt) && fs.statSync(dirWithoutExt).isDirectory()) {
            candidatePath = dirWithoutExt;
            const nestedMtime = latestTranscriptMtime(dirWithoutExt);
            if (nestedMtime !== null) candidateMtime = Math.max(candidateMtime, nestedMtime);
          } else {
            candidatePath = fullPath;
          }
        } catch {
          // ignore stat errors
        }
      } else if (entry.isDirectory()) {
        candidatePath = fullPath;
        candidateMtime = latestTranscriptMtime(fullPath);
      }

      if (candidatePath !== null && candidateMtime !== null && candidateMtime > latestMtime) {
        latestMtime = candidateMtime;
        latestPath = candidatePath;
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
    const matchingDirectory = targetPath.endsWith(".jsonl") && path.basename(targetPath) !== "session.jsonl"
      ? targetPath.slice(0, -".jsonl".length)
      : null;
    if (
      matchingDirectory !== null &&
      fs.existsSync(matchingDirectory) &&
      fs.statSync(matchingDirectory).isDirectory()
    ) {
      return collectTranscriptFilesWithMetadata(matchingDirectory);
    }
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
 * @returns {Promise<{ turns: any[], sessionInfo: any, agent: string | null, isForkSnapshot: boolean, inheritedTurnCount: number, unresolvedForkBoundary: boolean, malformedLineCount: number }>}
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
      unresolvedForkBoundary: false,
      malformedLineCount: 0,
    };
  }

  let turns = [];
  let sessionInfo = null;
  let currentAgent = null;
  let segmentId = 0;
  let isForkSnapshot = false;
  let sessionHeaderSeen = false;
  let forkCreatedAt = null;
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
        isForkSnapshot = typeof data.parentSession === "string" && data.parentSession.length > 0;
        if (isForkSnapshot) {
          const parsedTimestamp = Date.parse(data.timestamp);
          forkCreatedAt = Number.isFinite(parsedTimestamp) ? parsedTimestamp : null;
        }
      }

      if (data.type === "session_info" && data.name) {
        segmentId += 1;
        // A fork replays its parent's prefix verbatim. The first marker at or after
        // the fork header's creation time starts the fork's own continuation.
        const sessionInfoTimestamp = Date.parse(data.timestamp);
        if (
          isForkSnapshot &&
          !forkBoundarySeen &&
          forkCreatedAt !== null &&
          Number.isFinite(sessionInfoTimestamp) &&
          sessionInfoTimestamp >= forkCreatedAt
        ) {
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
    unresolvedForkBoundary: isForkSnapshot && !forkBoundarySeen,
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
    reported: Object.fromEntries(AGGREGATE_DIMENSIONS.map((dimension) => [dimension, 0])),
    missing: Object.fromEntries(AGGREGATE_DIMENSIONS.map((dimension) => [dimension, 0])),
  };
}

function addUsageToAggregate(aggregate, usage) {
  aggregate.turns += 1;
  for (const dimension of AGGREGATE_DIMENSIONS) {
    const value = usage[dimension];
    if (value === null) {
      aggregate.missing[dimension] += 1;
    } else {
      aggregate.values[dimension] += value;
      aggregate.reported[dimension] += 1;
    }
  }
}

function aggregateValue(aggregate, dimension) {
  return aggregate.reported[dimension] > 0 ? aggregate.values[dimension] : null;
}

function aggregateAvailability(aggregate, dimension) {
  if (aggregate.reported[dimension] === 0) return "unavailable";
  return aggregate.missing[dimension] > 0 ? "partial" : "complete";
}

function aggregateCacheHitRatio(aggregate) {
  const input = aggregateValue(aggregate, "input");
  const cacheRead = aggregateValue(aggregate, "cacheRead");
  if (input === null || cacheRead === null || input + cacheRead < 1) return null;
  return Number((cacheRead / (input + cacheRead)).toFixed(4));
}

function aggregateCacheHitRatioAvailability(aggregate) {
  if (aggregateCacheHitRatio(aggregate) === null) return "unavailable";
  return ["input", "cacheRead"].some(
    (dimension) => aggregateAvailability(aggregate, dimension) !== "complete",
  ) ? "partial" : "complete";
}

function roundCost(value) {
  return value === null ? null : Number(value.toFixed(4));
}

function sessionAvailability(aggregate) {
  return {
    inputTokens: aggregateAvailability(aggregate, "input"),
    outputTokens: aggregateAvailability(aggregate, "output"),
    cacheReadTokens: aggregateAvailability(aggregate, "cacheRead"),
    cacheWriteTokens: aggregateAvailability(aggregate, "cacheWrite"),
    totalTokens: aggregateAvailability(aggregate, "totalTokens"),
    cacheHitRatio: aggregateCacheHitRatioAvailability(aggregate),
    estimatedCost: aggregateAvailability(aggregate, "cost"),
  };
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
  let unresolvedForkBoundaries = 0;
  let malformedLines = 0;

  for (const file of files) {
    const parsed = await parseTranscriptFile(file);
    const usageTurns = parsed.turns.filter(isUsageBearing);
    malformedLines += parsed.malformedLineCount;
    if (parsed.unresolvedForkBoundary) unresolvedForkBoundaries += 1;
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
        availability: sessionAvailability(sessionAggregate),
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
      availability: sessionAvailability(aggregate),
    };
  }

  return {
    ok: true,
    targetPath,
    totalFilesExamined: files.length,
    forkSnapshotsProcessed,
    retainedForkTurns,
    skippedInheritedForkTurns,
    unresolvedForkBoundaries,
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
      availability: sessionAvailability(overallAggregate),
      malformedLines,
      unresolvedForkBoundaries,
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
function markPartial(value, availability) {
  return availability === "partial" ? `${value} (partial)` : value;
}

function formatTokenCount(value, availability) {
  const formatted = value === null || value === undefined
    ? "n/a"
    : String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return markPartial(formatted, availability);
}

function formatRatio(value, availability) {
  const formatted = value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;
  return markPartial(formatted, availability);
}

function formatCost(value, availability) {
  const formatted = value === null || value === undefined ? "n/a" : `$${value.toFixed(4)}`;
  return markPartial(formatted, availability);
}

function escapeMarkdown(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/g, (character) => `&#${character.charCodeAt(0)};`)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "&#92;")
    .replace(/`/g, "&#96;")
    .replace(/\[/g, "&#91;")
    .replace(/\]/g, "&#93;")
    .replace(/\(/g, "&#40;")
    .replace(/\)/g, "&#41;")
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
    unresolvedForkBoundaries = summary.unresolvedForkBoundaries ?? 0,
    malformedLines = summary.malformedLines ?? 0,
  } = auditResult;

  const lines = [];
  lines.push("## Pi Session Token Audit");
  lines.push("");
  lines.push(`- **Resolved Target**: \`${escapeMarkdown(targetPath ?? "unknown")}\``);
  lines.push(`- **Transcript Files Examined**: ${auditResult.totalFilesExamined ?? "unknown"}`);
  lines.push(`- **Total Turns**: ${summary.totalTurns}`);
  const totalMillions = summary.totalTokens === null || summary.totalTokens === undefined
    ? "n/a"
    : `${(summary.totalTokens / 1_000_000).toFixed(2)}M`;
  lines.push(`- **Total Tokens**: ${formatTokenCount(summary.totalTokens, summary.availability?.totalTokens)} (${totalMillions})`);
  lines.push(`- **Uncached Input**: ${formatTokenCount(summary.inputTokens, summary.availability?.inputTokens)}`);
  lines.push(`- **Cached Read**: ${formatTokenCount(summary.cacheReadTokens, summary.availability?.cacheReadTokens)}`);
  lines.push(`- **Output**: ${formatTokenCount(summary.outputTokens, summary.availability?.outputTokens)}`);
  lines.push(`- **Cache Hit Ratio**: ${formatRatio(summary.cacheHitRatio, summary.availability?.cacheHitRatio)}`);
  lines.push(`- **Estimated Cost**: ${formatCost(summary.estimatedCost, summary.availability?.estimatedCost)}`);
  lines.push(`- **Fork Snapshots**: ${forkSnapshotsProcessed} processed; ${retainedForkTurns} fork-own turns retained; ${skippedInheritedForkTurns} inherited turns excluded`);
  if (unresolvedForkBoundaries > 0) {
    lines.push(`- **Unresolved Fork Boundaries**: ${unresolvedForkBoundaries}; inherited replay could not be excluded and totals may be incomplete`);
  }
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
      `| \`${escapeMarkdown(model)}\` | ${data.turns} | ${formatTokenCount(data.input, data.availability?.inputTokens)} | ${formatTokenCount(data.cacheRead, data.availability?.cacheReadTokens)} | ${formatTokenCount(data.output, data.availability?.outputTokens)} | ${formatRatio(data.cacheHitRatio, data.availability?.cacheHitRatio)} | ${formatTokenCount(data.totalTokens, data.availability?.totalTokens)} | ${formatCost(data.cost, data.availability?.estimatedCost)} |`
    );
  }
  lines.push("");

  lines.push("### Session Breakdown & Context Snowballing");
  lines.push("");
  lines.push("| Role | Turns | Models | Total Tokens | Cache Write | Cache Ratio | Init Prompt | Final Prompt | Growth |");
  lines.push("| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |");
  for (const s of sessions) {
    const modelsStr = s.models.map((model) => `\`${escapeMarkdown(model)}\``).join(", ");
    const growth = s.snowball.promptGrowthFactor === null ? "n/a" : `${s.snowball.promptGrowthFactor}x`;
    lines.push(
      `| **${escapeMarkdown(s.role)}** | ${s.turnCount} | ${modelsStr} | ${formatTokenCount(s.totalTokens, s.availability?.totalTokens)} | ${formatTokenCount(s.cacheWriteTokens, s.availability?.cacheWriteTokens)} | ${formatRatio(s.snowball.cacheHitRatio, s.availability?.cacheHitRatio)} | ${formatTokenCount(s.snowball.initialPromptTokens)} | ${formatTokenCount(s.snowball.finalPromptTokens)} | ${growth} |`
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
