import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import {
  INSPECT_RUN_VIEWER_MANAGED_RECORD_PATH,
  buildOpenBrowserInvocation,
  createInspectRunViewerLifecycleManager,
} from '../../scripts/loop/inspect-run-viewer/managed-instance.mjs';
import {
  classifyInspectRunViewerCiChanges,
  isInspectRunViewerRelevantPath,
  runCli as runInspectRunViewerCiChangesCli,
} from '../../scripts/loop/inspect-run-viewer-ci-changes.mjs';
function createManager(overrides = {}) {
  const listenersByPort = new Map();
  const processes = new Map();
  const browserOpens = [];
  const launches = [];
  const stopped = [];
  let nextPid = 4000;

  const manager = createInspectRunViewerLifecycleManager({
  // standard happy-path manager used by the bounded lifecycle tests
    nowImpl: () => '2026-06-01T12:00:00.000Z',
    async listListeningPidsImpl(port) {
      return [...(listenersByPort.get(port) ?? [])];
    },
    async isProcessAliveImpl(pid) {
      return processes.get(pid)?.alive === true;
    },
    async healthcheckUrlImpl(url) {
      return [...processes.values()].some((entry) => entry.url === url && entry.healthy === true);
    },
    async launchManagedServerImpl({ repoRoot, repo, host, port, url }) {
      const pid = nextPid++;
      launches.push({ repoRoot, repo, host, port, url, pid });
      processes.set(pid, { alive: true, healthy: true, port, url, repo });
      listenersByPort.set(port, [pid]);
      return { pid };
    },
    async stopManagedProcessImpl(pid) {
      stopped.push(pid);
      const processEntry = processes.get(pid);
      if (processEntry) {
        processEntry.alive = false;
        processEntry.healthy = false;
        listenersByPort.set(processEntry.port, (listenersByPort.get(processEntry.port) ?? []).filter((value) => value !== pid));
      }
    },
    async openBrowserImpl(url) {
      browserOpens.push(url);
    },
    ...overrides,
  });

  return {
    manager,
    listenersByPort,
    processes,
    browserOpens,
    launches,
    stopped,
  };
}


function createStubbornManagedProcessManager() {
  let nextPid = 7000;
  let listenerPid = null;
  let nowMs = 0;
  const alive = new Set();
  const healthy = new Set();
  const launches = [];
  const stopCalls = [];

  const manager = createInspectRunViewerLifecycleManager({
    nowImpl: () => '2026-06-01T12:00:00.000Z',
    nowMsImpl: () => nowMs,
    async waitImpl(ms = 0) {
      nowMs += ms || 100;
    },
    async listListeningPidsImpl() {
      return listenerPid === null ? [] : [listenerPid];
    },
    async isProcessAliveImpl(pid) {
      return alive.has(pid);
    },
    async healthcheckUrlImpl() {
      return listenerPid !== null && alive.has(listenerPid) && healthy.has(listenerPid);
    },
    async launchManagedServerImpl({ repoRoot, repo, host, port, url }) {
      const pid = nextPid++;
      listenerPid = pid;
      alive.add(pid);
      healthy.add(pid);
      launches.push({ repoRoot, repo, host, port, url, pid });
      return { pid };
    },
    async stopManagedProcessImpl(pid) {
      stopCalls.push(pid);
    },
    async openBrowserImpl() {},
  });

  return {
    manager,
    launches,
    stopCalls,
    markUnhealthy(pid) {
      healthy.delete(pid);
    },
    currentPid() {
      return listenerPid;
    },
  };
}

test('managed seam writes and reads the repo-local record on open/status', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-managed-'));
  const { manager, browserOpens, launches } = createManager();

  const opened = await manager.open({ repoRoot, repo: 'mfittko/dev-loops' });
  assert.equal(opened.state, 'running');
  assert.equal(opened.startedFresh, true);
  assert.equal(opened.reusedExisting, false);
  assert.equal(opened.url, 'http://127.0.0.1:4311');
  assert.deepEqual(browserOpens, ['http://127.0.0.1:4311']);
  assert.equal(launches.length, 1);

  const recordPath = path.join(repoRoot, INSPECT_RUN_VIEWER_MANAGED_RECORD_PATH);
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  assert.equal(record.surfaceId, 'inspect-run-viewer');
  assert.equal(record.launchArgs.repo, 'mfittko/dev-loops');
  assert.equal(record.pid, launches[0].pid);
  assert.equal(record.cwd, repoRoot);

  const status = await manager.status({ repoRoot, repo: 'mfittko/dev-loops' });
  assert.equal(status.state, 'running');
  assert.equal(status.url, 'http://127.0.0.1:4311');
  assert.match(status.detail, /managed/i);
});

