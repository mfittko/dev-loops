import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OUT_OF_BAND_WRITE, readSealed, writeSealed } from "../../scripts/github/_gate-artifact-seal.mjs";

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
  it("accepts an unsealed legacy artifact", async () => {
    const f = path.join(await mkdtemp(path.join(os.tmpdir(), "seal-")), "legacy.json");
    await writeFile(f, "{}\n", "utf8");
    expect(await readSealed(f)).toBe("{}\n");
    expect(await readFile(f, "utf8")).toBe("{}\n");
  });
});
