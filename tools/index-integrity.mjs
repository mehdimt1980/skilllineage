#!/usr/bin/env node
// Streamed, deterministic SHA-256 inventory of a locally built schema-0.5 index.
// This is NOT a publisher signature, license clearance, or public index downloader.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const FORMAT = "skilllineage-index-integrity-1";
const HELP = "Usage:\n  node tools/index-integrity.mjs generate <index-dir> <new-sidecar.json>\n  node tools/index-integrity.mjs verify <index-dir> <sidecar.json>\nSidecar must be outside the index directory. Generate refuses overwrites.";
function fail(s) { throw new Error(s); }
function validRel(s) {
  return typeof s === "string" && s.length > 0 &&
    !s.startsWith("/") && !s.includes("\\") && !s.includes(":") &&
    s.split("/").every(p => p !== "" && p !== "." && p !== "..") &&
    !/[\x00-\x1f]/.test(s);
}
function isInside(root, dest) {
  const rel = path.relative(root, dest);
  return !rel || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}
async function listFiles(root) {
  const result = [];
  async function walk(directory, rel) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const key = rel ? rel + "/" + entry.name : entry.name;
      if (!validRel(key)) fail("Unsafe or nonportable index path: " + key);
      const full = path.join(directory, entry.name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) fail("Symlink not allowed in index: " + key);
      if (stat.isDirectory()) await walk(full, key);
      else if (stat.isFile()) result.push(key);
      else fail("Unsupported non-regular index entry: " + key);
    }
  }
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("Index path must be a real directory");
  await walk(root, "");
  return result.sort();
}
function checkSchema(m) {
  if (m?.schemaVersion !== "0.5" || m?.kind !== "skilllineage-exact-index" ||
      m?.indexes?.exact?.algorithm !== "git-blob-sha1" ||
      m?.indexes?.exact?.shardPrefixLength !== 2 ||
      m?.indexes?.instructions?.algorithm !== "normalized-instructions-sha256" ||
      m?.indexes?.instructions?.shardPrefixLength !== 2 ||
      m?.variantIndex?.algorithm !== "bottom-k-token-shingles-v1" ||
      m?.variantIndex?.shingleSize !== 5 ||
      m?.variantIndex?.shingleHash !== "sha256-96" ||
      m?.variantIndex?.sketchSize !== 32 ||
      m?.variantIndex?.anchorCount !== 8 ||
      m?.variantIndex?.maxAnchorPostings !== 2000 ||
      m?.variantIndex?.anchorShardRouting !== "sha256-anchor-hex-v1" ||
      m?.variantIndex?.sketchShardRouting !== "variant-id-hex4-v1" ||
      m?.variantIndex?.enrichment?.algorithm !== "precomputed-variant-summary-v1" ||
      m?.variantIndex?.enrichment?.shardRouting !== "instructions-sha256-hex4-v1" ||
      m?.variantIndex?.enrichment?.exampleLimit !== 3 ||
      typeof m?.variantIndex?.skippedHotAnchorCount !== "number" ||
      m?.historyIndex?.algorithm !== "dataset-observed-history-v1" ||
      m?.historyIndex?.exactRouting !== "git-blob-sha1-hex4-v1" ||
      m?.historyIndex?.instructionRouting !== "instructions-sha256-hex4-v1" ||
      m?.historyIndex?.semantics !== "observed-not-origin" ||
      m?.historyIndex?.timestampNormalization !== "utc-v1")
    fail("Index manifest does not declare expected schema-0.5 descriptors");
}
async function inspect(root, files) {
  if (!files.includes("manifest.json")) fail("Index manifest.json is missing");
  checkSchema(JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8")));
  const seen = new Set(files);
  for (let i = 0; i < 256; i++) {
    const leaf = i.toString(16).padStart(2, "0") + ".json.gz";
    for (const prefix of ["exact/", "instructions/", "variants/anchors/"]) {
      if (!seen.has(prefix + leaf)) fail("Required shard missing: " + prefix + leaf);
    }
  }
}
async function digest(filename) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    bytes += chunk.length;
    if (!Number.isSafeInteger(bytes)) fail("File size exceeds safe integer range: " + filename);
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}
async function generate(root, sidecar) {
  const files = await listFiles(root);
  await inspect(root, files);
  const inventory = [];
  for (const rel of files)
    inventory.push({ path: rel, ...(await digest(path.join(root, ...rel.split("/")))) });
  const json = JSON.stringify({
    format: FORMAT, indexSchemaVersion: "0.5",
    fileCount: inventory.length, files: inventory
  }, null, 2) + "\n";
  await writeFile(sidecar, json, { flag: "wx" });
  console.log("Generated " + sidecar + " (" + inventory.length + " SHA-256 records)");
}
async function verify(root, sidecar) {
  const stat = await lstat(sidecar);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("Sidecar must be a regular file, not a symlink");
  const meta = JSON.parse(await readFile(sidecar, "utf8"));
  if (meta?.format !== FORMAT || meta?.indexSchemaVersion !== "0.5" ||
      !Number.isSafeInteger(meta.fileCount) || meta.fileCount < 0 ||
      !Array.isArray(meta.files) || meta.fileCount !== meta.files.length)
    fail("Invalid integrity sidecar format/count");
  const files = await listFiles(root);
  await inspect(root, files);
  if (files.length !== meta.files.length)
    fail("File count mismatch: found " + files.length + " recorded " + meta.files.length);
  for (let i = 0; i < files.length; i++) {
    const expected = meta.files[i];
    if (!expected || !validRel(expected.path) || expected.path !== files[i] ||
        !Number.isSafeInteger(expected.bytes) || expected.bytes < 0 ||
        !/^[0-9a-f]{64}$/.test(expected.sha256))
      fail("Malformed, unsorted or untrusted integrity record at position " + i);
    const observed = await digest(path.join(root, ...files[i].split("/")));
    if (observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256)
      fail("Integrity mismatch: " + files[i]);
  }
  console.log("PASS: " + files.length + " index files agree with supplied SHA-256 sidecar");
  console.log("This is byte integrity, NOT publisher authentication, provenance or redistribution permission.");
}
const [command, indexArg, sidecarArg, ...extra] = process.argv.slice(2);
if (!["generate", "verify"].includes(command) || !indexArg || !sidecarArg || extra.length) {
  console.error(HELP);
  process.exitCode = 2;
} else {
  try {
    const root = path.resolve(indexArg);
    const sidecar = path.resolve(sidecarArg);
    if (isInside(root, sidecar)) fail("Sidecar must be outside index directory");
    if (command === "generate") await generate(root, sidecar);
    else await verify(root, sidecar);
  } catch (error) {
    console.error("ERROR: " + error.message);
    process.exitCode = 1;
  }
}
