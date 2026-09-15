import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type {
  IndexManifest,
  IndexShard,
  IndexHashEntry,
  InstructionShard,
  SketchShard,
  AnchorShard,
} from "./types.js";
import { VARIANT_SKETCH_SHARD_ROUTING } from "./routing.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class IndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexError";
  }
}

export type ShardKind = "exact" | "instructions" | "variant_anchor" | "variant_sketch";
export interface ShardReadEvent { shardKind: ShardKind; prefix: string; compressedBytes: number; decompressedBytes: number; readMs: number; gunzipMs: number; parseMs: number; totalMs: number; }
export type ShardReadObserver = (event: ShardReadEvent) => void;

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export async function readManifest(indexDir: string): Promise<IndexManifest> {
  const manifestPath = path.join(indexDir, "manifest.json");

  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    throw new IndexError(`Manifest not found: ${manifestPath}`);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(raw) as unknown;
  } catch {
    throw new IndexError(`Malformed manifest JSON: ${manifestPath}`);
  }

  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("schemaVersion" in manifest) ||
    !("kind" in manifest)
  ) {
    throw new IndexError(`Invalid manifest structure: ${manifestPath}`);
  }

  const m = manifest as Record<string, unknown>;

  if (m.kind !== "skilllineage-exact-index") {
    throw new IndexError(
      `Unsupported index kind: ${String(m.kind)}`,
    );
  }

  if (m.schemaVersion !== "0.3") {
    throw new IndexError(
      `Unsupported schema version: ${String(m.schemaVersion)}. Rebuild the index with the current builder.`,
    );
  }

  const indexes = m.indexes;
  if (
    typeof indexes !== "object" ||
    indexes === null ||
    !("exact" in indexes) ||
    !("instructions" in indexes)
  ) {
    throw new IndexError(`Manifest does not declare both indexes: ${manifestPath}`);
  }

  const descriptors = indexes as Record<string, unknown>;
  if (
    !isIndexDescriptor(descriptors.exact, "git-blob-sha1") ||
    !isIndexDescriptor(
      descriptors.instructions,
      "normalized-instructions-sha256",
    )
  ) {
    throw new IndexError(`Unsupported index descriptors: ${manifestPath}`);
  }

  if (!isCompatibleVariantIndex(m.variantIndex)) {
    throw new IndexError(`Unsupported variant index parameters or shard routing: ${manifestPath}. Rebuild the index with the current builder.`);
  }

  return manifest as IndexManifest;
}

function isCompatibleVariantIndex(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.algorithm === "bottom-k-token-shingles-v1" &&
    v.shingleSize === 5 &&
    v.shingleHash === "sha256-96" &&
    v.sketchSize === 32 &&
    v.anchorCount === 8 &&
    v.maxAnchorPostings === 2000 &&
    v.anchorShardRouting === "sha256-anchor-hex-v1" &&
    v.sketchShardRouting === VARIANT_SKETCH_SHARD_ROUTING &&
    typeof v.skippedHotAnchorCount === "number"
  );
}

function isIndexDescriptor(value: unknown, algorithm: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const descriptor = value as Record<string, unknown>;
  return (
    descriptor.algorithm === algorithm && descriptor.shardPrefixLength === 2
  );
}

// ---------------------------------------------------------------------------
// Shard prefix
// ---------------------------------------------------------------------------

/**
 * Compute the shard filename prefix for a given hex hash.
 * Uses the first 2 hex characters.
 */
export function shardPrefix(hexHash: string): string {
  return hexHash.slice(0, 2).toLowerCase();
}

// ---------------------------------------------------------------------------
// Exact shard reading
// ---------------------------------------------------------------------------

/**
 * Read and decompress a single exact-match shard.
 * Only reads the one shard file needed for the given prefix.
 */
export async function readShard(
  indexDir: string,
  prefix: string,
  observer?: ShardReadObserver,
): Promise<IndexShard> {
  return readGzipShard(
    path.join(indexDir, "exact", `${prefix}.json.gz`),
    "exact", prefix, observer,
  ) as Promise<IndexShard>;
}

/**
 * Look up a single git blob hash in the exact index.
 * Reads only the required shard.
 */
