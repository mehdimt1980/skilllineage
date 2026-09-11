import { createHash } from "node:crypto";

import { shingleSet, tokenize } from "../compare/similarity.js";

export const SHINGLE_SIZE = 5;
export const SHINGLE_HASH_HEX_LENGTH = 24;
export const DEFAULT_SKETCH_SIZE = 32;
export const DEFAULT_ANCHOR_COUNT = 8;

export function shingleHash96(shingle: string): string {
  return createHash("sha256")
    .update(Buffer.from(shingle, "utf-8"))
    .digest("hex")
    .slice(0, SHINGLE_HASH_HEX_LENGTH);
}

export function instructionSketch(
  normalizedInstructions: string,
  sketchSize = DEFAULT_SKETCH_SIZE,
): string[] {
  const hashes = [...shingleSet(tokenize(normalizedInstructions))]
    .map(shingleHash96)
    .sort();
  return hashes.slice(0, sketchSize);
}

export function variantIdFromInstructionsSha256(
  instructionsSha256: string,
): string {
  const hex = instructionsSha256.replace(/^sha256:/, "");
  return hex.slice(0, SHINGLE_HASH_HEX_LENGTH);
}

export function estimateSketchSimilarity(
  sketchA: readonly string[],
  sketchB: readonly string[],
): number {
  if (sketchA.length === 0 && sketchB.length === 0) return 1;
  if (sketchA.length === 0 || sketchB.length === 0) return 0;

  const lastA = sketchA[sketchA.length - 1];
  const lastB = sketchB[sketchB.length - 1];
  const tau = lastA < lastB ? lastA : lastB;
  const aTau = new Set(sketchA.filter((hash) => hash <= tau));
  const bTau = new Set(sketchB.filter((hash) => hash <= tau));
  let intersection = 0;
  for (const hash of aTau) {
    if (bTau.has(hash)) intersection++;
  }
  return intersection / (aTau.size + bTau.size - intersection);
}
