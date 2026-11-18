// ADR 0293: the durable marker `pr create --spike-file` writes into a spike PR body.
// ready-for-review and merge-pr refuse a PR carrying it.
export const SPIKE_PR_MARKER = "<!-- dev-loops:spike-pr no-merge -->";

// A marker line inside a fenced code block is documentation, not the stamp.
export function hasSpikePrMarker(body) {
  if (typeof body !== "string") return false;
  let fence = null;
  for (const line of body.split(/\r?\n/u)) {
    // A fence may follow list markers or container indentation (`- ~~~html`, four spaces).
    let open = /^\s*(?:(?:[-+*]|\d{1,9}[.)])\s+)*(`{3,}|~{3,})(.*)$/u.exec(line);
    // CommonMark: a backtick opener's info string holds no backtick (a one-line code span is no fence).
    if (open && open[1][0] === "`" && open[2].includes("`")) open = null;
    if (fence === null && open) fence = open[1];
    // CommonMark: a closer is at least as long as the opener, same character, no info string.
    else if (fence !== null && open && open[1][0] === fence[0] && open[1].length >= fence.length && open[2].trim() === "") fence = null;
    else if (fence === null && line.trim() === SPIKE_PR_MARKER) return true;
  }
  return false;
}

export function spikePrRefusal(pr) {
  return `PR #${pr} was created with the spike size exemption (ADR 0293) and never merges: it cannot be marked ready or merged. Ship the work through normal-sized issues.`;
}
