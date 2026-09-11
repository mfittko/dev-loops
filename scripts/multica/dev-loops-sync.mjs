#!/usr/bin/env node
// dev-loops-sync — sync dev-loops agents + skills into a Multica workspace from a
// detected source (self checkout > local > claude > pi). Skills are SKILL.md-only
// (tools/docs resolve from the source at runtime via dev-loops-run); agents are
// pinned to a runtime, carry DEVLOOPS_HOME, and are bound to their skills. Idempotent.
//
//   node scripts/multica/dev-loops-sync.mjs [--source DIR] [--workspace SLUG ...]
//                                           [--runtime claude] [--api URL] [--pat TOKEN]
// Omitted --source is auto-detected (or it guides you to install one).
// Omitted --workspace is listed and prompted.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const HOME = homedir(), A = args();
const SKILLS = ["copilot-pr-followup", "dev-loop", "final-approval", "local-implementation", "loop-grill", "review", "ui-review"];
const CARRIERS = ["dev-loops-runtime", "dev-loops-contracts"]; // deprecated: resolve from source, don't copy
const BIND = { "dev-loop": ["dev-loop", "copilot-pr-followup", "final-approval"], developer: ["local-implementation"], docs: [], fixer: ["copilot-pr-followup"], judge: [], quality: [], refiner: ["loop-grill"], review: ["review", "ui-review"] };
const AGENTS = Object.keys(BIND);

const CLONE = "git clone https://github.com/mfittko/dev-loops ~/github/dev-loops";

// --- source: self checkout > local checkout > claude plugin > pi install ------
const isCheckout = (d) => d && existsSync(join(d, "scripts")) && (() => { try { return JSON.parse(readFileSync(join(d, "package.json"), "utf8")).name === "dev-loops"; } catch { return false; } })();
// When this script runs from inside a dev-loops checkout (e.g. scripts/multica/),
// prefer that checkout: walk up from the script dir for a dev-loops package.json + scripts/.
const selfCheckout = () => { let d = dirname(fileURLToPath(import.meta.url)); for (let i = 0; i < 6; i++) { if (isCheckout(d)) return d; const up = dirname(d); if (up === d) break; d = up; } return null; };
const claudeDir = () => { try { const j = JSON.parse(readFileSync(join(HOME, ".claude/plugins/installed_plugins.json"), "utf8")); return Object.entries(j).find(([k]) => k.includes("dev-loops"))?.[1]?.[0]?.installPath || null; } catch { return null; } };
const SOURCES = [["self", selfCheckout()], ["local", join(HOME, "github/dev-loops")], ["claude", claudeDir()], ["pi", join(HOME, ".pi/agent/npm/node_modules/dev-loops")]];
const has = (d) => d && existsSync(join(d, "package.json"));
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
function args() { const a = { workspace: [] }; const v = process.argv.slice(2); for (let i = 0; i < v.length; i++) v[i] === "--workspace" ? a.workspace.push(v[++i]) : v[i].startsWith("--") && (a[v[i].slice(2)] = v[++i]); return a; }

async function resolveSource() {
  if (A.source || process.env.DEVLOOPS_HOME) return A.source || process.env.DEVLOOPS_HOME;
  const hit = SOURCES.find(([, d]) => has(d));
  if (hit) { console.log(`source: ${hit[0]} ${hit[1]}`); return hit[1]; }
  // no source: guide setup
  console.error("No dev-loops source found. Checked, in order:");
  console.error("  self   the dev-loops checkout this script ships in");
  console.error("  local  ~/github/dev-loops        (a live checkout)");
  console.error("  claude ~/.claude/plugins/…/dev-loops (claude plugin install)");
  console.error("  pi     ~/.pi/agent/npm/…/dev-loops   (pi install)");
  console.error(`\nGet one (local checkout is preferred and is what DEVLOOPS_HOME points at):\n  ${CLONE}`);
  console.error("  or install the dev-loops plugin in Claude/Pi per its README, then re-run.");
  if (process.stdin.isTTY && (await ask("\nClone the checkout now? [y/N] ")).toLowerCase() === "y") {
    execSync(CLONE.replace("~", HOME), { stdio: "inherit", shell: "/bin/bash" });
    return join(HOME, "github/dev-loops");
  }
  process.exit(2);
}

