// Leaf module: the generic pre-PR self-check items (PRE-PR-DEVELOPER-SELF-CHECK), shared by the brief and the record writer.
export const SELF_CHECK_ITEMS = Object.freeze([
  { id: "tests", check: "A test covers each acceptance criterion and each failure path." },
  { id: "description", check: "The PR body matches the as-built code: the exact validation command, a stable pass/fail outcome (never a lifecycle status such as pending), and an In scope list of every changed file." },
  { id: "surface-text", check: "--help text, docs, contracts and the changelog match the behavior." },
  { id: "edge-cases", check: "For every new input, name the null, empty, wrong-shape and resumed-state case and its test." },
]);
