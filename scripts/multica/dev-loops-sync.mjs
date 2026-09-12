#!/usr/bin/env node
// dev-loops-sync — sync dev-loops agents + skills into a Multica workspace from a
// detected source (self > local > claude > pi), driving the `multica` CLI (not raw
// HTTP). Skills are SKILL.md-only (tools/docs resolve from the source at runtime via
// dev-loops-run); agents are pinned to a runtime, carry DEVLOOPS_HOME, and are bound
// to their skills. Idempotent.
//
//   multica-run: node dev-loops-sync.mjs [--source DIR] [--pull]
//                  [--workspace SLUG ...] [--runtime claude]
//                  [--profile NAME] [--server-url URL] [--mca PATH]
// In an agent run the daemon injects MULTICA_SERVER_URL/MULTICA_TOKEN/MULTICA_WORKSPACE_ID,
// so no --profile/--workspace is needed. Standalone: pass --profile (or --server-url) so
// the CLI can authenticate; omit --workspace to be prompted, or pass slugs/ids.
//
// Model invariant: the agent model is owned by Multica configuration. This script never
// passes --model — not on create (omit → inherit runtime defaults), not on update (omit →
// preserve the existing selection). Verified by test/multica/dev-loops-sync.test.mjs.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const HOME = homedir(), A = args();
const SKILLS = ["copilot-pr-followup", "dev-loop", "final-approval", "local-implementation", "loop-grill", "review", "ui-review"];
// Multica-native fan-out/fan-in contract, bound to every canonical agent: in Multica the
// loop dispatches work through a root dispatch comment on the existing parent issue
// (mention-dispatch to the dedicated agents, replies in-thread). The dispatch context
// is durable and self-contained: no coordinator worktree path in the briefing, an
// immutable committed head SHA (repo + PR + SHA), context in the comment/attachment,
// results back through the thread — never the coordinator's tmp/. Child issues are an
// explicit fallback only, carrying the same durable-context rules — not Pi's in-process
// subagent tool. Outside Multica the ordinary Pi dispatch is unchanged.
const MULTICA_DISPATCH = "multica-dispatch";
const CARRIERS = ["dev-loops-runtime", "dev-loops-contracts"]; // deprecated: resolve from source, don't copy
const BIND = { "dev-loop": ["dev-loop", "copilot-pr-followup", "final-approval"], developer: ["local-implementation"], docs: [], fixer: ["copilot-pr-followup"], judge: [], quality: [], refiner: ["loop-grill"], review: ["review", "ui-review"] };
const AGENTS = Object.keys(BIND).map((n) => ({ name: n, skills: [...(BIND[n] || []), MULTICA_DISPATCH] }));
const CLONE = "git clone https://github.com/mfittko/dev-loops ~/github/dev-loops";

// --- multica CLI -------------------------------------------------------------
function resolveMca() {
  const tries = [A.mca, process.env.MULTICA_BIN, "multica"].filter(Boolean);
  for (const t of tries) { try { execFileSync(t, ["--help"], { stdio: "ignore" }); return t; } catch {} }
  const built = "/tmp/mca";
  try { execFileSync("go", ["build", "-o", built, "./cmd/multica"], { cwd: join(HOME, "github/multica/server"), stdio: "inherit" }); return built; }
  catch { die("no `multica` binary: pass --mca PATH, set MULTICA_BIN, put `multica` on PATH, or make the source checkout buildable."); }
}
const MCA = resolveMca();
const BASE = [...(A.profile ? ["--profile", A.profile] : []), ...(A["server-url"] ? ["--server-url", A["server-url"]] : [])];
// run a CLI command; parse JSON stdout when present. `ws` scopes to a workspace id.
function cli(cmd, { ws, stdin } = {}) {
  const argv = [...BASE, ...(ws ? ["--workspace-id", ws] : []), ...cmd];
  const out = execFileSync(MCA, argv, { input: stdin, encoding: "utf8", maxBuffer: 64 << 20 });
  const t = out.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return t; }
}
const listArr = (j, ...k) => Array.isArray(j) ? j : (k.map((x) => j?.[x]).find(Boolean) || []);

