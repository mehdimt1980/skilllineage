/**
 * Trace report schema for SkillLineage v0.3.
 */

import type { IndexOccurrence } from "../index/types.js";
import type { ShardReadEvent } from "../index/reader.js";

export interface TraceProfiling { stages: Record<string, number>; counts: Record<string, number | boolean>; shardReads: ShardReadEvent[]; }
export interface TraceProfilingOptions { profile: TraceProfiling; }

export interface TraceReport {
  readonly schemaVersion: "0.3";
  readonly query: TraceQuery;
  readonly match: TraceMatch;
  readonly origin: {
    readonly status: "not_inferred";
  };
}

export interface TraceQuery {
  readonly gitBlobSha1: string;
  readonly instructionsSha256: string;
}

export type TraceMatch =
  | ExactMatch
  | SameInstructionsMatch
  | VariantCandidatesMatch
  | NoneMatch;

export interface ExactMatch {
  readonly type: "exact";
  readonly copyCount: number;
  readonly occurrences: readonly IndexOccurrence[];
  readonly history: TraceHistoryEvidence;
}

export interface SameInstructionsMatch {
  readonly type: "same_instructions";
  /** Number of distinct raw Git blob SHA-1 hashes with the same normalized body. */
  readonly rawVariantCount: number;
  /** Total occurrence count across all raw variants. */
  readonly copyCount: number;
  /** Sorted list of sha1:-prefixed Git blob hashes. */
  readonly contentHashes: readonly string[];
  readonly occurrences: readonly IndexOccurrence[];
  readonly history: TraceHistoryEvidence;
}

export interface VariantCandidatesMatch {
  readonly type: "variant_candidates";
  readonly method: "bottom-k-token-shingles-v1";
  readonly approximate: true;
  readonly candidateGenerationTruncated: boolean;
  readonly candidates: readonly VariantCandidate[];
  readonly temporalEvidence: TraceTemporalEvidence;
}

export interface TraceTemporalCandidateObservation {
  readonly instructionsSha256: string;
  readonly coverage: "partial" | "complete";
  readonly earliestObserved: TraceHistoryObservation;
}

export interface TraceTemporalRelation {
  readonly left: TraceTemporalCandidateObservation;
  readonly right: TraceTemporalCandidateObservation;
  readonly relation:
    | "left_first_observed_before_right"
    | "right_first_observed_before_left"
    | "same_first_observed_at";
}

export type TraceTemporalEvidence =
  | {
      readonly status: "available";
      readonly semantics: "dataset_observation_order_only";
      readonly basis: "earliest_observed_first_commit_at";
      readonly candidateCount: number;
      readonly totalPairCount: number;
      readonly comparablePairCount: number;
      readonly nonComparablePairCount: number;
      readonly relations: readonly TraceTemporalRelation[];
    }
  | {
      readonly status: "not_available";
      readonly semantics: "dataset_observation_order_only";
      readonly basis: "earliest_observed_first_commit_at";
      readonly reason: "fewer_than_two_candidates" | "insufficient_usable_history";
      readonly candidateCount: number;
      readonly totalPairCount: number;
      readonly comparablePairCount: 0;
      readonly nonComparablePairCount: number;
      readonly relations: readonly [];
    };

export interface VariantCandidate {
  readonly instructionsSha256: string;
  readonly estimatedSimilarity: number;
  readonly sharedAnchors: number;
  readonly rawVariantCount: number;
  readonly copyCount: number;
  readonly examples: readonly VariantCandidateExample[];
  readonly history: TraceHistoryEvidence;
}

export interface TraceHistoryObservation {
  readonly repoFullName: string;
  readonly path: string;
  readonly firstCommitAt: string;
  readonly lastCommitAt: string | null;
}

export type TraceHistoryEvidence =
  | {
      readonly status: "available";
      readonly semantics: "observed_not_origin";
      readonly coverage: "none" | "partial" | "complete";
      readonly totalLocationCount: number;
      readonly historyFetchedLocationCount: number;
      readonly usableLocationCount: number;
      readonly chronologyAnomalyCount: number;
      readonly conflictingLocationCount: number;
      readonly earliestObserved: TraceHistoryObservation | null;
      readonly latestObserved: TraceHistoryObservation | null;
    }
  | {
      readonly status: "not_available";
      readonly semantics: "observed_not_origin";
      readonly reason: "no_stored_history" | "empty_normalized_instructions";
    };

export interface VariantCandidateExample {
  readonly repoFullName: string;
  readonly path: string;
  readonly stars: number | null;
}

export interface NoneMatch {
  readonly type: "none";
  readonly copyCount: 0;
  readonly occurrences: readonly [];
}
