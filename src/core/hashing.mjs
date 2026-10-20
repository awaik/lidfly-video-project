import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

/**
 * Canonical JSON for hashing and for immutable manifests.
 *
 * Key order is the only thing normalized: two objects that differ solely by the
 * order their keys were written produce the same text, so a re-serialized
 * manifest never looks like a different one.
 */
export function stableJson(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

/** sha256 of the canonical form of a value. */
export function hashValue(value) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

/**
 * sha256 of a file, read as a stream.
 *
 * Media files are hundreds of megabytes; readFile() would pull a whole master
 * into memory just to fingerprint it.
 */
export async function hashFile(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Fingerprint a set of input files, sorted so the result does not depend on the
 * order the caller happened to collect them.
 */
export async function hashInputs(paths) {
  const unique = [...new Set(paths)].sort();
  const entries = [];
  for (const path of unique) {
    const info = await stat(path);
    if (!info.isFile()) throw new TypeError(`Not a file: ${path}`);
    entries.push({ path, sha256: await hashFile(path), size_bytes: info.size });
  }
  return entries;
}