test('status reports stale_record when the saved pid is dead', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-stale-'));
  const { manager, processes, launches, listenersByPort } = createManager();

  await manager.open({ repoRoot });
  processes.get(launches[0].pid).alive = false;
  processes.get(launches[0].pid).healthy = false;
  listenersByPort.set(4311, []);

  const status = await manager.status({ repoRoot });
  assert.equal(status.state, 'stale_record');
  assert.equal(status.url, 'http://127.0.0.1:4311');
});

test('status reports conflict_unmanaged_listener when no managed record exists but the port is occupied', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-conflict-'));
  const { manager, listenersByPort, processes } = createManager();
  listenersByPort.set(4311, [9001]);
  processes.set(9001, { alive: true, healthy: true, port: 4311, url: 'http://127.0.0.1:4311' });

  const status = await manager.status({ repoRoot });
  assert.equal(status.state, 'conflict_unmanaged_listener');
  assert.equal(status.url, 'http://127.0.0.1:4311');
});

test('restart reclaims unmanaged listeners when no managed record exists', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-restart-unmanaged-only-'));
  const { manager, listenersByPort, processes, stopped, launches } = createManager();
  listenersByPort.set(4311, [9001]);
  processes.set(9001, { alive: true, healthy: true, port: 4311, url: 'http://127.0.0.1:4311' });

  const restarted = await manager.restart({ repoRoot, repo: 'mfittko/dev-loops' });
  assert.equal(restarted.state, 'running');
  assert.match(restarted.detail, /restarted the managed inspect-run viewer/i);
  assert.deepEqual(stopped, [9001]);
  assert.equal(launches.length, 1);
});

test('open reuses a matching live managed instance instead of relaunching', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-reuse-'));
  const { manager, launches, browserOpens } = createManager();

  await manager.open({ repoRoot, repo: 'mfittko/dev-loops' });
  const reopened = await manager.open({ repoRoot, repo: 'mfittko/dev-loops' });

  assert.equal(reopened.state, 'running');
  assert.equal(reopened.reusedExisting, true);
  assert.equal(reopened.startedFresh, false);
  assert.equal(launches.length, 1);
  assert.equal(browserOpens.length, 2);
});

test('open keeps the managed record when a running viewer ignores SIGTERM during replacement', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-open-running-stubborn-'));
  const { manager, launches, stopCalls, currentPid } = createStubbornManagedProcessManager();

  await manager.open({ repoRoot, repo: 'mfittko/dev-loops' });
  const result = await manager.open({ repoRoot, repo: 'other/repo' });

  assert.equal(result.state, 'stale_record');
  assert.match(result.detail, /keeping the managed record instead of replacing it/i);
  assert.deepEqual(stopCalls, [currentPid()]);
  assert.equal(launches.length, 1);

  const record = JSON.parse(await readFile(path.join(repoRoot, INSPECT_RUN_VIEWER_MANAGED_RECORD_PATH), 'utf8'));
  assert.equal(record.pid, currentPid());
});

test('resume fails closed and does not auto-start when nothing live is managed', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-resume-'));
  const { manager, launches, browserOpens } = createManager();

  const resumed = await manager.resume({ repoRoot, repo: 'mfittko/dev-loops' });
  assert.equal(resumed.state, 'stopped');
  assert.equal(resumed.resumedExisting, false);
  assert.equal(resumed.url, null);
  assert.equal(resumed.detail.includes('open'), true);
  assert.equal(launches.length, 0);
  assert.equal(browserOpens.length, 0);
});

