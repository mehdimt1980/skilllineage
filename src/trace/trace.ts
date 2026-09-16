import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { fingerprint, normalizeInstructions } from "../fingerprint/index.js";
import {
  IndexError,
  readManifest,
  lookupExact,
  lookupInstructions,
  readShard,
  readAnchorShard,
  readSketchShard,
  readVariantEnrichmentShard,
  variantEnrichmentRoute,
  shardPrefix,
} from "../index/index.js";
import type {
  IndexOccurrence,
  IndexHashEntry,
  VariantEnrichmentRecord,
} from "../index/types.js";
import {
  DEFAULT_ANCHOR_COUNT,
  generateVariantCandidates,
  instructionSketch,
  scoreVariantCandidates,
} from "../variant/index.js";
import type {
  CandidateGenerationDiagnostics,
  ScoredCandidate,
  ScoringDiagnostics,
} from "../variant/index.js";
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
  const observer = profile
    ? (event: import("../index/reader.js").ShardReadEvent) =>
        profile.shardReads.push(event)
    : undefined;
  const totalStart = profile ? performance.now() : 0;
  const timed = async <T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const started = profile ? performance.now() : 0;
    const value = await operation();
    if (profile) profile.stages[name] = performance.now() - started;
    return value;
  };

  let indexStat;
  try {
    indexStat = await stat(indexDir);
  } catch {
    throw new TraceError(`Index directory does not exist: ${indexDir}`);
  }
  if (!indexStat.isDirectory()) {
    throw new TraceError(`Not a directory: ${indexDir}`);
  }

  await timed("manifestMs", () => readManifest(indexDir));

  const fp = await timed("fingerprintMs", () =>
    fingerprint(skillPath, toolVersion),
  );

  const gitBlobSha1 = fp.fingerprints.gitBlobSha1;
  const instructionsSha256 = fp.fingerprints.instructionsSha256;
  const hexBlobHash = gitBlobSha1.replace(/^sha1:/, "");
  const hexInstructionHash = instructionsSha256.replace(/^sha256:/, "");

  const query = { gitBlobSha1, instructionsSha256 };

  const exactEntry = await timed("exactLookupMs", () =>
    lookupExact(indexDir, hexBlobHash, observer),
  );
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

  const blobHashes = await timed("instructionLookupMs", () =>
    lookupInstructions(indexDir, hexInstructionHash, observer),
  );
  if (blobHashes && blobHashes.length > 0) {
    const sameInstructionsMatch = await buildSameInstructionsMatch(
      indexDir,
      blobHashes,
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

  const rawSkill = await readFile(
    path.join(path.resolve(skillPath), "SKILL.md"),
    "utf-8",
  );
  const localSketch = instructionSketch(normalizeInstructions(rawSkill));
  if (profile) {
    profile.counts.localSketchSize = localSketch.length;
    profile.counts.localAnchorCount = Math.min(
      localSketch.length,
      DEFAULT_ANCHOR_COUNT,
    );
  }

  const generationStats: CandidateGenerationDiagnostics | undefined = profile
    ? {
        observedCandidateCount: 0,
        eligibleCandidateCount: 0,
        returnedCandidateCount: 0,
        uniqueAnchorShardCount: 0,
      }
    : undefined;

  const generated = await timed("variantAnchorGenerationMs", () =>
    generateVariantCandidates(
      localSketch,
      (prefix) => readAnchorShard(indexDir, prefix, observer),
      generationStats,
    ),
  );

  if (profile && generationStats) {
    Object.assign(profile.counts, generationStats, {
      candidateGenerationTruncated: generated.truncated,
    });
  }

  const scoringStats: ScoringDiagnostics | undefined = profile
    ? {
        inputCandidateCount: 0,
        uniqueSketchShardCount: 0,
        sketchRecordsFound: 0,
        passedEstimatedThresholdCount: 0,
        finalCandidateCount: 0,
      }
    : undefined;

  const scored = await timed("variantSketchScoringMs", () =>
    scoreVariantCandidates(
      localSketch,
      generated.candidates,
      (routeKey) => readSketchShard(indexDir, routeKey, observer),
      scoringStats,
    ),
  );

  if (profile && scoringStats) Object.assign(profile.counts, scoringStats);

  if (scored.length > 0) {
    const candidates = await timed("variantEnrichmentMs", () =>
      enrichVariantCandidates(indexDir, scored, observer, profile),
    );
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

/**
 * Resolve static presentation metadata for already-ranked variant candidates.
 * Schema 0.4 stores this material at build time, so enrichment no longer
 * reconstructs occurrences by scanning instruction and exact shards.
 */
export async function enrichVariantCandidates(
  indexDir: string,
  scored: readonly ScoredCandidate[],
  observer?: import("../index/reader.js").ShardReadObserver,
  profile?: import("./types.js").TraceProfiling,
): Promise<VariantCandidate[]> {
  const byRoute = new Map<string, ScoredCandidate[]>();
  for (const candidate of scored) {
    const routeKey = variantEnrichmentRoute(candidate.instructionsSha256).key;
    const group = byRoute.get(routeKey) ?? [];
    group.push(candidate);
    byRoute.set(routeKey, group);
  }

  const summaries = new Map<string, VariantEnrichmentRecord>();
  for (const [routeKey, groupedCandidates] of byRoute) {
    const shard = await readVariantEnrichmentShard(indexDir, routeKey, observer);
    for (const candidate of groupedCandidates) {
      if (
        !Object.prototype.hasOwnProperty.call(
          shard,
          candidate.instructionsSha256,
        )
      ) {
        throw new IndexError(
          `Variant enrichment index is inconsistent: missing summary for ${candidate.instructionsSha256} in route ${routeKey}. Rebuild the index with the current builder.`,
        );
      }
      summaries.set(
        candidate.instructionsSha256,
        shard[candidate.instructionsSha256],
      );
    }
  }

  if (profile) {
    profile.counts.enrichmentSummaryShardCount = byRoute.size;
    profile.counts.enrichmentInstructionShardCount = 0;
    profile.counts.enrichmentExactShardCount = 0;
  }

  return scored.map((candidate) => {
    const summary = summaries.get(candidate.instructionsSha256);
    if (!summary) {
      throw new IndexError(
        `Variant enrichment index is inconsistent: missing summary for ${candidate.instructionsSha256}. Rebuild the index with the current builder.`,
      );
    }
    return {
      instructionsSha256: `sha256:${candidate.instructionsSha256}`,
      estimatedSimilarity: Number(candidate.estimatedSimilarity.toFixed(4)),
      sharedAnchors: candidate.sharedAnchors,
      rawVariantCount: summary.rawVariantCount,
      copyCount: summary.copyCount,
      examples: summary.examples,
    };
  });
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

  const occurrencesByLocation = new Map<string, IndexOccurrence>();

  for (const [pfx, hashes] of byPrefix) {
    const shard = await readExactShard(indexDir, pfx);
    for (const h of hashes) {
      const entry: IndexHashEntry | undefined = Object.prototype.hasOwnProperty.call(
        shard,
        h,
      )
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

  const allOccurrences = [...occurrencesByLocation.values()].sort((a, b) => {
    const r =
      a.repoFullName < b.repoFullName
        ? -1
        : a.repoFullName > b.repoFullName
          ? 1
          : 0;
    if (r !== 0) return r;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

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