export async function lookupExact(
  indexDir: string,
  hexHash: string,
  observer?: ShardReadObserver,
): Promise<IndexHashEntry | null> {
  const prefix = shardPrefix(hexHash);
  const shard = await readShard(indexDir, prefix, observer);
  if (Object.prototype.hasOwnProperty.call(shard, hexHash)) {
    return shard[hexHash];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Instruction shard reading
// ---------------------------------------------------------------------------

/**
 * Read and decompress a single instruction-index shard.
 * Only reads the one shard file needed for the given prefix.
 */
export async function readInstructionShard(
  indexDir: string,
  prefix: string,
  observer?: ShardReadObserver,
): Promise<InstructionShard> {
  return readGzipShard(
    path.join(indexDir, "instructions", `${prefix}.json.gz`),
    "instructions", prefix, observer,
  ) as Promise<InstructionShard>;
}

/**
 * Look up an instruction SHA-256 hex in the instruction index.
 * Returns sorted list of git blob SHA-1 hex strings, or null if not found.
 * Reads exactly one shard.
 */
export async function lookupInstructions(
  indexDir: string,
  instructionHex: string,
  observer?: ShardReadObserver,
): Promise<string[] | null> {
  const prefix = shardPrefix(instructionHex);
  const shard = await readInstructionShard(indexDir, prefix, observer);
  if (Object.prototype.hasOwnProperty.call(shard, instructionHex)) {
    return shard[instructionHex];
  }
  return null;
}

/**
 * Read a schema-0.3 variant sketch micro-shard.
 * Route keys are stable physical identifiers such as "a1/b2".
 * Missing micro-shards represent an empty route and are therefore valid.
 */
export async function readSketchShard(
  indexDir: string,
  routeKey: string,
  observer?: ShardReadObserver,
): Promise<SketchShard> {
  const normalized = routeKey.toLowerCase();
  if (!/^[0-9a-f]{2}\/[0-9a-f]{2}$/.test(normalized)) {
    throw new IndexError(`Invalid variant sketch route: ${routeKey}`);
  }
  const [directory, file] = normalized.split("/");
  return readGzipShard(
    path.join(indexDir, "variants", "sketches", directory, `${file}.json.gz`),
    "variant_sketch", normalized, observer, true,
  ) as Promise<SketchShard>;
}

export async function readAnchorShard(
  indexDir: string,
  prefix: string,
  observer?: ShardReadObserver,
): Promise<AnchorShard> {
  return readGzipShard(
    path.join(indexDir, "variants", "anchors", `${prefix}.json.gz`),
    "variant_anchor", prefix, observer,
  ) as Promise<AnchorShard>;
}

// ---------------------------------------------------------------------------
// Shared gzip shard reader
// ---------------------------------------------------------------------------

async function readGzipShard(
  shardPath: string,
  shardKind?: ShardKind,
  prefix?: string,
  observer?: ShardReadObserver,
  missingAsEmpty = false,
): Promise<Record<string, unknown>> {
  const totalStart = observer ? performance.now() : 0;
  let readMs = 0;
  let gunzipMs = 0;
  let parseMs = 0;
  let compressed: Buffer;
  try {
    const started = observer ? performance.now() : 0;
    compressed = await readFile(shardPath);
    readMs = observer ? performance.now() - started : 0;
  } catch (error) {
    if (missingAsEmpty && isFileNotFound(error)) return {};
    throw new IndexError(`Shard not found: ${shardPath}`);
  }

  let decompressed: Buffer;
  try {
    const started = observer ? performance.now() : 0;
    decompressed = gunzipSync(compressed);
    gunzipMs = observer ? performance.now() - started : 0;
  } catch {
    throw new IndexError(`Corrupt gzip shard: ${shardPath}`);
  }

  let shard: unknown;
  try {
    const started = observer ? performance.now() : 0;
    shard = JSON.parse(decompressed.toString("utf-8")) as unknown;
    parseMs = observer ? performance.now() - started : 0;
  } catch {
    throw new IndexError(`Malformed shard JSON: ${shardPath}`);
  }

  if (typeof shard !== "object" || shard === null || Array.isArray(shard)) {
    throw new IndexError(`Invalid shard structure: ${shardPath}`);
  }

  if (observer && shardKind && prefix) observer({ shardKind, prefix, compressedBytes: compressed.length, decompressedBytes: decompressed.length, readMs, gunzipMs, parseMs, totalMs: performance.now() - totalStart });
  return shard as Record<string, unknown>;
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}
