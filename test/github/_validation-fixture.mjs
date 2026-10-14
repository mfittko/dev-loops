import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initGitFixture } from '../_helpers.mjs';
import { DEVLOOPS_CONFIG_PATHS } from '../../scripts/loop/check-adr-tripwire.mjs';
import { parse as parseYaml } from 'yaml';

export const validationWarning = { code: 'validation_not_configured', message: "Validation was not performed: no validator or CI authority is configured. Configure validation in the default branch's .devloops to enable it." };
export async function seedValidation(root, { validation, headSha = 'd'.repeat(40), record = {}, initialize = true, configText } = {}) {
  if (initialize) initGitFixture(root);
  if (validation !== undefined) await writeFile(path.join(root, '.devloops.json'), JSON.stringify({ validation }));
  if (configText !== undefined) await writeFile(path.join(root, '.devloops.json'), configText);
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git(['add', '-A']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'validation fixture']);
  const commitSha = git(['rev-parse', 'HEAD']);
  if (headSha === 'HEAD') headSha = commitSha;
  git(['update-ref', 'refs/remotes/origin/fixture-default', commitSha]);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/fixture-default']);
  let config = null;
  let configPath = null;
  for (const name of DEVLOOPS_CONFIG_PATHS) {
    config = await readFile(path.join(root, name)).catch(() => null);
    if (config) { configPath = name; break; }
  }
  let state = 'absent';
  try { if (config && parseYaml(config.toString())?.validation !== undefined) state = 'empty'; } catch {}
  const artifact = { repo: 'o/r', pr: 7, gate: 'pre_approval_gate', headSha, profile: 'targeted', generatedAt: new Date().toISOString(), ok: true, status: 'not_configured', allPassed: null, suites: [], warning: validationWarning,
    configResolution: { source: 'default-branch', ref: 'refs/remotes/origin/fixture-default', commitSha, configPath, configSha256: config ? createHash('sha256').update(config).digest('hex') : null, state }, ...record };
  const file = path.join(root, 'validation.json');
  const bytes = Buffer.from(JSON.stringify(artifact));
  await writeFile(file, bytes);
  const read = { kind: 'validation', path: file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, required: false };
  return { artifact, read, file, context: { headSha, scope: { validationResultsPath: file }, requiredReads: [read] } };
}