test('stop only terminates the recorded managed pid', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-stop-'));
  const { manager, listenersByPort, processes, stopped, launches } = createManager();

  await manager.open({ repoRoot });
  listenersByPort.set(4311, [launches[0].pid, 9002]);
  processes.set(9002, { alive: true, healthy: true, port: 4311, url: 'http://127.0.0.1:4311' });

  const stoppedResult = await manager.stop({ repoRoot });
  assert.equal(stoppedResult.state, 'conflict_unmanaged_listener');
  assert.deepEqual(stopped, [launches[0].pid]);
  assert.equal(processes.get(9002).alive, true);
});

test('restart keeps the managed record when a running viewer ignores SIGTERM', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-restart-running-stubborn-'));
  const { manager, launches, stopCalls, currentPid } = createStubbornManagedProcessManager();

  await manager.open({ repoRoot, repo: 'mfittko/dev-loops' });
  const result = await manager.restart({ repoRoot, repo: 'mfittko/dev-loops' });

  assert.equal(result.state, 'stale_record');
  assert.match(result.detail, /keeping the managed record instead of restarting it/i);
  assert.deepEqual(stopCalls, [currentPid()]);
  assert.equal(launches.length, 1);

  const record = JSON.parse(await readFile(path.join(repoRoot, INSPECT_RUN_VIEWER_MANAGED_RECORD_PATH), 'utf8'));
  assert.equal(record.pid, currentPid());
});

test('restart reclaims an unmanaged listener conflict before relaunching', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-restart-'));
  const { manager, listenersByPort, processes, stopped, launches } = createManager();

  await manager.open({ repoRoot, repo: 'mfittko/dev-loops' });
  const managedPid = launches[0].pid;
  processes.get(managedPid).alive = false;
  processes.get(managedPid).healthy = false;
  listenersByPort.set(4311, [9111]);
  processes.set(9111, { alive: true, healthy: true, port: 4311, url: 'http://127.0.0.1:4311' });

  const restarted = await manager.restart({ repoRoot, repo: 'mfittko/dev-loops' });
  assert.equal(restarted.state, 'running');
  assert.match(restarted.detail, /restarted the managed inspect-run viewer/i);
  assert.deepEqual(stopped, [9111]);
  assert.equal(launches.length, 2);
});

test('open recovers from a stale record by replacing it with a fresh managed instance', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-open-stale-'));
  const { manager, launches, processes, listenersByPort } = createManager();

  await manager.open({ repoRoot });
  processes.get(launches[0].pid).alive = false;
  processes.get(launches[0].pid).healthy = false;
  listenersByPort.set(4311, []);

  const reopened = await manager.open({ repoRoot });
  assert.equal(reopened.state, 'running');
  assert.equal(reopened.startedFresh, true);
  assert.equal(launches.length, 2);
});

test('open reports a warning instead of failing when browser auto-open errors', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-browser-warning-'));
  const { manager } = createManager({
    async openBrowserImpl() {
      throw new Error('browser unavailable');
    },
  });

  const opened = await manager.open({ repoRoot });
  assert.equal(opened.state, 'running');
  assert.equal(opened.warning, 'browser unavailable');
});

test('stop keeps a stale managed record when the recorded pid stays alive on the viewer port', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-stop-stale-stubborn-'));
  const { manager, stopCalls, markUnhealthy, currentPid } = createStubbornManagedProcessManager();

  await manager.open({ repoRoot });
  markUnhealthy(currentPid());

  const result = await manager.stop({ repoRoot });
  assert.equal(result.state, 'stale_record');
  assert.match(result.detail, /keeping the stale record for manual cleanup/i);
  assert.deepEqual(stopCalls, [currentPid()]);

  const record = JSON.parse(await readFile(path.join(repoRoot, INSPECT_RUN_VIEWER_MANAGED_RECORD_PATH), 'utf8'));
  assert.equal(record.pid, currentPid());
});

test('status treats an unreadable managed record as stale_record with delete guidance', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-corrupt-record-'));
  await mkdir(path.join(repoRoot, '.pi', 'ui-servers'), { recursive: true });
  await writeFile(path.join(repoRoot, INSPECT_RUN_VIEWER_MANAGED_RECORD_PATH), '{not json\n');
  const { manager } = createManager();

  const status = await manager.status({ repoRoot });
  assert.equal(status.state, 'stale_record');
  assert.match(status.detail, /delete/i);
});

