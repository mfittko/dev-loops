import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OUT_OF_BAND_WRITE, QUARANTINE_REMEDY, UNSEALED, readSealed, writeSealed } from "../../scripts/github/_gate-artifact-seal.mjs";

describe("gate artifact seal", () => {
  it("round-trips a sanctioned write", async () => {
    const f = path.join(await mkdtemp(path.join(os.tmpdir(), "seal-")), "a.fanin-ledger.json");
    await writeSealed(f, "{\"a\":1}\n");
    expect(await readSealed(f)).toBe("{\"a\":1}\n");
  });
  it("fails with a typed reason naming the file after an out-of-band edit", async () => {
    const f = path.join(await mkdtemp(path.join(os.tmpdir(), "seal-")), "a.fanin-ledger.json");
    await writeSealed(f, "{\"a\":1}\n");
    await writeFile(f, "{\"a\":2}\n", "utf8");
    const error = await readSealed(f).catch((e) => e);
    expect(error.code).toBe(OUT_OF_BAND_WRITE);
    expect(error.message).toContain(f);
  });
  it("refuses an unsealed artifact with a typed reason naming the file and the next step", async () => {
    const f = path.join(await mkdtemp(path.join(os.tmpdir(), "seal-")), "legacy.json");
    await writeFile(f, "{}\n", "utf8");
    const error = await readSealed(f).catch((e) => e);
    expect(error.code).toBe(UNSEALED);
    expect(error.message).toContain(f);
    expect(error.message).toContain("re-run the sanctioned writer");
    expect(error.message).not.toContain("quarantine-gate-findings-log.mjs");
    expect(error.message).not.toContain("--findings <json>");
    expect(await readFile(f, "utf8")).toBe("{}\n");
  });
  it("appends the caller's own remedy to an unsealed refusal", async () => {
    const f = path.join(await mkdtemp(path.join(os.tmpdir(), "seal-")), "legacy.json");
    await writeFile(f, "{}\n", "utf8");
    const error = await readSealed(f, { remedy: QUARANTINE_REMEDY }).catch((e) => e);
    expect(error.code).toBe(UNSEALED);
    expect(error.message).toContain("quarantine-gate-findings-log.mjs");
  });
  it("waits for a held write lock before refusing a missing seal", async () => {
    const f = path.join(await mkdtemp(path.join(os.tmpdir(), "seal-")), "a.json");
    await writeFile(f, "{\"w\":1}\n", "utf8");
    await mkdir(`${f}.lock`);
    const read = readSealed(f);
    setTimeout(async () => { await writeFile(`${f}.seal`, `${createHash("sha256").update("{\"w\":1}\n").digest("hex")}\n`, "utf8"); await rm(`${f}.lock`, { recursive: true }); }, 100);
    expect(await read).toBe("{\"w\":1}\n");
  });
  it("waits for a held write lock before reporting a seal mismatch, then re-reads once", async () => {
    const f = path.join(await mkdtemp(path.join(os.tmpdir(), "seal-")), "a.json");
    await writeFile(f, "{\"w\":2}\n", "utf8");
    await writeFile(`${f}.seal`, "stale\n", "utf8");
    await mkdir(`${f}.lock`);
    const read = readSealed(f);
    setTimeout(async () => { await writeFile(`${f}.seal`, `${createHash("sha256").update("{\"w\":2}\n").digest("hex")}\n`, "utf8"); await rm(`${f}.lock`, { recursive: true }); }, 100);
    expect(await read).toBe("{\"w\":2}\n");
  });
});

describe("gate artifact seal edge cases", () => {
  const tmp = async () => path.join(await mkdtemp(path.join(os.tmpdir(), "seal-")), "a.json");
  it("an orphan seal with missing data fails with ENOENT", async () => {
    const f = await tmp();
    await writeFile(`${f}.seal`, "abc\n", "utf8");
    expect((await readSealed(f).catch((e) => e)).code).toBe("ENOENT");
  });
  it("an empty seal is a mismatch", async () => {
    const f = await tmp();
    await writeFile(f, "{}\n", "utf8");
    await writeFile(`${f}.seal`, "", "utf8");
    expect((await readSealed(f).catch((e) => e)).code).toBe(OUT_OF_BAND_WRITE);
  });
  it("types a non-ENOENT seal read error as unsealed", async () => {
    const f = await tmp();
    await writeFile(f, "{}\n", "utf8");
    await mkdir(`${f}.seal`);
    const error = await readSealed(f).catch((e) => e);
    expect(error.code).toBe(UNSEALED);
    expect(error.message).toContain(f);
  });
  it("accepts an uppercase seal", async () => {
    const f = await tmp();
    await writeSealed(f, "x\n");
    await writeFile(`${f}.seal`, (await readFile(`${f}.seal`, "utf8")).toUpperCase(), "utf8");
    expect(await readSealed(f)).toBe("x\n");
  });
});

describe("gate artifact seal concurrency and shared reader", () => {
  const tmp = async () => path.join(await mkdtemp(path.join(os.tmpdir(), "seal-")), "a.json");
  it("overlapping sanctioned writes always leave a coherent pair", async () => {
    const f = await tmp();
    const texts = Array.from({ length: 20 }, (_, i) => `{"w":${i}}\n`);
    await Promise.all(texts.map((t) => writeSealed(f, t)));
    expect(texts).toContain(await readSealed(f));
  });
  it("resolveFindingsInput refuses valid-JSON and malformed-JSON tampering with the typed reason", async () => {
    const { resolveFindingsInput } = await import("../../scripts/github/_findings-input.mjs");
    const f = await tmp();
    await writeSealed(f, "[]\n");
    const deps = { parseError: (m) => new Error(m), validate: (v) => v };
    expect(await resolveFindingsInput({ findingsFile: f }, deps)).toMatchObject({ findings: [] });
    for (const edit of ["[{\"severity\":\"low\"}]\n", "{not json"]) {
      await writeFile(f, edit, "utf8");
      expect((await resolveFindingsInput({ findingsFile: f }, deps).catch((e) => e)).code).toBe(OUT_OF_BAND_WRITE);
    }
  });
});
