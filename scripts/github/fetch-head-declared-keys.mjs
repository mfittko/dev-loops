#!/usr/bin/env node
// Fetches the head-declared-keys artifact uploaded by a pull_request run and prints
// `{"declaredKeys":[...]}` (docs/decisions/0234). Runs trusted default-branch
// code only, on issue_comment events. The artifact is DATA from an untrusted job: it must
// match the PR's current head SHA and the strict schema, otherwise the result is the empty
// set. Every failure prints the empty set and exits 0.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { parseRepoSlug } from "@dev-loops/core/github/repo-slug";
import { parseHeadDeclaredKeys } from "./head-declared-keys-schema.mjs";

const execFileAsync = promisify(execFile);
const MAX_ZIP_BYTES = 1024 * 1024;

export const parseDeclaredKeysStrict = parseHeadDeclaredKeys;

/** Newest non-expired artifact named exactly `head-declared-keys-<sha>` produced by a run at that head, else null. */
export function selectHeadKeysArtifact(artifacts, headSha) {
  const name = `head-declared-keys-${headSha}`;
  const matches = (Array.isArray(artifacts) ? artifacts : []).filter(
    (a) => a?.name === name && a.expired !== true && a.workflow_run?.head_sha === headSha,
  );
  // Newest created_at first (non-finite last), ties broken on numeric id descending.
  const time = (a) => { const t = Date.parse(a.created_at); return Number.isFinite(t) ? t : -Infinity; };
  matches.sort((a, b) => (time(b) === time(a) ? 0 : time(b) > time(a) ? 1 : -1) || Number(b.id) - Number(a.id));
  return matches[0] ?? null;
}

const defaultExec = async (file, args) => (await execFileAsync(file, args, { encoding: "buffer", maxBuffer: MAX_ZIP_BYTES })).stdout;

/** Resolve the validated declared-key list; any problem yields []. `exec(file, args)` returns stdout as a Buffer. */
export async function fetchHeadDeclaredKeys({ repo, pr, headSha, exec = defaultExec }) {
  let dir;
  try {
    // Validate before interpolating into gh api paths; any mismatch yields the empty set.
    const { owner, name } = parseRepoSlug(repo);
    const slug = `${owner}/${name}`;
    if (slug !== repo || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug)) return [];
    if (!/^[1-9]\d*$/.test(String(pr)) || !/^[0-9a-f]{40}$/.test(String(headSha))) return [];
    const gh = async (apiPath) => exec("gh", ["api", apiPath]);
    const current = JSON.parse((await gh(`repos/${slug}/pulls/${pr}`)).toString("utf8"));
    if (current?.head?.sha !== headSha) return [];
    const list = JSON.parse((await gh(`repos/${slug}/actions/artifacts?name=head-declared-keys-${headSha}&per_page=100`)).toString("utf8"));
    const artifact = selectHeadKeysArtifact(list?.artifacts, headSha);
    if (!artifact || !Number.isInteger(artifact.id)) return [];
    dir = await mkdtemp(path.join(os.tmpdir(), "head-declared-keys-"));
    const zip = path.join(dir, "artifact.zip");
    await writeFile(zip, await gh(`repos/${slug}/actions/artifacts/${artifact.id}/zip`));
    const text = (await exec("unzip", ["-p", zip, "head-declared-keys.json"])).toString("utf8");
    return parseDeclaredKeysStrict(text);
  } catch {
    return [];
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { repo: { type: "string" }, pr: { type: "string" }, "head-sha": { type: "string" } },
    strict: false,
  });
  const declaredKeys = values.repo && values.pr && values["head-sha"]
    ? await fetchHeadDeclaredKeys({ repo: values.repo, pr: values.pr, headSha: values["head-sha"] })
    : [];
  console.log(JSON.stringify({ declaredKeys }));
}
