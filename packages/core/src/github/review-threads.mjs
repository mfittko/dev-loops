import { readFile } from "node:fs/promises";

import { parseCliTokens } from "../cli/primitives.mjs";

function normalizeId(value, fallback) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return fallback;
}

function normalizeBody(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function normalizeAuthor(author) {
  if (!author || typeof author !== "object") {
    return {
      login: "",
      type: "System",
      isBot: false,
    };
  }

  const login = typeof author.login === "string" ? author.login.trim() : "";
  const type = typeof author.__typename === "string"
    ? author.__typename.trim()
    : typeof author.type === "string"
      ? author.type.trim()
      : "User";

  return {
    login,
    type,
    isBot: Boolean(author.isBot) || type === "Bot" || login.endsWith("[bot]"),
  };
}

function extractRawComments(thread) {
  if (Array.isArray(thread?.comments)) {
    return thread.comments;
  }

  if (Array.isArray(thread?.comments?.nodes)) {
    return thread.comments.nodes;
  }

  return [];
}

function extractRawThreads(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  const candidates = [
    payload?.threads,
    payload?.reviewThreads,
    payload?.reviewThreads?.nodes,
    payload?.data?.repository?.pullRequest?.reviewThreads?.nodes,
    payload?.data?.node?.reviewThreads?.nodes,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  throw new Error("Could not find review threads in payload");
}

function compareIds(left, right) {
  return left.localeCompare(right, undefined, { numeric: true });
}

export function isActionableComment(comment) {
  const body = normalizeBody(comment?.body ?? comment?.bodyText ?? comment?.bodyHTML ?? "");
  const author = normalizeAuthor(comment?.author);

  return body.length > 0 && author.login.length > 0 && author.type !== "System" && !author.isBot;
}

export function isActionableThread(thread) {
  if (Boolean(thread?.isResolved)) {
    return false;
  }

  return extractRawComments(thread).some((comment) => isActionableComment(comment));
}

function normalizeComment(comment, threadId, index, { isResolved = false } = {}) {
  const author = normalizeAuthor(comment?.author);
  const body = normalizeBody(comment?.body ?? comment?.bodyText ?? comment?.bodyHTML ?? "");
  const databaseId = comment?.databaseId === null || comment?.databaseId === undefined
    ? null
    : normalizeId(comment.databaseId, null);

  return {
    id: normalizeId(comment?.id ?? comment?.databaseId, `${threadId}:comment-${index + 1}`),
    databaseId,
    threadId,
    author,
    body,
    isActionable: !isResolved && body.length > 0 && author.login.length > 0 && author.type !== "System" && !author.isBot,
  };
}

export function parseReviewThreads(payload) {
  const rawThreads = extractRawThreads(payload);
  const comments = [];
  const threads = rawThreads.map((thread, threadIndex) => {
    const threadId = normalizeId(thread?.id ?? thread?.databaseId, `thread-${threadIndex + 1}`);
    const isResolved = Boolean(thread?.isResolved);
    const normalizedComments = extractRawComments(thread)
      .map((comment, commentIndex) => normalizeComment(comment, threadId, commentIndex, { isResolved }))
      .sort((left, right) => compareIds(left.id, right.id));

    comments.push(...normalizedComments);
    const commentIds = normalizedComments.map((comment) => comment.id);
    const commentDatabaseIds = normalizedComments
      .map((comment) => comment.databaseId)
      .filter((value) => value !== null);
    const actionableComments = isResolved
      ? []
      : normalizedComments.filter((comment) => comment.isActionable);
    const actionableCommentIds = actionableComments.map((comment) => comment.id);
    const actionableCommentDatabaseIds = actionableComments
      .map((comment) => comment.databaseId)
      .filter((value) => value !== null);

    return {
      id: threadId,
      isResolved,
      isActionable: actionableCommentIds.length > 0,
      commentIds,
      commentDatabaseIds,
      actionableCommentIds,
      actionableCommentDatabaseIds,
    };
  }).sort((left, right) => compareIds(left.id, right.id));

  const sortedComments = comments.sort((left, right) => {
    const threadOrder = compareIds(left.threadId, right.threadId);
    return threadOrder === 0 ? compareIds(left.id, right.id) : threadOrder;
  });

  return {
    summary: {
      totalThreads: threads.length,
      unresolvedThreads: threads.filter((thread) => !thread.isResolved).length,
      actionableThreads: threads.filter((thread) => thread.isActionable).length,
      actionableComments: threads.reduce((count, thread) => count + thread.actionableCommentIds.length, 0),
    },
    threads,
    comments: sortedComments,
  };
}

// ── Signal classification heuristics ──────────────────────────────────────

const HIGH_SIGNAL_PATTERNS = [
  /\bbug\b/i, /\bcrash\b/i, /\bsecurity\b/i, /\bvulnerab/i,
  /\bcontract\b/i, /\bbroken\b/i, /\bincorrect\b/i, /\bwrong\b/i,
  /\bsilent(?:ly)?\b/i, /\bdata.?loss\b/i, /\brace.?condition\b/i,
  /\bmemory.?leak\b/i, /\binfinite.?loop\b/i, /\bdeadlock\b/i,
  /\bexception\b/i, /\bfatal\b/i, /\bcorrupt/i, /\bdiverg/i,
  /\binconsisten/i, /\bregression\b/i, /\blost\b/i, /\bmissing\b/i,
];

const MID_SIGNAL_PATTERNS = [
  /\brefactor\b/i, /\brestructur/i, /\breorganiz/i,
  /\bperform(?:ance)?\b/i, /\barchitect/i, /\bdesign\b/i,
  /\b(?:should\s+)?consider\b/i, /\b(?:\w+\s+)?maybe\b/i,
  /\balternative\b/i, /\bimprove(?:ment)?\b/i, /\bextract\b/i,
  /\babstract(?:ion)?\b/i, /\bdry\b/i, /\bsimplif/i,
  /\bduplicat/i, /\bunnecessary/i, /\bover.engineer/i,
  /\bcould\b/i, /\bwould\b/i, /\bsuggest/i, /\brecommend/i,
  /\bprefer\b/i, /\bbetter\b/i, /\bclean(?:er)?\b/i,
  /\breus(?:e|able)\b/i, /\btestable/i, /\bconsistent/i,
];

/**
 * Classify a single comment by signal level using heuristic keyword matching.
 * No AI or API confidence data is used.
 *
 * @param {{ body?: string|null }} comment
 * @returns {"high"|"mid"|"low"}
 */
export function classifyCommentSignal(comment) {
  const body = (typeof comment?.body === "string" ? comment.body : "").trim();
  if (body.length === 0) return "low";

  for (const pattern of HIGH_SIGNAL_PATTERNS) {
    if (pattern.test(body)) return "high";
  }
  for (const pattern of MID_SIGNAL_PATTERNS) {
    if (pattern.test(body)) return "mid";
  }
  return "low";
}

/**
 * Classify a review thread by its highest comment signal level.
 *
 * @param {{ comments: Array<{ body?: string|null }> }} thread
 * @returns {"high"|"mid"|"low"}
 */
export function classifyThreadSignal(thread) {
  const comments = Array.isArray(thread?.comments) ? thread.comments : [];
  let maxSignal = "low";
  for (const comment of comments) {
    const signal = classifyCommentSignal(comment);
    if (signal === "high") return "high";
    if (signal === "mid") maxSignal = "mid";
  }
  return maxSignal;
}

/**
 * Determine the maximum signal level across all Copilot-authored threads.
 *
 * Filters threads to those containing at least one Copilot-authored comment,
 * then classifies the signal level using all comments in those threads
 * (including human replies in Copilot threads, which may clarify severity).
 * Returns null if no Copilot-authored threads exist.
 *
 * @param {{ threads: Array<object>, comments: Array<object> }} parsedResult — output of parseReviewThreads()
 * @param {(login: string) => boolean} isCopilotLoginFn — predicate for Copilot authors
 * @returns {"high"|"mid"|"low"|null}
 */
export function classifyReviewThreadsSignal(parsedResult, isCopilotLoginFn) {
  const threads = Array.isArray(parsedResult?.threads) ? parsedResult.threads : [];
  const flatComments = Array.isArray(parsedResult?.comments) ? parsedResult.comments : [];
  if (flatComments.length === 0) return null;

  // Group comments by threadId
  const commentsByThread = new Map();
  for (const comment of flatComments) {
    const tid = comment.threadId ?? "unknown";
    if (!commentsByThread.has(tid)) commentsByThread.set(tid, []);
    commentsByThread.get(tid).push(comment);
  }

  let maxSignal = null;
  for (const thread of threads) {
    const threadComments = commentsByThread.get(thread.id) ?? [];
    const hasCopilotComment = threadComments.some(
      (c) => typeof c?.author?.login === "string" && isCopilotLoginFn(c.author.login),
    );
    if (!hasCopilotComment) continue;
    const signal = classifyThreadSignal({ comments: threadComments });
    if (signal === "high") return "high";
    if (maxSignal === null || (signal === "mid" && maxSignal === "low")) {
      maxSignal = signal;
    }
  }
  return maxSignal;
}


export function parseCliArgs(argv) {
  const { values } = parseCliTokens(argv, {
    input: { type: "string" },
  });

  return {
    inputPath: values.get("input"),
  };
}

export async function readInput({ inputPath, stdin = process.stdin } = {}) {
  if (inputPath) {
    return readFile(inputPath, "utf8");
  }

  let input = "";
  for await (const chunk of stdin) {
    input += chunk;
  }

  if (input.trim().length === 0) {
    throw new Error("Expected review-thread JSON via --input <path> or stdin");
  }

  return input;
}

export function parseJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON input");
  }
}

export function formatCliError(error) {
  const payload = { ok: false, error: error instanceof Error ? error.message : String(error) };
  if (error instanceof Error && typeof error.usage === "string") {
    payload.usage = error.usage;
  }
  return JSON.stringify(payload);
}

export async function runCli(
  argv = process.argv.slice(2),
  {
    stdin = process.stdin,
    stdout = process.stdout,
  } = {},
) {
  const options = parseCliArgs(argv);
  const text = await readInput({ inputPath: options.inputPath, stdin });
  const result = parseReviewThreads(parseJsonText(text));
  stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}
