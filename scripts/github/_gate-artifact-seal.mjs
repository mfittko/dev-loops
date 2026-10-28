/**
 * LEAF module: a sha256 seal beside the keyed fan-in ledger and the durable
 * findings log. The sanctioned writers call writeSealed; every sanctioned
 * reader calls readSealed. A hand edit changes the bytes but not the seal, so
 * the next read fails with a typed integrity error naming the file.
 * ponytail: a missing seal reads as a legacy artifact and is accepted; a
 * writer that also rewrites the seal is out of reach. Refuse a missing seal
 * once all writers have shipped.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export const OUT_OF_BAND_WRITE = "gate_artifact_out_of_band_write";
const sealPath = (file) => `${file}.seal`;
const digest = (text) => createHash("sha256").update(text).digest("hex");

export async function writeSealed(file, text) {
  await writeFile(file, text, "utf8");
  await writeFile(sealPath(file), `${digest(text)}\n`, "utf8");
}

export async function readSealed(file) {
  const text = await readFile(file, "utf8");
  let seal;
  try { seal = (await readFile(sealPath(file), "utf8")).trim(); } catch (error) {
    if (error?.code === "ENOENT") return text;
    throw error;
  }
  if (seal !== digest(text)) {
    throw Object.assign(new Error(`${OUT_OF_BAND_WRITE}: ${file} was modified outside its sanctioned writer (seal mismatch)`), { code: OUT_OF_BAND_WRITE, file });
  }
  return text;
}