test('open clears a directory-shaped managed record path and starts fresh', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-record-directory-'));
  await mkdir(path.join(repoRoot, INSPECT_RUN_VIEWER_MANAGED_RECORD_PATH), { recursive: true });
  const { manager, launches } = createManager();

  const opened = await manager.open({ repoRoot });
  assert.equal(opened.state, 'running');
  assert.equal(launches.length, 1);

  const record = JSON.parse(await readFile(path.join(repoRoot, INSPECT_RUN_VIEWER_MANAGED_RECORD_PATH), 'utf8'));
  assert.equal(record.surfaceId, 'inspect-run-viewer');
  assert.equal(record.pid, launches[0].pid);
});

test('stop fails closed with explicit guidance when --repo does not match the managed instance', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-stop-mismatch-'));
  const { manager, launches, stopped } = createManager();

  await manager.open({ repoRoot, repo: 'mfittko/dev-loops' });
  const result = await manager.stop({ repoRoot, repo: 'other/repo' });

  assert.equal(result.state, 'stopped');
  assert.equal(result.url, null);
  assert.match(result.detail, /different managed inspect-run viewer/i);
  assert.equal(stopped.length, 0);
  assert.equal(launches.length, 1);
});

test('open does not attempt to auto-open a browser when an unmanaged listener ignores SIGTERM', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-open-conflict-'));
  let stopCalls = 0;
  let nowMs = 1;
  const { manager, listenersByPort, processes, browserOpens } = createManager({
    async stopManagedProcessImpl() {
      stopCalls += 1;
    },
    nowMsImpl: () => nowMs,
    async waitImpl(ms = 0) {
      nowMs += Math.max(ms, 0);
    },
  });
  listenersByPort.set(4311, [9555]);
  processes.set(9555, { alive: true, healthy: true, port: 4311, url: 'http://127.0.0.1:4311' });

  const result = await manager.open({ repoRoot });
  assert.equal(result.state, 'conflict_unmanaged_listener');
  assert.match(result.detail, /did not stop after SIGTERM/i);
  assert.equal(stopCalls, 1);
  assert.deepEqual(browserOpens, []);
});

test('status treats a record with the wrong surface identity as stale_record', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-wrong-surface-'));
  await mkdir(path.join(repoRoot, '.pi', 'ui-servers'), { recursive: true });
  await writeFile(path.join(repoRoot, INSPECT_RUN_VIEWER_MANAGED_RECORD_PATH), `${JSON.stringify({
    schemaVersion: 99,
    surfaceId: 'something-else',
    pid: 123,
    host: '127.0.0.1',
    port: 4311,
    url: 'http://127.0.0.1:4311',
    launchArgs: { repo: null, host: '127.0.0.1', port: 4311 },
  })}\n`);
  const { manager } = createManager();

  const status = await manager.status({ repoRoot });
  assert.equal(status.state, 'stale_record');
  assert.match(status.detail, /delete/i);
});

test('open does not kill a stale recorded pid when it is alive but not listening on the viewer port', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-stale-pid-reuse-'));
  const { manager, processes, launches, stopped, listenersByPort } = createManager();

  await manager.open({ repoRoot });
  const stalePid = launches[0].pid;
  processes.get(stalePid).healthy = false;
  processes.get(stalePid).port = 9999;
  listenersByPort.set(4311, []);

  const reopened = await manager.open({ repoRoot });
  assert.equal(reopened.state, 'running');
  assert.deepEqual(stopped, []);
});

test('open cleans up the spawned process when startup never becomes healthy', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-launch-timeout-'));
  const stopped = [];
  let nowMs = 0;
  const manager = createInspectRunViewerLifecycleManager({
    async listListeningPidsImpl() {
      return [];
    },
    async isProcessAliveImpl(pid) {
      return pid === 7123;
    },
    async healthcheckUrlImpl() {
      return false;
    },
    async launchManagedServerImpl() {
      return { pid: 7123 };
    },
    async stopManagedProcessImpl(pid) {
      stopped.push(pid);
    },
    async waitImpl(ms = 0) {
      nowMs += ms || 100;
    },
    nowImpl: () => '2026-06-01T12:00:00.000Z',
    nowMsImpl: () => nowMs,
    async openBrowserImpl() {},
  });

  await assert.rejects(manager.open({ repoRoot }), /startup timeout/i);
  assert.deepEqual(stopped, [7123]);
});