// --- source: self (this checkout) > local > claude > pi ----------------------
const claudeDir = () => { try { const j = JSON.parse(readFileSync(join(HOME, ".claude/plugins/installed_plugins.json"), "utf8")); return Object.entries(j).find(([k]) => k.includes("dev-loops"))?.[1]?.[0]?.installPath || null; } catch { return null; } };
const selfDir = () => { let d = dirname(fileURLToPath(import.meta.url)); for (;;) { if (isCheckout(d)) return d; const p = dirname(d); if (p === d) return null; d = p; } };
// Portable detectors first: `self` (this script's own checkout, set once it ships
// inside dev-loops) and DEVLOOPS_HOME (set on every synced agent) need no machine
// assumptions; claude/pi are standard install roots. `local` is a best-effort guess
// for the common dogfooder layout only.
// ponytail: `~/github/dev-loops` is a convention guess, not a portable default — set
// DEVLOOPS_HOME or pass --source for any other checkout location.
const SOURCES = [["self", selfDir()], ["local", join(HOME, "github/dev-loops")], ["claude", claudeDir()], ["pi", join(HOME, ".pi/agent/npm/node_modules/dev-loops")]];
const has = (d) => d && existsSync(join(d, "package.json"));
function isCheckout(d) { try { return !!d && existsSync(join(d, "scripts")) && JSON.parse(readFileSync(join(d, "package.json"), "utf8")).name === "dev-loops"; } catch { return false; } }
const skillsDir = (s) => existsSync(join(s, ".claude/skills")) ? join(s, ".claude/skills") : join(s, "skills");
const agentsDir = (s) => existsSync(join(s, ".claude/agents")) ? join(s, ".claude/agents") : join(s, "agents");

// --- front-matter (name/description + body) ----------------------------------
function fm(text) {
  const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  if (end < 0) return { d: {}, body: text };
  const d = {}, lines = text.slice(3, end).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([\w-]+):\s*(.*)$/); if (!m) continue;
    let v = m[2];
    if ([">-", ">", "|", "|-"].includes(v)) { const p = []; while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) p.push(lines[++i].trim()); v = p.join(" "); }
    else v = v.replace(/^["']|["']$/g, "");
    d[m[1]] = v;
  }
  return { d, body: text.slice(end + 4).replace(/^\r?\n/, "") };
}
const clip = (s) => s.length <= 255 ? s : s.slice(0, 254).replace(/\s+\S*$/, "") + "…";

async function ask(q) { if (!process.stdin.isTTY) die(`need input, no TTY: ${q}`); const rl = createInterface({ input: process.stdin, output: process.stdout }); const a = (await rl.question(q)).trim(); rl.close(); return a; }
function die(m) { console.error("error:", m); process.exit(1); }
function args() { const a = { workspace: [] }; const v = process.argv.slice(2); for (let i = 0; i < v.length; i++) { const k = v[i]; if (k === "--workspace") a.workspace.push(v[++i]); else if (k === "--pull") a.pull = true; else if (k.startsWith("--")) a[k.slice(2)] = v[++i]; } return a; }

async function resolveSource() {
  let src = A.source || process.env.DEVLOOPS_HOME;
  if (!src) {
    const hit = SOURCES.find(([, d]) => has(d));
    if (hit) { src = hit[1]; console.log(`source: ${hit[0]} ${src}`); }
  }
  if (!src) {
    console.error("No dev-loops source found (checked self, ~/github/dev-loops, claude plugin, pi install).");
    console.error(`Get one (local checkout is preferred and is what DEVLOOPS_HOME points at):\n  ${CLONE}`);
    console.error("  or install the dev-loops plugin in Claude/Pi per its README, then re-run.");
    if (process.stdin.isTTY && (await ask("Clone the checkout now? [y/N] ")).toLowerCase() === "y") {
      execFileSync("bash", ["-c", CLONE.replace("~", HOME)], { stdio: "inherit" });
      src = join(HOME, "github/dev-loops");
    } else process.exit(2);
  }
  if (A.pull && isCheckout(src)) {
    console.log(`pull: git -C ${src} pull --ff-only`);
    try { execFileSync("git", ["-C", src, "pull", "--ff-only"], { stdio: "inherit" }); }
    catch { die("git pull --ff-only failed — resolve the checkout state, then re-run."); }
  } else if (A.pull) console.log("pull: skipped (source is not a git checkout).");
  return src;
}

