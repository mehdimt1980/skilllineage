import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { fingerprint, normalizeInstructions } from "../fingerprint/index.js";
import {
  readManifest,
  lookupExact,
  lookupInstructions,
  shardPrefix,
  readShard,
  readInstructionShard,
  readAnchorShard,
  readSketchShard,
} from "../index/index.js";
import type {
  IndexOccurrence,
  IndexHashEntry,
  IndexShard,
  InstructionShard,
} from "../index/types.js";
import {
  generateVariantCandidates,
  instructionSketch,
  scoreVariantCandidates,
} from "../variant/index.js";
import type { ScoredCandidate } from "../variant/index.js";
import type {
  TraceReport,
  SameInstructionsMatch,
  VariantCandidate,
  TraceProfilingOptions,
} from "./types.js";

/**
 * Trace a local skill against a dual (exact + instructions) index.
 *
 * Precedence:
 *   1. exact raw Git blob match
 *   2. same normalized instructions
 *   3. approximate variant candidates
 *   4. none
 *
 * Does NOT depend on CLI code.
 */
export async function traceSkill(
  skillPath: string,
  indexDir: string,
  toolVersion: string,
  profilingOptions?: TraceProfilingOptions,
): Promise<TraceReport> {
  const profile = profilingOptions?.profile;
  const observer = profile ? (event: import("../index/reader.js").ShardReadEvent) => profile.shardReads.push(event) : undefined;
  const totalStart = profile ? performance.now() : 0;
  const timed = async <T>(name: string, operation: () => Promise<T>): Promise<T> => { const started = profile ? performance.now() : 0; const value = await operation(); if (profile) profile.stages[name] = performance.now() - started; return value; };
  // Validate index directory exists
  let indexStat;
  try {
    indexStat = await stat(indexDir);
  } catch {
    throw new TraceError(`Index directory does not exist: ${indexDir}`);
  }
  if (!indexStat.isDirectory()) {
    throw new TraceError(`Not a directory: ${indexDir}`);
  }

  // Read and validate manifest
  await timed("manifestMs", () => readManifest(indexDir));

  // Fingerprint the local skill (reuses all existing validation)
  const fp = await timed("fingerprintMs", () => fingerprint(skillPath, toolVersion));

  // Extract raw hex hashes (strip prefixes)
  const gitBlobSha1 = fp.fingerprints.gitBlobSha1;
  const instructionsSha256 = fp.fingerprints.instructionsSha256;
  const hexBlobHash = gitBlobSha1.replace(/^sha1:/, "");
  const hexInstructionHash = instructionsSha256.replace(/^sha256:/, "");

  const query = { gitBlobSha1, instructionsSha256 };

  // Step 1: Exact raw Git blob match — reads exactly one shard
  const exactEntry = await timed("exactLookupMs", () => lookupExact(indexDir, hexBlobHash, observer));
  if (exactEntry) {
    if (profile) profile.stages.totalTraceMs = performance.now() - totalStart;
    return {
      schemaVersion: "0.1",
      query,
      match: {
        type: "exact",
        copyCount: exactEntry.copyCount,
        occurrences: exactEntry.occurrences,
      },
      origin: { status: "not_inferred" },
    };
  }

  // Step 2: Same normalized instructions — reads one instruction shard,
  // then at most one exact shard per unique prefix among the matched hashes.
  const blobHashes = await timed("instructionLookupMs", () => lookupInstructions(indexDir, hexInstructionHash, observer));
  if (blobHashes && blobHashes.length > 0) {
    const sameInstructionsMatch = await buildSameInstructionsMatch(
      indexDir, blobHashes,
      (dir, prefix) => readShard(dir, prefix, observer),
    );
    if (profile) profile.stages.totalTraceMs = performance.now() - totalStart;
    return {
      schemaVersion: "0.1",
      query,
      match: sameInstructionsMatch,
      origin: { status: "not_inferred" },
    };
  }

  // Step 3: Approximate variant candidates.
  const rawSkill = await readFile(path.join(path.resolve(skillPath), "SKILL.md"), "utf-8");
  const localSketch = instructionSketch(normalizeInstructions(rawSkill));
  if (profile) { profile.counts.localSketchSize = localSketch.length; profile.counts.localAnchorCount = Math.min(localSketch.length, 8); }
  const generationStats: import("../variant/index.js").CandidateGenerationDiagnostics = { observedCandidateCount: 0, eligibleCandidateCount: 0, returnedCandidateCount: 0, uniqueAnchorShardCount: 0 };
  const generated = await timed("variantAnchorGenerationMs", () => generateVariantCandidates(
    localSketch,
    (prefix) => readAnchorShard(indexDir, prefix, observer), generationStats,
  ));
  if (profile) Object.assign(profile.counts, generationStats, { candidateGenerationTruncated: generated.truncated });
  const scoringStats: import("../variant/index.js").ScoringDiagnostics = { inputCandidateCount: 0, uniqueSketchShardCount: 0, sketchRecordsFound: 0, passedEstimatedThresholdCount: 0, finalCandidateCount: 0 };
  const scored = await timed("variantSketchScoringMs", () => scoreVariantCandidates(
    localSketch,
    generated.candidates,
    (prefix) => readSketchShard(indexDir, prefix, observer), scoringStats,
  ));
  if (profile) Object.assign(profile.counts, scoringStats);
  if (scored.length > 0) {
    const candidates = await timed("variantEnrichmentMs", () => enrichVariantCandidates(indexDir, scored, observer, profile));
    if (profile) profile.stages.totalTraceMs = performance.now() - totalStart;
    return {
      schemaVersion: "0.1",
      query,
      match: {
        type: "variant_candidates",
        method: "bottom-k-token-shingles-v1",
        approximate: true,
        candidateGenerationTruncated: generated.truncated,
        candidates,
      },
      origin: { status: "not_inferred" },
    };
  }

  // Step 4: No match
  if (profile) profile.stages.totalTraceMs = performance.now() - totalStart;
  return {
    schemaVersion: "0.1",
    query,
    match: {
      type: "none",
      copyCount: 0,
      occurrences: [],
    },
    origin: { status: "not_inferred" },
  };
}

