/**
 * Trace report schema for SkillLineage v0.1.
 */

import type { IndexOccurrence } from "../index/types.js";

export interface TraceReport {
  readonly schemaVersion: "0.1";
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
}

export interface VariantCandidatesMatch {
  readonly type: "variant_candidates";
  readonly method: "bottom-k-token-shingles-v1";
  readonly approximate: true;
  readonly candidateGenerationTruncated: boolean;
  readonly candidates: readonly VariantCandidate[];
}

export interface VariantCandidate {
  readonly instructionsSha256: string;
  readonly estimatedSimilarity: number;
  readonly sharedAnchors: number;
  readonly rawVariantCount: number;
  readonly copyCount: number;
  readonly examples: readonly VariantCandidateExample[];
}

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
