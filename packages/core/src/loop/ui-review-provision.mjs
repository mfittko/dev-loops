/**
 * Provision + boot orchestrator for the ui_review route (Stage 1).
 *
 * Provisions an isolated worktree for a PR head and boots the branch's app to a
 * ready state, then hands off a booted app for the running-app review stages.
 * The orchestration is a fail-closed sequence:
 *
 *   1. create-or-reuse the PR worktree (fetch before) and provision it
 *   2. refuse to operate in the primary checkout (worktree guard)
 *   3. install ONLY the dependency-lock delta vs. the primary checkout
 *   4. run pending dev-DB migrations; a destructive one stops for explicit ack
 *   5. resolve a per-project run recipe (no app is ever guessed)
 *   6. boot the app and poll an HTTP readiness probe (never a fixed sleep)
 *
 * Every bounded cap (install skipped, migration ack required, boot timeout) is
 * logged — no silent truncation. This module is pure orchestration: all IO
 * (git/worktree, config, spawn, HTTP probe, clock) is injected so it is fully
 * testable against a fixture project. The thin CLI wires the real seams.
 *
 * Out of scope (later stages): browser driving, auth, screenshots, review
 * posting, production DB.
 */

const MUST_FIX = "must-fix";

/**
 * Run the provision+boot sequence.
 *
 * @param {object} input
 * @param {string} input.repoRoot - Absolute path to the primary checkout.
 * @param {number} input.pr - PR number whose head is provisioned.
 * @param {string} [input.branch] - Branch to check out (default: pr-<n>).
 * @param {boolean} [input.ackDestructiveMigration] - Explicit ack unblocking a
 *   destructive/blocked migration. Fail-closed: absent means "not acknowledged".
 * @param {object} seams - Injected IO (all required except clock/log defaults).
 * @param {(a:{repoRoot:string,pr:number,branch?:string})=>Promise<{path:string,created:boolean,reused:boolean}>} seams.ensureWorktree
 * @param {(a:{worktreePath:string,repoRoot:string})=>{ok:boolean,message?:string,mainWorktreePath?:string|null}} seams.assertNotPrimary
 * @param {(a:{repoRoot:string,worktreePath:string})=>Promise<{changed:boolean,detail:string}>} seams.detectDepDelta
 * @param {(a:{worktreePath:string})=>Promise<{ok:boolean,detail:string}>} seams.installDeps
 * @param {(worktreePath:string)=>Promise<object|null>} seams.resolveRunRecipe
 * @param {(a:{worktreePath:string,recipe:object})=>Promise<{pending:string[],destructive:string[],detail:string}>} seams.inspectMigrations
 * @param {(a:{worktreePath:string,recipe:object})=>Promise<{applied:number,detail:string}>} seams.applyMigrations
 * @param {(a:{worktreePath:string,recipe:object})=>Promise<{pid:number|null,detail:string}>} seams.bootApp
 * @param {(url:string)=>Promise<boolean>} seams.probe
 * @param {(ms:number)=>Promise<void>} [seams.delay]
 * @param {()=>number} [seams.now]
 * @param {(msg:string)=>void} [seams.log]
 * @returns {Promise<object>} A result envelope (see fields assembled below).
 */
