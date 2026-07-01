import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { installServerTeardown } from "../../scripts/loop/inspect-run-viewer.mjs";

function makeServerStub() {
  let closeCount = 0;
  return {
    get closeCount() {
      return closeCount;
    },
    close() {
      closeCount += 1;
    },
  };
}

function makeProcessStub() {
  const emitter = new EventEmitter();
  return {
    emitter,
    on: (signal, handler) => emitter.on(signal, handler),
    removeListener: (signal, handler) => emitter.removeListener(signal, handler),
    listenerCount: (signal) => emitter.listenerCount(signal),
  };
}

test("teardown() closes the server and is idempotent", () => {
  const server = makeServerStub();
  const processImpl = makeProcessStub();
  const teardown = installServerTeardown(server, { lifetimeMs: 0, processImpl });

  teardown();
  teardown();

  assert.equal(server.closeCount, 1, "server should be closed exactly once");
});

test("SIGINT and SIGTERM each close the server via the installed handler", () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const server = makeServerStub();
    const processImpl = makeProcessStub();
    installServerTeardown(server, { lifetimeMs: 0, processImpl });

    assert.equal(processImpl.listenerCount(signal), 1, `${signal} handler installed`);
    processImpl.emitter.emit(signal, signal);

    assert.equal(server.closeCount, 1, `${signal} should close the server`);
    assert.equal(processImpl.listenerCount(signal), 0, `${signal} handler detached after teardown`);
  }
});

test("lifetime timeout closes the server and the timer is unref'd", () => {
  const server = makeServerStub();
  const processImpl = makeProcessStub();
  let scheduled = null;
  let unrefCalled = false;
  const setTimeoutImpl = (fn, ms) => {
    scheduled = { fn, ms };
    return { unref: () => { unrefCalled = true; } };
  };
  const clearTimeoutImpl = () => {};

  installServerTeardown(server, {
    lifetimeMs: 1000,
    processImpl,
    setTimeoutImpl,
    clearTimeoutImpl,
  });

  assert.equal(scheduled.ms, 1000, "lifetime timer scheduled with configured ms");
  assert.equal(unrefCalled, true, "lifetime timer is unref'd so it never keeps the loop alive");

  scheduled.fn();
  assert.equal(server.closeCount, 1, "lifetime timeout should close the server");
});

test("explicit teardown detaches all signal handlers and clears the timer", () => {
  const server = makeServerStub();
  const processImpl = makeProcessStub();
  let cleared = false;
  const teardown = installServerTeardown(server, {
    lifetimeMs: 1000,
    processImpl,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => { cleared = true; },
  });

  teardown();

  assert.equal(processImpl.listenerCount("SIGINT"), 0);
  assert.equal(processImpl.listenerCount("SIGTERM"), 0);
  assert.equal(cleared, true, "pending lifetime timer is cleared on teardown");
});
