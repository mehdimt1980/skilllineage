import { DEFAULT_ANCHOR_COUNT, anchorShardPrefix, estimateSketchSimilarity } from "./sketch.js";
import type { AnchorShard, SketchShard } from "../index/types.js";

export const MIN_SHARED_ANCHORS = 2;
export const MAX_PRE_SCORE_CANDIDATES = 2000;
export const MIN_ESTIMATED_SIMILARITY = 0.7;
export const MAX_FINAL_CANDIDATES = 10;

export interface PreScoreCandidate {
  readonly variantId: string;
  readonly sharedAnchors: number;
}

export interface CandidateGenerationResult {
  readonly candidates: readonly PreScoreCandidate[];
  readonly truncated: boolean;
  readonly diagnostics?: CandidateGenerationDiagnostics;
}
export interface CandidateGenerationDiagnostics { observedCandidateCount: number; eligibleCandidateCount: number; returnedCandidateCount: number; uniqueAnchorShardCount: number; }
export interface ScoringDiagnostics { inputCandidateCount: number; uniqueSketchShardCount: number; sketchRecordsFound: number; passedEstimatedThresholdCount: number; finalCandidateCount: number; }

export interface ScoredCandidate extends PreScoreCandidate {
  readonly instructionsSha256: string;
  readonly estimatedSimilarity: number;
}

export async function generateVariantCandidates(
  localSketch: readonly string[],
  readAnchorShard: (prefix: string) => Promise<AnchorShard>,
  diagnostics?: CandidateGenerationDiagnostics,
): Promise<CandidateGenerationResult> {
  const anchors = localSketch.slice(0, DEFAULT_ANCHOR_COUNT);
  const byPrefix = new Map<string, string[]>();
  for (const anchor of anchors) {
    const prefix = anchorShardPrefix(anchor);
    const group = byPrefix.get(prefix) ?? [];
    group.push(anchor);
    byPrefix.set(prefix, group);
  }

  const counts = new Map<string, number>();
  for (const [prefix, groupedAnchors] of byPrefix) {
    const shard = await readAnchorShard(prefix);
    for (const anchor of groupedAnchors) {
      for (const variantId of shard[anchor] ?? []) {
        counts.set(variantId, (counts.get(variantId) ?? 0) + 1);
      }
    }
  }

  const eligible = [...counts]
    .filter(([, count]) => count >= MIN_SHARED_ANCHORS)
    .map(([variantId, sharedAnchors]) => ({ variantId, sharedAnchors }))
    .sort(
      (a, b) =>
        b.sharedAnchors - a.sharedAnchors ||
        compareStrings(a.variantId, b.variantId),
    );

  const result = {
    candidates: eligible.slice(0, MAX_PRE_SCORE_CANDIDATES),
    truncated: eligible.length > MAX_PRE_SCORE_CANDIDATES,
  };
  if (diagnostics) Object.assign(diagnostics, { observedCandidateCount: counts.size, eligibleCandidateCount: eligible.length, returnedCandidateCount: result.candidates.length, uniqueAnchorShardCount: byPrefix.size });
  return result;
}

export async function scoreVariantCandidates(
  localSketch: readonly string[],
  candidates: readonly PreScoreCandidate[],
  readSketchShard: (prefix: string) => Promise<SketchShard>,
  diagnostics?: ScoringDiagnostics,
): Promise<ScoredCandidate[]> {
  const byPrefix = new Map<string, PreScoreCandidate[]>();
  for (const candidate of candidates) {
    const prefix = candidate.variantId.slice(0, 2);
    const group = byPrefix.get(prefix) ?? [];
    group.push(candidate);
    byPrefix.set(prefix, group);
  }

  const scored: ScoredCandidate[] = [];
  let found = 0;
  for (const [prefix, groupedCandidates] of byPrefix) {
    const shard = await readSketchShard(prefix);
    for (const candidate of groupedCandidates) {
      if (!Object.prototype.hasOwnProperty.call(shard, candidate.variantId)) continue;
      found++;
      const record = shard[candidate.variantId];
      const estimatedSimilarity = estimateSketchSimilarity(
        localSketch,
        record.sketch,
      );
      if (estimatedSimilarity >= MIN_ESTIMATED_SIMILARITY) {
        scored.push({
          ...candidate,
          instructionsSha256: record.instructionsSha256,
          estimatedSimilarity,
        });
      }
    }
  }

  const result = scored
    .sort(
      (a, b) =>
        b.estimatedSimilarity - a.estimatedSimilarity ||
        b.sharedAnchors - a.sharedAnchors ||
        compareStrings(a.instructionsSha256, b.instructionsSha256),
    )
    .slice(0, MAX_FINAL_CANDIDATES);
  if (diagnostics) Object.assign(diagnostics, { inputCandidateCount: candidates.length, uniqueSketchShardCount: byPrefix.size, sketchRecordsFound: found, passedEstimatedThresholdCount: scored.length, finalCandidateCount: result.length });
  return result;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
