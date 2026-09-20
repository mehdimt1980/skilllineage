import type {
  TraceTemporalCandidateObservation,
  TraceTemporalEvidence,
  TraceTemporalRelation,
  VariantCandidate,
} from "./types.js";

const SEMANTICS = "dataset_observation_order_only" as const;
const BASIS = "earliest_observed_first_commit_at" as const;

/** Compare only observations already attached to the final ranked candidates. */
export function buildTemporalEvidence(
  candidates: readonly VariantCandidate[],
): TraceTemporalEvidence {
  const candidateCount = candidates.length;
  const totalPairCount = candidateCount < 2 ? 0 : candidateCount * (candidateCount - 1) / 2;
  const relations: TraceTemporalRelation[] = [];

  for (let i = 0; i < candidateCount; i++) {
    const left = observation(candidates[i]);
    for (let j = i + 1; j < candidateCount; j++) {
      const right = observation(candidates[j]);
      if (left === null || right === null) continue;
      const leftAt = left.earliestObserved.firstCommitAt;
      const rightAt = right.earliestObserved.firstCommitAt;
      relations.push({
        left,
        right,
        relation: leftAt < rightAt
          ? "left_first_observed_before_right"
          : leftAt > rightAt
            ? "right_first_observed_before_left"
            : "same_first_observed_at",
      });
    }
  }

  const comparablePairCount = relations.length;
  const nonComparablePairCount = totalPairCount - comparablePairCount;
  if (candidateCount < 2 || comparablePairCount === 0) {
    return {
      status: "not_available",
      semantics: SEMANTICS,
      basis: BASIS,
      reason: candidateCount < 2
        ? "fewer_than_two_candidates"
        : "insufficient_usable_history",
      candidateCount,
      totalPairCount,
      comparablePairCount: 0,
      nonComparablePairCount,
      relations: [],
    };
  }
  return {
    status: "available",
    semantics: SEMANTICS,
    basis: BASIS,
    candidateCount,
    totalPairCount,
    comparablePairCount,
    nonComparablePairCount,
    relations,
  };
}

function observation(candidate: VariantCandidate): TraceTemporalCandidateObservation | null {
  const history = candidate.history;
  if (history.status !== "available" || history.earliestObserved === null) return null;
  return {
    instructionsSha256: candidate.instructionsSha256,
    coverage: history.coverage,
    earliestObserved: history.earliestObserved,
  };
}
