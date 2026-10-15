import { collectFingerprints } from "./_gate-finding-surface.mjs";

export function selectActThreadBinding(parsed, threadId, gateLogin, actFingerprints) {
  // parseReviewThreads id-sorts comments; databaseId identifies the root, falling back to the first comment.
  const numeric = (c) => (/^\d+$/.test(String(c.databaseId ?? "")) ? Number(c.databaseId) : Infinity);
  const root = parsed.comments
    .filter((c) => c.threadId === threadId)
    .reduce((root, c) => (root === undefined || numeric(c) < numeric(root) ? c : root), undefined);
  const fps = new Set();
  if (root?.author?.login === gateLogin) collectFingerprints(root?.body ?? "", fps);
  // Merged roots carry one marker per member; resolution never changes membership.
  return { root, members: [...fps].filter((fp) => actFingerprints.has(fp)) };
}
