// ADR 0293: the durable marker `pr create --spike-file` writes into a spike PR body.
// ready-for-review and merge-pr refuse a PR carrying it.
export const SPIKE_PR_MARKER = "<!-- dev-loops:spike-pr no-merge -->";

// The marker is live only as the last non-empty line of the body, exactly equal to the marker.
// A marker mid-body, indented, or inside a fenced example is documentation, not the stamp.
export function hasSpikePrMarker(body) {
  if (typeof body !== "string") return false;
  return body.trimEnd().split(/\r?\n/u).at(-1) === SPIKE_PR_MARKER;
}

export function spikePrRefusal(pr) {
  return `PR #${pr} was created with the spike size exemption (ADR 0293) and never merges: it cannot be marked ready or merged. Ship the work through normal-sized issues.`;
}
