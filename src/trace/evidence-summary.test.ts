import { describe, it, expect } from "vitest";
import { buildEvidenceSummary } from "./evidence-summary.js";
import type {
  ExactMatch,
  SameInstructionsMatch,
  VariantCandidatesMatch,
  NoneMatch,
} from "./types.js";

describe("evidence-summary", () => {
  describe("exact match summary", () => {
    it("builds summary for exact match with complete history", () => {
      const match: ExactMatch = {
        type: "exact",
        copyCount: 3,
        occurrences: [
          {
            repoFullName: "owner/a",
            path: "skills/a/SKILL.md",
            stars: 10,
            locationClass: null,
            firstCommitAt: "2024-01-15T10:00:00Z",
            lastCommitAt: "2024-06-01T12:00:00Z",
            historyFetched: true,
          },
          {
            repoFullName: "owner/b",
            path: "skills/b/SKILL.md",
            stars: 5,
            locationClass: null,
            firstCommitAt: "2024-03-01T10:00:00Z",
            lastCommitAt: null,
            historyFetched: true,
          },
          {
            repoFullName: "owner/c",
            path: "skills/c/SKILL.md",
            stars: 2,
            locationClass: null,
            firstCommitAt: "2024-05-20T08:00:00Z",
            lastCommitAt: "2024-06-01T12:00:00Z",
            historyFetched: true,
          },
        ],
        history: {
          status: "available",
          semantics: "observed_not_origin",
          coverage: "complete",
          totalLocationCount: 3,
          historyFetchedLocationCount: 3,
          usableLocationCount: 3,
          chronologyAnomalyCount: 0,
          conflictingLocationCount: 0,
          earliestObserved: {
            repoFullName: "owner/a",
            path: "skills/a/SKILL.md",
            firstCommitAt: "2024-01-15T10:00:00Z",
            lastCommitAt: "2024-06-01T12:00:00Z",
          },
          latestObserved: {
            repoFullName: "owner/c",
            path: "skills/c/SKILL.md",
            firstCommitAt: "2024-05-20T08:00:00Z",
            lastCommitAt: "2024-06-01T12:00:00Z",
          },
        },
      };

      const summary = buildEvidenceSummary(match);
      expect(summary.semantics).toBe("derived_from_trace_evidence_only");
      expect(summary.headline).toBe("Exact content match found in 3 indexed occurrences.");
      expect(summary.facts).toEqual([
        {
          code: "match",
          text: "Exact content match found in 3 indexed occurrences.",
        },
        {
          code: "history_coverage",
          text: "Stored history coverage is complete: 3 of 3 indexed locations have usable historical observations.",
        },
        {
          code: "earliest_observed",
          text: "Earliest usable observation in the indexed dataset is 2024-01-15T10:00:00Z at owner/a/skills/a/SKILL.md.",
        },
      ]);
      expect(summary.limitations).toEqual([
        {
          code: "origin_not_inferred",
          text: "SkillLineage does not infer an origin repository or original author from this evidence.",
        },
        {
          code: "dataset_observation_only",
          text: "Historical timestamps describe observations in the indexed dataset, not when a Skill first existed outside the dataset.",
        },
      ]);
      // No history_incomplete or history_unavailable warning when complete
      expect(summary.limitations.some((l) => l.code === "history_incomplete")).toBe(false);
      expect(summary.limitations.some((l) => l.code === "history_unavailable")).toBe(false);
    });

    it("handles singular occurrence correctly", () => {
      const match: ExactMatch = {
        type: "exact",
        copyCount: 1,
        occurrences: [{
          repoFullName: "owner/a",
          path: "SKILL.md",
          stars: null,
          locationClass: null,
          firstCommitAt: "2023-01-01T00:00:00Z",
          lastCommitAt: null,
          historyFetched: true,
        }],
        history: {
          status: "available",
          semantics: "observed_not_origin",
          coverage: "complete",
          totalLocationCount: 1,
          historyFetchedLocationCount: 1,
          usableLocationCount: 1,
          chronologyAnomalyCount: 0,
          conflictingLocationCount: 0,
          earliestObserved: {
            repoFullName: "owner/a",
            path: "SKILL.md",
            firstCommitAt: "2023-01-01T00:00:00Z",
            lastCommitAt: null,
          },
          latestObserved: null,
        },
      };

      const summary = buildEvidenceSummary(match);
      expect(summary.headline).toBe("Exact content match found in 1 indexed occurrence.");
      expect(summary.facts[0].text).toBe("Exact content match found in 1 indexed occurrence.");
    });

    it("builds summary for exact match with partial history", () => {
      const match: ExactMatch = {
        type: "exact",
        copyCount: 5,
        occurrences: [],
        history: {
          status: "available",
          semantics: "observed_not_origin",
          coverage: "partial",
          totalLocationCount: 5,
          historyFetchedLocationCount: 3,
          usableLocationCount: 2,
          chronologyAnomalyCount: 0,
          conflictingLocationCount: 0,
          earliestObserved: {
            repoFullName: "owner/b",
            path: "SKILL.md",
            firstCommitAt: "2024-02-01T00:00:00Z",
            lastCommitAt: null,
          },
          latestObserved: null,
        },
      };

      const summary = buildEvidenceSummary(match);
      expect(summary.limitations).toEqual([
        {
          code: "origin_not_inferred",
          text: "SkillLineage does not infer an origin repository or original author from this evidence.",
        },
        {
          code: "dataset_observation_only",
          text: "Historical timestamps describe observations in the indexed dataset, not when a Skill first existed outside the dataset.",
        },
        {
          code: "history_incomplete",
          text: "Historical coverage is partial; additional or earlier observations may exist outside the stored evidence.",
        },
      ]);
    });

    it("builds summary when history coverage is none", () => {
      const match: ExactMatch = {
        type: "exact",
        copyCount: 2,
        occurrences: [],
        history: {
          status: "available",
          semantics: "observed_not_origin",
          coverage: "none",
          totalLocationCount: 2,
          historyFetchedLocationCount: 2,
          usableLocationCount: 0,
          chronologyAnomalyCount: 0,
          conflictingLocationCount: 2,
          earliestObserved: null,
          latestObserved: null,
        },
      };

      const summary = buildEvidenceSummary(match);
      expect(summary.facts).toEqual([
        {
          code: "match",
          text: "Exact content match found in 2 indexed occurrences.",
        },
        {
          code: "history_coverage",
          text: "Stored history coverage is none: 0 of 2 indexed locations have usable historical observations.",
        },
      ]);
      expect(summary.facts.some((f) => f.code === "earliest_observed")).toBe(false);
      expect(summary.limitations).toEqual([
        {
          code: "origin_not_inferred",
          text: "SkillLineage does not infer an origin repository or original author from this evidence.",
        },
        {
          code: "history_unavailable",
          text: "Stored historical evidence is insufficient for an observation-order claim.",
        },
      ]);
    });

    it("builds summary when history is not available", () => {
      const match: ExactMatch = {
        type: "exact",
        copyCount: 1,
        occurrences: [],
        history: {
          status: "not_available",
          semantics: "observed_not_origin",
          reason: "no_stored_history",
        },
      };

      const summary = buildEvidenceSummary(match);
      expect(summary.facts).toEqual([
        {
          code: "match",
          text: "Exact content match found in 1 indexed occurrence.",
        },
      ]);
      expect(summary.limitations).toEqual([
        {
          code: "origin_not_inferred",
          text: "SkillLineage does not infer an origin repository or original author from this evidence.",
        },
        {
          code: "history_unavailable",
          text: "Stored historical evidence is not available for this match.",
        },
      ]);
    });
  });

  describe("same instructions summary", () => {
    it("builds headline and facts with rawVariantCount and copyCount", () => {
      const match: SameInstructionsMatch = {
        type: "same_instructions",
        rawVariantCount: 4,
        copyCount: 11,
        contentHashes: ["sha1:1111", "sha1:2222", "sha1:3333", "sha1:4444"],
        occurrences: [],
        history: {
          status: "available",
          semantics: "observed_not_origin",
          coverage: "complete",
          totalLocationCount: 11,
          historyFetchedLocationCount: 11,
          usableLocationCount: 11,
          chronologyAnomalyCount: 0,
          conflictingLocationCount: 0,
          earliestObserved: {
            repoFullName: "owner/root",
            path: "skills/skill/SKILL.md",
            firstCommitAt: "2023-05-10T12:00:00Z",
            lastCommitAt: null,
          },
          latestObserved: null,
        },
      };

      const summary = buildEvidenceSummary(match);
      expect(summary.headline).toBe(
        "Normalized instructions match found across 4 raw content variants and 11 indexed occurrences.",
      );
      expect(summary.facts).toEqual([
        {
          code: "match",
          text: "Normalized instructions match found across 4 raw content variants and 11 indexed occurrences.",
        },
        {
          code: "history_coverage",
          text: "Stored history coverage is complete: 11 of 11 indexed locations have usable historical observations.",
        },
        {
          code: "earliest_observed",
          text: "Earliest usable observation in the indexed dataset is 2023-05-10T12:00:00Z at owner/root/skills/skill/SKILL.md.",
        },
      ]);
      expect(summary.limitations).toEqual([
        {
          code: "origin_not_inferred",
          text: "SkillLineage does not infer an origin repository or original author from this evidence.",
        },
        {
          code: "dataset_observation_only",
          text: "Historical timestamps describe observations in the indexed dataset, not when a Skill first existed outside the dataset.",
        },
      ]);
    });

    it("handles singular raw variants and copy count", () => {
      const match: SameInstructionsMatch = {
        type: "same_instructions",
        rawVariantCount: 1,
        copyCount: 1,
        contentHashes: ["sha1:1111"],
        occurrences: [],
        history: {
          status: "not_available",
          semantics: "observed_not_origin",
          reason: "empty_normalized_instructions",
        },
      };

      const summary = buildEvidenceSummary(match);
      expect(summary.headline).toBe(
        "Normalized instructions match found across 1 raw content variant and 1 indexed occurrence.",
      );
      expect(summary.facts[0].text).toBe(
        "Normalized instructions match found across 1 raw content variant and 1 indexed occurrence.",
      );
    });
  });

  describe("variant candidates summary", () => {
    it("builds summary for variant candidates with mixed history", () => {
      const match: VariantCandidatesMatch = {
        type: "variant_candidates",
        method: "bottom-k-token-shingles-v1",
        approximate: true,
        candidateGenerationTruncated: false,
        candidates: [
          {
            instructionsSha256: "sha256:aaaa",
            estimatedSimilarity: 0.9123,
            sharedAnchors: 7,
            rawVariantCount: 1,
            copyCount: 2,
            examples: [{ repoFullName: "owner/a", path: "SKILL.md", stars: 10 }],
            history: {
              status: "available",
              semantics: "observed_not_origin",
              coverage: "complete",
              totalLocationCount: 2,
              historyFetchedLocationCount: 2,
              usableLocationCount: 2,
              chronologyAnomalyCount: 0,
              conflictingLocationCount: 0,
              earliestObserved: {
                repoFullName: "owner/a",
                path: "SKILL.md",
                firstCommitAt: "2023-01-01T00:00:00Z",
                lastCommitAt: null,
              },
              latestObserved: null,
            },
          },
          {
            instructionsSha256: "sha256:bbbb",
            estimatedSimilarity: 0.85,
            sharedAnchors: 5,
            rawVariantCount: 2,
            copyCount: 3,
            examples: [{ repoFullName: "owner/b", path: "SKILL.md", stars: 2 }],
            history: {
              status: "available",
              semantics: "observed_not_origin",
              coverage: "partial",
              totalLocationCount: 3,
              historyFetchedLocationCount: 2,
              usableLocationCount: 1,
              chronologyAnomalyCount: 0,
              conflictingLocationCount: 0,
              earliestObserved: {
                repoFullName: "owner/b",
                path: "SKILL.md",
                firstCommitAt: "2023-03-01T00:00:00Z",
                lastCommitAt: null,
              },
              latestObserved: null,
            },
          },
          {
            instructionsSha256: "sha256:cccc",
            estimatedSimilarity: 0.78,
            sharedAnchors: 4,
            rawVariantCount: 1,
            copyCount: 1,
            examples: [{ repoFullName: "owner/c", path: "SKILL.md", stars: 0 }],
            history: {
              status: "not_available",
              semantics: "observed_not_origin",
              reason: "no_stored_history",
            },
          },
        ],
        temporalEvidence: {
          status: "available",
          semantics: "dataset_observation_order_only",
          basis: "earliest_observed_first_commit_at",
          candidateCount: 3,
          totalPairCount: 3,
          comparablePairCount: 1,
          nonComparablePairCount: 2,
          relations: [
            {
              left: {
                instructionsSha256: "sha256:aaaa",
                coverage: "complete",
                earliestObserved: {
                  repoFullName: "owner/a",
                  path: "SKILL.md",
                  firstCommitAt: "2023-01-01T00:00:00Z",
                  lastCommitAt: null,
                },
              },
              right: {
                instructionsSha256: "sha256:bbbb",
                coverage: "partial",
                earliestObserved: {
                  repoFullName: "owner/b",
                  path: "SKILL.md",
                  firstCommitAt: "2023-03-01T00:00:00Z",
                  lastCommitAt: null,
                },
              },
              relation: "left_first_observed_before_right",
            },
          ],
        },
        evidenceGraph: {
          semantics: "evidence_links_not_lineage_direction",
          queryNodeId: "query",
          nodeCount: 4,
          candidateNodeCount: 3,
          edgeCount: 4,
          similarityEdgeCount: 3,
          temporalObservationEdgeCount: 1,
          nodes: [
            { id: "query", kind: "query", instructionsSha256: "sha256:qqqq" },
            { id: "candidate:0:aaaa", kind: "variant_candidate", candidateIndex: 0, rank: 1, instructionsSha256: "sha256:aaaa" },
            { id: "candidate:1:bbbb", kind: "variant_candidate", candidateIndex: 1, rank: 2, instructionsSha256: "sha256:bbbb" },
            { id: "candidate:2:cccc", kind: "variant_candidate", candidateIndex: 2, rank: 3, instructionsSha256: "sha256:cccc" },
          ],
          edges: [
            { kind: "query_similarity", nodeIds: ["query", "candidate:0:aaaa"], approximate: true, method: "bottom-k-token-shingles-v1", estimatedSimilarity: 0.9123, sharedAnchors: 7 },
            { kind: "query_similarity", nodeIds: ["query", "candidate:1:bbbb"], approximate: true, method: "bottom-k-token-shingles-v1", estimatedSimilarity: 0.85, sharedAnchors: 5 },
            { kind: "query_similarity", nodeIds: ["query", "candidate:2:cccc"], approximate: true, method: "bottom-k-token-shingles-v1", estimatedSimilarity: 0.78, sharedAnchors: 4 },
            { kind: "temporal_observation", nodeIds: ["candidate:0:aaaa", "candidate:1:bbbb"], semantics: "dataset_observation_order_only", basis: "earliest_observed_first_commit_at", relation: "left_first_observed_before_right", leftCoverage: "complete", rightCoverage: "partial", leftFirstObservedAt: "2023-01-01T00:00:00Z", rightFirstObservedAt: "2023-03-01T00:00:00Z" },
          ],
        },
      };

      const summary = buildEvidenceSummary(match);
      expect(summary.headline).toBe("3 approximate instruction variant candidates met the retrieval criteria.");
      expect(summary.facts).toEqual([
        {
          code: "match",
          text: "3 approximate instruction variant candidates met the retrieval criteria.",
        },
        {
          code: "match",
          text: "Top-ranked candidate has estimated similarity 0.9123 and 7 shared anchors.",
        },
        {
          code: "candidate_history",
          text: "Usable earliest-observation evidence is available for 2 of 3 final candidates.",
        },
        {
          code: "temporal_comparability",
          text: "1 of 3 candidate pairs have comparable first-observation evidence in the indexed dataset.",
        },
        {
          code: "evidence_graph",
          text: "Evidence graph contains 3 candidate nodes, 3 query-similarity edges, and 1 temporal-observation edge.",
        },
      ]);

      expect(summary.limitations).toEqual([
        {
          code: "approximate_similarity",
          text: "Variant similarity is approximate and is not evidence of copying, derivation, or common origin.",
        },
        {
          code: "origin_not_inferred",
          text: "SkillLineage does not infer an origin repository or original author from this evidence.",
        },
        {
          code: "dataset_observation_only",
          text: "Historical timestamps describe observations in the indexed dataset, not when a Skill first existed outside the dataset.",
        },
        {
          code: "history_incomplete",
          text: "At least one final candidate lacks complete usable historical coverage; temporal evidence may be incomplete.",
        },
      ]);
    });

    it("adds candidate_generation_truncated limitation when candidateGenerationTruncated is true", () => {
      const match: VariantCandidatesMatch = {
        type: "variant_candidates",
        method: "bottom-k-token-shingles-v1",
        approximate: true,
        candidateGenerationTruncated: true,
        candidates: [
          {
            instructionsSha256: "sha256:aaaa",
            estimatedSimilarity: 0.9,
            sharedAnchors: 1,
            rawVariantCount: 1,
            copyCount: 1,
            examples: [],
            history: {
              status: "available",
              semantics: "observed_not_origin",
              coverage: "complete",
              totalLocationCount: 1,
              historyFetchedLocationCount: 1,
              usableLocationCount: 1,
              chronologyAnomalyCount: 0,
              conflictingLocationCount: 0,
              earliestObserved: {
                repoFullName: "owner/a",
                path: "SKILL.md",
                firstCommitAt: "2023-01-01T00:00:00Z",
                lastCommitAt: null,
              },
              latestObserved: null,
            },
          },
        ],
        temporalEvidence: {
          status: "not_available",
          semantics: "dataset_observation_order_only",
          basis: "earliest_observed_first_commit_at",
          reason: "fewer_than_two_candidates",
          candidateCount: 1,
          totalPairCount: 0,
          comparablePairCount: 0,
          nonComparablePairCount: 0,
          relations: [],
        },
        evidenceGraph: {
          semantics: "evidence_links_not_lineage_direction",
          queryNodeId: "query",
          nodeCount: 2,
          candidateNodeCount: 1,
          edgeCount: 1,
          similarityEdgeCount: 1,
          temporalObservationEdgeCount: 0,
          nodes: [],
          edges: [],
        },
      };

      const summary = buildEvidenceSummary(match);
      expect(summary.headline).toBe("1 approximate instruction variant candidate met the retrieval criteria.");
      expect(summary.facts[1].text).toBe("Top-ranked candidate has estimated similarity 0.9 and 1 shared anchor.");
      expect(summary.facts[2].text).toBe("Usable earliest-observation evidence is available for 1 of 1 final candidate.");
      expect(summary.facts[3].text).toBe(
        "Pairwise temporal comparison is not available because fewer than two final candidates were returned.",
      );
      expect(summary.facts[4].text).toBe(
        "Evidence graph contains 1 candidate node, 1 query-similarity edge, and 0 temporal-observation edges.",
      );
      expect(summary.limitations).toEqual([
        {
          code: "approximate_similarity",
          text: "Variant similarity is approximate and is not evidence of copying, derivation, or common origin.",
        },
        {
          code: "origin_not_inferred",
          text: "SkillLineage does not infer an origin repository or original author from this evidence.",
        },
        {
          code: "dataset_observation_only",
          text: "Historical timestamps describe observations in the indexed dataset, not when a Skill first existed outside the dataset.",
        },
        {
          code: "candidate_generation_truncated",
          text: "Candidate generation was truncated; additional approximate candidates may exist beyond the returned set.",
        },
      ]);
    });

    it("handles temporal insufficient_usable_history", () => {
      const match: VariantCandidatesMatch = {
        type: "variant_candidates",
        method: "bottom-k-token-shingles-v1",
        approximate: true,
        candidateGenerationTruncated: false,
        candidates: [
          {
            instructionsSha256: "sha256:1",
            estimatedSimilarity: 0.8,
            sharedAnchors: 3,
            rawVariantCount: 1,
            copyCount: 1,
            examples: [],
            history: { status: "not_available", semantics: "observed_not_origin", reason: "no_stored_history" },
          },
          {
            instructionsSha256: "sha256:2",
            estimatedSimilarity: 0.75,
            sharedAnchors: 2,
            rawVariantCount: 1,
            copyCount: 1,
            examples: [],
            history: { status: "not_available", semantics: "observed_not_origin", reason: "no_stored_history" },
          },
        ],
        temporalEvidence: {
          status: "not_available",
          semantics: "dataset_observation_order_only",
          basis: "earliest_observed_first_commit_at",
          reason: "insufficient_usable_history",
          candidateCount: 2,
          totalPairCount: 1,
          comparablePairCount: 0,
          nonComparablePairCount: 1,
          relations: [],
        },
        evidenceGraph: {
          semantics: "evidence_links_not_lineage_direction",
          queryNodeId: "query",
          nodeCount: 3,
          candidateNodeCount: 2,
          edgeCount: 2,
          similarityEdgeCount: 2,
          temporalObservationEdgeCount: 0,
          nodes: [],
          edges: [],
        },
      };

      const summary = buildEvidenceSummary(match);
      const temporalFact = summary.facts.find((f) => f.code === "temporal_comparability");
      expect(temporalFact?.text).toBe("No final candidate pair has usable first-observation evidence for comparison.");
      // Since no candidate has usable observation, dataset_observation_only should NOT be present
      expect(summary.limitations.some((l) => l.code === "dataset_observation_only")).toBe(false);
      expect(summary.limitations.some((l) => l.code === "history_incomplete")).toBe(true);
    });
  });

  describe("none summary", () => {
    it("builds summary for none match", () => {
      const match: NoneMatch = {
        type: "none",
        copyCount: 0,
        occurrences: [],
      };

      const summary = buildEvidenceSummary(match);
      expect(summary.headline).toBe("No match met the current index and retrieval criteria.");
      expect(summary.facts).toEqual([
        {
          code: "match",
          text: "No exact, same-instructions, or approximate variant match met the current index and retrieval criteria.",
        },
      ]);
      expect(summary.limitations).toEqual([
        {
          code: "no_match_not_global_absence",
          text: "A none result does not prove that no related Skill exists outside the current index or retrieval criteria.",
        },
      ]);
      expect(summary.facts.some((f) => f.code.includes("history"))).toBe(false);
    });
  });

  describe("safety, determinism, and mutation invariance", () => {
    it("does not mutate the input match object", () => {
      const match: ExactMatch = {
        type: "exact",
        copyCount: 2,
        occurrences: [{
          repoFullName: "owner/a",
          path: "SKILL.md",
          stars: null,
          locationClass: null,
          firstCommitAt: "2023-01-01T00:00:00Z",
          lastCommitAt: null,
          historyFetched: true,
        }],
        history: {
          status: "available",
          semantics: "observed_not_origin",
          coverage: "complete",
          totalLocationCount: 1,
          historyFetchedLocationCount: 1,
          usableLocationCount: 1,
          chronologyAnomalyCount: 0,
          conflictingLocationCount: 0,
          earliestObserved: {
            repoFullName: "owner/a",
            path: "SKILL.md",
            firstCommitAt: "2023-01-01T00:00:00Z",
            lastCommitAt: null,
          },
          latestObserved: null,
        },
      };

      const before = JSON.stringify(match);
      buildEvidenceSummary(match);
      const after = JSON.stringify(match);
      expect(after).toBe(before);
    });

    it("produces deterministic output across multiple invocations", () => {
      const match: ExactMatch = {
        type: "exact",
        copyCount: 1,
        occurrences: [],
        history: {
          status: "available",
          semantics: "observed_not_origin",
          coverage: "partial",
          totalLocationCount: 2,
          historyFetchedLocationCount: 1,
          usableLocationCount: 1,
          chronologyAnomalyCount: 0,
          conflictingLocationCount: 0,
          earliestObserved: {
            repoFullName: "owner/a",
            path: "SKILL.md",
            firstCommitAt: "2023-01-01T00:00:00Z",
            lastCommitAt: null,
          },
          latestObserved: null,
        },
      };

      const summaryA = buildEvidenceSummary(match);
      const summaryB = buildEvidenceSummary(match);
      expect(JSON.stringify(summaryA)).toBe(JSON.stringify(summaryB));
    });

    it("contains no affirmative prohibited phrases", () => {
      const prohibitedPhrases = [
        "copied from",
        "derived from",
        "is the source",
        "is the origin",
        "is the parent",
        "is the ancestor",
        "original repository is",
      ];

      const matches: Array<ExactMatch | SameInstructionsMatch | VariantCandidatesMatch | NoneMatch> = [
        {
          type: "exact",
          copyCount: 2,
          occurrences: [],
          history: {
            status: "available",
            semantics: "observed_not_origin",
            coverage: "complete",
            totalLocationCount: 2,
            historyFetchedLocationCount: 2,
            usableLocationCount: 2,
            chronologyAnomalyCount: 0,
            conflictingLocationCount: 0,
            earliestObserved: {
              repoFullName: "owner/a",
              path: "SKILL.md",
              firstCommitAt: "2023-01-01T00:00:00Z",
              lastCommitAt: null,
            },
            latestObserved: null,
          },
        },
        {
          type: "same_instructions",
          rawVariantCount: 2,
          copyCount: 3,
          contentHashes: ["sha1:111", "sha1:222"],
          occurrences: [],
          history: { status: "not_available", semantics: "observed_not_origin", reason: "no_stored_history" },
        },
        {
          type: "variant_candidates",
          method: "bottom-k-token-shingles-v1",
          approximate: true,
          candidateGenerationTruncated: true,
          candidates: [],
          temporalEvidence: {
            status: "not_available",
            semantics: "dataset_observation_order_only",
            basis: "earliest_observed_first_commit_at",
            reason: "fewer_than_two_candidates",
            candidateCount: 0,
            totalPairCount: 0,
            comparablePairCount: 0,
            nonComparablePairCount: 0,
            relations: [],
          },
          evidenceGraph: {
            semantics: "evidence_links_not_lineage_direction",
            queryNodeId: "query",
            nodeCount: 1,
            candidateNodeCount: 0,
            edgeCount: 0,
            similarityEdgeCount: 0,
            temporalObservationEdgeCount: 0,
            nodes: [],
            edges: [],
          },
        },
        {
          type: "none",
          copyCount: 0,
          occurrences: [],
        },
      ];

      for (const match of matches) {
        const summary = buildEvidenceSummary(match);
        const serialized = JSON.stringify(summary).toLowerCase();
        for (const phrase of prohibitedPhrases) {
          expect(serialized).not.toContain(phrase);
        }
      }
    });
  });
});
