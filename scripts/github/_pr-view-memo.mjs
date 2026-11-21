// Per-invocation memo for `gh pr view --json` reads. The caller owns the Map, so
// nothing is shared across invocations. With no memo, `load` runs on every call.
export function readPrViewOnce({ repo, pr, fields }, memo, load) {
  if (!memo) return load();
  // The key ignores how `load` fetches, so the first loader's result (including a REST fallback) serves later identical reads.
  const key = `${repo}#${pr}#${fields}`;
  if (!memo.has(key)) {
    // A rejected read is evicted so a retry fetches again.
    memo.set(key, load().catch((error) => { memo.delete(key); throw error; }));
  }
  return memo.get(key);
}