test('open tolerates ESRCH while replacing a managed instance', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-open-esrch-'));
  let nextPid = 5000;
  let listenerPid = null;
  const alive = new Set();
  const stopCalls = [];
  let nowMs = 0;
  const manager = createInspectRunViewerLifecycleManager({
    async listListeningPidsImpl() {
      return listenerPid === null ? [] : [listenerPid];
    },
    async isProcessAliveImpl(pid) {
      return alive.has(pid);
    },
    async healthcheckUrlImpl() {
      return listenerPid !== null && alive.has(listenerPid);
    },
    async launchManagedServerImpl() {
      const pid = nextPid++;
      listenerPid = pid;
      alive.add(pid);
      return { pid };
    },
    async stopManagedProcessImpl(pid) {
      stopCalls.push(pid);
      alive.delete(pid);
      listenerPid = null;
      const error = new Error('gone');
      error.code = 'ESRCH';
      throw error;
    },
    async waitImpl(ms = 0) {
      nowMs += ms || 100;
    },
    nowMsImpl: () => nowMs,
    nowImpl: () => '2026-06-01T12:00:00.000Z',
    async openBrowserImpl() {},
  });

  await manager.open({ repoRoot, repo: 'mfittko/dev-loops' });
  const reopened = await manager.open({ repoRoot, repo: 'other/repo' });
  assert.equal(reopened.state, 'running');
  assert.deepEqual(stopCalls, [5000]);
});

test('stop and restart treat ESRCH as already-stopped', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-stop-restart-esrch-'));
  let nextPid = 6000;
  let listenerPid = null;
  const alive = new Set();
  let stopCalls = 0;
  let nowMs = 0;
  const manager = createInspectRunViewerLifecycleManager({
    async listListeningPidsImpl() {
      return listenerPid === null ? [] : [listenerPid];
    },
    async isProcessAliveImpl(pid) {
      return alive.has(pid);
    },
    async healthcheckUrlImpl() {
      return listenerPid !== null && alive.has(listenerPid);
    },
    async launchManagedServerImpl() {
      const pid = nextPid++;
      listenerPid = pid;
      alive.add(pid);
      return { pid };
    },
    async stopManagedProcessImpl(pid) {
      stopCalls += 1;
      alive.delete(pid);
      listenerPid = null;
      const error = new Error('gone');
      error.code = 'ESRCH';
      throw error;
    },
    async waitImpl(ms = 0) {
      nowMs += ms || 100;
    },
    nowMsImpl: () => nowMs,
    nowImpl: () => '2026-06-01T12:00:00.000Z',
    async openBrowserImpl() {},
  });

  await manager.open({ repoRoot, repo: 'mfittko/dev-loops' });
  const stopped = await manager.stop({ repoRoot, repo: 'mfittko/dev-loops' });
  assert.equal(stopped.state, 'stopped');

  await manager.open({ repoRoot, repo: 'mfittko/dev-loops' });
  const restarted = await manager.restart({ repoRoot, repo: 'mfittko/dev-loops' });
  assert.equal(restarted.state, 'running');
  assert.equal(stopCalls, 2);
});

test('status returns the raw conflict URL instead of appending a scoped query to an unmanaged listener', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-conflict-raw-url-'));
  const { manager, listenersByPort, processes } = createManager();
  listenersByPort.set(4311, [9444]);
  processes.set(9444, { alive: true, healthy: true, port: 4311, url: 'http://127.0.0.1:4311' });

  const status = await manager.status({ repoRoot, repo: 'mfittko/dev-loops' });
  assert.equal(status.state, 'conflict_unmanaged_listener');
  assert.equal(status.url, 'http://127.0.0.1:4311');
});

test('status surfaces a friendly lsof guidance error when listener discovery support is unavailable', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-lsof-guidance-'));
  const manager = createInspectRunViewerLifecycleManager({
    async listListeningPidsImpl() {
      const error = new Error('spawn lsof ENOENT');
      error.code = 'ENOENT';
      error.path = 'lsof';
      throw error;
    },
  });

  await assert.rejects(manager.status({ repoRoot }), /lsof\/POSIX support/i);
});

