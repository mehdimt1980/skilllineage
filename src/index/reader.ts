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
  VariantEnrichmentShard,
  HistoryShard,
  HistorySummaryRecord,
} from "./types.js";
import {
  VARIANT_ENRICHMENT_SHARD_ROUTING,
  VARIANT_SKETCH_SHARD_ROUTING,
  EXACT_HISTORY_SHARD_ROUTING,
  INSTRUCTION_HISTORY_SHARD_ROUTING,
  exactHistoryRoute,
  instructionHistoryRoute,
} from "./routing.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class IndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexError";
  }
}

export type ShardKind =
  | "exact"
  | "instructions"
  | "variant_anchor"
  | "variant_sketch"
  | "variant_enrichment"
  | "history_exact"
  | "history_instructions";
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

  if (m.schemaVersion !== "0.5") {
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

  if (!isCompatibleHistoryIndex(m.historyIndex)) {
    throw new IndexError(`Unsupported history index descriptor: ${manifestPath}. Rebuild the index with the current builder.`);
  }

  return manifest as IndexManifest;
}

function isCompatibleHistoryIndex(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const h = value as Record<string, unknown>;
  return h.algorithm === "dataset-observed-history-v1" &&
    h.exactRouting === EXACT_HISTORY_SHARD_ROUTING &&
    h.instructionRouting === INSTRUCTION_HISTORY_SHARD_ROUTING &&
    h.semantics === "observed-not-origin" &&
    h.timestampNormalization === "utc-v1";
}

/** Sparse history shards contain observed dataset metadata, never origin claims. */
export async function readHistoryShard(
  indexDir: string,
  kind: "exact" | "instructions",
  routeKey: string,
  observer?: ShardReadObserver,
): Promise<HistoryShard> {
  const normalized = routeKey.toLowerCase();
  if (!/^[0-9a-f]{2}\/[0-9a-f]{2}$/.test(normalized)) {
    throw new IndexError(`Invalid history route: ${routeKey}`);
  }
  const [directory, file] = normalized.split("/");
  const shard = await readGzipShard(
    path.join(indexDir, "history", kind, directory, `${file}.json.gz`),
    kind === "exact" ? "history_exact" : "history_instructions",
    normalized, observer, true,
  );
  for (const [hash, value] of Object.entries(shard)) {
    if (!new RegExp(`^[0-9a-f]{${kind === "exact" ? 40 : 64}}$`).test(hash) ||
        hash.slice(0, 4) !== directory + file || !isHistorySummary(value)) {
      throw new IndexError(`Invalid history summary at route ${normalized}`);
    }
  }
  return shard as HistoryShard;
}

export async function lookupExactHistory(indexDir: string, blobSha1: string, observer?: ShardReadObserver): Promise<HistorySummaryRecord | null> {
  const route = exactHistoryRoute(blobSha1);
  const shard = await readHistoryShard(indexDir, "exact", route.key, observer);
  return Object.prototype.hasOwnProperty.call(shard, blobSha1.toLowerCase())
    ? shard[blobSha1.toLowerCase()] : null;
}

export async function lookupInstructionHistory(indexDir: string, instructionsSha256: string, observer?: ShardReadObserver): Promise<HistorySummaryRecord | null> {
  const route = instructionHistoryRoute(instructionsSha256);
  const shard = await readHistoryShard(indexDir, "instructions", route.key, observer);
  return Object.prototype.hasOwnProperty.call(shard, instructionsSha256.toLowerCase())
    ? shard[instructionsSha256.toLowerCase()] : null;
}

const HISTORY_UTC_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function isCanonicalHistoryTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    HISTORY_UTC_TIMESTAMP_RE.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function isHistoryObservation(
  value: unknown,
): value is NonNullable<HistorySummaryRecord["earliestObserved"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const obs = value as Record<string, unknown>;
  if (
    typeof obs.repoFullName !== "string" ||
    typeof obs.path !== "string" ||
    !isCanonicalHistoryTimestamp(obs.firstCommitAt) ||
    !(
      obs.lastCommitAt === null ||
      isCanonicalHistoryTimestamp(obs.lastCommitAt)
    )
  ) {
    return false;
  }
  return (
    obs.lastCommitAt === null ||
    obs.lastCommitAt >= obs.firstCommitAt
  );
}

