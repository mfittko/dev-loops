/**
 * Minimize superseded gate-verdict reviews (GATE-COMMENT-SUPERSEDE-OUTDATED,
 * skills/docs/gate-review-comment-contract.md).
 *
 * Every gate round posts a `### Gate review: <gate>` summary review at that
 * round's head. When the head moves, the prior round's verdict stays expanded
 * in the PR conversation, so a multi-round gate leaves a stack of stale
 * `findings_present` verdicts. GitHub's own answer is `minimizeComment(classifier:
 * OUTDATED)`, and a `PullRequestReview` body is Minimizable.
 *
 * This module folds the SAME gate's prior verdict reviews (recorded at an
 * EARLIER head) as OUTDATED after a new verdict lands. It is BEST-EFFORT and
 * additive: the verdict post is the authoritative write, and folding old noise
 * must never fail it. Every error is swallowed into a returned warning.
 *
 * Split into a pure selector (network-free, unit-tested) and a thin IO runner.
 */

// The round-bearing marker `renderGateReviewCommentBody` embeds, and the visible
// header a bare (round-less) verdict post carries. Either identifies a gate
// verdict review and its reviewed head.
const REVIEW_MARKER_RE = /<!--\s*dev-loops:gate-findings-review\s+(draft_gate|pre_approval_gate)\s+([0-9a-f]{7,64})\s+round=\d+\s*-->/;
const HEADER_GATE_RE = /###\s*Gate review:\s*`(draft_gate|pre_approval_gate)`/;
const HEADER_HEAD_RE = /\*\*Reviewed head SHA:\*\*\s*`([0-9a-f]{7,64})`/;

// A cap so a pathological round history cannot fan out into an unbounded
// minimize storm. One PR reaching this many stale same-gate verdicts is itself
// a signal worth surfacing, not silently sweeping.
export const DEFAULT_MAX_SUPERSEDED_MINIMIZE = 50;

/**
 * Identify a review body as a gate verdict and extract its gate + reviewed head.
 * Prefers the machine marker; falls back to the visible header so a round-less
 * bare verdict post is still recognized.
 * @param {string} body
 * @returns {{ gate: string, headSha: string } | null}
 */
export function parseGateReviewHeadAndGate(body) {
  if (typeof body !== "string" || body.length === 0) {
    return null;
  }
  const marker = REVIEW_MARKER_RE.exec(body);
  if (marker) {
    return { gate: marker[1], headSha: marker[2] };
  }
  const gate = HEADER_GATE_RE.exec(body)?.[1];
  const head = HEADER_HEAD_RE.exec(body)?.[1];
  if (gate && head) {
    return { gate, headSha: head };
  }
  return null;
}

// Two head SHAs name the same head when one is a prefix of the other. Marker
// heads are full SHAs, so this is exact in practice; the prefix tolerance only
// guards a caller that passed an abbreviated current head.
function sameHead(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length === 0 || b.length === 0) {
    return false;
  }
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/**
 * From a PR's reviews, pick the node ids to minimize: same gate, a head other
 * than the current one, not already minimized. The just-posted current-head
 * verdict is excluded by the head check, and the OTHER gate's verdicts by the
 * gate check.
 *
 * @param {object} params
 * @param {Array<{ id: string, isMinimized: boolean, body: string }>} params.reviews
 * @param {string} params.gate - "draft_gate" | "pre_approval_gate"
 * @param {string} params.currentHeadSha
 * @param {number} [params.max]
 * @returns {{ ids: string[], overflow: number }}
 */
export function selectSupersededGateReviewIds({ reviews, gate, currentHeadSha, max = DEFAULT_MAX_SUPERSEDED_MINIMIZE }) {
  if (!Array.isArray(reviews) || typeof gate !== "string" || typeof currentHeadSha !== "string" || currentHeadSha.length === 0) {
    return { ids: [], overflow: 0 };
  }
  const matched = [];
  for (const review of reviews) {
    if (!review || review.isMinimized === true || typeof review.id !== "string") {
      continue;
    }
    const parsed = parseGateReviewHeadAndGate(review.body);
    if (parsed === null || parsed.gate !== gate) {
      continue;
    }
    if (sameHead(parsed.headSha, currentHeadSha)) {
      continue;
    }
    matched.push(review.id);
  }
  const cap = Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_SUPERSEDED_MINIMIZE;
  return { ids: matched.slice(0, cap), overflow: Math.max(0, matched.length - cap) };
}

const LIST_REVIEWS_QUERY = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){reviews(first:100){nodes{id isMinimized body}}}}}`;
const MINIMIZE_MUTATION = `mutation($id:ID!){minimizeComment(input:{subjectId:$id,classifier:OUTDATED}){minimizedComment{isMinimized}}}`;

async function defaultListReviews({ owner, name, pr }, { env, runChild, ghGraphqlImpl }) {
  const payload = await ghGraphqlImpl(LIST_REVIEWS_QUERY, { owner, name, pr }, env, runChild);
  const nodes = payload?.data?.repository?.pullRequest?.reviews?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

async function defaultMinimize(id, { env, runChild, ghGraphqlImpl }) {
  await ghGraphqlImpl(MINIMIZE_MUTATION, { id }, env, runChild);
}

/**
 * Fold the same gate's prior-head verdict reviews as OUTDATED. Best-effort and
 * fail-open: returns `{ ok, minimized, overflow, warning }` and never throws.
 *
 * @param {object} target
 * @param {string} target.owner
 * @param {string} target.name
 * @param {number} target.pr
 * @param {string} target.gate
 * @param {string} target.currentHeadSha
 * @param {object} [deps]
 */
export async function minimizeSupersededGateReviews(
  { owner, name, pr, gate, currentHeadSha },
  {
    env = process.env,
    runChild,
    ghGraphqlImpl,
    listReviewsImpl = defaultListReviews,
    minimizeImpl = defaultMinimize,
    max = DEFAULT_MAX_SUPERSEDED_MINIMIZE,
  } = {},
) {
  // Only the two persisted gates stack verdicts across heads; `review` posts no
  // head-keyed summary that supersedes, so it is a no-op here.
  if (gate !== "draft_gate" && gate !== "pre_approval_gate") {
    return { ok: true, minimized: 0, overflow: 0 };
  }
  const io = { env, runChild, ghGraphqlImpl };
  try {
    const reviews = await listReviewsImpl({ owner, name, pr }, io);
    const { ids, overflow } = selectSupersededGateReviewIds({ reviews, gate, currentHeadSha, max });
    let minimized = 0;
    let firstError = null;
    for (const id of ids) {
      try {
        await minimizeImpl(id, io);
        minimized += 1;
      } catch (error) {
        // One failed minimize must not abort the rest, and never the caller.
        firstError = firstError ?? error;
      }
    }
    const warning = firstError
      ? `Minimized ${minimized}/${ids.length} superseded ${gate} verdict reviews; first failure: ${firstError instanceof Error ? firstError.message : String(firstError)}`
      : (overflow > 0
        ? `Minimized ${minimized} superseded ${gate} verdict reviews; ${overflow} more exceed the ${max} cap and were left expanded.`
        : null);
    return { ok: firstError === null, minimized, overflow, ...(warning ? { warning } : {}) };
  } catch (error) {
    return {
      ok: false,
      minimized: 0,
      overflow: 0,
      warning: `Superseded-verdict minimize skipped (best-effort): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
