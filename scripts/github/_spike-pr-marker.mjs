// ADR 0293: the durable marker `pr create --spike-file` writes into a spike PR body.
// ready-for-review and merge-pr refuse a PR carrying it.
export const SPIKE_PR_MARKER = "<!-- dev-loops:spike-pr no-merge -->";

export function hasSpikePrMarker(body) {
  return typeof body === "string" && body.split(/\r?\n/u).some((line) => line.trim() === SPIKE_PR_MARKER);
}

export function spikePrRefusal(pr) {
  return `PR #${pr} was created with the spike size exemption (ADR 0293) and never merges: it cannot be marked ready or merged. Ship the work through normal-sized issues.`;
}