function isHistorySummary(value: unknown): value is HistorySummaryRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const s = value as Record<string, unknown>;
  const total = s.totalLocationCount;
  const fetched = s.historyFetchedLocationCount;
  const usable = s.usableLocationCount;
  const chronology = s.chronologyAnomalyCount;
  const conflicts = s.conflictingLocationCount;
  const counts = [total, fetched, usable, chronology, conflicts];

  if (
    counts.some((n) => !Number.isInteger(n) || (n as number) < 0) ||
    (total as number) < 1 ||
    [fetched, usable, chronology, conflicts].some(
      (n) => (n as number) > (total as number),
    ) ||
    (usable as number) + (chronology as number) > (total as number) ||
    (usable as number) + (conflicts as number) > (total as number)
  ) {
    return false;
  }

  const coverage =
    usable === 0
      ? "none"
      : usable === total && chronology === 0 && conflicts === 0
        ? "complete"
        : "partial";
  if (s.coverage !== coverage) return false;

  if (usable === 0) {
    return s.earliestObserved === null && s.latestObserved === null;
  }

  const earliest = s.earliestObserved;
  const latest = s.latestObserved;
  if (!isHistoryObservation(earliest) || !isHistoryObservation(latest)) {
    return false;
  }

  return earliest.firstCommitAt <= latest.firstCommitAt;
}

function isCompatibleVariantIndex(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const enrichment = v.enrichment;
  if (typeof enrichment !== "object" || enrichment === null) return false;
  const e = enrichment as Record<string, unknown>;
  return (
    v.algorithm === "bottom-k-token-shingles-v1" &&
    v.shingleSize === 5 &&
    v.shingleHash === "sha256-96" &&
    v.sketchSize === 32 &&
    v.anchorCount === 8 &&
    v.maxAnchorPostings === 2000 &&
    v.anchorShardRouting === "sha256-anchor-hex-v1" &&
    v.sketchShardRouting === VARIANT_SKETCH_SHARD_ROUTING &&
    e.algorithm === "precomputed-variant-summary-v1" &&
    e.shardRouting === VARIANT_ENRICHMENT_SHARD_ROUTING &&
    e.exampleLimit === 3 &&
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
 * Read a schema-0.3+ variant sketch micro-shard.
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

/**
 * Read and validate one schema-0.4 precomputed variant-enrichment micro-shard.
 * Missing, corrupt, malformed, or structurally invalid enrichment data is an
 * index inconsistency because every scored candidate must have a summary.
 */
export async function readVariantEnrichmentShard(
  indexDir: string,
  routeKey: string,
  observer?: ShardReadObserver,
): Promise<VariantEnrichmentShard> {
  const normalized = routeKey.toLowerCase();
  if (!/^[0-9a-f]{2}\/[0-9a-f]{2}$/.test(normalized)) {
    throw new IndexError(`Invalid variant enrichment route: ${routeKey}`);
  }
  const [directory, file] = normalized.split("/");
  let shard: Record<string, unknown>;
  try {
    shard = await readGzipShard(
      path.join(indexDir, "variants", "enrichment", directory, `${file}.json.gz`),
      "variant_enrichment", normalized, observer,
    );
  } catch (error) {
    if (error instanceof IndexError) {
      throw new IndexError(
        `Variant enrichment index is inconsistent at route ${normalized}: ${error.message}. Rebuild the index with the current builder.`,
      );
    }
    throw error;
  }

  if (!isVariantEnrichmentShard(shard)) {
    throw new IndexError(
      `Variant enrichment index is inconsistent at route ${normalized}: invalid summary structure. Rebuild the index with the current builder.`,
    );
  }
  return shard;
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

function isVariantEnrichmentShard(
  shard: Record<string, unknown>,
): shard is VariantEnrichmentShard {
  for (const [instructionSha, value] of Object.entries(shard)) {
    if (!/^[0-9a-f]{64}$/.test(instructionSha)) return false;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    if (
      !Number.isInteger(record.rawVariantCount) ||
      (record.rawVariantCount as number) < 1 ||
      !Number.isInteger(record.copyCount) ||
      (record.copyCount as number) < 1 ||
      !Array.isArray(record.examples) ||
      record.examples.length > 3 ||
      record.examples.length > (record.copyCount as number)
    ) {
      return false;
    }
    for (const example of record.examples) {
      if (
        typeof example !== "object" ||
        example === null ||
        Array.isArray(example)
      ) {
        return false;
      }
      const e = example as Record<string, unknown>;
      if (
        typeof e.repoFullName !== "string" ||
        typeof e.path !== "string" ||
        !(e.stars === null || typeof e.stars === "number")
      ) {
        return false;
      }
    }
  }
  return true;
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