test('status rejects a missing repoRoot with a clear lifecycle error', async () => {
  const { manager } = createManager();

  await assert.rejects(manager.status(), /requires a repoRoot/i);
});

test('buildOpenBrowserInvocation quotes Windows URLs as one literal argument', () => {
  const invocation = buildOpenBrowserInvocation('http://127.0.0.1:4311/?scope=owner/repo&view=current', 'win32');

  assert.equal(invocation.command, 'cmd');
  assert.deepEqual(invocation.args, [
    '/c',
    'start',
    '""',
    '"http://127.0.0.1:4311/?scope=owner/repo&view=current"',
  ]);
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.windowsVerbatimArguments, true);
});

test('status treats a record with a non-default host or port as stale_record', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-wrong-host-port-'));
  await mkdir(path.join(repoRoot, '.pi', 'ui-servers'), { recursive: true });
  await writeFile(path.join(repoRoot, INSPECT_RUN_VIEWER_MANAGED_RECORD_PATH), `${JSON.stringify({
    schemaVersion: 1,
    surfaceId: 'inspect-run-viewer',
    pid: 123,
    host: '0.0.0.0',
    port: 9999,
    url: 'http://0.0.0.0:9999',
    launchArgs: { repo: null, host: '0.0.0.0', port: 9999 },
  })}\n`);
  const { manager } = createManager();

  const status = await manager.status({ repoRoot });
  assert.equal(status.state, 'stale_record');
  assert.match(status.detail, /delete/i);
});

test('status treats a record with a non-integer pid as stale_record', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-bad-pid-'));
  await mkdir(path.join(repoRoot, '.pi', 'ui-servers'), { recursive: true });
  await writeFile(path.join(repoRoot, INSPECT_RUN_VIEWER_MANAGED_RECORD_PATH), `${JSON.stringify({
    schemaVersion: 1,
    surfaceId: 'inspect-run-viewer',
    pid: 12.5,
    host: '127.0.0.1',
    port: 4311,
    url: 'http://127.0.0.1:4311',
    launchArgs: { repo: null, host: '127.0.0.1', port: 4311 },
  })}\n`);
  const { manager } = createManager();

  const status = await manager.status({ repoRoot });
  assert.equal(status.state, 'stale_record');
  assert.match(status.detail, /delete/i);
});

test('open fails with a clear error when the launch seam does not return a positive integer pid', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-invalid-launch-pid-'));
  const manager = createInspectRunViewerLifecycleManager({
    async listListeningPidsImpl() {
      return [];
    },
    async launchManagedServerImpl() {
      return { pid: undefined };
    },
    async openBrowserImpl() {},
  });

  await assert.rejects(manager.open({ repoRoot }), /positive integer pid/i);
});

