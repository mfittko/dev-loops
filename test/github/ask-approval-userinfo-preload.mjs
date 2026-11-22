// Test-only preload (`node --import`) for the ask-approval hook subprocesses (MERGE-ASK-APPROVAL).
// The hooks resolve the approval directory from the account database, like the merge verifier, and ignore
// the directory override in their real environment. A test redirects the account home instead.
//   DEVLOOPS_TEST_HOME=<dir>          os.userInfo().homedir is <dir>
//   DEVLOOPS_TEST_USERINFO=throw      os.userInfo() throws (a UID with no passwd entry)
//   DEVLOOPS_TEST_USERINFO=bad-home   os.userInfo() returns a non-string home, so path resolution throws
import os from "node:os";

const real = os.userInfo;
if (process.env.DEVLOOPS_TEST_USERINFO === "throw") {
  os.userInfo = () => { throw new Error("ENOENT: no passwd entry for this uid"); };
} else if (process.env.DEVLOOPS_TEST_USERINFO === "bad-home") {
  os.userInfo = (...args) => ({ ...real(...args), homedir: 42 });
} else if (process.env.DEVLOOPS_TEST_HOME) {
  os.userInfo = (...args) => ({ ...real(...args), homedir: process.env.DEVLOOPS_TEST_HOME });
}
