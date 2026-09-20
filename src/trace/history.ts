import { createHash } from "node:crypto";

import { normalizeInstructions } from "../fingerprint/index.js";
import {
  instructionHistoryRoute,
  lookupInstructionHistory,
  readHistoryShard,
} from "../index/index.js";
import type { ShardReadObserver } from "../index/reader.js";
import type { HistorySummaryRecord } from "../index/types.js";
import type { TraceHistoryEvidence } from "./types.js";

/** SHA-256 of the canonical normalized empty instruction body ("\n"). */
export const EMPTY_NORMALIZED_INSTRUCTIONS_SHA256 = createHash("sha256")
  .update(normalizeInstructions(""), "utf-8")
  .digest("hex");

const SEMANTICS = "observed_not_origin" as const;

export function historyEvidence(
  record: HistorySummaryRecord | null,
): TraceHistoryEvidence {
  if (record === null) {
    return { status: "not_available", semantics: SEMANTICS, reason: "no_stored_history" };
  }
  return {
    status: "available",
    semantics: SEMANTICS,
    coverage: record.coverage,
    totalLocationCount: record.totalLocationCount,
    historyFetchedLocationCount: record.historyFetchedLocationCount,
    usableLocationCount: record.usableLocationCount,
    chronologyAnomalyCount: record.chronologyAnomalyCount,
    conflictingLocationCount: record.conflictingLocationCount,
    earliestObserved: record.earliestObserved,
    latestObserved: record.latestObserved,
  };
}

export function isEmptyNormalizedInstructions(hash: string): boolean {
  return hash.toLowerCase() === EMPTY_NORMALIZED_INSTRUCTIONS_SHA256;
}

export async function instructionHistoryEvidence(
  indexDir: string,
  instructionHash: string,
  observer?: ShardReadObserver,
): Promise<TraceHistoryEvidence> {
  if (isEmptyNormalizedInstructions(instructionHash)) {
    return {
      status: "not_available",
      semantics: SEMANTICS,
      reason: "empty_normalized_instructions",
    };
  }
  return historyEvidence(await lookupInstructionHistory(indexDir, instructionHash, observer));
}

/** Add presentation evidence after candidate ranking, with one read per route. */
export async function attachVariantHistory<T extends { readonly instructionsSha256: string }>(
  indexDir: string,
  candidates: readonly T[],
  observer?: ShardReadObserver,
): Promise<{ candidates: Array<T & { history: TraceHistoryEvidence }>; routeCount: number }> {
  const byRoute = new Map<string, string[]>();
  for (const candidate of candidates) {
    const hash = candidate.instructionsSha256.replace(/^sha256:/, "").toLowerCase();
    if (isEmptyNormalizedInstructions(hash)) continue;
    const route = instructionHistoryRoute(hash).key;
    const hashes = byRoute.get(route) ?? [];
    hashes.push(hash);
    byRoute.set(route, hashes);
  }

  const records = new Map<string, HistorySummaryRecord>();
  for (const [route, hashes] of byRoute) {
    const shard = await readHistoryShard(indexDir, "instructions", route, observer);
    for (const hash of hashes) {
      if (Object.prototype.hasOwnProperty.call(shard, hash)) records.set(hash, shard[hash]);
    }
  }

  return {
    candidates: candidates.map((candidate) => {
      const hash = candidate.instructionsSha256.replace(/^sha256:/, "").toLowerCase();
      const history: TraceHistoryEvidence = isEmptyNormalizedInstructions(hash)
        ? { status: "not_available", semantics: SEMANTICS, reason: "empty_normalized_instructions" }
        : historyEvidence(records.get(hash) ?? null);
      return { ...candidate, history };
    }),
    routeCount: byRoute.size,
  };
}
