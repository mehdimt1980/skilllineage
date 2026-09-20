import type {
  TraceEvidenceGraph,
  TraceEvidenceGraphCandidateNode,
  TraceEvidenceGraphEdge,
  TraceQuery,
  TraceTemporalEvidence,
  VariantCandidate,
} from "./types.js";

/** Project already-selected trace evidence into links with no inferred lineage direction. */
export function buildEvidenceGraph(
  query: TraceQuery,
  candidates: readonly VariantCandidate[],
  temporalEvidence: TraceTemporalEvidence,
): TraceEvidenceGraph {
  const candidateNodes: TraceEvidenceGraphCandidateNode[] = candidates.map((candidate, candidateIndex) => ({
    id: `candidate:${candidate.instructionsSha256}`,
    kind: "variant_candidate",
    candidateIndex,
    rank: candidateIndex + 1,
    instructionsSha256: candidate.instructionsSha256,
  }));
  const candidateIds = new Set(candidateNodes.map((node) => node.id));
  const nodes: TraceEvidenceGraph["nodes"] = [
    { id: "query", kind: "query", instructionsSha256: query.instructionsSha256 },
    ...candidateNodes,
  ];

  const edges: TraceEvidenceGraphEdge[] = candidates.map((candidate) => ({
    kind: "query_similarity",
    nodeIds: ["query", `candidate:${candidate.instructionsSha256}`],
    approximate: true,
    method: "bottom-k-token-shingles-v1",
    estimatedSimilarity: candidate.estimatedSimilarity,
    sharedAnchors: candidate.sharedAnchors,
  }));

  for (const item of temporalEvidence.relations) {
    const leftId = `candidate:${item.left.instructionsSha256}`;
    const rightId = `candidate:${item.right.instructionsSha256}`;
    if (!candidateIds.has(leftId) || !candidateIds.has(rightId)) {
      throw new Error("Temporal evidence refers to a candidate absent from the final result");
    }
    edges.push({
      kind: "temporal_observation",
      nodeIds: [leftId, rightId],
      semantics: temporalEvidence.semantics,
      basis: temporalEvidence.basis,
      relation: item.relation,
      leftCoverage: item.left.coverage,
      rightCoverage: item.right.coverage,
      leftFirstObservedAt: item.left.earliestObserved.firstCommitAt,
      rightFirstObservedAt: item.right.earliestObserved.firstCommitAt,
    });
  }

  return {
    semantics: "evidence_links_not_lineage_direction",
    queryNodeId: "query",
    nodeCount: nodes.length,
    candidateNodeCount: candidateNodes.length,
    edgeCount: edges.length,
    similarityEdgeCount: candidates.length,
    temporalObservationEdgeCount: temporalEvidence.relations.length,
    nodes,
    edges,
  };
}
