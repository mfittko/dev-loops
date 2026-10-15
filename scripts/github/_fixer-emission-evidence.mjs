import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { repoSlugFor } from "./_gate-artifact-paths.mjs";
import { executionIndexPath, materializationHash, pullReceiptPath, verifyPullReceipt, workOrderDigest } from "./_work-order-protocol.mjs";

const refuse = (reason) => { throw new Error(`fixer emission evidence: ${reason}`); };
const same = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
const unchanged = (a, b) => same(a, b) && a?.size === b?.size && a?.mtimeMs === b?.mtimeMs && a?.ctimeMs === b?.ctimeMs;
const optionalStat = (file) => lstat(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });

// Historical prose is authenticated by its actual pull, never by the current renderer.
export async function authenticateOriginalPlan({ plan, canonical, receiptTmpRoot, requireReceipt = false, read = readFile }) {
  const order = plan.workOrder;
  const { executionIdentity, workOrderRef, workOrderDigest: digest } = plan;
  if (!/^f\d+-[a-f0-9]{8}$/.test(executionIdentity ?? "") || order?.role !== "fixer"
    || !["commit_only", "full"].includes(order.phase) || workOrderDigest(order) !== digest
    || workOrderRef !== `fixer:${order.target?.repo}#${order.target?.pr}:${order.headSha}:${executionIdentity}`
    || canonical !== path.join(receiptTmpRoot, "gate-fixer", repoSlugFor(order.target.repo), `pr-${order.target.pr}`, "fixer-emit-plan.json")) refuse("original identity or semantic digest mismatch");
  const prompt = await read(path.join(path.dirname(canonical), "work-orders", `${executionIdentity}.md`));
  if (materializationHash(prompt) !== plan.materializationHash) refuse("original historical materialization hash mismatch");
  const suffix = Buffer.from(`## Work order\n\n\`\`\`json\n${JSON.stringify(order, null, 2)}\n\`\`\`\n`);
  if (!prompt.subarray(-suffix.length).equals(suffix)) refuse("historical complete Work order JSON suffix differs");
  const receiptBytes = await read(pullReceiptPath(receiptTmpRoot, workOrderRef)).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
  if (!receiptBytes && !requireReceipt) return order;
  const pulled = await verifyPullReceipt({ receiptTmpRoot, role: "fixer", workOrderRef, workOrderDigest: digest, executionIdentity });
  if (!pulled.ok) refuse(`original pull receipt failed: ${pulled.reason}`);
  const subject = pulled.receipt.subject;
  if (subject?.repo !== order.target.repo || subject.pr !== order.target.pr || subject.headSha !== order.headSha
    || subject.branch !== order.mutationAuthority?.branch || subject.phase !== order.phase
    || typeof subject.planPath !== "string" || await realpath(subject.planPath) !== canonical) refuse("original receipt subject is not the original canonical plan");
  if (materializationHash(prompt) !== pulled.receipt.materializationHash) refuse("original historical materialization hash mismatch");
  return order;
}

// This lock coordinates current emitters only; obsolete tools do not participate.
export async function beginFixerEmission(dir) {
  const directories = new Map();
  const files = new Map();
  async function directory(target) {
    if (directories.has(target)) {
      if (!same(directories.get(target), await optionalStat(target))) refuse(`changed directory identity: ${target}`);
      return;
    }
    if (path.dirname(target) !== target) await directory(path.dirname(target));
    await mkdir(target).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) refuse(`unsafe directory alias ${target}`);
    directories.set(target, info);
  }
  await directory(dir);
  const lockPath = path.join(dir, ".fixer-emission.lock");
  const lock = await open(lockPath, "wx");
  const owned = await lock.stat();
  async function read(file) {
    const parent = path.dirname(file);
    const actualParent = file.startsWith(`${dir}${path.sep}`) ? parent : await realpath(parent).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (actualParent) await directory(actualParent);
    const before = await optionalStat(file);
    if (files.has(file) && (files.get(file) ? !unchanged(files.get(file), before) : before !== null)) refuse(`changed source identity: ${file}`);
    if (!before) { files.set(file, null); return null; }
    if (!before.isFile() || before.nlink !== 1) refuse(`evidence must be a singly linked regular file: ${file}`);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!unchanged(before, await handle.stat())) refuse(`changed file identity: ${file}`);
      const bytes = await handle.readFile();
      if (!unchanged(before, await handle.stat()) || !unchanged(before, await lstat(file))) refuse(`changed file identity: ${file}`);
      files.set(file, before);
      return bytes;
    } finally { await handle.close(); }
  }
  return {
    read,
    async preserve(canonical, receiptTmpRoot) {
      const bytes = await read(canonical);
      if (!bytes) return;
      const plan = JSON.parse(bytes);
      const report = path.join(dir, plan.executionIdentity, "fixer-disposition.json");
      if (plan.promptPath !== path.join(dir, "work-orders", `${plan.executionIdentity}.md`)
        || plan.workOrder?.outputRefs?.length !== 1 || plan.workOrder.outputRefs[0] !== report) refuse("original evidence paths are not execution-derived");
      await authenticateOriginalPlan({ plan, canonical, receiptTmpRoot, read: async (file) => {
        const bytes = await read(file);
        if (!bytes) throw Object.assign(new Error(`missing ${file}`), { code: "ENOENT" });
        return bytes;
      } });
      for (const file of [report, executionIndexPath(receiptTmpRoot, plan.executionIdentity), ...plan.workOrder.requiredReads.map((entry) => entry.path)]) await read(file);
      await this.write(path.join(dir, plan.executionIdentity, "original-fixer-emit-plan.json"), bytes);
    },
    async write(file, bytes) {
      await directory(path.dirname(file));
      try {
        const handle = await open(file, "wx");
        try { await handle.writeFile(bytes); } finally { await handle.close(); }
      } catch (error) { if (error.code !== "EEXIST") throw error; }
      const actual = await read(file);
      if (!actual?.equals(Buffer.from(bytes))) refuse(`archive or work order already exists with different content: ${file}`);
    },
    async recheck() {
      for (const [file, before] of directories) if (!same(before, await optionalStat(file))) refuse(`changed directory identity: ${file}`);
      for (const [file, before] of files) {
        const after = await optionalStat(file);
        if (before ? !unchanged(before, after) || after.nlink !== 1 : after !== null) refuse(`changed source identity: ${file}`);
      }
      if (!same(owned, await optionalStat(lockPath))) refuse("emission lock ownership changed");
    },
    async release() {
      try { if (same(owned, await optionalStat(lockPath))) await unlink(lockPath); }
      finally { await lock.close(); }
    },
  };
}
