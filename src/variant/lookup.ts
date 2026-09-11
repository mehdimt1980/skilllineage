import { DEFAULT_ANCHOR_COUNT, estimateSketchSimilarity } from "./sketch.js";
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
}

export interface ScoredCandidate extends PreScoreCandidate {
  readonly instructionsSha256: string;
  readonly estimatedSimilarity: number;
}

export async function generateVariantCandidates(
  localSketch: readonly string[],
  readAnchorShard: (prefix: string) => Promise<AnchorShard>,
): Promise<CandidateGenerationResult> {
  const anchors = localSketch.slice(0, DEFAULT_ANCHOR_COUNT);
  const byPrefix = new Map<string, string[]>();
  for (const anchor of anchors) {
    const prefix = anchor.slice(0, 2);
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

  return {
    candidates: eligible.slice(0, MAX_PRE_SCORE_CANDIDATES),
    truncated: eligible.length > MAX_PRE_SCORE_CANDIDATES,
  };
}

export async function scoreVariantCandidates(
  localSketch: readonly string[],
  candidates: readonly PreScoreCandidate[],
  readSketchShard: (prefix: string) => Promise<SketchShard>,
): Promise<ScoredCandidate[]> {
  const byPrefix = new Map<string, PreScoreCandidate[]>();
  for (const candidate of candidates) {
    const prefix = candidate.variantId.slice(0, 2);
    const group = byPrefix.get(prefix) ?? [];
    group.push(candidate);
    byPrefix.set(prefix, group);
  }

  const scored: ScoredCandidate[] = [];
  for (const [prefix, groupedCandidates] of byPrefix) {
    const shard = await readSketchShard(prefix);
    for (const candidate of groupedCandidates) {
      if (!Object.prototype.hasOwnProperty.call(shard, candidate.variantId)) continue;
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

  return scored
    .sort(
      (a, b) =>
        b.estimatedSimilarity - a.estimatedSimilarity ||
        b.sharedAnchors - a.sharedAnchors ||
        compareStrings(a.instructionsSha256, b.instructionsSha256),
    )
    .slice(0, MAX_FINAL_CANDIDATES);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
