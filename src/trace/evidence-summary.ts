import type {
  TraceMatch,
  ExactMatch,
  SameInstructionsMatch,
  VariantCandidatesMatch,
  TraceEvidenceSummary,
  TraceEvidenceSummaryFact,
  TraceEvidenceSummaryLimitation,
} from "./types.js";

function countLabel(
  count: number,
  singular: string,
  plural: string,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function buildExactEvidenceSummary(
  match: ExactMatch,
): TraceEvidenceSummary {
  const headline = `Exact content match found in ${countLabel(
    match.copyCount,
    "indexed occurrence",
    "indexed occurrences",
  )}.`;

  const facts: TraceEvidenceSummaryFact[] = [
    {
      code: "match",
      text: headline,
    },
  ];

  if (match.history.status === "available") {
    facts.push({
      code: "history_coverage",
      text: `Stored history coverage is ${match.history.coverage}: ${match.history.usableLocationCount} of ${match.history.totalLocationCount} indexed locations have usable historical observations.`,
    });

    if (match.history.earliestObserved !== null) {
      facts.push({
        code: "earliest_observed",
        text: `Earliest usable observation in the indexed dataset is ${match.history.earliestObserved.firstCommitAt} at ${match.history.earliestObserved.repoFullName}/${match.history.earliestObserved.path}.`,
      });
    }
  }

  const limitations: TraceEvidenceSummaryLimitation[] = [
    {
      code: "origin_not_inferred",
      text: "SkillLineage does not infer an origin repository or original author from this evidence.",
    },
  ];

  if (
    match.history.status === "available" &&
    match.history.earliestObserved !== null
  ) {
    limitations.push({
      code: "dataset_observation_only",
      text: "Historical timestamps describe observations in the indexed dataset, not when a Skill first existed outside the dataset.",
    });
  }

  if (match.history.status === "available") {
    if (match.history.coverage === "partial") {
      limitations.push({
        code: "history_incomplete",
        text: "Historical coverage is partial; additional or earlier observations may exist outside the stored evidence.",
      });
    } else if (match.history.coverage === "none") {
      limitations.push({
        code: "history_unavailable",
        text: "Stored historical evidence is insufficient for an observation-order claim.",
      });
    }
  } else {
    limitations.push({
      code: "history_unavailable",
      text: "Stored historical evidence is not available for this match.",
    });
  }

  return {
    semantics: "derived_from_trace_evidence_only",
    headline,
    facts,
    limitations,
  };
}

function buildSameInstructionsEvidenceSummary(
  match: SameInstructionsMatch,
): TraceEvidenceSummary {
  const headline = `Normalized instructions match found across ${countLabel(
    match.rawVariantCount,
    "raw content variant",
    "raw content variants",
  )} and ${countLabel(
    match.copyCount,
    "indexed occurrence",
    "indexed occurrences",
  )}.`;

  const facts: TraceEvidenceSummaryFact[] = [
    {
      code: "match",
      text: headline,
    },
  ];

  if (match.history.status === "available") {
    facts.push({
      code: "history_coverage",
      text: `Stored history coverage is ${match.history.coverage}: ${match.history.usableLocationCount} of ${match.history.totalLocationCount} indexed locations have usable historical observations.`,
    });

    if (match.history.earliestObserved !== null) {
      facts.push({
        code: "earliest_observed",
        text: `Earliest usable observation in the indexed dataset is ${match.history.earliestObserved.firstCommitAt} at ${match.history.earliestObserved.repoFullName}/${match.history.earliestObserved.path}.`,
      });
    }
  }

  const limitations: TraceEvidenceSummaryLimitation[] = [
    {
      code: "origin_not_inferred",
      text: "SkillLineage does not infer an origin repository or original author from this evidence.",
    },
  ];

  if (
    match.history.status === "available" &&
    match.history.earliestObserved !== null
  ) {
    limitations.push({
      code: "dataset_observation_only",
      text: "Historical timestamps describe observations in the indexed dataset, not when a Skill first existed outside the dataset.",
    });
  }

  if (match.history.status === "available") {
    if (match.history.coverage === "partial") {
      limitations.push({
        code: "history_incomplete",
        text: "Historical coverage is partial; additional or earlier observations may exist outside the stored evidence.",
      });
    } else if (match.history.coverage === "none") {
      limitations.push({
        code: "history_unavailable",
        text: "Stored historical evidence is insufficient for an observation-order claim.",
      });
    }
  } else {
    limitations.push({
      code: "history_unavailable",
      text: "Stored historical evidence is not available for this match.",
    });
  }

  return {
    semantics: "derived_from_trace_evidence_only",
    headline,
    facts,
    limitations,
  };
}

function buildVariantCandidatesEvidenceSummary(
  match: VariantCandidatesMatch,
): TraceEvidenceSummary {
  const candidateCount = match.candidates.length;
  const headline = `${countLabel(
    candidateCount,
    "approximate instruction variant candidate",
    "approximate instruction variant candidates",
  )} met the retrieval criteria.`;

  const facts: TraceEvidenceSummaryFact[] = [
    {
      code: "match",
      text: headline,
    },
  ];

  if (candidateCount > 0) {
    const top = match.candidates[0];
    facts.push({
      code: "match",
      text: `Top-ranked candidate has estimated similarity ${top.estimatedSimilarity} and ${countLabel(
        top.sharedAnchors,
        "shared anchor",
        "shared anchors",
      )}.`,
    });
  }

  const usableCandidatesCount = match.candidates.filter(
    (c) =>
      c.history.status === "available" &&
      c.history.coverage !== "none" &&
      c.history.earliestObserved !== null,
  ).length;

  facts.push({
    code: "candidate_history",
    text: `Usable earliest-observation evidence is available for ${usableCandidatesCount} of ${countLabel(
      candidateCount,
      "final candidate",
      "final candidates",
    )}.`,
  });

  if (match.temporalEvidence.status === "available") {
    facts.push({
      code: "temporal_comparability",
      text: `${match.temporalEvidence.comparablePairCount} of ${countLabel(
        match.temporalEvidence.totalPairCount,
        "candidate pair",
        "candidate pairs",
      )} have comparable first-observation evidence in the indexed dataset.`,
    });
  } else {
    if (match.temporalEvidence.reason === "fewer_than_two_candidates") {
      facts.push({
        code: "temporal_comparability",
        text: "Pairwise temporal comparison is not available because fewer than two final candidates were returned.",
      });
    } else {
      facts.push({
        code: "temporal_comparability",
        text: "No final candidate pair has usable first-observation evidence for comparison.",
      });
    }
  }

  facts.push({
    code: "evidence_graph",
    text: `Evidence graph contains ${countLabel(
      match.evidenceGraph.candidateNodeCount,
      "candidate node",
      "candidate nodes",
    )}, ${countLabel(
      match.evidenceGraph.similarityEdgeCount,
      "query-similarity edge",
      "query-similarity edges",
    )}, and ${countLabel(
      match.evidenceGraph.temporalObservationEdgeCount,
      "temporal-observation edge",
      "temporal-observation edges",
    )}.`,
  });

  const limitations: TraceEvidenceSummaryLimitation[] = [
    {
      code: "approximate_similarity",
      text: "Variant similarity is approximate and is not evidence of copying, derivation, or common origin.",
    },
    {
      code: "origin_not_inferred",
      text: "SkillLineage does not infer an origin repository or original author from this evidence.",
    },
  ];

  const hasAnyUsableObservation = match.candidates.some(
    (c) =>
      c.history.status === "available" &&
      c.history.coverage !== "none" &&
      c.history.earliestObserved !== null,
  );
  if (hasAnyUsableObservation) {
    limitations.push({
      code: "dataset_observation_only",
      text: "Historical timestamps describe observations in the indexed dataset, not when a Skill first existed outside the dataset.",
    });
  }

  const hasIncompleteHistory = match.candidates.some(
    (c) =>
      !(
        c.history.status === "available" &&
        c.history.coverage === "complete" &&
        c.history.earliestObserved !== null
      ),
  );
  if (hasIncompleteHistory) {
    limitations.push({
      code: "history_incomplete",
      text: "At least one final candidate lacks complete usable historical coverage; temporal evidence may be incomplete.",
    });
  }

  if (match.candidateGenerationTruncated) {
    limitations.push({
      code: "candidate_generation_truncated",
      text: "Candidate generation was truncated; additional approximate candidates may exist beyond the returned set.",
    });
  }

  return {
    semantics: "derived_from_trace_evidence_only",
    headline,
    facts,
    limitations,
  };
}

function buildNoneEvidenceSummary(): TraceEvidenceSummary {
  const headline = "No match met the current index and retrieval criteria.";
  return {
    semantics: "derived_from_trace_evidence_only",
    headline,
    facts: [
      {
        code: "match",
        text: "No exact, same-instructions, or approximate variant match met the current index and retrieval criteria.",
      },
    ],
    limitations: [
      {
        code: "no_match_not_global_absence",
        text: "A none result does not prove that no related Skill exists outside the current index or retrieval criteria.",
      },
    ],
  };
}

/**
 * Pure, deterministic builder that constructs a human-readable evidence summary
 * projection strictly from existing trace match evidence.
 */
export function buildEvidenceSummary(match: TraceMatch): TraceEvidenceSummary {
  switch (match.type) {
    case "exact":
      return buildExactEvidenceSummary(match);
    case "same_instructions":
      return buildSameInstructionsEvidenceSummary(match);
    case "variant_candidates":
      return buildVariantCandidatesEvidenceSummary(match);
    case "none":
      return buildNoneEvidenceSummary();
  }
}
