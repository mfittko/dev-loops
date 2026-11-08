#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { isDirectCliRun } from "../lib/direct-run.mjs";

const USAGE = "usage: prose-inventory.mjs --base <rev> [--head <rev>] <path>...";
const MARKER = /<!--\s*rule:\s*([A-Z0-9-]+)\s*-->/g;
const OBLIGATION = /\b(MUST|SHALL)\b/;

class UsageError extends Error {}

const norm = (s) => s.replace(/\s+/g, " ").trim();

function readAt(rev, file) {
  if (rev === undefined) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      throw new UsageError(`unreadable path: ${file}`);
    }
  }
  try {
    return execFileSync("git", ["cat-file", "blob", `${rev}:./${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 28 });
  } catch {
    throw new UsageError(`unknown revision or unreadable path: ${rev}:${file}`);
  }
}

const stats = (text) => ({ bytes: Buffer.byteLength(text), words: text.split(/\s+/).filter(Boolean).length });

// ponytail: sentence split on terminal punctuation, so abbreviations like "e.g." split early; harmless for a presence check.
function obligations(text) {
  const withoutMarkers = text.replace(MARKER, "");
  return withoutMarkers
    .split(/(?<=[.!?])\s+|\n\s*\n/)
    .map(norm)
    .filter((s) => OBLIGATION.test(s));
}

export function inventory({ base, head, paths }) {
  const rows = [];
  const sections = [];
  let missing = false;
  for (const file of paths) {
    const rel = path.relative(process.cwd(), path.resolve(file));
    const baseText = readAt(base, rel);
    const headText = readAt(head, rel);
    const b = stats(baseText);
    const h = stats(headText);
    rows.push(`| \`${file}\` | ${b.bytes} | ${b.words} | ${h.bytes} | ${h.words} | ${h.bytes - b.bytes} |`);
    const headMarkers = new Set([...headText.matchAll(MARKER)].map((m) => m[1]));
    const baseMarkers = [...new Set([...baseText.matchAll(MARKER)].map((m) => m[1]))];
    const headNorm = norm(headText.replace(MARKER, ""));
    const lines = [`### \`${file}\``];
    for (const id of baseMarkers) {
      if (headMarkers.has(id)) lines.push(`- rule ${id}`);
      else {
        missing = true;
        lines.push(`- error: rule marker ${id} missing at head`);
      }
    }
    for (const s of obligations(baseText)) {
      lines.push(`- obligation${headNorm.includes(s) ? "" : " (review required)"}: ${s}`);
    }
    sections.push(lines.join("\n"));
  }
  const table = [
    "| path | base bytes | base words | head bytes | head words | byte delta |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
  return { output: `${table}\n\n${sections.join("\n\n")}\n`, missing };
}

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { base: { type: "string" }, head: { type: "string" } },
      allowPositionals: true,
    });
    if (!values.base || positionals.length === 0) throw new UsageError(USAGE);
    for (const rev of [values.base, values.head]) if (rev !== undefined && (rev === "" || rev.startsWith("-"))) throw new UsageError(USAGE);
    const { output, missing } = inventory({ base: values.base, head: values.head, paths: positionals });
    io.out(output);
    return missing ? 1 : 0;
  } catch (error) {
    io.err(`prose-inventory: ${String(error.message).split("\n")[0]}\n`);
    return 2;
  }
}

if (isDirectCliRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
