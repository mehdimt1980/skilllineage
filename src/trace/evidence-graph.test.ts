import { describe, expect, it } from "vitest";

import type { TraceQuery, TraceTemporalEvidence, VariantCandidate } from "./types.js";
import { buildEvidenceGraph } from "./evidence-graph.js";

const query: TraceQuery = {
  gitBlobSha1: `sha1:${"f".repeat(40)}`,
  instructionsSha256: `sha256:${"e".repeat(64)}`,
};

function candidate(name: string, estimatedSimilarity: number, sharedAnchors: number): VariantCandidate {
  return {
    instructionsSha256: `sha256:${name.repeat(64)}`,
    estimatedSimilarity,
    sharedAnchors,
    rawVariantCount: 1,
    copyCount: 1,
    examples: [],
    history: { status: "not_available", semantics: "observed_not_origin", reason: "no_stored_history" },
  };
}

const candidates = [candidate("a", 0.91, 7), candidate("b", 0.84, 5), candidate("c", 0.78, 3)];
const atA = "2025-01-01T00:00:00.000000Z";
const atB = "2025-02-01T00:00:00.000000Z";
const observed = (index: number, firstCommitAt: string, coverage: "partial" | "complete") => ({
  instructionsSha256: candidates[index].instructionsSha256,
  coverage,
  earliestObserved: { repoFullName: `owner/${index}`, path: "SKILL.md", firstCommitAt, lastCommitAt: null },
});
const A = observed(0, atA, "partial");
const B = observed(1, atB, "complete");
const C = observed(2, atA, "partial");
const temporalEvidence: TraceTemporalEvidence = {
  status: "available", semantics: "dataset_observation_order_only",
  basis: "earliest_observed_first_commit_at", candidateCount: 3,
  totalPairCount: 3, comparablePairCount: 2, nonComparablePairCount: 1,
  relations: [
    { left: A, right: B, relation: "left_first_observed_before_right" },
    { left: A, right: C, relation: "same_first_observed_at" },
  ],
};