async function main() {
  const src = await resolveSource();
  if (!has(src)) die(`not a dev-loops source: ${src}`);
  const [sd, ad] = [skillsDir(src), agentsDir(src)];
  const home = A.checkout || (isCheckout(src) ? src : SOURCES.find(([k, d]) => k === "local" && isCheckout(d))?.[1]) || null;
  const provider = A.runtime || "claude";

  const skills = [...SKILLS, MULTICA_DISPATCH].map((n) => ({ name: n, content: readFileSync(join(sd, n, "SKILL.md"), "utf8") }));
  const agents = AGENTS.map((n) => { const f = existsSync(join(ad, `${n.name}.agent.md`)) ? `${n.name}.agent.md` : `${n.name}.md`; const { d, body } = fm(readFileSync(join(ad, f), "utf8")); return { ...n, description: clip(d.description || n.name), instructions: body }; });

  // Resolve target workspace ids. In an agent run MULTICA_WORKSPACE_ID is injected → single implicit ws.
  let targets = A.workspace;
  if (!targets.length && process.env.MULTICA_WORKSPACE_ID) targets = [process.env.MULTICA_WORKSPACE_ID];
  const wsList = listArr(cli(["workspace", "list", "--output", "json"]), "workspaces", "data");
  if (!targets.length) {
    console.log("workspaces:", wsList.map((w) => w.slug).join(", "));
    targets = (await ask("target slug(s), comma-separated: ")).split(",").map((s) => s.trim()).filter(Boolean);
  }
  const ids = targets.map((sel) => wsList.find((w) => w.slug === sel || w.id === sel)?.id || sel);

  for (const wsId of ids) {
    const slug = wsList.find((w) => w.id === wsId)?.slug || wsId;
    const exSkills = listArr(cli(["skill", "list", "--output", "json"], { ws: wsId }), "skills", "data");
    const sid = {};
    for (const sk of skills) {
      const e = exSkills.find((x) => x.name === sk.name);
      const r = e
        ? cli(["skill", "update", e.id, "--content-stdin", "--output", "json"], { ws: wsId, stdin: sk.content })
        : cli(["skill", "create", "--name", sk.name, "--description", `dev-loops ${sk.name}`, "--content-stdin", "--output", "json"], { ws: wsId, stdin: sk.content });
      sid[sk.name] = e ? e.id : (r?.id || r?.skill?.id);
    }
    let removed = 0;
    for (const dep of CARRIERS) { const e = exSkills.find((x) => x.name === dep); if (e) { cli(["skill", "delete", e.id], { ws: wsId }); removed++; } }

    const rts = listArr(cli(["runtime", "list", "--output", "json"], { ws: wsId }), "runtimes", "data");
    const rt = rts.find((r) => r.provider === provider && r.status === "online") || rts.find((r) => r.provider === provider);
    if (!rt) die(`[${slug}] no ${provider} runtime`);
    const exAgents = listArr(cli(["agent", "list", "--output", "json"], { ws: wsId }), "agents", "data");
    for (const a of agents) {
      const e = exAgents.find((x) => x.name === a.name);
      let id;
      if (e) { cli(["agent", "update", e.id, "--description", a.description, "--instructions", a.instructions, "--output", "json"], { ws: wsId }); id = e.id; }
      else { const r = cli(["agent", "create", "--name", a.name, "--description", a.description, "--instructions", a.instructions, "--runtime-id", rt.id, "--visibility", "private", "--output", "json"], { ws: wsId }); id = r?.id || r?.agent?.id; }
      // DEVLOOPS_HOME is desired state, not a gate: an agent run may lack owner/admin
      // permission for `agent env set` on some agents. Tolerate the failure (warn, keep
      // going) so the remaining bindings still sync — a stale-but-set DEVLOOPS_HOME is
      // harmless, a sync that dies mid-loop is not.
      if (home) { try { cli(["agent", "env", "set", id, "--custom-env-stdin", "--output", "json"], { ws: wsId, stdin: JSON.stringify({ DEVLOOPS_HOME: home }) }); } catch (e) { console.error(`[${slug}] warning: agent env set failed for ${a.name} (continuing): ${String(e?.message || e).split("\n")[0]}`); } }
      cli(["agent", "skills", "set", id, "--skill-ids", a.skills.map((n) => sid[n]).filter(Boolean).join(","), "--output", "json"], { ws: wsId });
    }
    console.log(`[${slug}] skills=${skills.length}, carriers removed=${removed}, agents=${agents.length}, runtime=${provider}, DEVLOOPS_HOME=${home || "(unset)"}`);
  }
}

main().catch((e) => die(e.message));
