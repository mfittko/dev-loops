import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ValidationConfig } from '@dev-loops/core/config';
import { DEVLOOPS_CONFIG_PATHS } from '../loop/check-adr-tripwire.mjs';
import { gitEnvNoDirOverrides } from '../loop/_repo-root-resolver.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (file) => realpathSync(file);
const defaultGit = (args, { repoRoot }) => execFileSync('git', args, { cwd: repoRoot, env: gitEnvNoDirOverrides(), timeout: 5000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** Raw capability only: applying config defaults here would invent CI authority. */
export function validationAbsenceState(validation) {
  if (validation === undefined) return 'absent';
  const parsed = ValidationConfig.safeParse(validation);
  if (!parsed.success) throw new Error('malformed validation configuration');
  return parsed.data.mode !== undefined || parsed.data.fullCommand !== undefined || parsed.data.paths?.some((entry) => entry.commands.length > 0) ? null : 'empty';
}

async function verifyAbsence(artifact, cwd, git) {
  const probe = (args) => git(args, { repoRoot: cwd });
  const text = (args) => probe(args).toString().trim();
  const provenance = artifact.configResolution;
  const ref = text(['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (!ref.startsWith('refs/remotes/origin/') || ref === 'refs/remotes/origin/HEAD') throw new Error('trusted default ref is unresolved');
  const commitSha = text(['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!provenance || provenance.source !== 'default-branch' || provenance.ref !== ref || provenance.commitSha !== commitSha) throw new Error('trusted default ref/commit provenance mismatch');
  const names = text(['ls-tree', '--name-only', commitSha, '--', ...DEVLOOPS_CONFIG_PATHS]).split('\n');
  const configPath = DEVLOOPS_CONFIG_PATHS.find((name) => names.includes(name)) ?? null;
  const bytes = configPath ? Buffer.from(probe(['show', `${commitSha}:${configPath}`])) : null;
  if (provenance.configPath !== configPath || provenance.configSha256 !== (bytes ? hash(bytes) : null)) throw new Error('trusted config path/hash provenance mismatch');
  let checkoutPath = null;
  let checkoutBytes = null;
  for (const name of DEVLOOPS_CONFIG_PATHS) {
    const file = path.resolve(cwd, name);
    try { await lstat(file); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`checkout config is unreadable: ${error.code}`);
    }
    try { checkoutBytes = await readFile(file); checkoutPath = name; break; }
    catch (error) { throw new Error(`checkout config is unreadable: ${error.code}`); }
  }
  if (checkoutPath !== configPath || (bytes && !bytes.equals(checkoutBytes))) throw new Error('checkout config source differs from trusted default branch');
  let config = {};
  if (bytes) {
    try { config = configPath.endsWith('.json') ? JSON.parse(bytes.toString('utf8')) : parseYaml(bytes.toString('utf8')); }
    catch { throw new Error('trusted config is malformed JSON/YAML'); }
    if (config === null || typeof config !== 'object' || Array.isArray(config)) throw new Error('trusted config is not a mapping');
  }
  const state = validationAbsenceState(config.validation);
  if (state === null) throw new Error('trusted validation is configured');
  if (state !== provenance.state) throw new Error('trusted config absence state mismatch');
}

export async function verifyNotConfiguredEvidence(artifact, { cwd = process.cwd(), git = defaultGit } = {}) {
  if (artifact.ok !== true || artifact.allPassed !== null || !Array.isArray(artifact.suites) || artifact.suites.length !== 0) throw new Error('not_configured requires ok:true, allPassed:null and empty suites');
  if (artifact.warning?.code !== 'validation_not_configured' || typeof artifact.warning.message !== 'string' || !/validation was not performed/i.test(artifact.warning.message) || !/configure.*validation/i.test(artifact.warning.message) || /[\r\n]/.test(artifact.warning.message)) throw new Error('not_configured requires an actionable validation-not-performed warning');
  await verifyAbsence(artifact, cwd, git);
  return artifact.warning;
}

/** Read bytes once; bind their location, hash, size and reviewed head before interpreting absence. */
export async function readValidationEvidence({ context, headSha, cwd = process.cwd(), requireBinding = true, git = defaultGit }) {
  const pointer = context?.scope?.validationResultsPath;
  const refuse = (reason) => ({ refusal: 'validation_evidence_invalid', reason });
  if (context?.requiredReads !== undefined && !Array.isArray(context.requiredReads)) return refuse('validation binding requiredReads is not an array');
  const reads = (context?.requiredReads ?? []).filter((read) => read?.kind === 'validation');
  if (pointer == null && reads.length === 0) return null; // Legacy native orders carry no validation read.
  if (typeof pointer !== 'string' || !pointer) return refuse('validation read has no scope.validationResultsPath');
  const validationResultsPath = path.resolve(cwd, pointer);
  try {
    const bytes = await readFile(validationResultsPath);
    const sha256 = hash(bytes);
    let artifact;
    try { artifact = JSON.parse(bytes.toString('utf8')); } catch { return refuse('validation record is not valid JSON'); }
    // Legacy prefix-file contexts carry no validation read; binding stays mandatory for not_configured and for any supplied read.
    if (requireBinding && (reads.length > 0 || artifact?.status === 'not_configured') && (reads.length !== 1 || canonical(path.resolve(cwd, reads[0].path)) !== canonical(validationResultsPath) || reads[0].sha256 !== sha256 || reads[0].bytes !== bytes.length)) return refuse("validation record does not match the context's hash-bound validation read");
    if (!headSha || artifact?.headSha !== headSha) return refuse(`validation record head ${artifact?.headSha ?? 'missing'} differs from requested head ${headSha ?? 'missing'}`);
    if (artifact.status === 'not_configured') {
      try { await verifyNotConfiguredEvidence(artifact, { cwd, git }); } catch (error) { return refuse(`trusted absence verification failed: ${error.message}`); }
    } else {
      if (artifact.status !== undefined && !['complete', 'failed', 'incomplete'].includes(artifact.status)) return refuse('validation record has an unsupported status');
      if (typeof artifact.allPassed !== 'boolean' || !Array.isArray(artifact.suites)) return refuse('legacy validation record requires boolean allPassed and suites array');
    }
    return { artifact, validationResultsPath, read: { kind: 'validation', path: validationResultsPath, sha256, bytes: bytes.length, required: false }, ...(artifact.status === 'not_configured' ? { warning: artifact.warning } : {}) };
  } catch (error) { return refuse(`validation record or binding is unreadable: ${error.code ?? error.message}`); }
}
