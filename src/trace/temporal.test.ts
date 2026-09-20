import { describe, expect, it } from "vitest";

import type { TraceHistoryEvidence, VariantCandidate } from "./types.js";
import { buildTemporalEvidence } from "./temporal.js";

const AT_A = "2025-01-01T00:00:00.000000Z";
const AT_B = "2025-02-01T00:00:00.000000Z";
const AT_C = "2025-03-01T00:00:00.000000Z";

function candidate(
  name: string,
  firstCommitAt: string | null,
  coverage: "none" | "partial" | "complete" = "partial",
): VariantCandidate {
  const earliestObserved = firstCommitAt === null ? null : {
    repoFullName: `owner/${name}`,
    path: "SKILL.md",
    firstCommitAt,
    lastCommitAt: null,
  };
  const usableLocationCount = firstCommitAt === null
    ? 0
    : coverage === "complete"
      ? 2
      : 1;
  const history: TraceHistoryEvidence = {
    status: "available", semantics: "observed_not_origin", coverage,
    totalLocationCount: 2,
    historyFetchedLocationCount: usableLocationCount,
    usableLocationCount,
    chronologyAnomalyCount: 0, conflictingLocationCount: 0,
    earliestObserved, latestObserved: earliestObserved,
  };
  return {
    instructionsSha256: `sha256:${name}`,
    estimatedSimilarity: 0.9, sharedAnchors: 4,
    rawVariantCount: 1, copyCount: 2, examples: [], history,
  };
}

function unavailable(name: string): VariantCandidate {
  return {
    ...candidate(name, null, "none"),
    history: { status: "not_available", semantics: "observed_not_origin", reason: "no_stored_history" },
  };
}

describe("dataset observation ordering", () => {
  it("compares first observation timestamps in both directions without reordering candidates", () => {
    const forward = [candidate("A", AT_A), candidate("B", AT_B)];
    const before = JSON.stringify(forward);
    const evidence = buildTemporalEvidence(forward);
    expect(evidence.status).toBe("available");
    expect(evidence.relations.map((item) => item.relation)).toEqual(["left_first_observed_before_right"]);
    expect(evidence.relations[0].left.instructionsSha256).toBe("sha256:A");
    expect(JSON.stringify(forward)).toBe(before);

    const reverseTime = [candidate("A", AT_B), candidate("B", AT_A)];
    expect(buildTemporalEvidence(reverseTime).relations[0].relation).toBe("right_first_observed_before_left");
    expect(reverseTime.map((item) => item.instructionsSha256)).toEqual(["sha256:A", "sha256:B"]);
  });

  it("keeps equal timestamps equal and preserves partial and complete coverage", () => {
    const equal = buildTemporalEvidence([candidate("B", AT_A, "partial"), candidate("A", AT_A, "complete")]);
    expect(equal.relations[0].relation).toBe("same_first_observed_at");
    expect(equal.relations[0].left.coverage).toBe("partial");
    expect(equal.relations[0].right.coverage).toBe("complete");
    expect(equal.relations[0].left.earliestObserved.firstCommitAt).toBe(AT_A);

    const partialPair = buildTemporalEvidence([candidate("A", AT_A), candidate("B", AT_B)]);
    expect(partialPair.comparablePairCount).toBe(1);
    expect(partialPair.relations[0].left.coverage).toBe("partial");
    expect(partialPair.relations[0].right.coverage).toBe("partial");
  });

  it("emits only comparable pairs in candidate-index order", () => {
    const candidates = [candidate("A", AT_A), candidate("B", AT_B), unavailable("C"), candidate("D", AT_C)];
    const evidence = buildTemporalEvidence(candidates);
    expect(evidence).toMatchObject({
      status: "available", semantics: "dataset_observation_order_only",
      basis: "earliest_observed_first_commit_at",
      candidateCount: 4, totalPairCount: 6,
      comparablePairCount: 3, nonComparablePairCount: 3,
    });
    expect(evidence.relations.map((item) => [item.left.instructionsSha256, item.right.instructionsSha256])).toEqual([
      ["sha256:A", "sha256:B"],
      ["sha256:A", "sha256:D"],
      ["sha256:B", "sha256:D"],
    ]);
  });

  it("counts unavailable and coverage-none pairs without emitting relations", () => {
    for (const pair of [
      [unavailable("A"), candidate("B", AT_A)],
      [candidate("A", null, "none"), candidate("B", AT_A)],
      [unavailable("A"), candidate("B", null, "none")],
    ]) {
      expect(buildTemporalEvidence(pair)).toEqual({
        status: "not_available", semantics: "dataset_observation_order_only",
        basis: "earliest_observed_first_commit_at",
        reason: "insufficient_usable_history", candidateCount: 2,
        totalPairCount: 1, comparablePairCount: 0,
        nonComparablePairCount: 1, relations: [],
      });
    }
  });

  it("reports fewer than two candidates separately", () => {
    expect(buildTemporalEvidence([candidate("A", AT_A)])).toMatchObject({
      status: "not_available", reason: "fewer_than_two_candidates",
      candidateCount: 1, totalPairCount: 0,
      comparablePairCount: 0, nonComparablePairCount: 0, relations: [],
    });
    expect(buildTemporalEvidence([])).toMatchObject({
      status: "not_available", reason: "fewer_than_two_candidates",
      candidateCount: 0, totalPairCount: 0,
      comparablePairCount: 0, nonComparablePairCount: 0, relations: [],
    });
  });

  it("emits at most 45 pairs for ten final candidates", () => {
    const candidates = Array.from({ length: 10 }, (_, index) =>
      candidate(String(index), AT_A));
    const evidence = buildTemporalEvidence(candidates);
    expect(evidence).toMatchObject({
      candidateCount: 10, totalPairCount: 45,
      comparablePairCount: 45, nonComparablePairCount: 0,
    });
    expect(evidence.relations).toHaveLength(45);
  });

  it("contains only observation metadata and no directional lineage claims or source text", () => {
    const evidence = buildTemporalEvidence([candidate("A", AT_A), candidate("B", AT_B)]);
    const serialized = JSON.stringify(evidence);
    for (const field of ["origin", "source", "parent", "ancestor", "descendant", "copiedFrom", "derivedFrom", "predecessor", "successor"]) {
      expect(serialized).not.toContain(`"${field}"`);
    }
    expect(serialized).not.toContain("SECRET-SKILL-BODY");
  });
});