async function main() {
  const src = await resolveSource();
  if (!has(src)) die(`not a dev-loops source: ${src}`);
  const [sd, ad] = [skillsDir(src), agentsDir(src)];
  const home = A.checkout || (isCheckout(src) ? src : SOURCES.find(([k, d]) => (k === "self" || k === "local") && isCheckout(d))?.[1]) || null;

  const api = A.api || process.env.MULTICA_API || "http://localhost:18908";
  const pat = A.pat || process.env.MULTICA_PAT || patFromProfile(api);
  if (!pat) die("no PAT: pass --pat, set MULTICA_PAT, or have a ~/.multica/profiles/*/config.json");

  const skills = SKILLS.map((n) => ({ name: n, content: readFileSync(join(sd, n, "SKILL.md"), "utf8") }));
  const agents = AGENTS.map((n) => { const f = existsSync(join(ad, `${n}.agent.md`)) ? `${n}.agent.md` : `${n}.md`; const { d, body } = fm(readFileSync(join(ad, f), "utf8")); return { name: n, description: clip(d.description || n), instructions: body }; });

  const allWs = await req("GET", api, pat, null, "/api/workspaces");
  let sel = A.workspace.length ? A.workspace : (process.env.MULTICA_WORKSPACES?.split(",") || []);
  if (!sel.length) { console.log("workspaces:", allWs.map((w) => w.slug).join(", ")); sel = (await ask("target slug(s), comma-separated: ")).split(",").map((s) => s.trim()).filter(Boolean); }
  const provider = A.runtime || "claude";

  for (const s of sel) {
    const ws = allWs.find((w) => w.slug === s || w.id === s); if (!ws) die(`no workspace: ${s}`);
    const c = (m, p, b) => req(m, api, pat, ws.id, p, b);
    const listed = async (p) => { const j = await c("GET", p); return j.skills || j.agents || (Array.isArray(j) ? j : j.data) || []; };

    const exSkills = await listed("/api/skills"), sid = {};
    for (const sk of skills) { const e = exSkills.find((x) => x.name === sk.name); const r = e ? await c("PUT", `/api/skills/${e.id}`, { content: sk.content, files: [] }) : await c("POST", "/api/skills", { name: sk.name, description: `dev-loops ${sk.name}`, content: sk.content }); sid[sk.name] = e ? e.id : (r.id || r.skill?.id); }
    let removed = 0; for (const dep of CARRIERS) { const e = exSkills.find((x) => x.name === dep); if (e) { await c("DELETE", `/api/skills/${e.id}`); removed++; } }

    const rts = await listed("/api/runtimes"), rt = rts.find((r) => r.provider === provider && r.status === "online") || rts.find((r) => r.provider === provider);
    if (!rt) die(`[${ws.slug}] no ${provider} runtime`);
    const exAgents = await listed("/api/agents");
    for (const a of agents) {
      const e = exAgents.find((x) => x.name === a.name);
      const id = e ? (await c("PUT", `/api/agents/${e.id}`, { description: a.description, instructions: a.instructions }), e.id) : (await c("POST", "/api/agents", { name: a.name, description: a.description, instructions: a.instructions, runtime_id: rt.id, visibility: "private" })).id;
      if (home) await c("PUT", `/api/agents/${id}/env`, { custom_env: { DEVLOOPS_HOME: home } });
      await c("PUT", `/api/agents/${id}/skills`, { skill_ids: (BIND[a.name] || []).map((n) => sid[n]).filter(Boolean) });
    }
    console.log(`[${ws.slug}] skills=${skills.length}, carriers removed=${removed}, agents=${agents.length}, runtime=${provider}, DEVLOOPS_HOME=${home || "(unset)"}`);
  }
}

function patFromProfile(api) { const dir = join(HOME, ".multica/profiles"); if (!existsSync(dir)) return null; const host = new URL(api).host.replace(/[:.]/g, "-"); const cs = readdirSync(dir).map((d) => join(dir, d, "config.json")).filter(existsSync); const pick = cs.find((c) => c.includes(host)) || cs[0]; try { return JSON.parse(readFileSync(pick, "utf8")).token; } catch { return null; } }
async function req(m, api, pat, ws, p, b) { const u = api + p + (ws ? (p.includes("?") ? "&" : "?") + "workspace_id=" + ws : ""); const r = await fetch(u, { method: m, headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json", ...(ws ? { "X-Workspace-ID": ws } : {}) }, body: b ? JSON.stringify(b) : undefined }); if (!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${(await r.text()).slice(0, 140)}`); return r.status === 204 ? {} : r.json(); }

main().catch((e) => die(e.message));