export async function provisionAndBoot(
  { repoRoot, pr, branch, ackDestructiveMigration = false },
  {
    ensureWorktree,
    assertNotPrimary,
    detectDepDelta,
    installDeps,
    resolveRunRecipe,
    inspectMigrations,
    applyMigrations,
    bootApp,
    probe,
    delay = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = () => Date.now(),
    log = () => {},
  } = {},
) {
  const logs = [];
  const findings = [];
  const record = (msg) => {
    logs.push(msg);
    log(msg);
  };
  const base = () => ({ pr, branch: branch ?? null, findings, logs });
  const stop = (stopReason, finding, extra = {}) => {
    if (finding) findings.push(finding);
    record(`STOP: ${stopReason}`);
    return { ok: false, stopped: true, stopReason, ...base(), ...extra };
  };

  // 1. Create-or-reuse the PR worktree (ensureWorktree fetches + provisions).
  const wt = await ensureWorktree({ repoRoot, pr, branch });
  const worktreePath = wt.path;
  record(`worktree ${wt.created ? "created" : "reused"}: ${worktreePath}`);

  // 2. Fail closed if that path is the primary checkout — never operate there.
  const guard = assertNotPrimary({ worktreePath, repoRoot });
  if (!guard.ok) {
    return stop(
      "worktree guard: refusing to operate in the primary checkout",
      { kind: "worktree-guard", severity: MUST_FIX, message: guard.message ?? "resolved worktree is the primary checkout" },
      { worktreePath },
    );
  }

  // 3. Install only the dependency-lock delta vs. the primary checkout. No delta
  //    => deps are shared; installing anything would be a blind re-install.
  const delta = await detectDepDelta({ repoRoot, worktreePath });
  let depInstall = { installed: false, detail: delta.detail };
  if (delta.changed) {
    record(`dependency-lock delta detected (${delta.detail}); installing branch deps`);
    const inst = await installDeps({ worktreePath });
    depInstall = { installed: inst.ok, detail: inst.detail };
    record(`dependency install ${inst.ok ? "ok" : "FAILED"}: ${inst.detail}`);
    if (!inst.ok) {
      return stop(
        "dependency install failed",
        { kind: "dep-install", severity: MUST_FIX, message: inst.detail },
        { worktreePath, depInstall },
      );
    }
  } else {
    record(`dependency install skipped: no lock delta vs primary checkout (${delta.detail})`);
  }

  // 4. Resolve the per-project run recipe before migrate/boot (no app guessed).
  const recipe = await resolveRunRecipe(worktreePath);
  if (!recipe) {
    return stop(
      "no run recipe: the branch declares no uiReview.run recipe (cannot boot the app)",
      { kind: "run-recipe-missing", severity: MUST_FIX, message: "declare uiReview.run.command + readyUrl in .devloops" },
      { worktreePath, depInstall },
    );
  }

  // 5. Dev-DB migrations. A destructive/blocked migration fails closed to a
  //    finding requiring explicit ack; nothing is applied until acknowledged.
  let migrations = { pending: 0, applied: 0, destructive: [], detail: "no migrate recipe" };
  if (recipe.migrate) {
    const mig = await inspectMigrations({ worktreePath, recipe });
    record(`migration status: ${mig.pending.length} pending, ${mig.destructive.length} destructive (${mig.detail})`);
    if (mig.destructive.length > 0 && !ackDestructiveMigration) {
      return stop(
        "destructive migration requires explicit acknowledgement",
        {
          kind: "destructive-migration",
          severity: MUST_FIX,
          requiresAck: true,
          message: `${mig.destructive.length} destructive migration(s) blocked pending ack`,
          destructive: mig.destructive,
        },
        { worktreePath, depInstall, migrations: { pending: mig.pending.length, applied: 0, destructive: mig.destructive, detail: mig.detail } },
      );
    }
    if (mig.pending.length > 0) {
      if (mig.destructive.length > 0) {
        record(`destructive migration(s) acknowledged; applying ${mig.pending.length} pending migration(s)`);
      }
      const applied = await applyMigrations({ worktreePath, recipe });
      migrations = { pending: mig.pending.length, applied: applied.applied, destructive: mig.destructive, detail: applied.detail };
      record(`migrations applied: ${applied.applied} (${applied.detail})`);
    } else {
      migrations = { pending: 0, applied: 0, destructive: mig.destructive, detail: "no pending migrations" };
      record("no pending migrations");
    }
  } else {
    record("migrations skipped: branch declares no migrate recipe");
  }

  // 6. Boot the app, then poll the readiness probe against an explicit deadline.
  const boot = await bootApp({ worktreePath, recipe });
  record(`app booting (pid ${boot.pid ?? "n/a"}): ${boot.detail}`);

  const timeoutMs = recipe.readyTimeoutMs;
  const intervalMs = recipe.readyIntervalMs;
  const deadline = now() + timeoutMs;
  let ready = false;
  let attempts = 0;
  // Bounded poll (never a fixed sleep): probe, then wait one interval, until the
  // deadline. The injected clock/delay make the timeout deterministic in tests.
  while (now() <= deadline) {
    attempts += 1;
    if (await probe(recipe.readyUrl)) {
      ready = true;
      break;
    }
    if (now() + intervalMs > deadline) break; // would overshoot the deadline
    await delay(intervalMs);
  }

  const bootResult = { pid: boot.pid ?? null, ready, attempts, readyUrl: recipe.readyUrl, timeoutMs, intervalMs };
  if (!ready) {
    record(`boot timeout: not ready after ${timeoutMs}ms (${attempts} probe attempt(s)) at ${recipe.readyUrl}`);
    return stop(
      `readiness probe timed out after ${timeoutMs}ms (${attempts} attempt(s) at ${recipe.readyUrl})`,
      { kind: "boot-timeout", severity: MUST_FIX, message: `app never became ready within ${timeoutMs}ms` },
      { worktreePath, depInstall, migrations, boot: bootResult },
    );
  }

  record(`app ready after ${attempts} probe attempt(s) at ${recipe.readyUrl}`);
  return {
    ok: true,
    stopped: false,
    stopReason: null,
    worktreePath,
    created: wt.created,
    reused: wt.reused,
    depInstall,
    migrations,
    boot: bootResult,
    ...base(),
  };
}