test('defaultHealthcheck fetches without AbortSignal (Node v24 compatibility)', async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-healthcheck-signal-'));

  // Spy on global fetch and short-circuit the response so the contract test
  // stays deterministic without depending on a real HTTP server lifecycle.
  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { status: 200 };
  };

  try {
    // Manager with real defaultHealthcheck (healthcheckUrlImpl defaults)
    // but stubbed lifecycle seams.
    const manager = createInspectRunViewerLifecycleManager({
      listListeningPidsImpl: async () => [42],
      isProcessAliveImpl: async () => true,
      async launchManagedServerImpl() { return { pid: 42 }; },
      async stopManagedProcessImpl() {},
      async openBrowserImpl() {},
    });

    const recordPath = path.join(repoRoot, INSPECT_RUN_VIEWER_MANAGED_RECORD_PATH);
    await mkdir(path.dirname(recordPath), { recursive: true });
    await writeFile(recordPath, `${JSON.stringify({
      schemaVersion: 1,
      surfaceId: 'inspect-run-viewer',
      pid: 42,
      host: '127.0.0.1',
      port: 4311,
      url: 'http://127.0.0.1:4311',
      launchArgs: { repo: null, host: '127.0.0.1', port: 4311 },
      argsFingerprint: JSON.stringify({ repo: null, host: '127.0.0.1', port: 4311 }),
      startedAt: new Date().toISOString(),
      cwd: repoRoot,
    })}
`);

    const status = await manager.status({ repoRoot });
    assert.equal(status.state, 'running');

    const healthcheckCall = fetchCalls.find((c) => String(c.url).includes('4311'));
    assert.ok(healthcheckCall, 'healthcheck should call fetch');
    assert.equal(healthcheckCall.options?.method, 'GET');
    assert.ok(!healthcheckCall.options?.signal, 'fetch must not receive an AbortSignal');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('isInspectRunViewerRelevantPath matches the bounded inspect-run viewer smoke surface', () => {
  assert.equal(isInspectRunViewerRelevantPath('.github/workflows/ci.yml'), true);
  assert.equal(isInspectRunViewerRelevantPath('package.json'), true);
  assert.equal(isInspectRunViewerRelevantPath('package-lock.json'), true);
  assert.equal(isInspectRunViewerRelevantPath('scripts/loop/inspect-run-viewer/rendering.mjs'), true);
  assert.equal(isInspectRunViewerRelevantPath('scripts/loop/inspect-run-viewer-ci-changes.mjs'), true);
  assert.equal(isInspectRunViewerRelevantPath('test/playwright/harness/webkit-smoke-harness.mjs'), true);
  assert.equal(isInspectRunViewerRelevantPath('test/playwright/inspect-run-viewer.spec.mjs'), true);
  assert.equal(isInspectRunViewerRelevantPath('test/playwright/fixtures/inspect-run-viewer-fixture.mjs'), true);
  assert.equal(isInspectRunViewerRelevantPath('test/playwright/some-other-ui.spec.mjs'), false);

  assert.equal(isInspectRunViewerRelevantPath('README.md'), false);
  assert.equal(isInspectRunViewerRelevantPath('docs/index.md'), false);
  assert.equal(isInspectRunViewerRelevantPath('test/loop/inspect-run-viewer.test.mjs'), false);
});

test('classifyInspectRunViewerCiChanges only requests browser smoke when relevant paths changed', () => {
  const relevant = classifyInspectRunViewerCiChanges([
    'README.md',
    'scripts/loop/inspect-run-viewer/server.mjs',
    'test/playwright/fixtures/inspect-run-viewer-fixture.mjs',
    'docs/index.md',
  ]);
  assert.equal(relevant.shouldRun, true);
  assert.deepEqual(relevant.relevantPaths, [
    'scripts/loop/inspect-run-viewer/server.mjs',
    'test/playwright/fixtures/inspect-run-viewer-fixture.mjs',
  ]);
  const irrelevant = classifyInspectRunViewerCiChanges([
    'README.md',
    'docs/IMPLEMENTATION_WORKFLOW.md',
  ]);
  assert.equal(irrelevant.shouldRun, false);
  assert.deepEqual(irrelevant.relevantPaths, []);
});

test('runCli emits github output entries for inspect-run viewer smoke gating', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'inspect-run-viewer-ci-changes-'));
  const pathsFile = path.join(tempDir, 'changed-files.txt');
  const githubOutputFile = path.join(tempDir, 'github-output.txt');
  const writes = [];

  try {
    await writeFile(pathsFile, [
      'README.md',
      'playwright.config.mjs',
      'test/playwright/harness/webkit-smoke-harness.mjs',
    ].join('\n'), 'utf8');

    const result = await runInspectRunViewerCiChangesCli([
      pathsFile,
    ], {
      env: {
        ...process.env,
        GITHUB_OUTPUT: githubOutputFile,
      },
      stdout: {
        write(chunk) {
          writes.push(String(chunk));
        },
      },
    });

    assert.equal(result.shouldRun, true);
    assert.deepEqual(result.relevantPaths, ['playwright.config.mjs', 'test/playwright/harness/webkit-smoke-harness.mjs']);

    const payload = JSON.parse(writes.join(''));
    assert.equal(payload.ok, true);
    assert.equal(payload.shouldRun, true);

    const githubOutput = await readFile(githubOutputFile, 'utf8');
    assert.match(githubOutput, /^inspect_run_viewer=true$/m);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