describe("evidence graph projection", () => {
  it("preserves ranked node order and copies query similarity values", () => {
    const before = JSON.stringify(candidates);
    const graph = buildEvidenceGraph(query, candidates, temporalEvidence);
    expect(JSON.stringify(candidates)).toBe(before);
    expect(graph.nodes.map((node) => node.id)).toEqual([
      "query", ...candidates.map((item) => `candidate:${item.instructionsSha256}`),
    ]);
    expect(graph.nodes.slice(1)).toMatchObject([
      { candidateIndex: 0, rank: 1 }, { candidateIndex: 1, rank: 2 }, { candidateIndex: 2, rank: 3 },
    ]);
    const similarity = graph.edges.filter((edge) => edge.kind === "query_similarity");
    expect(similarity.map((edge) => [edge.estimatedSimilarity, edge.sharedAnchors])).toEqual([
      [0.91, 7], [0.84, 5], [0.78, 3],
    ]);
    expect(similarity.map((edge) => edge.nodeIds[0])).toEqual(["query", "query", "query"]);
    expect(similarity.map((edge) => [edge.approximate, edge.method])).toEqual([
      [true, "bottom-k-token-shingles-v1"],
      [true, "bottom-k-token-shingles-v1"],
      [true, "bottom-k-token-shingles-v1"],
    ]);
  });

  it("projects temporal relations in their original order with unchanged metadata", () => {
    const graph = buildEvidenceGraph(query, candidates, temporalEvidence);
    const edges = graph.edges.filter((edge) => edge.kind === "temporal_observation");
    expect(edges).toEqual([
      {
        kind: "temporal_observation",
        nodeIds: [`candidate:${A.instructionsSha256}`, `candidate:${B.instructionsSha256}`],
        semantics: "dataset_observation_order_only", basis: "earliest_observed_first_commit_at",
        relation: "left_first_observed_before_right",
        leftCoverage: "partial", rightCoverage: "complete",
        leftFirstObservedAt: atA, rightFirstObservedAt: atB,
      },
      {
        kind: "temporal_observation",
        nodeIds: [`candidate:${A.instructionsSha256}`, `candidate:${C.instructionsSha256}`],
        semantics: "dataset_observation_order_only", basis: "earliest_observed_first_commit_at",
        relation: "same_first_observed_at",
        leftCoverage: "partial", rightCoverage: "partial",
        leftFirstObservedAt: atA, rightFirstObservedAt: atA,
      },
    ]);
    expect(edges.map((edge) => edge.relation)).toEqual(temporalEvidence.relations.map((item) => item.relation));
  });

  it("uses the supplied temporal sequence and relation without sorting or deriving dates", () => {
    const supplied: TraceTemporalEvidence = {
      ...temporalEvidence,
      relations: [
        temporalEvidence.relations[1],
        { ...temporalEvidence.relations[0], relation: "right_first_observed_before_left" },
      ],
    };
    const graph = buildEvidenceGraph(query, candidates, supplied);
    const edges = graph.edges.filter((edge) => edge.kind === "temporal_observation");
    expect(edges.map((edge) => edge.nodeIds)).toEqual([
      [`candidate:${A.instructionsSha256}`, `candidate:${C.instructionsSha256}`],
      [`candidate:${A.instructionsSha256}`, `candidate:${B.instructionsSha256}`],
    ]);
    expect(edges.map((edge) => edge.relation)).toEqual([
      "same_first_observed_at", "right_first_observed_before_left",
    ]);
  });

  it("keeps all similarity links when temporal evidence is unavailable", () => {
    const graph = buildEvidenceGraph(query, candidates, {
      status: "not_available", semantics: "dataset_observation_order_only",
      basis: "earliest_observed_first_commit_at", reason: "insufficient_usable_history",
      candidateCount: 3, totalPairCount: 3, comparablePairCount: 0,
      nonComparablePairCount: 3, relations: [],
    });
    expect(graph.nodes).toHaveLength(4);
    expect(graph.similarityEdgeCount).toBe(3);
    expect(graph.temporalObservationEdgeCount).toBe(0);
    expect(graph.edges).toHaveLength(3);
  });

  it("satisfies count invariants for three and one candidates", () => {
    const one: TraceTemporalEvidence = {
      status: "not_available", semantics: "dataset_observation_order_only",
      basis: "earliest_observed_first_commit_at", reason: "fewer_than_two_candidates",
      candidateCount: 1, totalPairCount: 0, comparablePairCount: 0,
      nonComparablePairCount: 0, relations: [],
    };
    for (const graph of [
      buildEvidenceGraph(query, candidates, temporalEvidence),
      buildEvidenceGraph(query, candidates.slice(0, 1), one),
    ]) {
      expect(graph.nodeCount).toBe(graph.nodes.length);
      expect(graph.nodeCount).toBe(graph.candidateNodeCount + 1);
      expect(graph.edgeCount).toBe(graph.edges.length);
      expect(graph.similarityEdgeCount).toBe(graph.edges.filter((edge) => edge.kind === "query_similarity").length);
      expect(graph.temporalObservationEdgeCount).toBe(graph.edges.filter((edge) => edge.kind === "temporal_observation").length);
      expect(graph.edgeCount).toBe(graph.similarityEdgeCount + graph.temporalObservationEdgeCount);
      expect(graph.semantics).toBe("evidence_links_not_lineage_direction");
    }
  });

  it("serializes evidence metadata without lineage fields or Skill text", () => {
    const serialized = JSON.stringify(buildEvidenceGraph(query, candidates, temporalEvidence));
    for (const field of ["origin", "source", "target", "from", "to", "parent", "child", "ancestor", "descendant", "copiedFrom", "derivedFrom", "predecessor", "successor", "root", "leaf"]) {
      expect(serialized).not.toContain(`"${field}"`);
    }
    expect(serialized).not.toContain("SECRET-SKILL-BODY");
  });
});