async function enrichVariantCandidates(
  indexDir: string,
  scored: readonly ScoredCandidate[],
  observer?: import("../index/reader.js").ShardReadObserver,
  profile?: import("./types.js").TraceProfiling,
): Promise<VariantCandidate[]> {
  const instructionCache = new Map<string, InstructionShard>();
  const exactCache = new Map<string, IndexShard>();
  const result: VariantCandidate[] = [];

  for (const candidate of scored) {
    const instructionPrefix = shardPrefix(candidate.instructionsSha256);
    let instructionShard = instructionCache.get(instructionPrefix);
    if (!instructionShard) {
      instructionShard = await readInstructionShard(indexDir, instructionPrefix, observer);
      instructionCache.set(instructionPrefix, instructionShard);
    }
    const blobHashes = [
      ...new Set(instructionShard[candidate.instructionsSha256] ?? []),
    ].sort();
    const occurrences = new Map<string, IndexOccurrence>();

    for (const blobHash of blobHashes) {
      const exactPrefix = shardPrefix(blobHash);
      let exactShard = exactCache.get(exactPrefix);
      if (!exactShard) {
        exactShard = await readShard(indexDir, exactPrefix, observer);
        exactCache.set(exactPrefix, exactShard);
      }
      if (!Object.prototype.hasOwnProperty.call(exactShard, blobHash)) continue;
      for (const occurrence of exactShard[blobHash].occurrences) {
        const key = `${occurrence.repoFullName}\0${occurrence.path}`;
        if (!occurrences.has(key)) occurrences.set(key, occurrence);
      }
    }

    const orderedOccurrences = [...occurrences.values()].sort(compareExamples);
    result.push({
      instructionsSha256: `sha256:${candidate.instructionsSha256}`,
      estimatedSimilarity: Number(candidate.estimatedSimilarity.toFixed(4)),
      sharedAnchors: candidate.sharedAnchors,
      rawVariantCount: blobHashes.length,
      copyCount: orderedOccurrences.length,
      examples: orderedOccurrences.slice(0, 3).map((occurrence) => ({
        repoFullName: occurrence.repoFullName,
        path: occurrence.path,
        stars: occurrence.stars,
      })),
    });
  }
  if (profile) { profile.counts.enrichmentInstructionShardCount = instructionCache.size; profile.counts.enrichmentExactShardCount = exactCache.size; }
  return result;
}

function compareExamples(a: IndexOccurrence, b: IndexOccurrence): number {
  if (a.stars === null && b.stars !== null) return 1;
  if (a.stars !== null && b.stars === null) return -1;
  if (a.stars !== null && b.stars !== null && a.stars !== b.stars) {
    return b.stars - a.stars;
  }
  return (
    compareStrings(a.repoFullName, b.repoFullName) ||
    compareStrings(a.path, b.path)
  );
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build the same_instructions match result.
 *
 * Groups blobHashes by their exact-shard prefix, reads each required
 * exact shard at most once, collects all occurrences, deduplicates,
 * then sorts deterministically.
 */
export async function buildSameInstructionsMatch(
  indexDir: string,
  blobHashes: string[],
  readExactShard: typeof readShard = readShard,
): Promise<SameInstructionsMatch> {
  const distinctBlobHashes = [...new Set(blobHashes)].sort();

  // Group hashes by exact-shard prefix to minimise shard reads
  const byPrefix = new Map<string, string[]>();
  for (const h of distinctBlobHashes) {
    const pfx = shardPrefix(h);
    const arr = byPrefix.get(pfx);
    if (arr) {
      arr.push(h);
    } else {
      byPrefix.set(pfx, [h]);
    }
  }

  // Collect occurrences across all matching entries (one shard read per prefix)
  const occurrencesByLocation = new Map<string, IndexOccurrence>();

  for (const [pfx, hashes] of byPrefix) {
    const shard = await readExactShard(indexDir, pfx);
    for (const h of hashes) {
      const entry: IndexHashEntry | undefined = Object.prototype.hasOwnProperty.call(shard, h)
        ? shard[h]
        : undefined;
      if (entry) {
        for (const occurrence of entry.occurrences) {
          const locationKey = `${occurrence.repoFullName}\0${occurrence.path}`;
          if (!occurrencesByLocation.has(locationKey)) {
            occurrencesByLocation.set(locationKey, occurrence);
          }
        }
      }
    }
  }

  // Sort occurrences deterministically: repoFullName then path
  const allOccurrences = [...occurrencesByLocation.values()].sort((a, b) => {
    const r = a.repoFullName < b.repoFullName ? -1 : a.repoFullName > b.repoFullName ? 1 : 0;
    if (r !== 0) return r;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  // Build sorted contentHashes with sha1: prefix
  const contentHashes = distinctBlobHashes.map((h) => `sha1:${h}`);

  return {
    type: "same_instructions",
    rawVariantCount: distinctBlobHashes.length,
    copyCount: allOccurrences.length,
    contentHashes,
    occurrences: allOccurrences,
  };
}

export class TraceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceError";
  }
}
